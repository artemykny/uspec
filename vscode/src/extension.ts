// The uspec extension: wires the project model to the views, editor features and commands
// (docs/vscode/overview.md).
import * as vscode from 'vscode';
import { AgentManager } from './agents';
import { DocumentLenses } from './codelens';
import { registerCommands } from './commands';
import { ContentProvider } from './content';
import { Decorations } from './decorations';
import { Diagnostics } from './diagnostics';
import { Editing } from './editing';
import { ProjectManager } from './projects';
import { StatusBar } from './statusbar';
import { ChangesViewProvider } from './views/changesView';
import { NodeViewProvider } from './views/nodeView';
import { SpecTreeProvider, type SpecEl } from './views/specTree';
import { NodeWindow } from './views/nodeWindow';
import { StateWindows } from './views/stateWindow';
import { TypesViewProvider } from './views/typesView';

/** What the integration tests reach through `extension.exports`. */
export interface UspecApi {
  manager: ProjectManager;
  agents: AgentManager;
  specTree: SpecTreeProvider;
  changes: ChangesViewProvider;
  nodeView: NodeViewProvider;
  stateWindows: StateWindows;
  ready: Promise<void>;
}

export function activate(ctx: vscode.ExtensionContext): UspecApi {
  const manager = new ProjectManager();
  const content = new ContentProvider();
  const agents = new AgentManager(manager, content, ctx.extensionPath, ctx.workspaceState);

  const changes = new ChangesViewProvider(manager, agents);
  const types = new TypesViewProvider(manager);
  const specTree = new SpecTreeProvider(manager, changes, types);
  const specTreeView = vscode.window.createTreeView<SpecEl>('uspec.specTree', { treeDataProvider: specTree, showCollapseAll: true });
  const nodeView = new NodeViewProvider(manager);
  const nodeWindow = new NodeWindow();
  const stateWindows = new StateWindows(manager, agents);

  ctx.subscriptions.push(
    manager,
    content,
    agents,
    specTree,
    specTreeView,
    nodeView,
    changes,
    types,
    stateWindows,
    nodeWindow,
    new Diagnostics(manager),
    new Decorations(manager),
    new Editing(manager),
    new DocumentLenses(manager),
    new StatusBar(manager, agents),
  );

  registerCommands(ctx, { manager, agents, content, specTree, specTreeView, nodeView, stateWindows, extensionPath: ctx.extensionPath });

  // The Node view and the Spec Tree follow the active file; a selection in the Spec Tree shows its node.
  const follow = (editor: vscode.TextEditor | undefined) => {
    const uri = editor?.document.uri;
    const p = manager.projectFor(uri);
    if (!p || !uri) return;
    const t = p.target(uri.fsPath);
    nodeView.setTarget(t && p.nodes.has(t.node) ? { p, node: t.node, doc: t.code ? undefined : t.doc } : undefined);
    if (specTreeView.visible && vscode.workspace.getConfiguration('uspec').get('specTree.followActiveEditor', true)) {
      const el = specTree.elementFor(p, uri.fsPath);
      if (el) void Promise.resolve(specTreeView.reveal(el, { select: true, focus: false })).catch(() => undefined);
    }
  };
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(follow),
    specTreeView.onDidChangeSelection((e) => {
      const el = e.selection[0];
      if (el?.kind === 'node') { nodeView.setTarget({ p: el.p, node: el.node }); nodeWindow.show(el.p, el.node); }
      else if (el?.kind === 'doc' && !el.missing) nodeView.setTarget({ p: el.p, node: el.node, doc: el.doc });
    }),
    manager.onDidChange(() => {
      void vscode.commands.executeCommand('setContext', 'uspec.hasProject', manager.projects.length > 0);
      void vscode.commands.executeCommand('setContext', 'uspec.hasChanges', manager.projects.some((p) => p.changes.length > 0));
      void vscode.commands.executeCommand('setContext', 'uspec.loaded', manager.loaded);
      if (!nodeView.target) follow(vscode.window.activeTextEditor);
    }),
  );

  const ready = manager.discover().then(() => { agents.restore(); follow(vscode.window.activeTextEditor); });
  return { manager, agents, specTree, changes, nodeView, stateWindows, ready };
}

export function deactivate(): void {
  // Everything is disposed through the extension context.
}
