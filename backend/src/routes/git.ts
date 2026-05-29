import { Router } from 'express';
import type { GitCommit, GitView } from 'gas-city-dashboard-shared';
import { execGitLog as defaultExecGitLog, ExecError } from '../exec.js';
import type { ExecResult } from '../exec.js';
import { recordAudit } from '../audit.js';
import { toWireExecError } from '../lib/sanitise-error.js';
import { LOG_COMPONENT, logWarn } from '../logging.js';
import { routeInternalError, writeRouteError } from '../route-errors.js';

// Hardcoded enum of `git log` invocations. Anything outside this set is
// rejected at the validator — the operator cannot pass arbitrary
// git args to the server.
const VIEWS: ReadonlySet<GitView> = new Set([
  'recent-main',
  'recent-all',
  'today',
  'this-week',
] as const);

const PRETTY_FORMAT = '%H%x09%h%x09%an%x09%aI%x09%D%x09%s';

export interface GitRouterOptions {
  /**
   * Injected `git log` runner. Defaults to the real exec wrapper; tests
   * pass a stub that throws so the catch-arm redaction contract
   * (gascity-dashboard-big) is unit-testable without spawning git.
   * Mirrors the DI pattern used by agentsRouter and maintainerRouter.
   */
  execGitLog?: (view: string) => Promise<ExecResult>;
}

export function gitRouter(opts: GitRouterOptions = {}): Router {
  const execGitLog = opts.execGitLog ?? defaultExecGitLog;
  const router = Router();

  router.get('/commits', async (req, res) => {
    const viewRaw = typeof req.query.view === 'string' ? req.query.view : 'recent-main';
    const view = VIEWS.has(viewRaw as GitView) ? (viewRaw as GitView) : 'recent-main';
    try {
      const result = await execGitLog(view);
      const items = parseGitLog(result.stdout);
      await recordAudit({
        type: 'dashboard.exec',
        endpoint: 'GET /api/git/commits',
        parsed_args: { view },
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      });
      res.json({ view, items });
    } catch (err) {
      if (err instanceof ExecError) {
        // gascity-dashboard-473: spawn-arm host path redaction. The
        // 'spawn' kind wraps node's "spawn <abs-path> ENOENT" exposing
        // the operator's binary layout; validation/timeout carry safe
        // pre-authored strings by ExecError construction. /commits has
        // no validation kind in practice (view is enum-validated above),
        // so the per-kind branch is here for completeness with the
        // sibling routes in this directory.
        if (err.kind === 'spawn') {
          logWarn(LOG_COMPONENT.git, `/api/git/commits spawn failed: ${err.message}`);
        }
        const wire = toWireExecError(err, err.kind === 'timeout' ? 504 : 500);
        res.status(wire.status).json(wire.body);
        return;
      }
      writeRouteError(res, routeInternalError(err, {
        component: LOG_COMPONENT.git,
        operation: '/api/git/commits failed',
        responseError: 'internal error',
      }));
    }
  });

  return router;
}

function parseGitLog(stdout: string): GitCommit[] {
  const items: GitCommit[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const [sha, shortSha, author, date, refs, subject] = parts;
    if (!sha || !shortSha || !author || !date) continue;
    const commit: GitCommit = {
      sha,
      short_sha: shortSha,
      author,
      date,
      subject: subject ?? '',
    };
    if (refs && refs.length > 0) commit.refs = refs;
    items.push(commit);
  }
  return items;
}

export { PRETTY_FORMAT };
