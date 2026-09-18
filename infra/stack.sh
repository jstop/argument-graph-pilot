#!/usr/bin/env bash
# Drives Veridian's own self-deployment compose files (infra/veridian,
# pinned submodule) with our env and image pins. Nothing in the
# submodule is modified.
#
#   ./stack.sh up       witnesses -> KERIA, following docs.veridian.id/selfdeployment
#   ./stack.sh status   containers + witness AIDs
#   ./stack.sh down     stop containers, keep data
#   ./stack.sh wipe     stop and DELETE all witness/KERIA data volumes
#
# MODE=local (default) uses env.local and plain HTTP on localhost.
# MODE=cloud uses env.cloud and Veridian's traefik compose (see RUNBOOK.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${MODE:-local}"
ENV_FILE="$HERE/env.$MODE"
GEN_FILE="$HERE/env.generated"
SECRETS_FILE="$HERE/secrets.env"
WITNESS_COUNT=6

case "$MODE" in
  local) COMPOSE_FILE=docker-compose.production.local.yaml ;;
  cloud) COMPOSE_FILE=docker-compose.production.traefik.yaml ;;
  *) echo "MODE must be local or cloud" >&2; exit 2 ;;
esac
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 2; }
[ -f "$HERE/veridian/$COMPOSE_FILE" ] || {
  echo "submodule missing: run 'git submodule update --init'" >&2; exit 2; }

# Refuse to run if anyone has switched on the Cardano backer.
if grep -Eq '^\s*WITNESS_TYPE\s*=\s*cardano' "$ENV_FILE"; then
  echo "WITNESS_TYPE=cardano is a non-goal of this pilot; refusing." >&2; exit 2
fi

touch "$GEN_FILE"

# KERIA's own passcode. keripy needs >= 21 base64url characters; with
# Veridian's placeholder ("CHANGEME") KERIA starts, looks healthy, and
# then answers every agent boot with a bare HTTP 500.
if [ ! -f "$SECRETS_FILE" ]; then
  (umask 077; echo "KERIA_PASSCODE=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | cut -c1-21)" > "$SECRETS_FILE")
  echo "generated $SECRETS_FILE (keep it; losing it orphans every agent in this KERIA)"
fi
# Veridian's compose mounts \$PWD/docker-assets, so it must run from the submodule.
cd "$HERE/veridian"
dc() {
  docker compose --env-file "$ENV_FILE" --env-file "$GEN_FILE" --env-file "$SECRETS_FILE" \
    -f "$COMPOSE_FILE" -f "$HERE/compose.pins.yaml" "$@"
}

witness_aid() {
  # awk must read to EOF: an early exit gives docker SIGPIPE, and with
  # pipefail that kills the script (seen on Linux, not on macOS).
  docker exec "veridian-prod-witness-$1-1" kli status --name "wit$1" --alias "wit$1" \
    2>/dev/null | awk '/Identifier/ && !found {print $2; found=1}'
}

witness_url() { # how KERIA and the outside world reach witness $1
  if [ "$MODE" = local ]; then echo "http://witness-$1:$((5642 + $1))"
  else
    # shellcheck disable=SC1090
    (set -a; . "$ENV_FILE"; echo "https://witness-$1.$PUBLIC_DOMAIN")
  fi
}

wait_http() { # url, tries
  for _ in $(seq 1 "${2:-30}"); do curl -sf -o /dev/null "$1" && return 0; sleep 2; done
  echo "timed out waiting for $1" >&2; return 1
}

cmd_up() {
  echo "== 1/4 witness-init (idempotent)"
  dc --profile witness-init up witness-init >/dev/null 2>&1 || {
    echo "witness-init failed; rerun with: docker logs veridian-prod-witness-init-1" >&2; exit 1; }

  echo "== 2/4 witnesses (and traefik in cloud mode, so certificates are issued first)"
  if [ "$MODE" = local ]; then dc --profile witness up -d
  else dc --profile witness --profile traefik up -d; fi
  local iurls=""
  for n in $(seq 0 $((WITNESS_COUNT - 1))); do
    local aid=""
    for _ in $(seq 1 30); do aid="$(witness_aid "$n")"; [ -n "$aid" ] && break; sleep 1; done
    [ -n "$aid" ] || { echo "witness-$n has no AID" >&2; exit 1; }
    # "?role=witness" is required: the wallet only treats configured OOBIs
    # carrying it as witnesses, and refuses to create identifiers without six.
    iurls="$iurls $(witness_url "$n")/oobi/$aid/controller?role=witness"
  done
  echo "KERIA_IURLS=\"${iurls# }\"" > "$GEN_FILE"

  echo "== 3/4 keria-init"
  dc --profile keria-init up keria-init >/dev/null 2>&1

  echo "== 4/4 KERIA (and traefik in cloud mode)"
  if [ "$MODE" = local ]; then
    dc --profile keria up -d keria
    wait_http http://127.0.0.1:3902/spec.yaml
  else
    dc --profile keria up -d keria
    # shellcheck disable=SC1090
    wait_http "https://$(set -a; . "$ENV_FILE"; echo "$KERIA_EXT_HOST")/spec.yaml" 60
  fi
  cmd_status
}

cmd_status() {
  dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Ports}}'
  echo
  for n in $(seq 0 $((WITNESS_COUNT - 1))); do
    echo "witness-$n  $(witness_aid "$n")  $(witness_url "$n")"
  done
}

case "${1:-}" in
  up) cmd_up ;;
  status) cmd_status ;;
  down) dc --profile witness --profile keria --profile traefik down ;;
  wipe) dc --profile witness --profile keria --profile traefik --profile witness-init --profile keria-init down -v ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
