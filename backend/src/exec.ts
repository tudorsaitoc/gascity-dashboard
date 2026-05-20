import { spawn } from 'node:child_process';

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
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT = 4;

// Param schemas — every privileged exec validates its args against these.
// SESSION_ID_RE lives in routes/sessions.ts now that peek is HTTP, not exec.
const BEAD_ID_RE = /^(td|th|jt)-[a-z0-9-]{3,32}$/;
const AGENT_ALIAS_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;

function cleanEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '/tmp';
  // PATH explicitly includes ~/.local/bin because that's where `gc` lives
  // on the operator's host. Override via ADMIN_PATH env if a future
  // install moves it.
  const path =
    process.env.ADMIN_PATH ?? `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
  return {
    PATH: path,
    HOME: home,
    LANG: 'C.UTF-8',
  };
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

function runExec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
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
      if (stdout.length + chunk.length > MAX_BYTES) {
        const remaining = Math.max(0, MAX_BYTES - stdout.length);
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
// `routes/sessions.ts` + `gc-client.ts::fetchTranscript`. The SESSION_ID_RE
// + sanitiseTerminalOutput pair stays here for use by that path.

export async function execBeadAction(
  beadId: string,
  action: 'claim' | 'close' | 'nudge',
  reason?: string,
): Promise<ExecResult> {
  if (!BEAD_ID_RE.test(beadId)) {
    throw new ExecError('invalid bead id', 'validation');
  }
  const args: string[] = ['bd'];
  if (action === 'claim') {
    args.push('update', beadId, '--status=in_progress', '--assignee=stephanie');
  } else if (action === 'close') {
    args.push('close', beadId);
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
  }
  await acquireSlot();
  try {
    return await runExec('gc', args, 15_000);
  } finally {
    releaseSlot();
  }
}

export async function execAgentNudge(alias: string): Promise<ExecResult> {
  if (!AGENT_ALIAS_RE.test(alias)) {
    throw new ExecError('invalid agent alias', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec('gc', ['agents', 'nudge', alias], 10_000);
  } finally {
    releaseSlot();
  }
}

// PHYSICAL SEPARATION (security_researcher td-wisp-eb0pn): mail-send is its
// OWN wrapper, deliberately with NO `from` / `as` parameter in its
// signature. The --from human pin is the SECOND belt — even if some
// future caller tries to add a `from` arg, the function refuses it because
// it isn't a parameter at all.
//
// `human` is gc's canonical wire identity for the operator. The audit log
// separately records `actor=stephanie` (see audit.ts) — that's the
// dashboard's internal accounting, distinct from gc's wire-level sender.
export async function execMailSend(
  to: string,
  subject: string,
  body: string,
): Promise<ExecResult> {
  if (!AGENT_ALIAS_RE.test(to)) {
    throw new ExecError('invalid recipient alias', 'validation');
  }
  if (subject.length === 0 || subject.length > 200) {
    throw new ExecError('subject must be 1–200 chars', 'validation');
  }
  if (body.length === 0 || body.length > 16 * 1024) {
    throw new ExecError('body too short or too long', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec(
      'gc',
      ['mail', 'send', to, '--from', 'human', '-s', subject, '-m', body],
      10_000,
    );
  } finally {
    releaseSlot();
  }
}

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

export { sanitiseTerminalOutput };
