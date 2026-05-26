import { Router } from 'express';
import type { GitCommit, GitView } from 'gas-city-dashboard-shared';
import { execGitLog, ExecError } from '../exec.js';
import { recordAudit } from '../audit.js';
import { toWireExecError, toWireInternal500 } from '../lib/sanitise-error.js';

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

export function gitRouter(): Router {
  const router = Router();

  router.get('/commits', async (req, res) => {
    const viewRaw = typeof req.query.view === 'string' ? req.query.view : 'recent-main';
    const view = VIEWS.has(viewRaw as GitView) ? (viewRaw as GitView) : 'recent-main';
    try {
      const result = await execGitLog(view);
      const items = parseGitLog(result.stdout);
      void recordAudit({
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
          console.warn(`[git] /api/git/commits spawn failed: ${err.message}`);
        }
        const wire = toWireExecError(err, err.kind === 'timeout' ? 504 : 500);
        res.status(wire.status).json(wire.body);
        return;
      }
      // gascity-dashboard-473: mirror the ayr sr6 redaction on the
      // catch-all 500. Raw err.message can embed OS detail.
      console.warn(`[git] /api/git/commits failed: ${(err as Error).message}`);
      const wire = toWireInternal500(err, {
        status: 500,
        error: 'internal error',
        kind: 'internal',
      });
      res.status(wire.status).json(wire.body);
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
    items.push({
      sha,
      short_sha: shortSha,
      author,
      date,
      refs: refs && refs.length > 0 ? refs : undefined,
      subject: subject ?? '',
    });
  }
  return items;
}

export { PRETTY_FORMAT };
