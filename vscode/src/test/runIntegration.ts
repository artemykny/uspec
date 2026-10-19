// Runs the integration tests in VS Code with the CLI built from cli/: the `flow` suite against a copy
// of examples/example_product with a fake `claude`, then the `multi` suite against a copy of this
// repository, whose spec tree has the example product nested in it.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** The real Claude Code for `USPEC_LIVE=1`: `USPEC_CLAUDE`, `claude` on the PATH, or the Claude Code extension's binary. */
function realClaude(): string {
  if (process.env.USPEC_CLAUDE) return process.env.USPEC_CLAUDE;
  try {
    return execFileSync('which', ['claude']).toString().trim();
  } catch {
    const exts = path.join(os.homedir(), '.vscode', 'extensions');
    const dir = fs
      .readdirSync(exts)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .pop();
    if (!dir) throw new Error('no Claude Code found; set USPEC_CLAUDE');
    return path.join(exts, dir, 'resources', 'native-binary', 'claude');
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], { cwd });

/** Opens `workspace` in VS Code and runs the suite's test files there. */
async function suite(name: 'flow' | 'multi' | 'live', ext: string, workspace: string, env: Record<string, string>): Promise<void> {
  const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  await runTests({
    vscodeExecutablePath: process.platform === 'darwin' && fs.existsSync(installed) ? installed : undefined,
    extensionDevelopmentPath: ext,
    extensionTestsPath: path.join(__dirname, 'integration', 'index'),
    extensionTestsEnv: { ...env, USPEC_SUITE: name, USPEC_TEST_WORKSPACE: workspace },
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(ext, '.vscode-test', `user-data-${name}`)}`],
  });
}

function settings(workspace: string, values: Record<string, unknown>): void {
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ ...values, 'git.enabled': false }, null, 2));
}

async function main(): Promise<void> {
  // USPEC_LIVE=1 runs live.test.ts with the real Claude Code instead of the fake: it costs money.
  const live = process.env.USPEC_LIVE === '1';
  const ext = path.resolve(__dirname, '..', '..');
  const repo = path.resolve(ext, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uspec-vscode-'));
  const cli = path.join(repo, 'cli', 'target', 'debug', 'uspec');
  execFileSync('cargo', ['build', '-q'], { cwd: path.join(repo, 'cli'), stdio: 'inherit' });

  // Run from inside VS Code (an integrated terminal or an extension), these would make the test
  // instance start as Node or talk to the running window.
  for (const k of Object.keys(process.env)) if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_')) delete process.env[k];

  try {
    // The example product on its own, with a fake (or, live, the real) Claude Code.
    const work = path.join(tmp, 'example_product');
    fs.cpSync(path.join(repo, 'examples', 'example_product'), work, { recursive: true });
    let claude = path.join(tmp, 'claude');
    if (live) {
      claude = realClaude();
      // Give the payments logic a rule the change touches, so a writer has something to do.
      fs.writeFileSync(
        path.join(work, 'docs', 'system', 'services', 'payments', 'logic.md'),
        '# Payments logic\n\n## Rules\n\n- A refund is eligible within 14 days of delivery; after that, refunds are refused.\n',
      );
    } else {
      fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ext, 'out', 'test', 'fixtures', 'fakeClaude.js')}" "$@"\n`);
      fs.chmodSync(claude, 0o755);
    }
    settings(work, { 'uspec.cliPath': cli, 'uspec.claudePath': claude, 'uspec.agents.approveWrites': 'never' });
    git(work, 'init', '-q');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'init');
    await suite(live ? 'live' : 'flow', ext, work, { FAKE_CLAUDE_LOG: path.join(tmp, 'claude.log') });
    if (live) return;

    // This repository: its own spec tree with the example product nested in it.
    const copy = path.join(tmp, 'uspec');
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo }).toString().split('\0').filter(Boolean);
    for (const f of files) {
      if (!fs.existsSync(path.join(repo, f)) || !fs.statSync(path.join(repo, f)).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
      fs.copyFileSync(path.join(repo, f), path.join(copy, f));
    }
    settings(copy, { 'uspec.cliPath': cli });
    git(copy, 'init', '-q');
    git(copy, 'add', '-A');
    git(copy, 'commit', '-qm', 'init');
    await suite('multi', ext, copy, {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
