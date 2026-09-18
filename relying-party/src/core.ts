// The relying party: holds the log, runs the gate, talks to wallets.
// Nobody logs in to anything here. Copied from demo2's relying party and
// changed where the brief requires:
//   - one presentation per member EVER (our agent keeps the verified
//     credential), then one "Sign" approval on the phone per entry;
//   - nothing is written except through Gate.submit;
//   - no chain step is hard-coded true: each is checked here, checked by
//     our KERIA agent (and labelled so), or reported as not checked.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import signify, { type SignifyClient } from "signify-ts";
import {
  agentOobi, connect, countSignatures, installAsciiJsonBodies, JsonStore, loadOrCreateBran,
  resolveOobi, toadFor, waitOp, witnessAidsFromAgentConfig, type KeriaEndpoints,
} from "@pilot/common";
import { entryPayload, EXPORT_FORMAT, genesisPayload, type EntryPayload, type Kind } from "@pilot/common/src/log";
import { Gate, issuerFacts, type Decision, type IssuerFacts, type KeriView, type KeyEvent } from "./gate";
import { project, type View } from "./projection";

export interface RelyingPartyConfig {
  keria: KeriaEndpoints;
  dataDir: string;
  displayName: string;
  community: string;
  /** Base URL at which phones' KERIA agents reach this service; it hosts the schema there. */
  publicUrl: string;
  schemaDir: string;
  /** The ONLY issuer whose membership credentials are accepted. */
  trustedIssuerAid: string;
  trustedIssuerOobi: string;
  /** Where the issuer serves its registry exports (GET /registry/<SAID>.cesr); used only by the export. */
  issuerUrl: string;
  schemaSaid: string;
  schemaOobi: string;
  sessionTtlMs: number;
  maxTextLength: number;
}

export type SessionState = "waiting-for-scan" | "requesting" | "verifying" | "verified" | "awaiting-signature" | "rejected" | "expired";
export interface Step { check: string; ok: boolean | null; detail: string }   // ok null = NOT CHECKED
export interface Session {
  id: string; state: SessionState; createdAt: string; expiresAt: string;
  holderAid?: string; handle?: string; applySaid?: string; agreeSaid?: string; credentialSaid?: string;
  presentedNow?: boolean;
  chain: Step[]; rejection?: string;
  pending?: { payload: EntryPayload; requestSaid: string };
  last?: Decision;
  posted: string[];
}
interface State { sessions: Session[]; publishedUrl?: string }

const ALIAS = "log";
const now = () => new Date().toISOString().replace("Z", "000+00:00");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class EntryError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export class RelyingParty implements KeriView {
  private client!: SignifyClient;
  private store: JsonStore<State>;
  private handles = new Map<string, string>();
  private facts: IssuerFacts = issuerFacts([]);
  gate!: Gate;
  aid = "";
  oobi = "";

  constructor(readonly config: RelyingPartyConfig) {
    this.store = new JsonStore<State>(join(config.dataDir, "sessions.json"), { sessions: [] });
  }

  schemaJson(): Buffer { return readFileSync(join(this.config.schemaDir, `${this.config.schemaSaid}.json`)); }

  async init(log: (msg: string) => void = () => undefined): Promise<void> {
    installAsciiJsonBodies();
    const { bran, created } = await loadOrCreateBran(join(this.config.dataDir, "operator.bran"));
    if (created) log(`new passcode written to ${join(this.config.dataDir, "operator.bran")}; back it up`);
    this.client = await connect(this.config.keria, bran);

    let hab = await this.client.identifiers().get(ALIAS).catch(() => undefined);
    if (!hab) {
      const wits = await witnessAidsFromAgentConfig(this.client);
      await waitOp(this.client, await (await this.client.identifiers().create(ALIAS, { wits, toad: toadFor(wits.length) })).op());
      await waitOp(this.client, await (await this.client.identifiers().addEndRole(ALIAS, "agent", this.client.agent!.pre)).op());
      hab = await this.client.identifiers().get(ALIAS);
    }
    this.aid = hab.prefix;
    // demo2, first phone run: without an indexer role and location the wallet drops our requests silently.
    const roles: Array<{ role: string }> = await (await this.client.fetch(`/identifiers/${ALIAS}/endroles`, "GET", null)).json();
    if (!roles.some((r) => r.role === "indexer")) await waitOp(this.client, await (await this.client.identifiers().addEndRole(ALIAS, "indexer", this.aid)).op());
    if (this.store.value.publishedUrl !== this.config.publicUrl) {
      const url = this.config.publicUrl;
      await waitOp(this.client, await (await this.client.identifiers().addLocScheme(ALIAS, { url, scheme: new URL(url).protocol.replace(":", "") })).op());
      this.store.update((st) => { st.publishedUrl = url; });
    }
    const hinted = this.config.trustedIssuerOobi.split("/oobi/")[1]?.split("/")[0];
    if (hinted !== this.config.trustedIssuerAid) throw new Error(`TRUSTED_ISSUER_OOBI points at ${hinted}, not at the pinned issuer ${this.config.trustedIssuerAid}`);
    await resolveOobi(this.client, this.config.trustedIssuerOobi, "community-issuer");
    if (!(await this.client.schemas().get(this.config.schemaSaid).catch(() => undefined))) await resolveOobi(this.client, this.config.schemaOobi);
    this.oobi = await agentOobi(this.client, ALIAS);

    this.gate = new Gate({ dataDir: this.config.dataDir, issuer: this.config.trustedIssuerAid, schema: this.config.schemaSaid, maxTextLength: this.config.maxTextLength }, this);
    if (!this.gate.genesis) {
      // Our own record takes the same road as everyone's: sealed in OUR key event log, then through the gate.
      const gp = genesisPayload({ community: this.config.community, issuer: this.config.trustedIssuerAid, schema: this.config.schemaSaid, operator: this.aid });
      const ixn = await this.client.identifiers().interact(ALIAS, { d: gp.d });
      await waitOp(this.client, await ixn.op());
      const d = await this.gate.submit(gp, ixn.serder.ked.s as string);
      if (d.decision !== "accept") throw new Error(`the gate rejected our genesis record at '${d.failed}': ${d.checks[d.checks.length - 1]?.detail}`);
      log(`genesis record ${d.record} written`);
    } else if (this.gate.genesis.payload.operator !== this.aid || this.gate.genesis.payload.issuer !== this.config.trustedIssuerAid) {
      throw new Error("the log on disk belongs to a different operator or issuer than the one configured; refusing to continue it");
    }
    for (const c of await this.client.credentials().list({ filter: { "-s": this.config.schemaSaid } })) this.handles.set(c.sad.d, c.sad.a.handle);
    await this.refreshIssuer().catch((e) => log(`could not refresh the issuer's log yet: ${e.message}`));
    log(`log operator ${this.aid} ready; community issuer ${this.config.trustedIssuerAid}; ${this.gate.log.length} record(s)`);
  }

  // ── KeriView: what the gate may ask of KERI, all of it through our own agent ──

  async eventAt(aid: string, sn: string): Promise<KeyEvent | undefined> {
    if (aid !== this.aid) await waitOp(this.client, await this.client.keyStates().query(aid, sn), 30_000).catch(() => undefined);
    const kel: KeyEvent[] = await this.client.keyEvents().get(aid);
    return kel.find((e) => e.ked.s === sn);
  }

  async witnessThreshold(aid: string): Promise<number | undefined> {
    const st = aid === this.aid ? [(await this.client.identifiers().get(ALIAS)).state] : await this.client.keyStates().get(aid);
    return st?.[0]?.bt === undefined ? undefined : parseInt(st[0].bt, 16);
  }

  async verifiedCredential(said: string): Promise<{ sad: any } | undefined> {
    return this.client.credentials().get(said).catch(() => undefined);
  }

  async issuerEvents(): Promise<KeyEvent[]> {
    await waitOp(this.client, await this.client.keyStates().query(this.config.trustedIssuerAid), 30_000);
    return this.client.keyEvents().get(this.config.trustedIssuerAid);
  }

  async refreshIssuer(): Promise<IssuerFacts> { return (this.facts = issuerFacts(await this.issuerEvents())); }

  // ── read side ──────────────────────────────────────────────────────

  view(): View { return project(this.gate.log, this.facts, (c) => this.handles.get(c) ?? "(unknown)"); }

  async kel(aid: string): Promise<KeyEvent[]> { return this.client.keyEvents().get(aid); }

  /** Everything the independent verifier needs, and nothing else. */
  async exportBundle(): Promise<unknown> {
    await this.refreshIssuer();
    const log = this.gate.log;
    const kels: Record<string, KeyEvent[]> = {};
    for (const aid of new Set([this.aid, this.config.trustedIssuerAid, ...log.slice(1).map((r) => r.payload.author as string)])) kels[aid] = await this.kel(aid);
    // demo2 found no way to read a registry through a Signify client that does not hold the credential's
    // registry. The issuer's own agent can export it, so the issuer serves that export and we pass it on
    // unread. The verifier trusts none of it: keripy re-verifies every event in it.
    const credentials: Record<string, string> = {};
    for (const said of new Set(log.slice(1).map((r) => r.payload.credential as string))) {
      const res = await fetch(`${this.config.issuerUrl}/registry/${said}.cesr`);
      if (!res.ok) throw new Error(`the issuer did not serve the registry export for ${said}: HTTP ${res.status}`);
      credentials[said] = await res.text();
    }
    return { format: EXPORT_FORMAT, log, kels, credentials };
  }

  // ── sessions ───────────────────────────────────────────────────────

  createSession(): Session {
    const created = new Date();
    const session: Session = { id: randomBytes(16).toString("hex"), state: "waiting-for-scan", createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.config.sessionTtlMs).toISOString(), chain: [], posted: [] };
    this.store.update((s) => { s.sessions.push(session); });
    return session;
  }

  qrUrl(session: Session): string {
    const url = new URL(this.oobi);
    url.searchParams.set("name", this.config.displayName);
    url.searchParams.set("externalId", session.id);
    return url.toString();
  }

  session(id: string): Session | undefined { return this.store.value.sessions.find((s) => s.id === id); }

  /** One pass of the background loop. Safe to call repeatedly. */
  async tick(): Promise<void> {
    const live = this.store.value.sessions.filter((s) => !["rejected", "expired"].includes(s.state));
    for (const s of live) if (Date.parse(s.expiresAt) < Date.now()) this.patch(s.id, { state: "expired" });
    if (live.length === 0) return;

    const waiting = live.filter((s) => s.state === "waiting-for-scan");
    if (waiting.length > 0) {
      const contacts: any[] = await this.client.contacts().list();
      for (const s of waiting) {
        const contact = contacts.find((c) => externalIdOf(c.oobi) === s.id);
        if (contact) await this.onScan(s, contact);
      }
    }
    const { notes } = await this.client.notifications().list();
    for (const note of notes) {
      const route: string = note.a.r;
      if (!["/exn/ipex/offer", "/exn/ipex/grant", "/exn/remotesign/ixn/ref"].includes(route)) continue;
      const exn = (await this.client.exchanges().get(note.a.d)).exn;
      try {
        if (route === "/exn/ipex/offer") await this.onOffer(exn);
        if (route === "/exn/ipex/grant") await this.onGrant(exn);
        if (route === "/exn/remotesign/ixn/ref") await this.onSignatureReference(exn);
      } finally {
        await this.client.notifications().delete(note.i);
      }
    }
  }

  /** A member we have seen before does not present again: our agent still holds the credential it verified. */
  private async onScan(s: Session, contact: any): Promise<void> {
    // One filter key only: on this KERIA two keys combined can match nothing although each alone does (seen in issuer/). The rest is checked below.
    const held: any[] = await this.client.credentials().list({ filter: { "-a-i": contact.id } });
    const facts = await this.refreshIssuer();
    const good = held.find((c) => c.sad.i === this.config.trustedIssuerAid && c.sad.s === this.config.schemaSaid && c.sad.a.i === contact.id && !facts.revokedAt.has(c.sad.d));
    if (good) {
      this.handles.set(good.sad.d, good.sad.a.handle);
      return this.patch(s.id, { state: "verified", holderAid: contact.id, handle: good.sad.a.handle, credentialSaid: good.sad.d, presentedNow: false,
        chain: [{ check: "Membership credential", ok: true, detail: `${good.sad.d}, presented and verified in an earlier visit; no revocation in the issuer's key event log up to event ${facts.seenSn}` }] });
    }
    const [apply, sigs] = await this.client.ipex().apply({ senderName: ALIAS, recipient: contact.id, schemaSaid: this.config.schemaSaid, attributes: {}, datetime: now() });
    await waitOp(this.client, await this.client.ipex().submitApply(ALIAS, apply, sigs, [contact.id]));
    this.patch(s.id, { state: "requesting", holderAid: contact.id, applySaid: apply.ked.d });
  }

  private async onOffer(exn: any): Promise<void> {
    const s = this.store.value.sessions.find((x) => x.state === "requesting" && x.holderAid === exn.i && x.applySaid === exn.p);
    if (!s) return;
    const [agree, sigs] = await this.client.ipex().agree({ senderName: ALIAS, recipient: exn.i, offerSaid: exn.d, datetime: now() });
    await waitOp(this.client, await this.client.ipex().submitAgree(ALIAS, agree, sigs, [exn.i]));
    this.patch(s.id, { agreeSaid: agree.ked.d });
  }

  private async onGrant(exn: any): Promise<void> {
    const s = this.store.value.sessions.find((x) => x.state === "requesting" && x.holderAid === exn.i && x.agreeSaid === exn.p);
    if (!s) return; // a presentation nobody asked for is ignored, not verified
    this.patch(s.id, { state: "verifying" });
    const chain: Step[] = [];
    const step = (check: string, ok: boolean | null, detail: string) => { chain.push({ check, ok, detail }); return ok !== false; };
    const reject = (why: string) => this.patch(s.id, { state: "rejected", rejection: why, chain });

    const acdc = exn.e?.acdc;
    if (!acdc?.d || !acdc.a) return reject("the presentation did not contain a credential");
    step("Presentation is signed by the presenter", null, `NOT CHECKED by this service. Our KERIA agent delivered message ${exn.d} from ${exn.i}; it delivers only messages whose signature it verified.`);
    if (!step("Credential uses the membership schema", acdc.s === this.config.schemaSaid, `schema ${acdc.s}`)) return reject("wrong kind of credential");
    if (!step("Credential comes from the community issuer", acdc.i === this.config.trustedIssuerAid, `issuer ${acdc.i}`)) return reject("credential is not from the community issuer");
    if (!step("Credential was issued to the presenter", acdc.a.i === exn.i, `issued to ${acdc.a.i}`)) return reject("credential belongs to someone else");

    const [admit, sigs, end] = await this.client.ipex().admit({ senderName: ALIAS, recipient: exn.i, grantSaid: exn.d, message: "", datetime: now() });
    await waitOp(this.client, await this.client.ipex().submitAdmit(ALIAS, admit, sigs, end, [exn.i]));
    let verified: any;
    for (let i = 0; i < 40 && !verified; i++) { verified = await this.client.credentials().get(acdc.d).catch(() => undefined); if (!verified) await sleep(500); }
    if (!step("Issuer's signature chain verifies", !!verified, verified ? `our KERIA agent accepted ${acdc.d}: digests, issuance event, and its seal in the issuer's key event log` : "our KERIA agent did not accept the credential")) return reject("credential failed cryptographic verification");
    if (verified.sad.d !== acdc.d || verified.sad.i !== this.config.trustedIssuerAid || verified.sad.a.i !== exn.i) {
      step("Verified copy matches the presented copy", false, "mismatch");
      return reject("credential changed between presentation and verification");
    }
    const events = await this.issuerEvents();
    const toad = await this.witnessThreshold(this.config.trustedIssuerAid);
    const thin = events.filter((e) => countSignatures(e.atc).witnessReceipts < (toad ?? Infinity));
    if (!step("Issuer's key event log is receipted by its witnesses", thin.length === 0, `${events.length} events, each with at least ${toad} witness receipts (counted by this service; verified by our KERIA agent)`)) return reject("issuer events lack witness receipts");
    const facts = (this.facts = issuerFacts(events));
    if (!step("Registry belongs to the issuer", facts.sealed.has(`${verified.sad.ri}|0`), `registry ${verified.sad.ri} inception is sealed in the issuer's key event log`)) return reject("registry is not the issuer's");
    const rev = facts.revokedAt.get(acdc.d);
    if (!step("Credential has not been revoked", rev === undefined, rev === undefined ? `no revocation sealed in the issuer's key event log up to event ${facts.seenSn}` : `revoked at issuer event ${rev}`)) return reject("membership has been revoked");

    this.handles.set(acdc.d, verified.sad.a.handle);
    this.patch(s.id, { state: "verified", credentialSaid: acdc.d, handle: verified.sad.a.handle, presentedNow: true, chain });
  }

  // ── entries ────────────────────────────────────────────────────────

  async requestEntry(sessionId: string, kind: unknown, text: unknown, target: unknown): Promise<Session> {
    const s = this.session(sessionId);
    if (!s) throw new EntryError("no such session", 404);
    if (s.state !== "verified") throw new EntryError("show your membership credential first", 403);
    if (kind !== "claim" && kind !== "support" && kind !== "attack") throw new EntryError("kind must be claim, support or attack", 400);
    if (typeof text !== "string" || text.trim() === "") throw new EntryError("text is required", 400);
    if ([...text.trim()].length > this.config.maxTextLength) throw new EntryError(`text is longer than ${this.config.maxTextLength} characters`, 400);
    if (kind !== "claim" && !this.gate.log.some((r) => r.n > 0 && r.d === target)) throw new EntryError("the entry you are responding to is not in the log", 400);

    const payload = entryPayload({ kind: kind as Kind, text: text.trim(), target: kind === "claim" ? undefined : String(target), author: s.holderAid!, credential: s.credentialSaid!, log: this.gate.genesis!.d });
    const hab = await this.client.identifiers().get(ALIAS);
    const [req, sigs, atc] = await this.client.exchanges().createExchangeMessage(hab, "/remotesign/ixn/req", payload as any, {}, s.holderAid!);
    await this.client.exchanges().sendFromEvents(ALIAS, "remotesign", req, sigs, atc, [s.holderAid!]);
    this.patch(s.id, { state: "awaiting-signature", pending: { payload, requestSaid: req.ked.d }, last: undefined });
    return this.session(sessionId)!;
  }

  private async onSignatureReference(exn: any): Promise<void> {
    const s = this.store.value.sessions.find((x) => x.state === "awaiting-signature" && x.holderAid === exn.i && x.pending?.requestSaid === exn.p);
    if (!s || !s.pending) return; // not an answer to anything we asked
    const decision = await this.gate.submit(s.pending.payload, String(exn.a?.sn ?? ""));
    await this.refreshIssuer().catch(() => undefined);
    const revoked = decision.failed === "standing";
    this.patch(s.id, { state: revoked ? "rejected" : "verified", rejection: revoked ? "membership has been revoked" : undefined, pending: undefined, last: decision,
      posted: decision.record ? [...s.posted, decision.record] : s.posted });
  }

  private patch(id: string, fields: Partial<Session>): void {
    this.store.update((s) => { const session = s.sessions.find((x) => x.id === id); if (session) Object.assign(session, fields); });
  }
}

function externalIdOf(oobi: unknown): string | undefined {
  if (typeof oobi !== "string") return undefined;
  try { return new URL(oobi).searchParams.get("externalId") ?? undefined; } catch { return undefined; }
}
