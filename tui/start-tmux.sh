#!/usr/bin/env bash
# Launch the Gas City TUI inside tmux so the live-peek split (enter) works.
#
#   ./tui/start-tmux.sh [--split] [--pct N] [<city>]   # or set GC_CITY_NAME
#   npm --workspace tui run start:tmux -- [--split] [--pct N] [<city>]
#
# Default: if you are already inside tmux, the TUI takes over the current pane
# (enter-peek then splits that window); otherwise it creates a dedicated
# `gc-tui` session so the TUI has a tmux to split into.
#
# --split: pin the dashboard BESIDE the current pane instead of taking it over,
# so you can leave it glancing on the side of the session you're working in
# (e.g. the mayor). Run it from inside the tmux window you want split; it adds
# a right-hand pane running the TUI and leaves your original pane in place.
# Outside tmux there is no window to split, so --split falls back to the
# dedicated `gc-tui` session (with a note).
set -euo pipefail

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

split=0
pct=40
city=""
while [ $# -gt 0 ]; do
  case "$1" in
    --split) split=1; shift ;;
    -l | --pct) pct="${2:-40}"; shift 2 ;;
    --city) city="${2:-}"; shift 2 ;;
    --city=*) city="${1#--city=}"; shift ;;
    --help) usage; exit 0 ;;
    *) city="$1"; shift ;;
  esac
done
city="${city:-${GC_CITY_NAME:-}}"
pct="${pct%\%}" # accept "40" or "40%"

city_flag=""
[ -n "$city" ] && city_flag="-- --city=$city"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
run="cd '$root' && npm --workspace tui run start $city_flag"

start_dedicated_session() {
  # Start a CLEAN dedicated session: kill any stale `gc-tui` (orphan peek panes
  # from a previous run) first, then create fresh.
  tmux kill-session -t gc-tui 2>/dev/null || true
  exec tmux new-session -s gc-tui "$run"
}

if [ "$split" = "1" ]; then
  if [ -n "${TMUX:-}" ]; then
    # Pin the dashboard beside the current pane (e.g. the mayor). Non-blocking:
    # the new right-hand pane runs the TUI; the current pane is preserved.
    # `-l N%` is tmux >= 3.1; fall back to the older `-p N` form otherwise.
    tmux split-window -h -l "${pct}%" "$run" 2>/dev/null ||
      tmux split-window -h -p "$pct" "$run"
  else
    echo "start-tmux.sh: --split needs an existing tmux window to split into;" >&2
    echo "  not inside tmux, so launching the dedicated 'gc-tui' session instead." >&2
    start_dedicated_session
  fi
  exit 0
fi

if [ -n "${TMUX:-}" ]; then
  # Already in tmux — run directly; enter-peek splits the current window.
  eval "$run"
else
  start_dedicated_session
fi
