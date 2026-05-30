#!/usr/bin/env bash
# CI gate for the modular-dashboard audience-hypothesis revisit
# (docs/PRD-modular-dashboard.md §7, premortem #1).
#
# The PRD requires a documented decision on or before the target date:
# either external Gas City operators have shown up wanting non-fork
# extension (open a Phase 2 design bead) OR they haven't (write
# docs/PLUGIN-API-DEFERRED.md tombstone and accept Phase 1 as the
# permanent end-state). This script fails CI on the day after the target
# date if neither path was taken.
#
# Inputs:
#   AUDIENCE_HYPOTHESIS_BEAD - the bead id created at PR-A merge time.
#                              Reads target date from the bead description.
#
# Exit codes:
#   0 - target date not reached, OR tombstone exists, OR bead is closed.
#   1 - target date passed AND no tombstone AND bead still open.
#   2 - inputs missing / bead lookup failed.
#
# Not yet wired into CI — re-evaluate at PR-D land time (per PRD §7
# CI-gates section).

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
TOMBSTONE="${REPO_ROOT}/docs/PLUGIN-API-DEFERRED.md"

if [ -f "${TOMBSTONE}" ]; then
  echo "audience-hypothesis: tombstone present at ${TOMBSTONE} — gate passes"
  exit 0
fi

BEAD_ID="${AUDIENCE_HYPOTHESIS_BEAD:-}"
if [ -z "${BEAD_ID}" ]; then
  echo "audience-hypothesis: AUDIENCE_HYPOTHESIS_BEAD env var unset" >&2
  exit 2
fi

# Defense-in-depth: bead ids in this repo are lowercase alphanumeric + hyphens
# + dots (e.g. gascity-dashboard-9yj.1). Reject anything else before passing
# to `bd show`. The current `bd` CLI quotes its argument safely, but a future
# CLI refactor that shells out unquoted would otherwise turn a malicious env
# var into command injection.
if ! [[ "${BEAD_ID}" =~ ^[a-z0-9.-]+$ ]]; then
  echo "audience-hypothesis: AUDIENCE_HYPOTHESIS_BEAD has unexpected format: ${BEAD_ID}" >&2
  exit 2
fi

if ! command -v bd >/dev/null 2>&1; then
  echo "audience-hypothesis: 'bd' CLI not on PATH" >&2
  exit 2
fi

BEAD_SHOW=$(bd show "${BEAD_ID}" 2>/dev/null) || {
  echo "audience-hypothesis: bead ${BEAD_ID} not found" >&2
  exit 2
}

STATUS=$(echo "${BEAD_SHOW}" | grep -i '^status:' | head -1 | awk '{print $2}')
if [ "${STATUS}" = "closed" ]; then
  echo "audience-hypothesis: bead ${BEAD_ID} is closed — gate passes"
  exit 0
fi

TARGET=$(echo "${BEAD_SHOW}" | grep -oE 'Target date: [0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1 | awk '{print $3}')
if [ -z "${TARGET}" ]; then
  echo "audience-hypothesis: bead ${BEAD_ID} description missing 'Target date: YYYY-MM-DD'" >&2
  exit 2
fi

TODAY=$(date -u +%Y-%m-%d)
if [[ "${TODAY}" >= "${TARGET}" ]]; then
  echo "audience-hypothesis: target date ${TARGET} reached (today=${TODAY})" >&2
  echo "audience-hypothesis: bead ${BEAD_ID} is still open AND no ${TOMBSTONE}" >&2
  echo "audience-hypothesis: per PRD §7, choose ONE: open Phase 2 design bead, OR write the tombstone" >&2
  exit 1
fi

echo "audience-hypothesis: target ${TARGET} not yet reached (today=${TODAY}) — gate passes"
exit 0
