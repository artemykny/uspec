// Badges in the Explorer and the Spec Tree: document states in the active change, nodes under
// implementation, drift, unwritten documents (docs/vscode/overview.md#views).
import * as vscode from 'vscode';
import type { DocState } from './core/model';
import { codePaths, STATE_LABEL, type ProjectManager } from './projects';

const BADGE: Record<DocState, { badge: string; color?: string }> = {
  pending: { badge: 'P', color: 'charts.yellow' },
  affected: { badge: 'A', color: 'charts.orange' },
  updated: { badge: 'U', color: 'charts.blue' },
  'no-change': { badge: '✓' },
};

export class Decorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private map = new Map<string, vscode.FileDecoration>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly manager: ProjectManager) {
    this.disposables = [vscode.window.registerFileDecorationProvider(this), manager.onDidChange(() => this.rebuild()), this.emitter];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === 'file' ? this.map.get(uri.fsPath) : undefined;
  }

  private rebuild(): void {
    const map = new Map<string, vscode.FileDecoration>();
    for (const p of this.manager.projects) {
      for (const key of p.unwritten) {
        map.set(p.abs(p.docFile(key)), new vscode.FileDecoration(undefined, 'Not written yet', new vscode.ThemeColor('list.deemphasizedForeground')));
      }
      const change = p.activeChange;
      if (change) {
        for (const d of change.docs.values()) {
          const b = BADGE[d.state];
          const tip = `${change.name}: ${STATE_LABEL[d.state]}${d.reason ? ` — ${d.reason}` : d.via.length ? ` — ${d.via.join('; ')}` : ''}`;
          map.set(p.abs(p.docFile(d.document)), new vscode.FileDecoration(b.badge, tip, b.color ? new vscode.ThemeColor(b.color) : undefined));
        }
        for (const [node, state] of change.impl) {
          map.set(
            p.abs(p.nodeDir(node)),
            state === 'done'
              ? new vscode.FileDecoration('✓', `${change.name}: implemented`)
              : new vscode.FileDecoration('I', `${change.name}: to implement`, new vscode.ThemeColor('charts.purple')),
          );
        }
      }
      for (const [node, reason] of p.drift) {
        const deco = new vscode.FileDecoration('D', `Drift: ${reason}`, new vscode.ThemeColor('list.warningForeground'));
        map.set(p.abs(p.nodeDir(node)), deco);
        for (const c of codePaths(p, node)) map.set(p.abs(c.path), deco);
      }
    }
    this.map = map;
    this.emitter.fire(undefined);
  }
}
