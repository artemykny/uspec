import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { showNode } from '../core/paths';
import { NodeViewProvider, type NodeTarget } from './nodeView';
import { renderOverview, type OverviewAction, type OverviewContext } from './nodeOverview';
export { renderOverview } from './nodeOverview';
type Mode = 'document' | 'implement';

/** Follows the shared target without revealing the editor on refresh. */
export class NodeWindow implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private actions: OverviewAction[] = [];
  private generation = 0;
  private request = 0;
  private readonly sub: vscode.Disposable;
  constructor(private readonly view: NodeViewProvider) {
    this.sub = view.onDidChangeTreeData(() => { void this.refresh(); });
  }
  get currentPanel(): vscode.WebviewPanel | undefined { return this.panel; }
  dispose(): void { this.sub.dispose(); this.panel?.dispose(); }
  show(target: NodeTarget): void {
    this.view.setTarget(target);
    if (!this.panel) {
      const panel = this.panel = vscode.window.createWebviewPanel('uspec.nodeOverview', showNode(target.node), vscode.ViewColumn.Active, { enableScripts: true });
      const message = panel.webview.onDidReceiveMessage(m => {
        if (m?.generation !== this.generation || !Number.isInteger(m.action)) return;
        const a = this.actions[m.action];
        if (a) void vscode.commands.executeCommand(a.command, ...a.args);
      });
      panel.onDidDispose(() => { message.dispose(); this.panel = undefined; this.actions = []; this.generation++; this.request++; });
    }
    void this.refresh();
    this.panel.reveal(undefined, true);
  }
  private async refresh(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const request = ++this.request;
    this.generation++;
    this.actions = [];
    const target = this.view.target;
    if (!target || !target.p.nodes.has(target.node)) {
      panel.webview.html = '<!doctype html><html><body><p>No node selected</p></body></html>';
      return;
    }
    const render = (contexts: OverviewContext[]) => {
      const result = renderOverview(target, contexts, randomBytes(16).toString('base64'), ++this.generation);
      this.actions = result.actions;
      panel.webview.html = result.html;
    };
    panel.title = `${showNode(target.node)} · overview`;
    render([]);
    const modes: Mode[] = [...(target.doc ? ['document' as const] : []), ...(target.p.hasCode(target.node) ? ['implement' as const] : [])];
    const contexts = await Promise.all(modes.map(async (mode): Promise<OverviewContext> => {
      try { return { mode, value: await this.view.context(mode) }; }
      catch (e) { return { mode, error: e instanceof Error ? e.message : String(e) }; }
    }));
    if (request !== this.request || this.panel !== panel) return;
    render(contexts);
  }
}
