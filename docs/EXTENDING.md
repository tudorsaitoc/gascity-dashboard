# Extending — adding a view, a route, an exec wrapper

## Adding a new view

1. Add the route component under `frontend/src/routes/MyView.tsx`. Use `PageHeader` for the route opener and `StatusBadge` for any state indicators (see `routes/Health.tsx` for the canonical example).
2. Add the route in `frontend/src/App.tsx`.
3. Add the nav entry in `frontend/src/components/Header.tsx` — append to the `ROUTES` array. The weight-contrast active state is automatic.
4. If the view shows data the backend has to fetch + process, add a backend route under `backend/src/routes/myview.ts` and register it in `server.ts`.

## Adding a backend route

`backend/src/routes/foo.ts`:

```ts
import { Router } from 'express';
import type { GcClient } from '../gc-client.js';

export function fooRouter(gc: GcClient): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    // ...
    res.json({ items: [...] });
  });
  return router;
}
```

Register in `server.ts`:

```ts
import { fooRouter } from './routes/foo.js';
// ...
writeRouter.use('/foo', fooRouter(gc));
```

The `writeRouter` mount already wraps routes in `csrfValidate` for state-changing methods. GETs pass through.

## Adding a new whitelisted exec command

**Every** privileged invocation MUST route through `backend/src/exec.ts`. There is no general-purpose exec helper outside that file.

To add a new command (e.g. `gc dolt size`):

1. **Define the param schema.** What inputs are allowed? Bead-id, session-id, agent-alias — or pure literal command? Add a regex if it takes a parameter.
2. **Export a named wrapper** in `exec.ts`:

```ts
export async function execDoltSize(): Promise<ExecResult> {
  await acquireSlot();
  try {
    return await runExec('gc', ['dolt', 'size'], 5_000);
  } finally {
    releaseSlot();
  }
}
```

3. **Wire it** in a route and `recordAudit({ type: 'dashboard.exec', endpoint, parsed_args, exit_code, duration_ms })`.

What you MUST NOT do:

- Don't pass user input into the args array without param-schema validation.
- Don't set `shell: true`.
- Don't inherit env (`runExec` already strips; if you bypass `runExec`, you carry the burden).
- Don't skip the audit log row.

## Adding a new shared type

Edit `shared/src/index.ts`, add the interface, then `npm run build:shared`. Both backend and frontend pick it up via the workspace.

## Running just one workspace

```bash
npm --workspace backend run dev     # tsx watch, instant reload
npm --workspace frontend run dev    # vite, HMR on :5174
npm --workspace shared run build    # types only (build:shared also at root)
```

## Running the Peek-modal regression locally

`scripts/snap-peek.mjs --test` is the regression guard for the Peek modal — it
catches transparency regressions (the modal must render opaque against the
scrim, per `Modal.tsx`) and CSRF / Vite-changeOrigin regressions (the POST to
`/api/sessions/<id>/peek` must return 200, not 403).

```bash
# Backend + frontend must both be up:
#   Terminal 1: npm run dev:backend
#   Terminal 2: npm run dev:frontend
node scripts/snap-peek.mjs --test
```

Exit codes:

- `0` and `peek regression: PASSED` — modal opaque, peek POST 200, all good.
- `0` and `peek regression: SKIPPED` — no frontend reachable, or no active
  sessions to peek. Not a failure, but you didn't actually verify anything.
- `1` and `peek regression: FAILED` — real regression. Check the per-theme
  `FAIL — ...` lines for which assertion blew (transparency, no peek POST,
  non-200 response, modal didn't open).

Without `--test`, the script behaves as a snap-only harness, same as the other
`scripts/snap*.mjs` files: writes PNGs to `/tmp/cp-snaps/` and exits 0.

## Why we don't import from `clients/app/`

`tools/admin-dashboard/` is a separate workspace with no runtime or build dependency on the Thriva product app. Visual primitives are **copied** (in `frontend/src/components/`), not imported. Wrong-direction coupling — tooling depending on product code — is exactly what we don't want; the admin tool needs to survive product-app refactors.

If you copy a primitive in, simplify it to the admin aesthetic (tighter padding, sharper corners, dark-mode classes). Don't bring in `ChildContext`, `useNotifications`, mode toggles, or anything product-specific.
