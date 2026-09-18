// The issuer of community membership credentials: one KERI identifier, one
// credential registry ("members"), one schema whose only attribute besides
// the member's AID and the date is a handle.
// It is a Signify client, like the wallet: keys are derived in this
// process from the passcode in DATA_DIR/issuer.bran and are never sent to
// KERIA. Replaces Veridian's reference credential server entirely.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SignifyClient } from "signify-ts";
import {
  agentOobi, connect, installAsciiJsonBodies, JsonStore, loadOrCreateBran, resolveOobi,
  toadFor, waitOp, witnessAidsFromAgentConfig,
  type KeriaEndpoints,
} from "@pilot/common";
import { parseHandle } from "./handle";

export interface IssuerConfig {
  keria: KeriaEndpoints;
  /** Base URL at which KERIA agents and phones can reach this service (it hosts the schema). */
  publicUrl: string;
  dataDir: string;
  /** Shown in the wallet as the connection name. */
  displayName: string;
  schemaDir: string;
  sessionTtlMs: number;
  /** Base URL of the relying party's log (serves GET /log/head). Needed to checkpoint and to revoke. */
  logUrl?: string;
}

export type SessionState = "waiting-for-scan" | "issuing" | "granted" | "admitted" | "expired" | "failed";

export interface Session {
  id: string;
  handle: string;
  state: SessionState;
  createdAt: string;
  expiresAt: string;
  holderAid?: string;
  holderAlias?: string;
  credentialSaid?: string;
  grantSaid?: string;
  error?: string;
}

export interface Member {
  said: string;
  handle: string;
  memberAid: string;
  /** "iss" or "rev", from the issuer's own registry. */
  status: string;
}

export class CheckpointError extends Error {}
export class RevokeError extends Error {}

const SAID_RE = /^[A-Za-z0-9_-]{44}$/;

/**
 * Asks the relying party for the current head of its log: GET
 * <logUrl>/log/head -> {n, d}. Throws CheckpointError if it cannot be
 * had; nothing may be anchored or revoked on a guess.
 */
export async function fetchLogHead(logUrl: string | undefined, timeoutMs = 10_000): Promise<{ n: number; d: string }> {
  if (!logUrl) throw new CheckpointError("LOG_URL is not set, so the log head cannot be fetched");
  const url = `${logUrl.replace(/\/+$/, "")}/log/head`;
  let head: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    head = await res.json();
  } catch (e) {
    throw new CheckpointError(`could not fetch the log head from ${url}: ${e instanceof Error ? e.message : e}`);
  }
  if (typeof head?.d !== "string" || !SAID_RE.test(head.d) || !Number.isInteger(head?.n)) {
    throw new CheckpointError(`${url} did not answer {n, d} with a SAID: ${JSON.stringify(head)}`);
  }
  return { n: head.n, d: head.d };
}

interface State {
  sessions: Session[];
  publishedUrl?: string;
}

const ALIAS = "issuer";
const REGISTRY = "members";
const now = () => new Date().toISOString().replace("Z", "000+00:00");

export class Issuer {
  private client!: SignifyClient;
  private store: JsonStore<State>;
  readonly schemaSaid: string;
  aid = "";
  registry = "";
  oobi = "";

  constructor(private readonly config: IssuerConfig) {
    this.schemaSaid = readFileSync(join(config.schemaDir, "SAID"), "utf8").trim();
    this.store = new JsonStore<State>(join(config.dataDir, "issuer-state.json"), { sessions: [] });
  }

  schemaJson(): Buffer {
    return readFileSync(join(this.config.schemaDir, `${this.schemaSaid}.json`));
  }

  /**
   * Idempotent. The first run IS the inception ceremony (RUNBOOK.md): it
   * creates the passcode, the identifier with pre-rotation committed, its
   * roles, and the registry. The HTTP server must already be listening,
   * because KERIA fetches the schema from us during this call.
   */
  async init(log: (msg: string) => void = () => undefined): Promise<void> {
    installAsciiJsonBodies();
    const { bran, created } = await loadOrCreateBran(join(this.config.dataDir, "issuer.bran"));
    if (created) log(`NEW PASSCODE written to ${join(this.config.dataDir, "issuer.bran")} — back it up now; it IS the issuer's keys`);
    this.client = await connect(this.config.keria, bran);

    let hab = await this.client.identifiers().get(ALIAS).catch(() => undefined);
    if (!hab) {
      const wits = await witnessAidsFromAgentConfig(this.client);
      const toad = toadFor(wits.length);
      log(`incepting identifier with ${wits.length} witnesses, threshold ${toad}`);
      await waitOp(this.client, await (await this.client.identifiers().create(ALIAS, { wits, toad })).op());
      hab = await this.client.identifiers().get(ALIAS);
    }
    this.aid = hab.prefix;

    const roles = await this.endRoles();
    if (!roles.some((r) => r.role === "agent")) {
      await waitOp(this.client, await (await this.client.identifiers().addEndRole(ALIAS, "agent", this.client.agent!.pre)).op());
    }
    // The wallet finds the schema host by looking up the issuer's "indexer"
    // role and its location. A Veridian convention, not a KERI one.
    if (!roles.some((r) => r.role === "indexer")) {
      await waitOp(this.client, await (await this.client.identifiers().addEndRole(ALIAS, "indexer", this.aid)).op());
    }
    if (this.store.value.publishedUrl !== this.config.publicUrl) {
      const url = this.config.publicUrl;
      await waitOp(this.client, await (await this.client.identifiers().addLocScheme(ALIAS, {
        url, scheme: new URL(url).protocol.replace(":", ""),
      })).op());
      this.store.update((s) => { s.publishedUrl = url; });
      log(`published schema location ${url}`);
    }

    let registries = await this.client.registries().list(ALIAS);
    if (registries.length === 0) {
      await waitOp(this.client, await (await this.client.registries().create({ name: ALIAS, registryName: REGISTRY })).op());
      registries = await this.client.registries().list(ALIAS);
    }
    this.registry = registries[0].regk;

    await resolveOobi(this.client, `${this.config.publicUrl}/oobi/${this.schemaSaid}`);
    this.oobi = await agentOobi(this.client, ALIAS);
    log(`issuer ${this.aid} ready`);
  }

  private async endRoles(): Promise<Array<{ role: string; eid: string }>> {
    const res = await this.client.fetch(`/identifiers/${ALIAS}/endroles`, "GET", null);
    return res.json();
  }

  /** Key state as the rest of the world sees it, for the operator page and Lesson 1. */
  async keyState(): Promise<{ aid: string; sn: number; witnesses: string[]; threshold: number; nextKeyDigests: string[] }> {
    const hab = await this.client.identifiers().get(ALIAS);
    return {
      aid: hab.prefix,
      sn: parseInt(hab.state.s, 16),
      witnesses: hab.state.b,
      threshold: parseInt(hab.state.bt, 16),
      nextKeyDigests: hab.state.n,
    };
  }

  /** The inception event with its attachments: controller signature + witness receipts. */
  async inceptionEvent(): Promise<{ ked: Record<string, unknown>; atc: string }> {
    const kel = await this.client.keyEvents().get(this.aid);
    return kel[0];
  }

  /**
   * Rotation ceremony: the key committed to at the previous event becomes
   * the signing key, and a fresh next key is committed. Both are derived
   * from the same passcode, so this protects against a leaked *signing
   * key*, not a leaked passcode (DESIGN.md).
   */
  async rotate(): Promise<number> {
    const res = await this.client.identifiers().rotate(ALIAS);
    await waitOp(this.client, await res.op());
    return (await this.keyState()).sn;
  }

  // ── sessions ────────────────────────────────────────────────────────

  createSession(handleInput: unknown): Session {
    const handle = parseHandle(handleInput);
    const created = new Date();
    const session: Session = {
      id: randomBytes(16).toString("hex"),
      handle,
      state: "waiting-for-scan",
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.config.sessionTtlMs).toISOString(),
    };
    this.store.update((s) => { s.sessions.push(session); });
    return session;
  }

  /** What goes in the QR code. Whoever scans it first receives the credential. */
  qrUrl(session: Session): string {
    const url = new URL(this.oobi);
    url.searchParams.set("name", this.config.displayName);
    url.searchParams.set("externalId", session.id);
    return url.toString();
  }

  session(id: string): Session | undefined {
    return this.store.value.sessions.find((s) => s.id === id);
  }

  sessions(): Session[] {
    return this.store.value.sessions;
  }

  /** One pass of the background loop. Safe to call repeatedly. */
  async tick(): Promise<void> {
    const open = this.sessions().filter((s) => s.state === "waiting-for-scan" || s.state === "granted");
    if (open.length === 0) return;

    for (const s of open) {
      if (s.state === "waiting-for-scan" && Date.parse(s.expiresAt) < Date.now()) {
        this.patch(s.id, { state: "expired" });
      }
    }

    const waiting = this.sessions().filter((s) => s.state === "waiting-for-scan");
    if (waiting.length > 0) {
      const contacts: any[] = await this.client.contacts().list();
      for (const s of waiting) {
        const contact = contacts.find((c) => externalIdOf(c.oobi) === s.id);
        if (!contact) continue;
        this.patch(s.id, { state: "issuing", holderAid: contact.id, holderAlias: contact.alias });
        try {
          const { credentialSaid, grantSaid } = await this.issueTo(contact.id, s.handle);
          this.patch(s.id, { state: "granted", credentialSaid, grantSaid });
        } catch (e) {
          this.patch(s.id, { state: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    const granted = this.sessions().filter((s) => s.state === "granted");
    if (granted.length > 0) {
      const { notes } = await this.client.notifications().list();
      for (const note of notes.filter((n: any) => n.a.r === "/exn/ipex/admit")) {
        const admit = await this.client.exchanges().get(note.a.d);
        const s = granted.find((g) => g.grantSaid === admit.exn.p && g.holderAid === admit.exn.i);
        if (s) this.patch(s.id, { state: "admitted" });
        await this.client.notifications().delete(note.i);
      }
    }
  }

  /** Issue and IPEX-grant. KERIA validates the attributes against the schema as well. */
  async issueTo(holderAid: string, handle: string): Promise<{ credentialSaid: string; grantSaid: string }> {
    const issued = await this.client.credentials().issue(ALIAS, {
      ri: this.registry, s: this.schemaSaid, a: { i: holderAid, handle },
    });
    await waitOp(this.client, issued.op);
    const [grant, sigs, end] = await this.client.ipex().grant({
      senderName: ALIAS, recipient: holderAid, datetime: now(),
      acdc: issued.acdc, iss: issued.iss, anc: issued.anc,
    });
    await waitOp(this.client, await this.client.ipex().submitGrant(ALIAS, grant, sigs, end, [holderAid]));
    return { credentialSaid: issued.acdc.ked.d, grantSaid: grant.ked.d };
  }

  // -- members and the public registry material ---------------------------

  /** Every credential this issuer has issued under the membership schema. */
  async members(): Promise<Member[]> {
    // Filtered by issuer only, the rest here: on this KERIA the combined
    // filter {"-i", "-s"} matches nothing although each alone does (observed).
    const creds: any[] = [];
    for (const limit = 100; ; ) {
      const page: any[] = await this.client.credentials().list({ filter: { "-i": this.aid }, skip: creds.length, limit });
      creds.push(...page);
      if (page.length < limit) break;
    }
    return creds
      .filter((c) => c.sad.i === this.aid && c.sad.ri === this.registry && c.sad.s === this.schemaSaid)
      .map((c) => ({ said: c.sad.d, handle: c.sad.a.handle, memberAid: c.sad.a.i, status: c.status.et }));
  }

  /**
   * CESR export of one credential WE issued: our KEL, the registry
   * inception, the credential's iss/rev events with witness receipts, and
   * the credential (established in spike/10). The independent verifier
   * consumes this. Undefined for anything we did not issue, including
   * credentials that merely sit in our agent's store.
   */
  async exportCesr(credentialSaid: string): Promise<string | undefined> {
    if (!(await this.members()).some((m) => m.said === credentialSaid)) return undefined;
    return (await this.client.credentials().get(credentialSaid, true)) as unknown as string;
  }

  // -- checkpoint and revocation -------------------------------------------

  /**
   * Anchors the digest-only seal {d: logHeadSaid} in the issuer's own KEL
   * (an interaction event, witnessed). Returns the event's sequence number.
   */
  async checkpoint(logHeadSaid: string): Promise<number> {
    if (!SAID_RE.test(logHeadSaid)) throw new CheckpointError(`log head "${logHeadSaid}" is not a SAID`);
    const ixn = await this.client.identifiers().interact(ALIAS, { d: logHeadSaid });
    await waitOp(this.client, await ixn.op());
    return parseInt(ixn.serder.ked.s as string, 16);
  }

  /**
   * Marks the credential revoked in the issuer's registry. Irreversible.
   *
   * The log is checkpointed FIRST: entries the member signed before the
   * revocation are only provably "before" if the issuer's KEL commits to
   * a log head that contains them, at a sequence number below the
   * revocation's anchor. `logHeadSaid === null` skips the checkpoint; the
   * verifier will then reject ALL of that member's entries not covered by
   * an earlier checkpoint. Callers must make the operator ask for that.
   */
  async revoke(credentialSaid: string, logHeadSaid: string | null): Promise<{ checkpointSn?: number; revocationSn: number }> {
    const member = (await this.members()).find((m) => m.said === credentialSaid);
    if (!member) throw new RevokeError(`no credential ${credentialSaid} issued by this issuer`);
    if (member.status === "rev") throw new RevokeError(`credential ${credentialSaid} is already revoked`);
    const checkpointSn = logHeadSaid === null ? undefined : await this.checkpoint(logHeadSaid);
    const res = await this.client.credentials().revoke(ALIAS, credentialSaid, now());
    await waitOp(this.client, res.op);
    return { checkpointSn, revocationSn: parseInt(res.anc.ked.s as string, 16) };
  }

  /** What the CLI and the operator API call: fetch the head, anchor it. */
  async checkpointCurrentHead(): Promise<{ head: { n: number; d: string }; sn: number }> {
    const head = await fetchLogHead(this.config.logUrl);
    return { head, sn: await this.checkpoint(head.d) };
  }

  /**
   * What the CLI and the operator API call. Refuses (nothing anchored,
   * nothing revoked) if the head cannot be fetched, unless the operator
   * explicitly passed noCheckpoint.
   */
  async revokeAtCurrentHead(credentialSaid: string, opts: { noCheckpoint?: boolean } = {}, log: (msg: string) => void = console.warn) {
    if (opts.noCheckpoint) {
      log(`WARNING: REVOKING ${credentialSaid} WITHOUT A LOG CHECKPOINT. The verifier will reject ALL of this member's ` +
        "entries that are not covered by an earlier checkpoint, including everything they signed in good standing since then.");
      return { head: undefined, ...(await this.revoke(credentialSaid, null)) };
    }
    let head;
    try {
      head = await fetchLogHead(this.config.logUrl);
    } catch (e) {
      throw new CheckpointError(`refusing to revoke: ${(e as Error).message}. Nothing was anchored or revoked. ` +
        "Fix LOG_URL / the relying party, or pass --no-checkpoint (API: {\"noCheckpoint\":true}) knowing that the verifier " +
        "will then reject all of this member's entries not covered by an earlier checkpoint.");
    }
    return { head, ...(await this.revoke(credentialSaid, head.d)) };
  }

  private patch(id: string, fields: Partial<Session>): void {
    this.store.update((s) => {
      const session = s.sessions.find((x) => x.id === id);
      if (session) Object.assign(session, fields);
    });
  }
}

function externalIdOf(oobi: unknown): string | undefined {
  if (typeof oobi !== "string") return undefined;
  try {
    return new URL(oobi).searchParams.get("externalId") ?? undefined;
  } catch {
    return undefined;
  }
}
