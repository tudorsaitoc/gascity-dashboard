<!--
  PR template for gas-city-dashboard. Keep it terse. Bullets over prose.
  Delete this comment and any section that genuinely does not apply,
  but say so explicitly (e.g. "Test plan: N/A, docs only").
-->

## Summary

1 to 3 bullets. What this PR changes, and why.

-
-

## Scope

- Named Rule touched (if any): e.g. The Flat Page Rule, The One Mark Rule, The One Voice Rule, The Greyscale Test, The Tabular Figures Rule. None is a valid answer.
- Views or routes affected: Agents, Beads, Mail, Activity, Health, or N/A.
- Layer: backend, frontend, shared, docs, ci, deploy. Multiple allowed.

## Test plan

- Tests added or modified: list paths.
- Automated checks run: typecheck and tests in each touched workspace, `npm run build` if frontend changed.
- Manual checks run: `node scripts/snap.mjs <route>` for any visual change, peek modal exercise for any Agents change, write-route smoke test for any backend write path.

## Risk + rollback

- What could regress, and where the operator would notice first.
- How to back out: revert the merge commit, or list the specific commits to revert.

## Linked issue

Closes #<n>, or `bd` id, or N/A.

## Operator-affecting changes

Tick both, or explain in the section above.

- [ ] No change to impersonation semantics (Reading-as strip stays read-only for non-operator; sends always go from the operator).
- [ ] No change to write-route audit shape (`audit.ts` envelope and event fields unchanged).
