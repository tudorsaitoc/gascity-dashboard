#!/usr/bin/env bash
# Live agent peek for the TUI. Follows the conversation transcript when one
# exists (Claude agents); otherwise watches live pane snapshots — which works
# for non-transcript sessions like control-dispatchers, where `session logs`
# fails with "no exact transcript found ... workdir fallback is ambiguous".
#   peek-agent.sh <cityRoot> <id>
set -uo pipefail
root="${1:?cityRoot}"; id="${2:?id}"

if gc --city "$root" session logs "$id" --tail 1 >/dev/null 2>&1; then
  gc --city "$root" session logs "$id" -f
else
  # No conversation transcript (e.g. a control-dispatcher). Show live pane
  # snapshots instead; the header is reprinted each refresh so the pane never
  # looks frozen, even when a controller process has no visible output.
  while true; do
    printf '\033[H\033[2J'
    echo "live pane of $id — no transcript (controller?); refreshing every 2s, Ctrl-C to stop"
    echo
    out="$(gc --city "$root" session peek "$id" --lines 200 2>&1)" || break
    if [ -n "$out" ]; then echo "$out"; else echo "(no visible pane output)"; fi
    sleep 2
  done
fi
exec "$SHELL"
