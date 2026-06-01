#!/usr/bin/env bash
# Drill into a formula run for the TUI peek pane: show the run's bead (formula,
# status, owner, description), then its code diff. Read-only.
#   peek-run.sh <cityRoot> <city> <baseUrl> <runId>
set -uo pipefail
root="${1:?cityRoot}"; city="${2:?city}"; base="${3:?baseUrl}"; rid="${4:?runId}"

printf '\033[1m== run %s ==\033[0m\n' "$rid"
gc --city "$root" bd show "$rid" 2>&1 || echo "(bd show failed)"

printf '\n\033[1m== diff ==\033[0m\n'
curl -s "$base/api/city/$city/runs/$rid/diff" 2>/dev/null \
  | python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("(diff unavailable)"); raise SystemExit
print(d.get("patch") or d.get("error") or "(no changes)")' 2>/dev/null \
  || echo "(diff unavailable)"

echo
exec "$SHELL"
