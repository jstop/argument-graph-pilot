#!/usr/bin/env bash
# Starts the issuer and the relying party as containers next to
# Veridian's stack (infra/compose.services.yaml).
#   ./services.sh up | down | logs | status | wipe
# The relying party must be pinned to the issuer's AID. On first `up`
# this script starts the issuer, reads its AID and OOBI, writes them into
# services.env if they are empty, then starts the relying party.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="$HERE/services.env"
[ -f "$ENV" ] || { echo "copy $HERE/services.env.example to $ENV and edit it" >&2; exit 2; }
dc() { docker compose --env-file "$ENV" -f "$HERE/compose.services.yaml" "$@"; }
token() { grep -E '^OPERATOR_TOKEN=' "$ENV" | cut -d= -f2-; }

case "${1:-}" in
  up)
    dc up -d --build arglog-issuer
    echo "waiting for the issuer (first start performs the inception ceremony)..."
    for _ in $(seq 1 60); do
      out="$(curl -sf -u "operator:$(token)" http://127.0.0.1:3110/api/issuer 2>/dev/null || true)"
      [ -n "$(echo "$out" | jq -r '.oobi // empty' 2>/dev/null)" ] && break; out=""; sleep 2
    done
    [ -n "$out" ] || { echo "issuer did not come up; see: $0 logs" >&2; exit 1; }
    aid="$(echo "$out" | jq -r .aid)"; oobi="$(echo "$out" | jq -r .oobi)"
    if grep -Eq '^TRUSTED_ISSUER_AID=\s*$' "$ENV"; then
      sed -i.bak "s|^TRUSTED_ISSUER_AID=.*|TRUSTED_ISSUER_AID=$aid|; s|^TRUSTED_ISSUER_OOBI=.*|TRUSTED_ISSUER_OOBI=$oobi|" "$ENV" && rm -f "$ENV.bak"
      echo "pinned relying party to issuer $aid"
    fi
    dc up -d --build arglog-log
    for _ in $(seq 1 60); do curl -sf http://127.0.0.1:3120/healthz >/dev/null 2>&1 && break; sleep 2; done
    "$0" status ;;
  status)
    dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Ports}}'
    curl -s http://127.0.0.1:3110/healthz; echo
    curl -s http://127.0.0.1:3120/healthz; echo ;;
  logs) dc logs -f --tail 50 ;;
  down) dc down ;;
  wipe) dc down -v ;;
  *) sed -n '2,7p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
