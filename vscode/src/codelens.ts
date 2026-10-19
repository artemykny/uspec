// The line at the top of a spec document: its template, its state in the active change, and actions
// (docs/vscode/overview.md#editing).
import * as vscode from 'vscode';
import { docKey } from './core/paths';
import { STATE_LABEL, type ProjectManager } from './projects';

function firstSentence(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  const out = m ? m[1] : flat;
  return out.length > 110 ? `${out.slice(0, 107)}…` : out;
}

export class DocumentLenses implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly manager: ProjectManager) {
    this.disposables = [
      vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'markdown' }, this),
      manager.onDidChange(() => this.emitter.fire()),
      this.emitter,
    ];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const p = this.manager.projectFor(doc.uri);
    const t = p?.target(doc.uri.fsPath);
    if (!p || !t || t.spec?.kind !== 'doc' || !t.doc) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    const type = p.typeOf(t.node);
    const td = p.typeDoc(t.node, t.doc);
    const key = docKey(t.node, t.doc);
    const target = { kind: 'doc', p, node: t.node, doc: t.doc };
    const lenses: vscode.CodeLens[] = [];
    const title = `${type?.name ?? t.node} · ${t.doc}.md${td?.description ? ` — ${firstSentence(td.description)}` : ''}`;
    lenses.push(new vscode.CodeLens(range, td?.template ? { title, command: 'vscode.open', arguments: [p.uriOf(td.template)], tooltip: td.description ?? undefined } : { title, command: '' }));
    lenses.push(new vscode.CodeLens(range, { title: 'Show context', command: 'uspec.context.show', arguments: [target] }));
    const change = p.activeChange;
    if (change) {
      const s = change.docs.get(key);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `${change.name}: ${s ? STATE_LABEL[s.state] : 'not in the change'}`,
          command: 'workbench.view.extension.uspec',
          tooltip: s?.reason ?? s?.via.join('; ') ?? 'Record it as updated once you have edited it for this change.',
        }),
      );
      if (s) lenses.push(new vscode.CodeLens(range, { title: 'Diff since baseline', command: 'uspec.change.diff', arguments: [target] }));
      if (s?.state !== 'updated') lenses.push(new vscode.CodeLens(range, { title: 'Record as updated', command: 'uspec.change.recordUpdated', arguments: [target] }));
      if (s?.state === 'affected') lenses.push(new vscode.CodeLens(range, { title: 'Run writer', command: 'uspec.agents.runWriter', arguments: [target] }));
    }
    return lenses;
  }
}
