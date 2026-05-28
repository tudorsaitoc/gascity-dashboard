import { Router } from 'express';
import {
  ExecError,
  execAgentPrime as defaultExecAgentPrime,
} from '../exec.js';
import type { ExecResult } from '../exec.js';
import { recordAudit } from '../audit.js';
import { HTTP_STATUS } from '../lib/http-status.js';
import { writeExecError } from '../lib/sanitise-error.js';
import { LOG_COMPONENT, logWarn } from '../logging.js';
import { routeInternalError, writeRouteError } from '../route-errors.js';

// gascity-dashboard-vq7: per-agent prompt/directive surface. Read-only.
// The bead acceptance is explicitly read-only; direct prompt editing through
// this dashboard would be a high-blast-radius action.
//
// Why a new router instead of folding into /api/sessions: sessions are
// keyed by id (gc-…/td-…/th-…); agent identity here is the alias
// (e.g. 'mayor' or 'thriva/devpipeline.architect') because that's what
// `gc prime` accepts. Keeping the namespace separate avoids confusion
// about which key type a route takes.
//
// AGENT_ALIAS_RE in exec.ts validates the alias shape; the route forwards
// the raw string and lets exec.ts gate it. 404 vs 502 is distinguished
// by gc's exit code + stderr message: --strict exits 1 with stderr
// "agent ... not found in city config" for unknown agents, exits 0 with
// the composed prompt on success.

interface AgentsRouterOptions {
  /** Optional city path forwarded to `gc prime --city=<path>`. */
  cityPath?: string;
  /**
   * Injected `gc prime` runner. Defaults to the real exec wrapper; tests
   * pass a stub. Mirrors the DI pattern used by maintainerRouter and
   * mailSendRouter so the non-zero-exit redaction contract
   * (gascity-dashboard-i53) is unit-testable without spawning gc.
   */
  execAgentPrime?: (alias: string, cityPath?: string) => Promise<ExecResult>;
}

export function agentsRouter(opts: AgentsRouterOptions | string = {}): Router {
  // Options normalization keeps tests and app wiring on one router factory.
  const normalised: AgentsRouterOptions =
    typeof opts === 'string' ? { cityPath: opts } : opts;
  const cityPath = normalised.cityPath;
  const execAgentPrime = normalised.execAgentPrime ?? defaultExecAgentPrime;
  const router = Router();

  router.get('/:alias/prime', async (req, res) => {
    const alias = req.params.alias;
    try {
      const result = await execAgentPrime(alias, cityPath);
      // --strict reports "agent X not found in city config" on stderr
      // when the alias doesn't map to a configured agent. Surface as
      // 404 so the UI can render an "agent not configured" state
      // instead of a generic upstream error.
      const exitOk = result.exitCode === 0;
      const stderr = result.stderr.slice(0, 1024);
      const notFound = !exitOk && /not found in city config|no agent/i.test(stderr);
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/agents/:alias/prime',
        parsed_args: {
          agent: alias,
          exit_code: String(result.exitCode),
          ...(exitOk
            ? { prompt_bytes: String(result.stdout.length) }
            : { error_kind: notFound ? 'not_found' : 'upstream' }),
        },
        duration_ms: result.durationMs,
      });
      if (!exitOk) {
        // gascity-dashboard-i53: do NOT echo raw stderr to the client.
        // gc prime's stderr is implementation-defined (up to 1024 bytes)
        // and can include host paths or sensitive context. The frontend
        // routes on `kind` + status code only (see AgentDetail.tsx:659
        // — `error?.status === 404 || error?.kind === 'not_found'`),
        // never on `details.stderr`. Mirror the 473 catch-arm pattern:
        // stderr stays server-side in the operational log for debugging;
        // the wire carries `kind` + a fixed error message,
        // plus `details: { name }` on the upstream arm so the shape is
        // consistent with the catch-all 500 below.
        logWarn(
          LOG_COMPONENT.agents,
          `/api/agents/${alias}/prime non-zero exit ${result.exitCode}: ${stderr}`,
        );
        if (notFound) {
          res.status(HTTP_STATUS.notFound).json({
            error: 'agent not configured',
            kind: 'not_found',
          });
        } else {
          res.status(HTTP_STATUS.badGateway).json({
            error: `gc prime failed with exit ${result.exitCode}`,
            kind: 'upstream',
            details: { name: 'NonZeroExit' },
          });
        }
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        agent: alias,
        prompt: result.stdout,
        bytes: result.stdout.length,
      });
    } catch (err) {
      // Failed-validation attempts are the most interesting audit
      // entries — they're the probing / scanning signal. Mirror the
      // success-path recordAudit so the forensic record is symmetric
      // across outcomes. error_kind + requested alias only; no raw
      // stderr in the audit body (could contain upstream noise or
      // sensitive paths).
      if (err instanceof ExecError) {
        void recordAudit({
          type: 'dashboard.fetch',
          endpoint: 'GET /api/agents/:alias/prime',
          parsed_args: { agent: alias, error_kind: err.kind },
          duration_ms: 0,
        });
        writeExecError(res, err, LOG_COMPONENT.agents, `/api/agents/${alias}/prime`);
        return;
      }
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/agents/:alias/prime',
        parsed_args: { agent: alias, error_kind: 'unknown' },
        duration_ms: 0,
      });
      writeRouteError(res, routeInternalError(err, {
        component: LOG_COMPONENT.agents,
        operation: `/api/agents/${alias}/prime failed`,
        responseError: 'internal error',
      }));
    }
  });

  return router;
}
