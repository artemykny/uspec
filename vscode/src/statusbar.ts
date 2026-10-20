// Status bar: the active change and what is left (a click opens its state window), and the node of the active file.
import * as vscode from 'vscode';
import type { AgentManager } from './agents';
import { docKey, showNode } from './core/paths';
import type { ProjectManager } from './projects';
import { summary } from './views/changesView';

export class StatusBar implements vscode.Disposable {
  private readonly change = vscode.window.createStatusBarItem('uspec.change', vscode.StatusBarAlignment.Left, 50);
  private readonly node = vscode.window.createStatusBarItem('uspec.node', vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly manager: ProjectManager,
    private readonly agents: AgentManager,
  ) {
    this.change.name = 'uspec change';
    this.node.name = 'uspec node';
    this.node.command = 'uspec.revealActiveFile';
    this.disposables = [
      this.change,
      this.node,
      manager.onDidChange(() => this.update()),
      agents.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    ];
    this.update();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private update(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const p = this.manager.projectFor(uri) ?? (this.manager.projects.length === 1 ? this.manager.projects[0] : undefined);
    const c = p?.activeChange;
    if (p && c) {
      const running = this.agents.runsOf(p, c.name).filter((r) => r.state === 'running').length;
      const waiting = this.agents.waiting(p, c.name);
      const extra = [running ? `${running} running` : '', waiting ? `${waiting} to approve` : ''].filter(Boolean);
      this.change.text = `${running ? '$(loading~spin)' : '$(git-pull-request-draft)'} ${c.name} · ${[summary(c), ...extra].join(' · ')}`;
      this.change.tooltip = `uspec change ${c.name}${p.changes.length > 1 ? ` (${p.changes.length} open)` : ''} · click to open its state`;
      this.change.command = { command: 'uspec.change.showState', title: 'Show State', arguments: [{ p, name: c.name }] };
      this.change.show();
    } else {
      this.change.hide();
    }
    const t = uri && p?.contains(uri.fsPath) ? p.target(uri.fsPath) : undefined;
    if (p && t && p.nodes.has(t.node)) {
      // The node's drift, and the active document's.
      const drift = [...(p.nodeDrift.get(t.node) ?? []), ...(t.spec?.kind === 'doc' && t.doc ? (p.docDrift.get(docKey(t.node, t.doc)) ?? []) : [])];
      this.node.text = `${drift.length ? '$(warning)' : '$(type-hierarchy)'} ${showNode(t.node)}`;
      this.node.tooltip = `${t.code ? 'Code of' : 'Spec node'} ${showNode(t.node)} (${p.nodes.get(t.node)?.type ?? '?'})${drift.length ? ` — drift: ${drift.join('; ')}` : ''}`;
      this.node.show();
    } else {
      this.node.hide();
    }
  }
}
