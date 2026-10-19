// Starts Claude Code headless (`claude -p`) and reads its stream-json output.
import { spawn } from 'child_process';

export interface ClaudeResult {
  /** The final message, from the `result` event. */
  text: string;
  isError: boolean;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface ClaudeRun {
  done: Promise<ClaudeResult>;
  kill(): void;
}

/** Runs `claude <args>` in `cwd` with `prompt` on stdin; every parsed event goes to `onEvent`. */
export function startClaude(opts: {
  claudePath: string;
  cwd: string;
  args: string[];
  prompt: string;
  env?: NodeJS.ProcessEnv;
  onEvent(e: any): void;
}): ClaudeRun {
  const child = spawn(opts.claudePath, opts.args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  const result: ClaudeResult = { text: '', isError: false, exitCode: null, signal: null, stderr: '' };

  const handle = (line: string) => {
    if (!line.trim()) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      stderr += line + '\n';
      return;
    }
    if (e.session_id) result.sessionId = e.session_id;
    if (e.type === 'result') {
      result.text = typeof e.result === 'string' ? e.result : '';
      result.isError = Boolean(e.is_error) || e.subtype !== 'success';
      result.costUsd = e.total_cost_usd;
      result.durationMs = e.duration_ms;
    }
    opts.onEvent(e);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  const done = new Promise<ClaudeResult>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      handle(buffer);
      buffer = '';
      result.exitCode = code;
      result.signal = signal;
      result.stderr = stderr;
      if (code !== 0 && !result.text) result.isError = true;
      resolve(result);
    };
    child.on('error', (err) => {
      stderr += `${err.message}\n`;
      result.isError = true;
      // A process that never started emits no 'close' on every platform.
      if (child.pid === undefined) finish(null, null);
    });
    child.on('close', finish);
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(opts.prompt);

  return {
    done,
    kill: () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
}
