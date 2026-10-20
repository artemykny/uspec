// The Spec Tree view: nodes with their types, documents and children (docs/vscode/overview.md#views).
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ChangesViewProvider, ChangeEl } from './changesView';
import type { TypesViewProvider, TypeEl } from './typesView';
import { baseName, docKey, join, showNode } from '../core/paths';
import { STATE_LABEL, type Project, type ProjectManager } from '../projects';

export type SpecEl =
  | { kind: 'root'; branch: 'changes' | 'types' | 'specification' }
  | { kind: 'foreign'; branch: 'changes' | 'types'; value: ChangeEl | TypeEl; parent: SpecEl }
  | { kind: 'project'; p: Project }
  | { kind: 'node'; p: Project; node: string }
  | { kind: 'doc'; p: Project; node: string; doc: string; missing?: boolean }
  | { kind: 'extra'; p: Project; node: string; doc: string; rel: string; dir: boolean }
  | { kind: 'message'; p: Project; text: string };

export class SpecTreeProvider implements vscode.TreeDataProvider<SpecEl>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SpecEl | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;
  private readonly agentSub?: vscode.Disposable;
  private reveals = 0;

  get revealing(): boolean { return this.reveals > 0; }

  /** Selecting a row for navigation must not act like a user selecting its overview. */
  async reveal(view: vscode.TreeView<SpecEl>, el: SpecEl, options: Parameters<vscode.TreeView<SpecEl>['reveal']>[1]): Promise<void> {
    this.reveals++;
    try { await view.reveal(el, options); }
    finally { this.reveals--; }
  }

  constructor(private readonly manager: ProjectManager, private readonly changes?: ChangesViewProvider, private readonly types?: TypesViewProvider) {
    this.sub = manager.onDidChange(() => this.emitter.fire(undefined));
    this.agentSub = changes?.onDidChangeTreeData(() => this.emitter.fire(undefined));
  }

  dispose(): void {
    this.sub.dispose();
    this.agentSub?.dispose();
    this.emitter.dispose();
  }

  getChildren(el?: SpecEl): SpecEl[] {
    if (!el) {
      // Empty, so the welcome view explains how to get the CLI.
      if (this.manager.cliMissing) return [];
      if (this.changes && this.types) return ['changes', 'types', 'specification'].map(branch => ({ kind: 'root', branch } as SpecEl));
      const ps = this.manager.projects;
      if (ps.length === 1) return this.projectChildren(ps[0]);
      return ps.map((p) => ({ kind: 'project', p }));
    }
    switch (el.kind) {
      case 'root':
        if (el.branch === 'specification') return this.manager.projects.length === 1 ? this.projectChildren(this.manager.projects[0]) : this.manager.projects.map(p => ({ kind: 'project', p }));
        return (el.branch === 'changes' ? this.changes!.getChildren() : this.types!.getChildren()).map(value => ({ kind: 'foreign', branch: el.branch as 'changes' | 'types', value, parent: el }));
      case 'foreign':
        return (el.branch === 'changes' ? this.changes!.getChildren(el.value as ChangeEl) : this.types!.getChildren(el.value as TypeEl)).map(value => ({ kind: 'foreign', branch: el.branch, value, parent: el }));
      case 'project':
        return this.projectChildren(el.p);
      case 'node': {
        const n = el.p.nodes.get(el.node);
        if (!n) return [];
        const out: SpecEl[] = [];
        const t = el.p.typeOf(el.node);
        if (t) {
          for (const d of t.documents) {
            if (n.documents.includes(d.document)) out.push({ kind: 'doc', p: el.p, node: el.node, doc: d.document });
            else if (d.required) out.push({ kind: 'doc', p: el.p, node: el.node, doc: d.document, missing: true });
          }
        } else {
          for (const d of n.documents) out.push({ kind: 'doc', p: el.p, node: el.node, doc: d });
        }
        for (const c of n.children) out.push({ kind: 'node', p: el.p, node: c });
        return out;
      }
      case 'doc': {
        if (el.missing || !el.p.nodes.get(el.node)?.extras.includes(el.doc)) return [];
        return [{ kind: 'extra', p: el.p, node: el.node, doc: el.doc, rel: join(el.p.nodeDir(el.node), `${el.doc}-extra`), dir: true }];
      }
      case 'extra': {
        if (!el.dir) return [];
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(el.p.abs(el.rel), { withFileTypes: true });
        } catch {
          return [];
        }
        return entries
          .filter((e) => !e.name.startsWith('.'))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => ({ kind: 'extra', p: el.p, node: el.node, doc: el.doc, rel: `${el.rel}/${e.name}`, dir: e.isDirectory() }));
      }
      default:
        return [];
    }
  }

  private projectChildren(p: Project): SpecEl[] {
    if (p.error) return [{ kind: 'message', p, text: p.error }];
    return p.nodes.has('') ? [{ kind: 'node', p, node: '' }] : [];
  }

  getParent(el: SpecEl): SpecEl | undefined {
    const multi = this.manager.projects.length > 1;
    switch (el.kind) {
      case 'root': return undefined;
      case 'foreign': return el.parent;
      case 'project':
        return this.changes ? { kind: 'root', branch: 'specification' } : undefined;
      case 'message':
        return multi ? { kind: 'project', p: el.p } : this.changes ? { kind: 'root', branch: 'specification' } : undefined;
      case 'node': {
        const parent = el.p.nodes.get(el.node)?.parent;
        if (parent !== undefined) return { kind: 'node', p: el.p, node: parent };
        return multi ? { kind: 'project', p: el.p } : this.changes ? { kind: 'root', branch: 'specification' } : undefined;
      }
      case 'doc':
        return { kind: 'node', p: el.p, node: el.node };
      case 'extra': {
        const parentRel = el.rel.slice(0, el.rel.lastIndexOf('/'));
        if (parentRel === el.p.nodeDir(el.node) || el.rel === join(el.p.nodeDir(el.node), `${el.doc}-extra`)) {
          return { kind: 'doc', p: el.p, node: el.node, doc: el.doc };
        }
        return { kind: 'extra', p: el.p, node: el.node, doc: el.doc, rel: parentRel, dir: true };
      }
    }
  }

  getTreeItem(el: SpecEl): vscode.TreeItem {
    switch (el.kind) {
      case 'root': {
        const item = new vscode.TreeItem({changes: 'Changes', types: 'Node types', specification: 'Specification'}[el.branch], el.branch === 'specification' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `root:${el.branch}`; item.contextValue = `uspec.root.${el.branch}`;
        item.iconPath = new vscode.ThemeIcon({changes: 'git-pull-request', types: 'symbol-class', specification: 'root-folder'}[el.branch]);
        return item;
      }
      case 'foreign': return el.branch === 'changes' ? this.changes!.getTreeItem(el.value as ChangeEl) : this.types!.getTreeItem(el.value as TypeEl);
      case 'project': {
        const item = new vscode.TreeItem(el.p.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${el.p.root}|project`;
        item.description = vscode.workspace.asRelativePath(el.p.uri);
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'uspec.project';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(el.text);
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
        item.tooltip = el.text;
        return item;
      }
      case 'node':
        return nodeItem(el.p, el.node);
      case 'doc':
        return docItem(el.p, el.node, el.doc, el.missing);
      case 'extra': {
        const name = el.rel.slice(el.rel.lastIndexOf('/') + 1);
        const item = new vscode.TreeItem(el.dir ? `${name}/` : name, el.dir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `${el.p.root}|extra|${el.rel}`;
        item.resourceUri = el.p.uriOf(el.rel);
        item.iconPath = el.dir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        item.contextValue = 'uspec.extra';
        item.tooltip = `${name}\n${el.rel}`;
        if (!el.dir) item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
        return item;
      }
    }
  }

  /** The element for a file, to reveal it. */
  elementFor(p: Project, fsPath: string): SpecEl | undefined {
    const t = p.target(fsPath);
    if (!t || !t.spec) return undefined;
    if (t.spec.kind === 'doc' || t.spec.kind === 'extra') return { kind: 'doc', p, node: t.node, doc: t.spec.doc };
    return { kind: 'node', p, node: t.node };
  }
}

function nodeItem(p: Project, node: string): vscode.TreeItem {
  const n = p.nodes.get(node)!;
  const t = p.typeOf(node);
  const label = node ? baseName(node) : p.rootLabel;
  const hasKids = n.children.length > 0 || n.documents.length > 0 || Boolean(t?.documents.length);
  const item = new vscode.TreeItem(
    label,
    !hasKids ? vscode.TreeItemCollapsibleState.None : node === '' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = `${p.root}|node|${node}`;
  item.resourceUri = p.uriOf(p.nodeDir(node));
  item.description = `${n.type ?? '?'}${n.code.length ? ' · </>' : ''}`;
  const issues = p.nodeIssues(node);
  const code = t?.code ?? false;
  item.iconPath = issues.length
    ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
    : new vscode.ThemeIcon('symbol-namespace');
  const drift = p.nodeDrift.get(node);
  item.contextValue = `uspec.node${code ? ';code' : ''}${node === '' ? ';root' : ';child'}${drift ? ';drift' : ''}`;

  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${showNode(node)}** · ${t ? `${t.name} (\`${t.type}\`)` : `type \`${n.type ?? '?'}\``}\n\n`);
  md.appendText(`${p.nodeDir(node)}\n\n`);
  if (t?.description) md.appendMarkdown(`${t.description.trim()}\n\n`);
  if (n.deps.length) md.appendMarkdown(`Derives from: ${n.deps.map((l) => `\`${l.raw}\``).join(', ')}\n\n`);
  const down = p.downstream.get(node) ?? [];
  if (down.length) md.appendMarkdown(`Linked from: ${down.map((l) => `\`${showNode(l)}\``).join(', ')}\n\n`);
  if (n.code.length) md.appendMarkdown(`Code: ${n.code.map((c) => `\`${c}\``).join(', ')}\n\n`);
  for (const r of drift ?? []) md.appendMarkdown(`$(warning) Drift: ${escapeMd(r)}\n\n`);
  for (const i of issues) md.appendMarkdown(`$(error) ${escapeMd(i.message)}\n\n`);
  item.tooltip = md;
  return item;
}

function docItem(p: Project, node: string, doc: string, missing?: boolean): vscode.TreeItem {
  const key = docKey(node, doc);
  const td = p.typeDoc(node, doc);
  const extras = p.nodes.get(node)?.extras.includes(doc) ?? false;
  const item = new vscode.TreeItem(`${doc}.md`, extras && !missing ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.id = `${p.root}|doc|${key}`;
  const flags: string[] = [];
  if (missing) {
    item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    item.description = 'missing';
    item.tooltip = `${p.docFile(key)}\n${doc}.md is required by type \`${p.nodes.get(node)?.type}\` but doesn't exist.`;
    item.contextValue = 'uspec.missingDoc';
    return item;
  }
  item.resourceUri = p.uriOf(p.docFile(key));
  item.iconPath = vscode.ThemeIcon.File;
  item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
  const state = p.docState(key);
  if (state) flags.push(STATE_LABEL[state.state]);
  if (td && !td.required) flags.push('optional');
  if (td && !td.exposed) flags.push('internal');
  if (p.unwritten.has(key)) flags.push('unwritten');
  item.description = flags.join(' · ');
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${key}**\n\n`);
  md.appendText(`${p.docFile(key)}\n\n`);
  if (td?.description) md.appendMarkdown(`${td.description.trim()}\n\n`);
  if (td?.derives_from.length) md.appendMarkdown(`Derives from: ${td.derives_from.map((d) => `\`${d.replace(/(#.*)?$/, '.md$1')}\``).join(', ')}\n\n`);
  if (state) {
    const change = p.activeChange!.name;
    md.appendMarkdown(`**${change}**: ${STATE_LABEL[state.state]}${state.reason ? ` — ${escapeMd(state.reason)}` : ''}\n\n`);
    if (state.via.length && !state.reason) md.appendMarkdown(`Reached by: ${state.via.map(escapeMd).join('; ')}\n\n`);
  }
  const drift = p.docDrift.get(key);
  for (const r of drift ?? []) md.appendMarkdown(`$(warning) Drift: ${escapeMd(r)}\n\n`);
  item.tooltip = md;
  item.contextValue = `uspec.doc${state ? `;inChange;${state.state}` : ''}${p.activeChange ? ';active' : ''}${drift ? ';drift' : ''}`;
  return item;
}

export function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]<>#|]/g, (c) => `\\${c}`);
}
