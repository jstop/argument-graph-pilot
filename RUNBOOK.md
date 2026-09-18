# RUNBOOK

Operator setup from zero, day-to-day, member revocation, and the key-loss
drills. Each drill below says **what was actually done, on what, and what
happened**, including the one that failed the first time. The drills
were run in **local mode** on macOS/Docker Desktop (arm64) on 2026-09-18
with Signify clients standing in for phones. **Cloud mode** was deployed
the same day (§1a). **No real phone has been run for this repo.**

Two modes, as in demo2. **Local**: one machine, plain HTTP; phones cannot
use it. **Cloud**: same containers behind Veridian's traefik file on a
public domain.

## 0. What you need

Linux box (Veridian's minimum: 4 vCPU, 8 GB, 20 GB) or a Mac for local
mode; Docker + compose v2, git, jq, curl, openssl; Node 20 and Python 3.12
only for tests and the verifier. Cloud: DNS A records for `keria`,
`keria-ext`, `keria-boot`, `witness-0`…`witness-5`, `issuer`, and the log
site (`claims` by default, `RP_SUBDOMAIN`) → the box; ports 80/443 open;
`sudo mkdir -p /var/lib/letsencrypt`. Close 3110/3120 to the outside.

## 1. From zero

```
git clone --recurse-submodules <repo> pilot && cd pilot     # infra/veridian @ ed015b1; do not edit it
./infra/stack.sh up                                          # MODE=cloud for cloud, after cp infra/env.cloud.example infra/env.cloud
cp infra/services.env.example infra/services.env             # then edit:
```
In `infra/services.env`: set `OPERATOR_TOKEN` (16+ characters; there is
no default and the issuer refuses to start without one:
`openssl rand -hex 16`). Cloud: also `PUBLIC_DOMAIN`, `ISSUER_PUBLIC_URL=
https://issuer.<domain>`, `RP_PUBLIC_URL=https://<RP_SUBDOMAIN>.<domain>`,
`WALLET_BOOT_URL=https://keria-boot.<domain>`, `WALLET_CONNECT_URL=
https://keria.<domain>`. `services.env`, `secrets.env` and `env.generated`
are git-ignored. **Commit none of them.**
```
./infra/services.sh up
```
This builds one image, starts the **issuer** (first start = inception
ceremony: passcode generated into the `arglog_issuer-data` volume as
`/data/issuer.bran`, identifier incepted with six witnesses threshold 4
and a pre-committed next key, `agent` and `indexer` roles, schema
location, registry `members`), pins the relying party to the issuer's AID
and OOBI in `services.env`, and starts the **relying party**, which
creates its own identifier and writes the **genesis record** through its
own gate. `curl localhost:3120/healthz` → `{"ok":true,…,"records":1}`.

**Back up now** (these two files and one line are all the secrets there
are; on the AWS box §1c does this nightly):
```
docker cp arglog-arglog-issuer-1:/data/issuer.bran <safe place>   # the issuer's keys, present and future
docker cp arglog-arglog-log-1:/data/operator.bran  <safe place>   # the log operator's keys
infra/secrets.env                                                  # KERIA_PASSCODE: losing it orphans every agent
```
plus the docker volumes `veridian-prod_keria-data`, `_keria-config`,
`_witnesses-config`, `arglog_rp-data` (the log).

Pages: operator `http://<box>:3110/` (user `operator`), the argument
`http://<box>:3120/`. If demo2's containers run on the same box they keep
3010/3020; ours are named `arglog-*` because docker DNS names on the
shared network collide otherwise (DESIGN.md).

Check the deployed processes end to end (stand-in phones):
```
OPERATOR_TOKEN=… npx tsx spike/12-drive-services.ts     # A claims, B attacks, 0.5000 → 0.2500, writes export.json
cd verifier && python -m arglog_verifier ../export.json --issuer <issuer AID>
```
Done on 2026-09-18: verifier exit 0, same authors, `1/4`.

## 1a. Cloud mode, as deployed on 2026-09-18

On demo2's existing box (AWS t3.large, Ubuntu 24.04, Docker 29,
`pilot.joshautomates.com`; demo2 RUNBOOK §9 for how it was made), whose
witnesses, KERIA and traefik were already running from demo2's identical
`stack.sh`; `stack.sh` was **not** re-run from this repo there. Steps:

1. rsync this repo to `~/arglog` (no secrets, no `infra/veridian`: the
   stack keeps running from `~/pilot`).
2. `infra/services.env` written on the box from the example with the
   five cloud URLs and a generated `OPERATOR_TOKEN`.
3. demo2's two service containers were **stopped** (`docker compose …
   stop` in `~/pilot`; containers, volumes, keys and its published claims
   are kept; `./infra/services.sh up` there brings them back, but both
   pilots claim `issuer.`, `claims.` and `keria-boot…/connect`, so only
   one can be up).
4. `./infra/services.sh up` in `~/arglog`.

Checked from a laptop over the internet: `https://claims.<domain>/healthz`
ok with the genesis record; `https://issuer.<domain>/` answers 401 without
the token; `https://keria-boot.<domain>/connect` answers with the connect
URL; the schema is served; ports 3110/3120 are closed from outside. Then
`PILOT_DOMAIN=… OPERATOR_TOKEN=… npx tsx spike/12-drive-services.ts`
(stand-in phones, through the public KERIA): 0.5000 → 0.2500, and the
downloaded export verified on the laptop, exit 0, `1/4`. Those two
stand-in members ("Ana", "Bo") and their two entries are now permanently
in the deployed log; `./infra/services.sh wipe` then `up` starts a clean
one under a **new** issuer identifier.

Seen on the box: `docker compose build` of both services at once fails
with `image "arglog-pilot:local": already exists` (no buildx on Ubuntu's
docker.io); the image is built anyway and `services.sh up`, which builds
one service at a time, is unaffected.

## 1b. GitHub, CI and deploys

Repository: `github.com/jstop/argument-graph-pilot`, **private**. Set up
and exercised on 2026-09-18.

**CI (`.github/workflows/ci.yml`)**, actions pinned by commit:
- `fast`, every push and pull request (~2 min): secret scan over files
  **and history** (`ops/secret-scan.sh`; it caught a planted token when
  tested), types, both DF-QuAD implementations against the shared
  vectors, the verifier against the recorded real log, page scripts.
  `personal/` needs the owner's Episteme code, which is not in this
  repo: its tests **skip in CI and say so**; they run on the owner's
  machine. `make check` runs the same locally.
- `live`, on main, nightly (07:17 UTC) and on demand: brings up
  Veridian's real compose stack in the runner (`infra/stack.sh up`) and
  runs the issuer and end-to-end suites, including the Python verifier
  reproducing every number. Nightly is there to notice upstream drift
  (images are digest-pinned, so drift should be rare; a failure means
  something outside the pins moved).
- Dependabot weekly for actions, npm and pip. **Not** for signify-ts
  (vendored at the wallet's commit) or the Veridian images (digests in
  `infra/`): those move only when the wallet moves, by hand.

**Deploy (`.github/workflows/deploy.yml`)**: only when the owner starts
it, and starting it is the approval:
```
gh workflow run deploy -f confirm=deploy        # or Actions → deploy → Run workflow
gh run watch
```
It refuses unless `fast` **and** `live` succeeded for exactly that
commit of main. GitHub's "required reviewers" and branch protection were
both tried and **refused for a private repository on this plan** (HTTP
422 / 403: needs Pro, or a public repository). Consequence: nothing
stops a direct push to main; CI still runs on it, and nothing reaches
the box without the owner starting a deploy.

**GitHub holds no credential for the box.** The first design gave
Actions an SSH key restricted to one forced command; its first run
failed with `connect to host … port 22: Connection timed out`, because
the box's firewall allows SSH only from the operator's address (demo2
RUNBOOK §9). Rather than open SSH to GitHub's address ranges, the
direction was reversed; the key, the secret and the `authorized_keys`
line were removed.

- The deploy workflow, after checking CI, only **moves the `production`
  tag** to the commit (that is all its `contents: write` is for), then
  waits until the public `/healthz` reports `"commit": "<that sha>"`
  (15 minutes, then it fails and says to look at the box).
- **The box pulls.** `~/arglog-deploy-poll.sh` (source:
  `ops/box/deploy-poll.sh`; installed by hand, outside the checkout, so
  a commit cannot rewrite what decides to deploy it) runs from cron
  every minute. With the box's **own read-only** deploy key (made on the
  box, never left it; a push with it is refused) it fetches `main` and
  the tag; if the tag names a commit that is on `origin/main` and is
  not what runs, it checks it out and runs `ops/deploy-remote.sh`. A
  commit that failed is not retried until the tag moves. Log:
  `~/arglog-deploy.log`; state: `~/.arglog-deploy/`.
- Who can deploy, then: whoever can move a tag in the repository, i.e.
  the owner and this one workflow. The same trust as `main` itself.

**What a deploy does (`ops/deploy-remote.sh`, on the box):** tags the
running image `:previous`, rebuilds, restarts both services, then
requires: both healthy; the issuer is **the same identifier** as before;
the log did **not shrink** and the previous head is still in it. Any
failure → the previous image is put back. It never touches volumes,
`services.env`, KERIA or the witnesses.

**Stop all automatic deploys:** `crontab -r` on the box (or delete the
`production` tag). **Deploy by hand instead:** on the box, `cd ~/arglog
&& git fetch && git checkout <sha> && ./ops/deploy-remote.sh`.

**Not under this control:** the box itself (made by hand, demo2 RUNBOOK
§9; no Terraform), DNS, the witnesses/KERIA stack (still started by
`stack.sh` from `~/pilot` on the box), backups of the three secrets and
the volumes (§1), monitoring or alerting (none), and demo2.

## 1c. AWS: what is defined, backed up, watched, and how to get in (done 2026-09-18)

**Defined in Terraform** (`infra/aws/`, state in a private, versioned,
encrypted bucket with S3 locking; the bucket itself was made once by
hand with the CLI): the box, its firewall, its elastic IP and the eleven
DNS records were **imported** from what demo2 made by hand (15 imports,
nothing replaced; `prevent_destroy` on the box, the address and the
backup bucket). Added: the box's role, the backup bucket, nightly
snapshots, health checks, alarms, the alert topic.
```
cd infra/aws && terraform init && terraform plan
```
Provider is pinned `~> 5.80`, the same major version as the owner's
Episteme Terraform.

**Getting onto the box: AWS Session Manager. Port 22 is closed** (applied
and tested: SSH times out). No key file on any one laptop is needed; access
follows the AWS login. `aws ssm start-session --target <instance>` (needs
the Session Manager plugin; AWS CloudShell in a browser has it, which
works from a phone), or one-off commands with `aws ssm send-command`.
To reopen SSH in an emergency: `terraform apply -var ssh_cidr=<your
ip>/32`. The agent had to be restarted once to notice the new role.

**Backups, two independent kinds:**
- *Whole-disk snapshots*, nightly 08:30 UTC, 14 kept (AWS Data Lifecycle
  Manager, anything tagged `Snapshots=nightly`).
- *File-level*, nightly 08:40 UTC, to `s3://arglog-pilot-backups-<acct>/
  box/<time>/`, 35 days: `~/arglog-backup.sh` (source `ops/box/
  backup.sh`) archives the seven docker volumes (KERIA's databases =
  every member's identifier; the witnesses' keystores; issuer and log
  data **including both passcode files and the log**; demo2's volumes),
  the env files with KERIA's passcode and the operator token, and
  traefik's certificate store. Containers are **paused** for the copy
  (measured: 5 s) so LMDB is captured crash-consistently, and always
  unpaused. The box's role can only **put** there; tested: it cannot
  list or read earlier backups. **The bucket holds the issuer's keys.**
  Whoever can read it can be the issuer. Today that is the account's
  IAM users; it is server-side encrypted, not client-side.

**Restore, drilled for real:**
- *From S3:* downloaded off-box, 8 of 8 checksums good, `issuer.bran`,
  `operator.bran`, `log.jsonl`, `secrets.env` present; the restored
  log's hash chain was intact and its head equalled the head recorded
  at backup time.
- *From a snapshot onto a fresh instance:* snapshot → new instance with
  no inbound access → reached over Session Manager. **Finding:** an
  Ubuntu instance given the snapshot as a *second* disk boots **from
  it** (same filesystem label), so the whole pilot came up by itself on
  the new instance: 9 containers, the same operator identifier, the same
  issuer identifier, the same log head as production. That is the
  restore working end to end, and it is also a hazard: for about five
  minutes a second copy of every identifier was alive (no inbound; it
  only reads from the real box through public DNS). Its cron was
  removed, containers stopped, instance terminated. **To only inspect
  a snapshot, attach it to an instance that is already running.**
- **Disaster procedure that follows** (not executed, because it moves
  production): launch an instance from the latest snapshot with the
  box's role and firewall, stop the old box, move the elastic IP
  (`aws ec2 associate-address`), `terraform import` the new instance.
  DNS, witness URLs and certificates all follow the address. Expect to
  lose what happened since the snapshot: at most a day of log entries
  and enrolments; the file-level backup may be newer for the log.

**Watched, from outside:** HTTPS checks every 30 s on the argument site,
the issuer, KERIA and one witness; alarms for those, for the root disk
over 80 % (the box reports it every 5 minutes) and for **no successful
backup in 26 hours**, all to the SNS topic `arglog-pilot-alerts`.
**Nobody is subscribed yet**: set `alert_email` and/or `alert_sms` and
apply, then confirm the email. Until then the alarms change colour in the
console and tell no one.

**Seen while here:** unattended security upgrades are on; the box says a
**reboot is required** for a pending update. Not done: it restarts every
service and nobody has tested that everything comes back on this box
(the snapshot drill suggests it does).

## 2. Day-to-day

- **Enrol a member**: operator page → handle → QR → member scans
  (wallet: Home → Add connection → Scan) → accepts. Status runs
  `waiting-for-scan → issuing → granted → admitted`. First-time wallets
  need the onboarding QR first (operator page, collapsed line at the
  top). Then hand them TESTER.md.
- **Logs**: `./infra/services.sh logs`; KERIA: `docker logs
  veridian-prod-keria-1`. Every gate decision: `/decisions`.
- **Stop/start** keeps everything: `./infra/services.sh down|up`,
  `./infra/stack.sh down|up`. `wipe` deletes identifiers, keys and the log.
- **Tests** (stack up, local): `npm install && npm test`;
  `cd verifier && pip install -r requirements.txt && python -m pytest -q`.
  The end-to-end test runs the verifier if `VERIFIER_PYTHON` points at an
  interpreter with keripy; otherwise that one test reports itself skipped
  and says the verifier was not exercised.

## 3. Revoke a member — drilled

```
docker compose --env-file infra/services.env -f infra/compose.services.yaml \
  exec arglog-issuer npx tsx issuer/src/main.ts revoke <credential SAID>      # SAIDs: operator page, or GET /api/members
```
What it does: reads the log head from the relying party (`LOG_URL/log/
head`), **seals that head in the issuer's key event log**, then revokes
(next issuer event). If it cannot read the head it refuses and anchors
nothing. `--no-checkpoint` overrides that and costs the member's
un-checkpointed history (DESIGN.md D6); do not use it casually.

Drilled (`spike/13-revocation-drill.ts`, against the containers, after a
key rotation): member posts → accepted; CLI printed `checkpoint: log head
… (entry 3) anchored at issuer event 7`, `revoked … at issuer event 8`;
the member's next entry, really signed, was rejected `at check standing`;
claim strength unchanged; the export verified independently with
`standing: revoked at issuer event #8; this entry (#3) is inside the log
head #3 the issuer sealed before revoking`. The site picks up revocations
made elsewhere within about 30 s for display, and at once for any
decision.

`main.ts checkpoint` seals the current head without revoking anything.
Nothing does this on a schedule.

## 4. Key drills

### 4.1 Signing key leaked → rotate — drilled, worked
```
… exec arglog-issuer npx tsx issuer/src/main.ts status
… exec arglog-issuer npx tsx issuer/src/main.ts rotate
```
Result: `rotated: event 4 -> 5`; next-key digest changed; members issued
before still verified, a new member was enrolled and revoked after it,
and the verifier replayed the issuer's log `#0..#8` across the rotation.
**What this does not answer:** both keys derive from `issuer.bran`.
Rotation answers a leaked *signing key*, not a leaked or lost passcode
file (same as demo2).

### 4.2 Issuer box lost, passcode file and KERIA volume survive — drilled; FAILED first, fixed, then worked
Done: copied `issuer.bran` out, destroyed the issuer container **and**
its data volume, created an empty volume containing only `issuer.bran`
(owner uid 1000, mode 600), started the issuer against the same KERIA.

First attempt **failed**: the issuer crash-looped with
`HTTP POST /identifiers/issuer/locschemes - 400 … "unable to verify end
role reply message"`. Cause (spike/14): this KERIA/signify pair refuses
to publish a location whenever the identifier's latest key event is an
interaction event, and the issuer, having lost its local note that the
location was already published, tried again. Fix: both services now ask
KERIA what is published and skip if unchanged. Second attempt: same AID,
same registry, all members listed with correct `iss`/`rev` status. (Not
done on the restored issuer: issuing a new credential from it. The test
suites, which passed after the fix, use their own issuer instances.)

**Not drilled:** restoring onto a *different host* (moving the KERIA and
witness volumes). The issuer's identifier, registry and issued
credentials live in KERIA's volume, encrypted to keys derived from
`issuer.bran`; the file alone, without that volume, restores nothing.
**If you must change `ISSUER_PUBLIC_URL` on restore**, rotate first
(`main.ts rotate`), then start with the new URL; the error message says
this too.

### 4.3 Member restores their wallet from the recovery phrase — drilled in stand-in form only
The wallet turns the phrase back into its passcode and **connects** to
the agent that already exists in this KERIA (no boot; needs only the
connect URL and the phrase; `agent.ts recoverKeriaAgent`).
`spike/15-wallet-recovery-standin.ts` does the same with a Signify
client: same identifier after recovery, the recovered client's next
event was accepted and witnessed, a wrong passcode was refused (`agent
does not exist`). **A real phone restoring from its written phrase
against this KERIA has not been done** and must be before enrolling
anyone real. It can only work while this KERIA's volume exists: lose
the KERIA volume or `KERIA_PASSCODE` and every member's identifier is
gone, phrase or not.

### 4.4 Issuer passcode gone for good — drilled
There is no recovery: the pre-committed next key derives from the same
lost file. Done, on the test stack: exported the existing log; destroyed
the issuer container and volume **without** a backup; started the issuer
→ a **new** identifier (`EAwNv9k…` ≠ `ENDFGb_…`); re-pinned the relying
party (`TRUSTED_ISSUER_AID/OOBI` in `services.env`).

- **The existing log**: the relying party **refused to start on it**:
  `the log on disk belongs to a different operator or issuer than the
  one configured; refusing to continue it`. A log names its one issuer
  in its genesis record; it cannot be continued under another. Moved
  `log.jsonl` and `decisions.jsonl` aside inside the volume (kept, not
  deleted); on restart the relying party wrote a **new genesis** naming
  the new issuer. The archived export **still verifies** under the old
  issuer AID (done: exit 0, 3 of 3 entries valid). It is a closed,
  checkable record; nobody can add to it or revoke within it any more.
- **Re-issuance**: every member scans a new operator QR and gets a new
  credential; their identifier and phone are unchanged. Old credentials
  are rejected at presentation ("not from the community issuer") — by
  code path, not separately drilled.
- **Re-pinning the trusted issuer**: `services.env` for the relying
  party; and **everyone who verifies** must be told the new issuer AID
  out of band (`--issuer`). That step is social and is the real cost.
- **Not possible**: revoking old credentials (the old registry is
  orphaned), carrying strengths or targets across logs.

So: keep `issuer.bran` like a CA key, in two places.

## 5. Things that break, and what they look like

Everything in demo2's RUNBOOK §8 still applies (KERIA 500 on boot;
"Misconfigured cloud agent" and the frozen per-agent config repair;
phone never shows the credential request → indexer role/`RP_PUBLIC_URL`;
"schema not found"; KERIA restarts after a bad IPEX grant; 400 Invalid
JSON on non-ASCII; traefik default certificate on Docker 29). New:

- **Relying party stuck at `{"ok":false}`, log says `could not resolve
  OOBI http://…/oobi/<schema>… timed out`**: KERIA cannot reach the
  relying party under the name in `RP_PUBLIC_URL`. Seen when demo2's
  `relying-party` container on the same network answered for that name.
- **Issuer or relying party exits with `could not publish location … Rotate
  the identifier's key, then start again`**: you changed a public URL
  after the identifier had interaction events (§4.2).
- **Relying party exits with `log file … is damaged … Refusing to start
  on it`**: `log.jsonl` no longer hash-chains. Restore it from a backup
  or an export (`.log` of `/export.json` is the same records, one JSON
  array instead of lines). It will not repair or skip records.
- **`refusing to revoke: … Nothing was anchored or revoked`**: the
  issuer could not read `LOG_URL/log/head`. Fix the relying party first.

## 6. Not done

- Any real phone, for this repo.
- A phone-side recovery drill (§4.3); a cross-host restore (§4.2).
- Backups beyond "copy two passcode files, `secrets.env`, the volumes".
- Alert subscribers (§1c); the pending reboot; the disaster procedure executed for real; scheduled checkpoints; client-side encryption of backups; the witness/KERIA stack run from this repo instead of demo2's directory.
