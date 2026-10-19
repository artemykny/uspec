// The selected agent in a terminal for work that needs a conversation, and installing the skills
// (docs/vscode/overview.md#agents).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { revealAgentTerminal } from './agentTerminal';
import { type AgentProvider, providerLabel } from './core/provider';
import { onPath } from './core/cli';
import type { Project } from './projects';

const SKILLS = ['uspec-spec', 'uspec-review'];
/** Skills earlier versions installed that no longer exist. */
const REMOVED = ['uspec-implement'];

/** Claude Code: the setting, `claude` on the PATH, the usual install places, then the Claude Code extension's binary. */
export function findClaude(): string | undefined {
  const setting = vscode.workspace.getConfiguration('uspec').get<string>('claudePath', '').trim();
  if (setting) return setting.startsWith('~') ? path.join(os.homedir(), setting.slice(1)) : setting;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found =
    onPath('claude') ??
    [path.join(os.homedir(), '.local', 'bin', exe), path.join(os.homedir(), '.claude', 'local', exe)].find((p) => fs.existsSync(p));
  if (found) return found;
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const bundled = path.join(ext.extensionPath, 'resources', 'native-binary', exe);
    if (fs.existsSync(bundled)) return bundled;
  }
  return undefined;
}

export function selectedProvider(): AgentProvider {
  return vscode.workspace.getConfiguration('uspec').get<string>('agents.provider') === 'codex' ? 'codex' : 'claude';
}

export function agentOrComplain(provider = selectedProvider()): string | undefined {
  const setting = vscode.workspace.getConfiguration('uspec').get<string>('codexPath', '').trim();
  const executable = provider === 'claude' ? findClaude() : setting ? (setting.startsWith('~') ? path.join(os.homedir(), setting.slice(1)) : setting) : onPath('codex');
  if (!executable) {
    const key = `uspec.${provider}Path`;
    void vscode.window.showErrorMessage(`${providerLabel(provider)} wasn’t found. Install it, or set ${key}.`, 'Open Settings')
      .then(a => a && vscode.commands.executeCommand('workbench.action.openSettings', key));
  }
  return executable;
}

const skillFolder = (provider = selectedProvider()) => provider === 'codex' ? '.agents' : '.claude';

export function quote(s: string): string {
  if (process.platform === 'win32') return `'${s.replace(/'/g, "''")}'`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Opens a terminal in the project root running the selected CLI. */
export function openAgent(p: Project, args: string[], name?: string, provider = selectedProvider()): vscode.Terminal | undefined {
  const executable = agentOrComplain(provider);
  if (!executable) return;
  const term = vscode.window.createTerminal({ name: name ?? `${providerLabel(provider)} · uspec`, cwd: p.root, shellPath: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', iconPath: new vscode.ThemeIcon('sparkle') });
  void revealAgentTerminal(term);
  term.sendText((process.platform === 'win32' ? '& ' : '') + [executable, ...args].map(quote).join(' '));
  return term;
}

/** Where a skill is installed for a project, if anywhere. */
export function installedSkill(p: Project, skill: string): string | undefined {
  return [path.join(p.root, skillFolder(), 'skills', skill), path.join(os.homedir(), skillFolder(), 'skills', skill)].find((d) =>
    fs.existsSync(path.join(d, 'SKILL.md')),
  );
}

/** Makes sure the skills a terminal session needs are installed; offers to install them. */
export async function ensureSkills(p: Project, extensionPath: string, skills: string[]): Promise<boolean> {
  const missing = skills.filter((s) => !installedSkill(p, s));
  if (!missing.length) return true;
  const pick = await vscode.window.showWarningMessage(
    `${missing.join(', ')} ${missing.length > 1 ? 'aren’t' : 'isn’t'} installed for ${p.name}. ${providerLabel(selectedProvider())} needs the skills to run it.`,
    'Install Skills',
    'Run Anyway',
  );
  if (pick === 'Install Skills') return installSkills(p, extensionPath);
  return pick === 'Run Anyway';
}

/** Copies bundled skills into the selected provider’s project skill directory. */
export async function installSkills(p: Project, extensionPath: string): Promise<boolean> {
  const from = path.join(extensionPath, 'skills');
  const to = path.join(p.root, skillFolder(), 'skills');
  const existing = SKILLS.filter((s) => fs.existsSync(path.join(to, s)));
  if (existing.length) {
    const ok = await vscode.window.showWarningMessage(
      `Replace ${existing.join(', ')} in ${vscode.workspace.asRelativePath(to)}?`,
      { modal: true },
      'Replace',
    );
    if (ok !== 'Replace') return false;
  }
  for (const s of REMOVED) fs.rmSync(path.join(to, s), { recursive: true, force: true });
  for (const s of SKILLS) {
    const src = path.join(from, s);
    if (!fs.existsSync(src)) continue;
    fs.rmSync(path.join(to, s), { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(src, path.join(to, s), { recursive: true });
  }
  void vscode.window.showInformationMessage(`Installed ${SKILLS.join(', ')} into ${vscode.workspace.asRelativePath(to)}.`);
  return true;
}

/** The prompt file of a subagent: the project's skills, the user's, then the bundled copy. */
export function promptFile(p: Project, extensionPath: string, skill: string, file: string, provider = selectedProvider()): string | undefined {
  return [
    path.join(p.root, skillFolder(provider), 'skills', skill, file),
    path.join(os.homedir(), skillFolder(provider), 'skills', skill, file),
    path.join(extensionPath, 'skills', skill, file),
  ].find((f) => fs.existsSync(f));
}
