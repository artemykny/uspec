// Claude Code in a terminal for work that needs a conversation, and installing the skills
// (docs/vscode/overview.md#agents).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
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

export function claudeOrComplain(): string | undefined {
  const c = findClaude();
  if (!c) {
    void vscode.window
      .showErrorMessage('Claude Code wasn’t found. Install it, or set uspec.claudePath.', 'Open Settings')
      .then((a) => a && vscode.commands.executeCommand('workbench.action.openSettings', 'uspec.claudePath'));
  }
  return c;
}

function quote(s: string): string {
  if (process.platform === 'win32') return `"${s.replace(/"/g, '""')}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Opens a terminal in the project root running `claude <args>`. */
export function openClaude(p: Project, args: string[], name = 'Claude Code · uspec'): void {
  const claude = claudeOrComplain();
  if (!claude) return;
  const term = vscode.window.createTerminal({ name, cwd: p.root, iconPath: new vscode.ThemeIcon('sparkle') });
  term.show();
  term.sendText([claude, ...args].map(quote).join(' '));
}

/** Where a skill is installed for a project, if anywhere. */
export function installedSkill(p: Project, skill: string): string | undefined {
  return [path.join(p.root, '.claude', 'skills', skill), path.join(os.homedir(), '.claude', 'skills', skill)].find((d) =>
    fs.existsSync(path.join(d, 'SKILL.md')),
  );
}

/** Makes sure the skills a terminal session needs are installed; offers to install them. */
export async function ensureSkills(p: Project, extensionPath: string, skills: string[]): Promise<boolean> {
  const missing = skills.filter((s) => !installedSkill(p, s));
  if (!missing.length) return true;
  const pick = await vscode.window.showWarningMessage(
    `${missing.join(', ')} ${missing.length > 1 ? 'aren’t' : 'isn’t'} installed for ${p.name}. Claude Code needs the skills to run it.`,
    'Install Skills',
    'Run Anyway',
  );
  if (pick === 'Install Skills') return installSkills(p, extensionPath);
  return pick === 'Run Anyway';
}

/** Copies the bundled skills into the project's `.claude/skills/`. */
export async function installSkills(p: Project, extensionPath: string): Promise<boolean> {
  const from = path.join(extensionPath, 'skills');
  const to = path.join(p.root, '.claude', 'skills');
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
export function promptFile(p: Project, extensionPath: string, skill: string, file: string): string | undefined {
  return [
    path.join(p.root, '.claude', 'skills', skill, file),
    path.join(os.homedir(), '.claude', 'skills', skill, file),
    path.join(extensionPath, 'skills', skill, file),
  ].find((f) => fs.existsSync(f));
}
