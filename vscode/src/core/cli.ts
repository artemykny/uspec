// Runs the uspec CLI (docs/cli/overview.md) and reads its output.
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A command the CLI ran and rejected: its `error: <message>`. */
export class UspecError extends Error {
  constructor(message: string, readonly args: string[]) {
    super(message);
  }
}

/** The CLI couldn't be started at all. */
export class CliNotFoundError extends Error {
  constructor(readonly cliPath: string) {
    super(`couldn't start the uspec CLI (${cliPath})`);
  }
}

/** Finds an executable on the PATH, or returns undefined. */
export function onPath(name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Resolves the `uspec.cliPath` setting: a bare command is looked up on the PATH and in ~/.cargo/bin. */
export function resolveCli(setting: string): string {
  const s = setting.trim() || 'uspec';
  if (s.includes('/') || s.includes('\\')) return s.startsWith('~') ? path.join(os.homedir(), s.slice(1)) : s;
  return onPath(s) ?? [path.join(os.homedir(), '.cargo', 'bin', s)].find((p) => existsSync(p)) ?? s;
}

interface Output {
  stdout: string;
  stderr: string;
  code: number;
}

function exec(cli: string, cwd: string, args: string[]): Promise<Output> {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new CliNotFoundError(cli));
        return;
      }
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Runs `uspec --json <args>` and parses the result. `validate` and `drift` exit with 1 when they find
 * something; their JSON is still the result. `{"error": …}` becomes a UspecError.
 */
export async function runJson<T>(cli: string, cwd: string, args: string[]): Promise<T> {
  const out = await exec(cli, cwd, ['--json', ...args]);
  let value: unknown;
  try {
    value = JSON.parse(out.stdout);
  } catch {
    const msg = out.stderr.trim().replace(/^error: /, '') || `uspec ${args.join(' ')} exited with ${out.code}`;
    throw new UspecError(msg, args);
  }
  if (value && typeof value === 'object' && 'error' in value) {
    throw new UspecError(String((value as { error: unknown }).error), args);
  }
  return value as T;
}

/** Runs `uspec <args>` for its text output, as skills give it to agents. */
export async function runText(cli: string, cwd: string, args: string[]): Promise<string> {
  const out = await exec(cli, cwd, args);
  if (out.code !== 0) {
    throw new UspecError(out.stderr.trim().replace(/^error: /, '') || `uspec ${args.join(' ')} exited with ${out.code}`, args);
  }
  return out.stdout;
}

/** Runs tasks one at a time, in the order they were queued. */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
