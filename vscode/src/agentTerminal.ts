// A run is the agent's own interactive TUI in a VS Code terminal. The extension never reads its
// output: hooks (Claude Code's SessionStart and Stop, Codex's notify) append the session and the final
// message of each turn to a sidecar file, and the first turn's final message is the run's result.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { StringDecoder } from 'string_decoder';
import type { AgentProvider } from './core/provider';
import type { ClaudeResult, ClaudeRun } from './core/claude';

/** Runs the agent on the terminal's own TTY and writes its exit code when it exits. */
const launcher = String.raw`
const fs = require('fs'), { spawn } = require('child_process');
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(c.executable, c.args, { cwd: c.cwd, env, stdio: 'inherit' });
child.on('error', e => { console.error(e.message); fs.writeFileSync(c.exit, '1'); });
child.on('exit', code => { try { fs.writeFileSync(c.exit, String(code ?? 1)); } catch {} });
process.on('SIGINT', () => {});
for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
`;

/** Called by the agent's hooks: Claude Code passes the event on stdin, Codex as the last argument. */
const hook = String.raw`
const fs = require('fs');
const [out, arg] = process.argv.slice(2);
const record = e => { try { if (fs.existsSync(require('path').dirname(out))) fs.appendFileSync(out, JSON.stringify(e) + '\n'); } catch {} };
const handle = e => {
  if (e.type === 'agent-turn-complete') record({ event: 'stop', session: e['thread-id'], text: e['last-assistant-message'] ?? '' });
  if (e.hook_event_name === 'SessionStart') record({ event: 'start', session: e.session_id, transcript: e.transcript_path });
  if (e.hook_event_name === 'Stop') record({ event: 'stop', session: e.session_id, text: e.last_assistant_message ?? '' });
};
if (arg !== undefined) { try { handle(JSON.parse(arg)); } catch {} }
else { let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => { try { handle(JSON.parse(s)); } catch {} }); }
`;

/** Prompts longer than this go in a file: one argument can't be longer than 128 KiB on Linux. */
const MAX_ARG = 100_000;

const q = (s: string) => process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
const dq = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/** Terminals whose agent process is still running. */
const live = new Set<vscode.Terminal>();

export function agentAlive(terminal: vscode.Terminal | undefined): boolean {
  return !!terminal && live.has(terminal);
}

/** How the agent calls the hook: settings for Claude Code, a `notify` program for Codex. */
function hookArgs(provider: AgentProvider, wrapper: string, events: string): string[] {
  if (provider === 'codex') return ['-c', `notify=${JSON.stringify([wrapper, events])}`];
  const command = { type: 'command', command: `${dq(wrapper)} ${dq(events)}` };
  return ['--settings', JSON.stringify({ hooks: { SessionStart: [{ hooks: [command] }], Stop: [{ hooks: [command] }] } })];
}

export function startTerminalAgent(opts: {
  executable: string; provider: AgentProvider; cwd: string; args: string[]; prompt: string; name: string; terminal?: vscode.Terminal;
  onEvent(e: any): void;
}): ClaudeRun & { terminal: vscode.Terminal } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uspec-agent-'));
  fs.chmodSync(dir, 0o700);
  const events = path.join(dir, 'events'), exit = path.join(dir, 'exit');
  const script = path.join(dir, 'launch.cjs'), config = path.join(dir, 'input.json'), hookScript = path.join(dir, 'hook.cjs');
  fs.writeFileSync(script, launcher, { mode: 0o600 });
  fs.writeFileSync(hookScript, hook, { mode: 0o600 });
  // The hook runs with the agent's environment, which doesn't make VS Code's binary a plain Node.
  const wrapper = path.join(dir, process.platform === 'win32' ? 'hook.cmd' : 'hook.sh');
  fs.writeFileSync(wrapper, process.platform === 'win32'
    ? `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" "${hookScript}" %*\r\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(hookScript)} "$@"\n`, { mode: 0o700 });
  let prompt = opts.prompt;
  if (prompt.length > MAX_ARG) {
    const file = path.join(dir, 'prompt.md');
    fs.writeFileSync(file, prompt, { mode: 0o600 });
    prompt = `Read ${file} in full and follow it exactly. It is your task, from the uspec VS Code extension.`;
  }
  const args = [...opts.args, ...hookArgs(opts.provider, wrapper, events), '--', prompt];
  fs.writeFileSync(config, JSON.stringify({ executable: opts.executable, cwd: opts.cwd, args, exit }), { mode: 0o600 });

  // A terminal whose agent still runs can't take a new command: its input goes to the agent.
  if (opts.terminal && live.has(opts.terminal)) opts.terminal.dispose();
  const terminal = opts.terminal && !live.has(opts.terminal) ? opts.terminal : vscode.window.createTerminal({
    name: opts.name, cwd: opts.cwd, shellPath: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    iconPath: new vscode.ThemeIcon('sparkle'),
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  live.add(terminal);
  terminal.sendText(`${process.platform === 'win32' ? '& ' : ''}${[process.execPath, script, config].map(q).join(' ')}`);

  const result: ClaudeResult = { text: '', isError: false, exitCode: null, signal: null, stderr: '' };
  let settled = false, ended = false, transcript: string | undefined, transcriptAt = 0, offset = 0, buffer = '', tail = '';
  const decoder = new StringDecoder('utf8'), tailDecoder = new StringDecoder('utf8');
  let resolve!: (r: ClaudeResult) => void;
  const done = new Promise<ClaudeResult>(r => resolve = r);
  const grow = (file: string, from: number): Buffer | undefined => {
    if (!fs.existsSync(file)) return undefined;
    const size = fs.statSync(file).size;
    if (size <= from) return undefined;
    const fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(size - from);
    try { fs.readSync(fd, bytes, 0, bytes.length, from); } finally { fs.closeSync(fd); }
    return bytes;
  };
  // Claude Code's transcript has the same messages as its stream-json output: they go to the log.
  const readTranscript = () => {
    const bytes = transcript && grow(transcript, transcriptAt);
    if (!bytes) return;
    transcriptAt += bytes.length;
    tail += tailDecoder.write(bytes);
    let i: number;
    while ((i = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, i); tail = tail.slice(i + 1);
      try { const e = JSON.parse(line); if (e.type === 'assistant' || e.type === 'user') opts.onEvent(e); } catch { /* not a message */ }
    }
  };
  const settle = (r: Partial<ClaudeResult>) => {
    if (settled) return;
    settled = true;
    Object.assign(result, r);
    resolve(result);
  };
  const read = () => {
    readTranscript();
    const bytes = grow(events, offset);
    if (!bytes) return;
    offset += bytes.length;
    buffer += decoder.write(bytes);
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.session && e.session !== result.sessionId) { result.sessionId = e.session; opts.onEvent({ session_id: e.session }); }
      if (e.event === 'start' && e.transcript && e.transcript !== transcript) { transcript = e.transcript; transcriptAt = fs.existsSync(e.transcript) ? fs.statSync(e.transcript).size : 0; }
      if (e.event === 'stop') { readTranscript(); settle({ text: e.text ?? '' }); }
    }
  };
  // Runs until the agent exits: after its first turn the session stays open for the user.
  const end = (code: number, why?: string) => {
    if (ended) return;
    ended = true;
    try { read(); } catch { /* the run ends anyway */ }
    clearInterval(timer); close.dispose(); live.delete(terminal);
    settle({ exitCode: code, isError: true, stderr: why ?? `${opts.provider === 'codex' ? 'Codex' : 'Claude Code'} ended before finishing its turn` });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const timer = setInterval(() => {
    try {
      read();
      if (fs.existsSync(exit)) end(Number(fs.readFileSync(exit, 'utf8')));
    } catch (e) { end(1, String(e)); }
  }, 200);
  const close = vscode.window.onDidCloseTerminal(t => { if (t === terminal) end(1, 'The agent terminal was closed'); });
  return { terminal, done, kill: () => { terminal.dispose(); end(1, 'stopped'); } };
}

export async function revealAgentTerminal(terminal: vscode.Terminal): Promise<void> {
  terminal.show();
  await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
}
