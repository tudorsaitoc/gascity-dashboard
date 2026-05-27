import { spawn } from 'node:child_process';

// Param schemas — every privileged exec validates its args against these.
// SESSION_ID_RE lives in lib/sessionId.ts now that peek is HTTP, not exec.
// BEAD_ID_RE is shared with routes/beads.ts via lib/beadId.ts so any prefix
// the read side accepts the write side can act on (gascity-dashboard-bwp).
import { BEAD_ID_RE } from './lib/beadId.js';

// Whitelisted-only shell-exec wrapper. Every privileged invocation in the
// app routes through this — there is intentionally no general-purpose
// exec helper exported elsewhere.
//
// Per security_researcher td-wisp-eb0pn:
//   - ENUM whitelist of allowed commands.
//   - shell:false (non-negotiable).
//   - Clean env — no inherited PATH/HOME/LANG.
//   - Timeout (10-30s) + output cap (100KB).
//   - Concurrency cap (semaphore).
//   - Bead-id / agent-alias param schemas enforced.

const MAX_BYTES = 100 * 1024;
// Larger ceiling for calls whose payload size is server-controlled (e.g.
// `gh ... --json <enumerated fields> --limit <N>`). Still capped — a
// 2MB hard ceiling prevents a runaway from filling memory while leaving
// generous headroom for repos with hundreds of long-labeled items.
const MAX_BYTES_LARGE = 2 * 1024 * 1024;
const MAX_WORKFLOW_DIFF_BYTES = 512 * 1024;
const MAX_CONCURRENT = 4;
// Agent alias / `gc sling` target validator.
//
// The char class deliberately permits `/` and `.` because gc treats the
// target as a *qualified name*, not a flat alias. Per gascity upstream
// (internal/config/config.go::QualifiedName / ParseQualifiedName), the
// canonical forms are:
//   - "mayor"                            (flat alias)
//   - "gastown.mayor"                    (binding-qualified alias)
//   - "hello-world/polecat"              (rig-qualified alias)
//   - "hello-world/gastown.polecat"      (rig + binding qualified)
//
// gc's ParseQualifiedName splits on the LAST `/` and looks the result up
// in the city config — the target is never resolved as a filesystem path.
// Pathological inputs like "a/../b" pass this regex but fail at gc's
// config lookup with `target_resolve_failed`; there is no path traversal
// surface because nothing on gc's side `open()`s the target string.
//
// Combined with the `shell: false` discipline in runExec (so values
// are positional argv, never interpolated into a shell string) and the
// 64-char length cap, the practical attack surface for this regex is
// limited to "submit a syntactically valid qualified name that doesn't
// resolve" — which is indistinguishable from a typo.
//
// Audited under gascity-dashboard-uyo (Phase 4 security-reviewer
// follow-up to wave-8nj). Do NOT tighten without first checking that
// no env (MAINTAINER_SLING_TARGET / MAINTAINER_TRIAGE_TARGET) or
// request payload uses the rig-qualified form.
export const AGENT_ALIAS_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;

function cleanEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '/tmp';
  // PATH explicitly includes ~/.local/bin because that's where `gc` lives
  // on the operator's host. Override via ADMIN_PATH env if a future
  // install moves it.
  const path =
    process.env.ADMIN_PATH ?? `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
  const env: NodeJS.ProcessEnv = {
    PATH: path,
    HOME: home,
    LANG: 'C.UTF-8',
    // Force color-off on every spawned subprocess. Belt-and-suspenders for
    // line-anchored stdout parsing (e.g. BEAD_ID_RE on `gc sling` output):
    // a future gc release that forces ANSI even when stdout isn't a TTY
    // would otherwise prefix the "Slung <id>" line with an SGR escape and
    // break the `^Slung` match silently. NO_COLOR is the cross-tool
    // standard (https://no-color.org); gc/gh/git all honour it.
    NO_COLOR: '1',
  };
  // gh CLI's active auth method on this host is GITHUB_TOKEN (per `gh
  // auth status`). Pass it through so execGhIssueList / execGhPrList
  // can talk to api.github.com under the clean-env discipline. Still an
  // allowlist — every other env var is dropped.
  if (process.env.GITHUB_TOKEN !== undefined) {
    env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }
  return env;
}

let runningCount = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (runningCount < MAX_CONCURRENT) {
        runningCount += 1;
        resolve();
      } else {
        waiting.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseSlot(): void {
  runningCount -= 1;
  const next = waiting.shift();
  if (next) next();
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export class ExecError extends Error {
  constructor(message: string, public readonly kind: 'validation' | 'timeout' | 'spawn') {
    super(message);
    this.name = 'ExecError';
  }
}

function runExec(
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number = MAX_BYTES,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const child = spawn(cmd, args, {
      shell: false,
      timeout: timeoutMs,
      env: cleanEnv(),
      // Cut off stdin so the child can't block on prompts.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - stdout.length);
        stdout += chunk.toString('utf-8', 0, remaining);
        truncated = true;
        child.kill('SIGTERM');
      } else {
        stdout += chunk.toString('utf-8');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length <= MAX_BYTES) {
        stderr += chunk.toString('utf-8');
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs + 500);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new ExecError(`spawn failed: ${err.message}`, 'spawn'));
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ExecError(`exec timed out after ${timeoutMs}ms`, 'timeout'));
        return;
      }
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - start,
      });
    });
  });
}

// Strip ANSI / OSC / control chars from peek output. Per
// security_researcher's regex spec. Server-side strip happens BEFORE the
// content reaches the browser; ansi_up on the client only ever sees
// safe SGR sequences (or none).
const CSI_NON_SGR_RE = /\x1b\[[?0-9;]*[a-ln-zA-LN-Z]/g; // CSI but excluding 'm' (SGR)
const OSC_RE = /\x1b\][^\x07]*\x07/g;
// Control chars except \t, \n; everything < 0x20 except those two.
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

function sanitiseTerminalOutput(raw: string): string {
  return raw
    .replace(OSC_RE, '')
    .replace(CSI_NON_SGR_RE, '')
    .replace(CTRL_RE, '');
}

// ── Public exec wrappers — each one is a named, whitelisted call. ──────
//
// Note: peek used to be a shell-exec wrapper here. Architect addendum
// td-wisp-ijk7g (mechanic td-wisp-e1v14) confirmed peek is served by
// `gc supervisor`'s HTTP API as a structured transcript — see
// `routes/sessions.ts` + `gc-client.ts::fetchTranscript`.

// Bead CLOSE + agent NUDGE only. CLAIM moved to GcClient.updateBead (HTTP
// POST /bead/{id}/update) under gascity-dashboard-mq2 — the supervisor
// exposes that write endpoint. CLOSE stays here because the HTTP
// `/bead/{id}/close` endpoint has no reason field and the dashboard's
// close-reason UI would silently lose it; NUDGE stays because no HTTP route
// exists for it (it's the CLI nudgequeue subsystem).
export async function execBeadAction(
  beadId: string,
  action: 'close' | 'nudge',
  reason?: string,
  cityPath?: string,
): Promise<ExecResult> {
  if (!BEAD_ID_RE.test(beadId)) {
    throw new ExecError('invalid bead id', 'validation');
  }
  const args: string[] = ['bd'];
  // --city pins the store so `gc bd` doesn't depend on the backend's cwd
  // (which is the dashboard repo, not a city directory). Without this,
  // writes fail with "not in a city directory". Same defensive validation
  // and flag placement as execAgentPrime.
  const cityArg =
    cityPath !== undefined && cityPath.length > 0
      ? (() => {
          if (!cityPath.startsWith('/') || cityPath.includes('..')) {
            throw new ExecError('invalid city path', 'validation');
          }
          return `--city=${cityPath}`;
        })()
      : undefined;
  if (action === 'close') {
    args.push('close', beadId);
    if (cityArg) args.push(cityArg);
    if (typeof reason === 'string' && reason.length > 0 && reason.length <= 1024) {
      args.push('--reason', reason);
    }
  } else if (action === 'nudge') {
    if (!AGENT_ALIAS_RE.test(beadId)) {
      // 'nudge' is on agent alias, not bead. We thread it through this
      // function for parity — but require alias format here.
      throw new ExecError('nudge requires agent alias, not bead id', 'validation');
    }
    args.push('nudge', beadId);
    if (cityArg) args.push(cityArg);
  }
  await acquireSlot();
  try {
    return await runExec('gc', args, 15_000);
  } finally {
    releaseSlot();
  }
}

/**
 * `gc prime --strict <alias>` — outputs the composed behavioural prompt
 * for an agent (the same text the agent reads on wake). gascity-dashboard-vq7
 * read-only surface: the dashboard surfaces the resolved prompt without
 * exposing an edit path (edits would need a file-write privilege the
 * exec whitelist deliberately doesn't grant — filed for follow-up
 * behind security review).
 *
 * --strict so 'agent not in city config' surfaces as exit=1 +
 * stderr (caller renders "not configured") instead of gc's default
 * fallback to a generic worker prompt that would mislead the operator.
 *
 * cityPath is optional. When omitted, `gc` walks up from cwd to
 * discover the city (matches the behaviour of the other exec helpers
 * in this file, which don't pin --city). When present, it must be an
 * absolute path with no `..` traversal segments.
 *
 * Output size: measured ~15KB for the mayor's prompt; well under
 * runExec's 100KB MAX_BYTES.
 */
export async function execAgentPrime(
  alias: string,
  cityPath?: string,
): Promise<ExecResult> {
  if (!AGENT_ALIAS_RE.test(alias)) {
    throw new ExecError('invalid agent alias', 'validation');
  }
  const args: string[] = ['prime', '--strict'];
  if (cityPath !== undefined && cityPath.length > 0) {
    if (!cityPath.startsWith('/') || cityPath.includes('..')) {
      throw new ExecError('invalid city path', 'validation');
    }
    args.push(`--city=${cityPath}`);
  }
  args.push(alias);
  await acquireSlot();
  try {
    return await runExec('gc', args, 10_000);
  } finally {
    releaseSlot();
  }
}

// Mail send moved to GcClient.sendMail (HTTP POST /mail with from:'human')
// under gascity-dashboard-mq2 — the supervisor exposes that write endpoint.
// The physical-separation guarantee (no `from`/`as` slot reaching the
// browser) now lives in the browser-facing MailComposeRequest shape +
// server.ts pinning from:'human'; the route file mail-send.ts still has no
// identity parameter in its handler.

// Hardcoded enum of `git log` invocations. Each view's args live entirely
// in this file — the operator cannot pass arbitrary git arguments to the
// server. The caller can only pick a view *name* (validated upstream).
// td-7t24i6 scope expansion: git log views previously capped at -n 50 in
// recent-main / recent-all, same undercount risk. Recent-main bumped to
// 200 (matches main's typical commit frequency * ~2 weeks); recent-all
// bumped to 200 too. The since= variants are time-windowed, not count-
// windowed, so no explicit cap needed — git's default for those is fine.
const GIT_LOG_VIEWS: Record<string, string[]> = {
  'recent-main': [
    'log',
    '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%D%x09%s',
    '-n',
    '200',
    'origin/main',
  ],
  'recent-all': [
    'log',
    '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%D%x09%s',
    '-n',
    '200',
    '--branches',
    '--remotes',
  ],
  today: [
    'log',
    '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%D%x09%s',
    '--since=24.hours.ago',
    '--branches',
    '--remotes',
  ],
  'this-week': [
    'log',
    '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%D%x09%s',
    '--since=7.days.ago',
    '--branches',
    '--remotes',
  ],
};

const GIT_REPO_PATH = process.env.ADMIN_GIT_REPO ?? process.env.HOME ?? '';

export async function execGitLog(view: string): Promise<ExecResult> {
  const args = GIT_LOG_VIEWS[view];
  if (!args) {
    throw new ExecError('unknown git view', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec('git', ['-C', GIT_REPO_PATH, ...args], 10_000);
  } finally {
    releaseSlot();
  }
}

type WorkflowGitView = 'root' | 'status' | 'diff' | 'diff-cached';

const WORKFLOW_GIT_VIEWS: Record<WorkflowGitView, string[]> = {
  root: ['rev-parse', '--show-toplevel'],
  status: ['status', '--porcelain=v1'],
  diff: ['diff', '--no-ext-diff', '--no-color'],
  'diff-cached': ['diff', '--cached', '--no-ext-diff', '--no-color'],
};

/**
 * Whitelisted git reads for workflow run detail diffs. The execution path
 * comes from supervisor-owned run metadata, not a browser parameter, but it is
 * still validated here so every subprocess boundary remains in this file.
 */
export async function execWorkflowGit(
  cwd: string,
  view: WorkflowGitView,
): Promise<ExecResult> {
  if (!isValidWorkflowCwd(cwd)) {
    throw new ExecError('invalid workflow cwd', 'validation');
  }
  const args = WORKFLOW_GIT_VIEWS[view];
  await acquireSlot();
  try {
    return await runExec(
      'git',
      ['-C', cwd, ...args],
      5_000,
      view === 'diff' || view === 'diff-cached' ? MAX_WORKFLOW_DIFF_BYTES : MAX_BYTES,
    );
  } finally {
    releaseSlot();
  }
}

function isValidWorkflowCwd(cwd: string): boolean {
  return cwd.startsWith('/') && !cwd.includes('\0') && !cwd.split('/').includes('..');
}

// ── Maintainer triage: gh CLI wrappers ───────────────────────────────
//
// gascity-dashboard-361. Pulls open issues + PRs from a GitHub repo
// through the `gh` CLI. The repo is server-config-bound (not a request
// parameter) and validated against a tight pattern; gh's --json
// argument is hardcoded server-side so the operator can't expand the
// field set from the browser. 30s timeout because gh hits api.github.com
// across the public internet; cap stays at 100KB but a busy repo with
// 100+ open items can crowd that — see notes on --limit.

const GH_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// `body` is deliberately omitted from the ingest json: a single repo with
// 500 long-body items easily blows past runExec's 100KB MAX_BYTES cap,
// and bead 361 doesn't render bodies anyway. Enrichment beads (gtr's
// blast-radius LLM extraction, 98h's embeddings) fetch bodies on demand
// for the subset of items they need to classify, via separate gh calls.
const GH_ISSUE_FIELDS = 'number,title,createdAt,updatedAt,author,labels,url';
// `closingIssuesReferences` is not present in gh 2.45. PR -> issue
// linkage gets derived by parsing PR bodies for "Fixes #N" / "Closes
// #N" / "Resolves #N" in triage.ts; `body` is fetched here for that
// purpose only. Issue bodies stay omitted: not used by ingest, and the
// 262-issue payload only fits the 2MB MAX_BYTES_LARGE cap because we
// don't carry them.
const GH_PR_FIELDS =
  'number,title,createdAt,updatedAt,author,labels,url,body,additions,deletions,reviewDecision,isDraft,state,files';

/**
 * `gh issue list --repo <repo> --state open --json <fields> --limit <n>`
 * Returns the raw JSON array as stdout. Caller parses + maps.
 */
export async function execGhIssueList(
  repo: string,
  limit: number,
): Promise<ExecResult> {
  if (!GH_REPO_RE.test(repo)) {
    throw new ExecError('invalid repo (expected owner/name)', 'validation');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ExecError('invalid limit (1..1000)', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--json',
        GH_ISSUE_FIELDS,
        '--limit',
        String(limit),
      ],
      30_000,
      MAX_BYTES_LARGE,
    );
  } finally {
    releaseSlot();
  }
}

/**
 * `gh issue list --repo <repo> --state all --json number,author,state,stateReason
 *  --limit <n>` — pulls the full lifetime issue history (open + closed,
 *  any reason) so the contributor-stats module can tally per-author
 *  totals without per-login round-trips. Returned shape is intentionally
 *  thin: no titles, no bodies, no labels — only what's needed to count.
 */
export async function execGhIssueListAll(
  repo: string,
  limit: number,
): Promise<ExecResult> {
  if (!GH_REPO_RE.test(repo)) {
    throw new ExecError('invalid repo (expected owner/name)', 'validation');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new ExecError('invalid limit (1..10000)', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--json',
        'number,author,state',
        '--limit',
        String(limit),
      ],
      60_000,
      MAX_BYTES_LARGE,
    );
  } finally {
    releaseSlot();
  }
}

/**
 * `gh pr list --repo <repo> --state all --json number,author,state --limit <n>`
 *  — same idea as execGhIssueListAll but for PRs. state values include
 *  OPEN / CLOSED / MERGED.
 */
export async function execGhPrListAll(
  repo: string,
  limit: number,
): Promise<ExecResult> {
  if (!GH_REPO_RE.test(repo)) {
    throw new ExecError('invalid repo (expected owner/name)', 'validation');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new ExecError('invalid limit (1..10000)', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--json',
        'number,author,state',
        '--limit',
        String(limit),
      ],
      60_000,
      MAX_BYTES_LARGE,
    );
  } finally {
    releaseSlot();
  }
}

/**
 * `gh pr list --repo <repo> --state open --json <fields> --limit <n>`
 */
export async function execGhPrList(
  repo: string,
  limit: number,
): Promise<ExecResult> {
  if (!GH_REPO_RE.test(repo)) {
    throw new ExecError('invalid repo (expected owner/name)', 'validation');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ExecError('invalid limit (1..1000)', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--json',
        GH_PR_FIELDS,
        '--limit',
        String(limit),
      ],
      30_000,
      MAX_BYTES_LARGE,
    );
  } finally {
    releaseSlot();
  }
}

export { sanitiseTerminalOutput };
