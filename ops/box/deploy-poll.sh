#!/usr/bin/env bash
# Installed ONCE on the box as /home/ubuntu/arglog-deploy-poll.sh and run
# every minute by cron. The box has no inbound path from GitHub (its SSH is
# firewalled to the operator) and GitHub holds no credential for it.
# Instead the box PULLS, with its own read-only key: when the `production`
# tag names a commit that is on origin/main and is not what is running, it
# checks that commit out and runs the repo's ops/deploy-remote.sh, which
# health-checks and rolls back by itself. A commit that failed is not
# retried until the tag moves again. This file lives outside the checkout
# so that a commit cannot rewrite the thing that decides to deploy it.
set -euo pipefail
REPO=/home/ubuntu/arglog
STATE=/home/ubuntu/.arglog-deploy
mkdir -p "$STATE"
exec 9>"$STATE/lock"; flock -n 9 || exit 0
cd "$REPO"
git fetch --quiet --force origin main 'refs/tags/production:refs/tags/production' 2>/dev/null || exit 0   # no tag yet, or GitHub unreachable
want="$(git rev-parse -q --verify 'refs/tags/production^{commit}')" || exit 0
[ "$want" != "$(cat "$STATE/deployed" 2>/dev/null)" ] || exit 0
[ "$want" != "$(cat "$STATE/failed" 2>/dev/null)" ] || exit 0
echo "== $(date -u +%FT%TZ) production -> $want"
if ! git merge-base --is-ancestor "$want" origin/main; then
  echo "refusing: $want is not on origin/main"; echo "$want" > "$STATE/failed"; exit 0
fi
git checkout --quiet --detach "$want"
if DEPLOYED_COMMIT="$want" ./ops/deploy-remote.sh; then
  echo "$want" > "$STATE/deployed"; rm -f "$STATE/failed"
else
  echo "$want" > "$STATE/failed"
  prev="$(cat "$STATE/deployed" 2>/dev/null || true)"; [ -z "$prev" ] || git checkout --quiet --detach "$prev"
fi
