#!/usr/bin/env bash
# Installed ONCE on the box as /home/ubuntu/arglog-deploy-gate.sh and named
# as the forced command of the CI deploy key in authorized_keys:
#   command="/home/ubuntu/arglog-deploy-gate.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 ...
# So the key GitHub holds can do exactly one thing: ask this box to deploy
# a commit that is already on origin/main of the repo this box pulls from
# with its own READ-ONLY deploy key. It cannot run a shell, copy files, or
# deploy code that is not on main. This file is deliberately outside the
# checkout: a commit cannot rewrite the gate it passes through.
set -euo pipefail
REPO=/home/ubuntu/arglog
sha="${SSH_ORIGINAL_COMMAND:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "gate: expected a 40-character commit id, nothing else" >&2; exit 2; }
exec 9>"$REPO/.deploy.lock"; flock -n 9 || { echo "gate: another deploy is running" >&2; exit 3; }
cd "$REPO"
git fetch --quiet origin main
git merge-base --is-ancestor "$sha" origin/main || { echo "gate: $sha is not on origin/main; refusing" >&2; exit 4; }
echo "gate: deploying $sha ($(git log -1 --format=%s "$sha"))"
git checkout --quiet --detach "$sha"
exec ./ops/deploy-remote.sh
