#!/usr/bin/env bash
# Fails if anything that must never be committed is tracked, now or (with
# --history) in any commit. No third-party service; patterns are the ones
# this project can actually leak. demo2 tracked a recovery phrase and a
# fallback operator token; this is the guard against a repeat.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bad=0
say() { echo "SECRET-SCAN: $*" >&2; bad=1; }

names='(^|/)(secrets\.env|services\.env|env\.generated|env\.cloud|.*\.bran|recovery_phrase.*|.*\.pem|id_(rsa|ed25519)[^/]*)$'
content='BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|(OPERATOR_TOKEN|KERIA_PASSCODE)[[:space:]]*=[[:space:]]*[A-Za-z0-9_/+=-]{12,}'
allow='test-operator-token-0123456789|CHANGEME|\$\(|openssl rand|<|\.\.\.|…'

tracked="$(git ls-files | grep -E "$names" || true)"
[ -z "$tracked" ] || say "tracked file(s) that must never be committed: $tracked"
hits="$(git grep -nIE "$content" -- . ':!ops/secret-scan.sh' | grep -vE "$allow" || true)"
[ -z "$hits" ] || { say "secret-looking content:"; echo "$hits" >&2; }

if [ "${1:-}" = "--history" ]; then
  files="$(git log --all --name-only --format= | sort -u | grep -E "$names" || true)"
  [ -z "$files" ] || { say "a commit in history contains: $files"; }
  old="$(git log --all -p --format='commit %h' | grep -E "^\+.*($content)" | grep -vE "$allow|secret-scan" || true)"
  [ -z "$old" ] || { say "secret-looking content in history:"; echo "$old" | head -20 >&2; }
fi
[ "$bad" = 0 ] && echo "secret-scan: clean${1:+ (including history)}"
exit "$bad"
