import { spawn } from 'node:child_process';

export const MAX_BYTES = 100 * 1024;
export const MAX_BYTES_LARGE = 2 * 1024 * 1024;
export const MAX_RUN_DIFF_BYTES = 512 * 1024;
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

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export type ExecSpawn = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number,
) => Promise<ExecResult>;

export interface ExecRunner {
  runExec(cmd: string, args: string[], timeoutMs: number, maxBytes?: number): Promise<ExecResult>;
}

export interface ExecRunnerOptions {
  maxConcurrent?: number;
  spawnExec?: ExecSpawn;
}

export class ExecError extends Error {
  constructor(
    message: string,
    public readonly kind: 'validation' | 'timeout' | 'spawn',
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '/tmp';
  const path = process.env.ADMIN_PATH ?? `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
  const env: NodeJS.ProcessEnv = {
    PATH: path,
    HOME: home,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
  };
  if (process.env.GITHUB_TOKEN !== undefined) {
    env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }
  return env;
}

export function createExecRunner({
  maxConcurrent = MAX_CONCURRENT,
  spawnExec = spawnExecProcess,
}: ExecRunnerOptions = {}): ExecRunner {
  let runningCount = 0;
  const waiting: Array<() => void> = [];

  function acquireSlot(): Promise<void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (runningCount < maxConcurrent) {
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

  return {
    async runExec(
      cmd: string,
      args: string[],
      timeoutMs: number,
      maxBytes: number = MAX_BYTES,
    ): Promise<ExecResult> {
      await acquireSlot();
      try {
        return await spawnExec(cmd, args, timeoutMs, maxBytes);
      } finally {
        releaseSlot();
      }
    },
  };
}

const defaultExecRunner = createExecRunner();

export async function runExec(
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number = MAX_BYTES,
): Promise<ExecResult> {
  return defaultExecRunner.runExec(cmd, args, timeoutMs, maxBytes);
}

function spawnExecProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number,
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
