// A Signify client that behaves like the stock Veridian wallet, for tests.
//
// Every method mirrors a specific piece of the wallet's source (paths are
// relative to infra/veridian/src/core/agent/services) so that a passing
// test says something about the real app. It is NOT the app: it has no
// UI, approves whatever the test tells it to, and cannot tell us how the
// phone renders anything. TESTER.md is the test of that.
import signify, { type SignifyClient } from "signify-ts";
import { agentOobi, connect, resolveOobi, toadFor, waitOp, witnessAidsFromAgentConfig, type KeriaEndpoints } from "../index";

const now = () => new Date().toISOString().replace("Z", "000+00:00");

/**
 * In local mode services advertise docker-network names ("http://keria:3902",
 * "http://issuer:3010") that a process on the host cannot resolve. The
 * wallet hardcodes one such rewrite; tests may add more via
 * STANDIN_URL_REWRITES="http://issuer:3010=http://127.0.0.1:3010,...".
 */
function localUrl(url: string): string {
  const rules = [["http://keria:3902", "http://127.0.0.1:3902"], ...(process.env.STANDIN_URL_REWRITES ?? "").split(",").filter(Boolean).map((r) => r.split("="))];
  for (const [from, to] of rules) if (url.startsWith(from)) return to + url.slice(from.length);
  return url;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WalletStandIn {
  private constructor(
    readonly client: SignifyClient,
    readonly name: string,
    readonly aid: string,
    readonly displayName: string
  ) {}

  /** identifierService.ts createIdentifier: witnesses come from KERIA's config. */
  static async create(keria: KeriaEndpoints, displayName = "Tester Phone"): Promise<WalletStandIn> {
    await signify.ready();
    const client = await connect(keria, signify.randomPasscode());
    const wits = await witnessAidsFromAgentConfig(client);
    const name = "holder";
    await waitOp(client, await (await client.identifiers().create(name, { wits, toad: toadFor(wits.length) })).op());
    await waitOp(client, await (await client.identifiers().addEndRole(name, "agent", client.agent!.pre)).op());
    const aid = (await client.identifiers().get(name)).prefix;
    return new WalletStandIn(client, name, aid, displayName);
  }

  /**
   * connectionService.ts connectByOobiUrl + shareIdentifier: resolve the
   * scanned OOBI, then send our own OOBI back in an /introduce reply,
   * echoing the scanned `externalId` and always carrying a `name`.
   */
  async scan(qrUrl: string): Promise<string> {
    const scanned = new URL(qrUrl);
    const remoteAid = scanned.pathname.split("/oobi/").pop()!.split("/")[0];
    await resolveOobi(this.client, qrUrl, scanned.searchParams.get("name") ?? undefined);

    const mine = new URL(await agentOobi(this.client, this.name));
    mine.searchParams.set("name", this.displayName);
    const externalId = scanned.searchParams.get("externalId");
    if (externalId) mine.searchParams.set("externalId", externalId);

    const signer = new signify.Signer({ transferable: false });
    const rpy = signify.reply("/introduce", { cid: signer.verfer.qb64, oobi: mine.toString() }, undefined, undefined, signify.Serials.JSON);
    const sig = signer.sign(new Uint8Array(signify.b(rpy.raw)));
    const ims = signify.d(signify.messagize(rpy, undefined, undefined, undefined, [sig as any]));
    await this.client.replies().submitRpy(remoteAid, ims);
    return remoteAid;
  }

  async waitForNotification(route: string, timeoutMs = 30_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { notes } = await this.client.notifications().list();
      const hit = notes.find((n: any) => n.a.r === route && !n.r);
      if (hit) {
        await this.client.notifications().mark(hit.i);
        return hit;
      }
      await sleep(400);
    }
    throw new Error(`wallet stand-in: no ${route} notification within ${timeoutMs}ms`);
  }

  /**
   * ipexCommunicationService.ts admitAcdcFromGrant: find the schema through
   * the issuer's "indexer" role OOBI (string-parsed, exactly as the wallet
   * does), resolve it, admit.
   */
  async acceptCredential(issuerOobi: string): Promise<string> {
    const note = await this.waitForNotification("/exn/ipex/grant");
    const grant = await this.client.exchanges().get(note.a.d);
    const issuer = grant.exn.i;

    const agentBase = localUrl(issuerOobi.split("/agent")[0].split("/controller")[0]);
    const text = await (await fetch(`${agentBase}/indexer/${issuer}`)).text();
    const schemaBase = text.split('"url":"')[1]?.split('"')[0];
    if (!schemaBase) throw new Error("wallet stand-in: issuer publishes no indexer location; the real wallet would fail here too");
    // The phone's KERIA resolves the schema OOBI, not the phone, so the
    // docker-network form is the right one to hand over here.
    await resolveOobi(this.client, `${schemaBase}/oobi/${grant.exn.e.acdc.s}`);

    const [admit, sigs, end] = await this.client.ipex().admit({
      senderName: this.name, recipient: issuer, grantSaid: note.a.d, message: "", datetime: now(),
    });
    await waitOp(this.client, await this.client.ipex().submitAdmit(this.name, admit, sigs, end, [issuer]));

    const said = grant.exn.e.acdc.d;
    for (let i = 0; i < 60; i++) {
      if (await this.client.credentials().get(said).catch(() => undefined)) return said;
      await sleep(400);
    }
    throw new Error("wallet stand-in: admitted credential never appeared in the wallet");
  }

  async credentials(schemaSaid: string): Promise<any[]> {
    return this.client.credentials().list({ filter: { "-s": schemaSaid } });
  }

  /**
   * Hands a copy of one of our credentials to another wallet (an
   * unsolicited IPEX grant, which the other wallet admits). Afterwards
   * the other wallet can present a credential that was not issued to it.
   *
   * NOTE: a wallet cannot present a credential its own agent does not
   * hold; KERIA crashes if asked to (spike/05-keria-crash-repro.ts). So
   * the copy must genuinely be admitted first.
   */
  async giveCopyTo(other: WalletStandIn, credentialSaid: string, schemaOobi: string): Promise<void> {
    await resolveOobi(other.client, await agentOobi(this.client, this.name), this.displayName);
    await resolveOobi(this.client, await agentOobi(other.client, other.name), other.displayName);
    const cred = await this.client.credentials().get(credentialSaid);
    const [grant, sigs, end] = await this.client.ipex().grant({
      senderName: this.name, recipient: other.aid, datetime: now(),
      acdc: new signify.Serder(cred.sad), iss: new signify.Serder(cred.iss),
      anc: new signify.Serder(cred.anc), ancAttachment: cred.ancatc,
    });
    await waitOp(this.client, await this.client.ipex().submitGrant(this.name, grant, sigs, end, [other.aid]));

    const note = await other.waitForNotification("/exn/ipex/grant");
    await resolveOobi(other.client, schemaOobi);
    const [admit, aSigs, aEnd] = await other.client.ipex().admit({
      senderName: other.name, recipient: this.aid, grantSaid: note.a.d, message: "", datetime: now(),
    });
    await waitOp(other.client, await other.client.ipex().submitAdmit(other.name, admit, aSigs, aEnd, [this.aid]));
    for (let i = 0; i < 60; i++) {
      if (await other.client.credentials().get(credentialSaid).catch(() => undefined)) return;
      await sleep(400);
    }
    throw new Error("wallet stand-in: copied credential never appeared");
  }

  /**
   * keriaNotificationService.ts processExnIpexApplyNotification ->
   * ipexCommunicationService.ts createLinkedIpexMessageRecord: before the
   * request is even shown, the wallet resolves the requested schema via
   * the REQUESTER's indexer role; a requester without one makes the wallet
   * drop the request silently. Then offerAcdcFromApply and
   * grantAcdcFromAgree.
   */
  async present(credentialSaid: string): Promise<void> {
    const applyNote = await this.waitForNotification("/exn/ipex/apply");
    const apply = await this.client.exchanges().get(applyNote.a.d);
    const verifier = apply.exn.i;
    {
      const contact = await this.client.contacts().get(verifier);
      const agentBase = localUrl(String(contact.oobi).split("/agent")[0].split("/controller")[0]);
      const text = await (await fetch(`${agentBase}/indexer/${verifier}`)).text();
      const schemaBase = text.split('"url":"')[1]?.split('"')[0];
      if (!schemaBase) throw new Error("wallet stand-in: requester publishes no indexer location; the real wallet drops the request here");
      await resolveOobi(this.client, `${schemaBase}/oobi/${apply.exn.a.s}`);
    }
    const cred = await this.client.credentials().get(credentialSaid);

    const [offer, oSigs, oEnd] = await this.client.ipex().offer({
      senderName: this.name, recipient: verifier, acdc: new signify.Serder(cred.sad), applySaid: applyNote.a.d, datetime: now(),
    });
    await waitOp(this.client, await this.client.ipex().submitOffer(this.name, offer, oSigs, oEnd, [verifier]));

    const agreeNote = await this.waitForNotification("/exn/ipex/agree");
    const [grant, gSigs, gEnd] = await this.client.ipex().grant({
      senderName: this.name, recipient: verifier, agreeSaid: agreeNote.a.d, datetime: now(),
      acdc: new signify.Serder(cred.sad), iss: new signify.Serder(cred.iss),
      anc: new signify.Serder(cred.anc), ancAttachment: cred.ancatc,
    });
    await waitOp(this.client, await this.client.ipex().submitGrant(this.name, grant, gSigs, gEnd, [verifier]));
  }

  /**
   * keriaNotificationService.ts processRemoteSignReq + identifierService.ts
   * remoteSign. Returns what the phone would have shown the user. With
   * `approve: false` the request is left unanswered, as when the user
   * taps away.
   *
   * ADVERSARIAL option, never something the real wallet does:
   * `lieAboutSn` answers "signed at event <sn>" without signing anything.
   */
  async handleSignRequest(opts: { approve: boolean; lieAboutSn?: string }): Promise<{ shown: Record<string, unknown>; accepted: boolean }> {
    const note = await this.waitForNotification("/exn/remotesign/ixn/req");
    const req = await this.client.exchanges().get(note.a.d);
    const payload = { ...req.exn.a };

    // The wallet silently drops requests whose payload SAID is wrong.
    const [saider] = signify.Saider.saidify({ ...payload });
    if (!payload.d || saider.qb64 !== payload.d) return { shown: {}, accepted: false };

    const shown = { ...payload };
    delete (shown as any).d;
    if (!opts.approve) return { shown, accepted: false };

    let sn = opts.lieAboutSn;
    if (sn === undefined) {
      const ixn = await this.client.identifiers().interact(req.exn.rp, { d: payload.d });
      await waitOp(this.client, await ixn.op());
      sn = ixn.serder.ked.s as string;
    }
    const hab = await this.client.identifiers().get(this.name);
    const [ref, sigs, atc] = await this.client.exchanges().createExchangeMessage(
      hab, "/remotesign/ixn/ref", { sn }, {}, req.exn.i, undefined, note.a.d
    );
    await this.client.exchanges().sendFromEvents(this.name, "remotesign", ref, sigs, atc, [req.exn.i]);
    return { shown, accepted: true };
  }
}
