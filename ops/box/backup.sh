#!/usr/bin/env bash
# Nightly file-level backup of everything on the box that cannot be
# recreated: KERIA's databases (EVERY member's identifier lives there), the
# witnesses' keystores, the issuer's and the log operator's passcodes and
# data (the log itself), and the env files with KERIA's passcode and the
# operator token. Installed as /home/ubuntu/arglog-backup.sh, run by cron.
#
# Containers writing to a volume are PAUSED (frozen, not stopped) for the few
# seconds the copy takes, so LMDB files are captured as a crash-consistent
# image, which LMDB is built to open. They are always unpaused, even on error.
# Upload goes to s3://$BUCKET/box/<UTC date>/ with the box's instance role,
# which can only PUT there: it cannot read or delete earlier backups.
# The backup contains secrets. Whoever can read the bucket holds the issuer.
set -euo pipefail
BUCKET="${BUCKET:?set BUCKET (terraform output backup_bucket)}"
VOLUMES="veridian-prod_keria-data veridian-prod_keria-config veridian-prod_witnesses-config arglog_issuer-data arglog_rp-data pilot_issuer-data pilot_rp-data"
FILES="/home/ubuntu/pilot/infra/secrets.env /home/ubuntu/pilot/infra/env.generated /home/ubuntu/pilot/infra/env.cloud /home/ubuntu/pilot/infra/services.env /home/ubuntu/arglog/infra/services.env"
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
WORK="$(mktemp -d /home/ubuntu/.backup-XXXXXX)"; chmod 700 "$WORK"
paused=""
cleanup() { [ -z "$paused" ] || docker unpause $paused >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "== $STAMP backup starting"
running="$(docker ps --format '{{.Names}}' | grep -E '^(veridian-prod-(keria|witness-[0-9])-1|arglog-arglog-(issuer|log)-1|pilot-(issuer|relying-party)-1)$' || true)"
[ -z "$running" ] || { docker pause $running >/dev/null; paused="$running"; }
t0=$(date +%s)
for v in $VOLUMES; do
  docker volume inspect "$v" >/dev/null 2>&1 || { echo "   (no volume $v)"; continue; }
  docker run --rm -v "$v":/v:ro -v "$WORK":/out alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc tar -C /v -czf "/out/$v.tgz" .
done
[ -z "$paused" ] || { docker unpause $paused >/dev/null; paused=""; }
echo "   services were frozen for $(( $(date +%s) - t0 )) s"
tar -czf "$WORK/env-files.tgz" --ignore-failed-read $FILES 2>/dev/null || true
# traefik's certificate store: the certificates AND the ACME account key. Without it a restored box must re-issue
# eleven certificates at once and can hit Let's Encrypt's rate limits. Root-only, hence sudo.
sudo tar -czf "$WORK/letsencrypt.tgz" -C /var/lib letsencrypt && sudo chown "$(id -u):$(id -g)" "$WORK/letsencrypt.tgz"
( cd "$WORK" && sha256sum *.tgz > SHA256SUMS )
curl -sf -m 10 http://127.0.0.1:3120/log/head > "$WORK/log-head.json" || echo '{}' > "$WORK/log-head.json"

for f in "$WORK"/*; do aws s3 cp --only-show-errors --sse AES256 "$f" "s3://$BUCKET/box/$STAMP/$(basename "$f")"; done
aws cloudwatch put-metric-data --namespace ArglogPilot --metric-name BackupSucceeded --value 1
echo "   uploaded $(ls "$WORK" | wc -l) objects, $(du -sh "$WORK" | cut -f1), to s3://$BUCKET/box/$STAMP/"
