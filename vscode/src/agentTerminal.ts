// A normal shell terminal runs the worker. Only its machine-readable sidecar is observed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { StringDecoder } from 'string_decoder';
import { eventAdapter, type AgentProvider } from './core/provider';
import type { ClaudeResult, ClaudeRun } from './core/claude';

const worker = String.raw`
const fs = require('fs'), { spawn } = require('child_process');
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const child = spawn(c.executable, c.args, {cwd: c.cwd, stdio: ['pipe','pipe','inherit']});
let buffer = '';
const out = fs.createWriteStream(c.events);
child.stdout.on('data', chunk => {
  out.write(chunk); buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0,i); buffer = buffer.slice(i+1);
    try {
      const e = JSON.parse(line);
      if(e.type === 'assistant') for(const b of e.message?.content || []) {
        if(b.type === 'text') console.log(b.text);
        else if(b.type === 'tool_use') console.log(b.name + ': ' + JSON.stringify(b.input));
      }
      if(e.type === 'result') console.log(e.result || e.subtype);
      if(e.type === 'item.completed') console.log(e.item?.text || e.item?.command || JSON.stringify(e.item));
      if(e.type === 'error' || e.type === 'turn.failed') console.error(e.message || e.error?.message || 'Codex turn failed');
    } catch { console.log(line); }
  }
});
child.on('error', e => { console.error(e.message); fs.writeFileSync(c.exit, '1'); });
child.on('close', code => out.end(() => { fs.writeFileSync(c.exit, String(code ?? 1)); }));
child.stdin.on('error', () => {});
child.stdin.end(c.prompt);
process.on('SIGTERM', () => { child.kill(); });
process.on('SIGHUP', () => { child.kill(); });
`;

export function startTerminalAgent(opts: {
  executable: string; provider: AgentProvider; cwd: string; args: string[]; prompt: string; name: string; terminal?: vscode.Terminal;
  onEvent(e: any): void;
}): ClaudeRun & { terminal: vscode.Terminal } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uspec-agent-'));
  fs.chmodSync(dir, 0o700);
  const events = path.join(dir, 'events'), exit = path.join(dir, 'exit');
  const script = path.join(dir, 'worker.cjs'), config = path.join(dir, 'input.json');
  fs.writeFileSync(script, worker, { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({ executable: opts.executable, cwd: opts.cwd, args: opts.args, prompt: opts.prompt, events, exit }), { mode: 0o600 });
  const terminal = opts.terminal ?? vscode.window.createTerminal({
    name: opts.name, cwd: opts.cwd, shellPath: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    iconPath: new vscode.ThemeIcon('terminal'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const q = (s: string) => process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
  terminal.sendText(`${process.platform === 'win32' ? '& ' : ''}${[process.execPath, script, config].map(q).join(' ')}`);
  const result: ClaudeResult = { text: '', isError: false, exitCode: null, signal: null, stderr: '' };
  let offset = 0, buffer = '', settled = false, sawResult = false;
  const decoder = new StringDecoder('utf8');
  const adapt = eventAdapter(opts.provider);
  let resolve!: (r: ClaudeResult) => void;
  const done = new Promise<ClaudeResult>(r => resolve = r);
  const read = () => {
    if (!fs.existsSync(events)) return;
    const size = fs.statSync(events).size;
    if (size <= offset) return;
    const fd = fs.openSync(events, 'r');
    const bytes = Buffer.alloc(size - offset);
    try { offset += fs.readSync(fd, bytes, 0, bytes.length, offset); } finally { fs.closeSync(fd); }
    buffer += decoder.write(bytes);
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try {
        const e = adapt(JSON.parse(line));
        if (e.type === 'error') result.stderr = e.message ?? e.error?.message ?? 'Agent error';
        if (e.session_id) result.sessionId = e.session_id;
        if (e.type === 'result') {
          sawResult = true;
          Object.assign(result, { text: e.result ?? '', isError: !!e.is_error || e.subtype !== 'success', costUsd: e.total_cost_usd });
        }
        opts.onEvent(e);
      } catch { /* Incomplete/non-JSON output cannot record a success. */ }
    }
  };
  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    try { read(); } catch (e) { result.stderr = String(e); code = 1; }
    clearInterval(timer); close.dispose();
    result.exitCode = code; result.isError ||= code !== 0 || !sawResult;
    fs.rmSync(dir, { recursive: true, force: true }); resolve(result);
  };
  const timer = setInterval(() => {
    try {
      read();
      if (fs.existsSync(exit)) finish(Number(fs.readFileSync(exit, 'utf8')));
    } catch (e) { result.stderr = String(e); finish(1); }
  }, 150);
  const close = vscode.window.onDidCloseTerminal(t => { if (t === terminal) finish(1); });
  return { terminal, done, kill: () => { terminal.dispose(); finish(1); } };
}

export async function revealAgentTerminal(terminal: vscode.Terminal): Promise<void> {
  terminal.show();
  await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
}
