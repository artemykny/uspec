import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { showNode } from '../core/paths';
import { NodeViewProvider, type NodeTarget } from './nodeView';
import { contextModes, renderOverview, type Mode, type OverviewAction, type OverviewContext } from './nodeOverview';
export { renderOverview } from './nodeOverview';

/** One reused overview tab beside the editor; follows the shared target without revealing the editor on refresh. */
export class NodeWindow implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private actions: OverviewAction[] = [];
  private generation = 0;
  private request = 0;
  /** The context the overview shows, kept while the target stays the same. */
  private mode?: Mode;
  private modeKey?: string;
  private modes: Mode[] = [];
  private readonly sub: vscode.Disposable;
  constructor(private readonly view: NodeViewProvider) {
    this.sub = view.onDidChangeTreeData(() => { void this.refresh(); });
  }
  get currentPanel(): vscode.WebviewPanel | undefined { return this.panel; }
  dispose(): void { this.sub.dispose(); this.panel?.dispose(); }
  show(target: NodeTarget): void {
    this.view.setTarget(target);
    if (!this.panel) {
      const panel = this.panel = vscode.window.createWebviewPanel('uspec.nodeOverview', showNode(target.node), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
      const message = panel.webview.onDidReceiveMessage(m => {
        if (m?.generation !== this.generation) return;
        // The Write / Implement switch: only a mode the overview offers, never a command.
        if (typeof m.mode === 'string') {
          if (this.modes.includes(m.mode) && m.mode !== this.mode) { this.mode = m.mode; void this.refresh(); }
          return;
        }
        if (!Number.isInteger(m.action)) return;
        const a = this.actions[m.action];
        if (a) void vscode.commands.executeCommand(a.command, ...a.args);
      });
      panel.onDidDispose(() => { message.dispose(); this.panel = undefined; this.actions = []; this.modes = []; this.generation++; this.request++; });
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
    this.modes = [];
    const target = this.view.target;
    if (!target || !target.p.nodes.has(target.node)) {
      panel.webview.html = '<!doctype html><html><body><p>No node selected</p></body></html>';
      return;
    }
    this.modes = contextModes(target);
    const key = `${target.p.root}\0${target.node}\0${target.doc ?? ''}`;
    if (key !== this.modeKey || !this.mode || !this.modes.includes(this.mode)) {
      this.modeKey = key;
      this.mode = this.modes[0];
    }
    const mode = this.mode;
    const render = (context?: OverviewContext) => {
      const result = renderOverview(target, mode, context, randomBytes(16).toString('base64'), ++this.generation);
      this.actions = result.actions;
      panel.webview.html = result.html;
    };
    panel.title = `${showNode(target.node)} · overview`;
    render();
    if (!mode) return;
    let context: OverviewContext;
    try { context = { mode, value: await this.view.context(mode) }; }
    catch (e) { context = { mode, error: e instanceof Error ? e.message : String(e) }; }
    if (request !== this.request || this.panel !== panel) return;
    render(context);
  }
}
