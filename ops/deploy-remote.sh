#!/usr/bin/env bash
# Runs ON THE BOX, from the repo checkout, after the gate has checked out
# the commit to deploy. Rebuilds and restarts the two services, then holds
# them to three conditions; if any fails, the previous image goes back.
#   1 both services answer healthy
#   2 the issuer is still the SAME identifier (a new one means its volume or passcode was lost)
#   3 the log did not shrink, and the old head is still in it (append-only means append-only)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV=infra/services.env
[ -f "$ENV" ] || { echo "deploy: $ENV is missing on this box (RUNBOOK §1); refusing" >&2; exit 2; }
dc() { docker compose --env-file "$ENV" -f infra/compose.services.yaml "$@"; }
IMAGE=arglog-pilot:local
export DEPLOYED_COMMIT="${DEPLOYED_COMMIT:-$(git rev-parse HEAD)}"     # shown at /healthz so the outside can see what runs
issuer_aid() { curl -sf -m 10 http://127.0.0.1:3110/healthz | jq -r '.issuer // empty'; }
head_json()  { curl -sf -m 10 http://127.0.0.1:3120/log/head; }

before_aid="$(issuer_aid || true)"; before_head="$(head_json || true)"
[ -n "$before_head" ] || before_head='{}'     # NOT ${before_head:-{}}: bash ends that expansion at the first } and appends the second
before_n="$(echo "$before_head" | jq -r '.n // -1')"; before_d="$(echo "$before_head" | jq -r '.d // empty')"
echo "deploy: commit $(git rev-parse --short HEAD); before: issuer=${before_aid:-none} log head #$before_n"

docker image inspect "$IMAGE" >/dev/null 2>&1 && docker tag "$IMAGE" arglog-pilot:previous
# one service at a time: without buildx, building both at once fails with "image already exists" (RUNBOOK §1a)
dc build arglog-issuer
dc up -d arglog-issuer arglog-log

check() {
  for _ in $(seq 1 60); do
    a="$(issuer_aid || true)"; h="$(head_json || true)"
    [ -n "$a" ] && [ -n "$h" ] && curl -sf -m 10 http://127.0.0.1:3120/healthz | jq -e '.ok == true' >/dev/null && break
    sleep 3
  done
  [ -n "${a:-}" ] && [ -n "${h:-}" ] || { echo "deploy: services did not become healthy" >&2; return 1; }
  [ -z "$before_aid" ] || [ "$a" = "$before_aid" ] || { echo "deploy: ISSUER IDENTIFIER CHANGED ($before_aid -> $a)" >&2; return 1; }
  n="$(echo "$h" | jq -r .n)"
  [ "$n" -ge "$before_n" ] || { echo "deploy: THE LOG SHRANK (#$before_n -> #$n)" >&2; return 1; }
  [ -z "$before_d" ] || curl -sf -m 20 http://127.0.0.1:3120/log.json | jq -e --arg d "$before_d" 'any(.[]; .d == $d)' >/dev/null \
    || { echo "deploy: the previous head $before_d is no longer in the log" >&2; return 1; }
  echo "deploy: healthy; issuer unchanged; log head #$n (was #$before_n)"
}

if ! check; then
  echo "deploy: ROLLING BACK to the previous image" >&2
  dc logs --tail 40 >&2 || true
  if docker image inspect arglog-pilot:previous >/dev/null 2>&1; then
    docker tag arglog-pilot:previous "$IMAGE"
    DEPLOYED_COMMIT="$(cat /home/ubuntu/.arglog-deploy/deployed 2>/dev/null || echo rolled-back)" dc up -d --no-build --force-recreate arglog-issuer arglog-log
    check && echo "deploy: rolled back; the previous version is serving" >&2 || echo "deploy: ROLLBACK DID NOT RECOVER; the box needs a person (RUNBOOK §5)" >&2
  fi
  exit 1
fi
