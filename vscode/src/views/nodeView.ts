// The Node view: the node of the active file, its template, links, code, state and context
// (docs/vscode/overview.md#views).
import * as vscode from 'vscode';
import { CONTEXT_GROUPS, type ContextFileJson, type ContextJson } from '../core/model';
import { docKey, showNode } from '../core/paths';
import { codePaths, STATE_LABEL, type Project, type ProjectManager } from '../projects';

export interface NodeTarget {
  p: Project;
  node: string;
  doc?: string;
}

type Mode = 'document' | 'implement';

export type NodeEl =
  | { kind: 'title' }
  | { kind: 'template' }
  | { kind: 'section'; section: 'upstream' | 'downstream' | 'code' }
  | { kind: 'link'; node: string; doc?: string; section?: string }
  | { kind: 'code'; path: string; dir: boolean }
  | { kind: 'state' }
  | { kind: 'drift' }
  | { kind: 'context'; mode: Mode }
  | { kind: 'instructions'; mode: Mode; name: string; text: string | null }
  | { kind: 'group'; mode: Mode; group: string; files: ContextFileJson[]; baseline: string | null }
  | { kind: 'file'; path: string; section: string | null; note: string | null; baseline: string | null }
  | { kind: 'error'; text: string };

export class NodeViewProvider implements vscode.TreeDataProvider<NodeEl>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<NodeEl | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;
  private contexts = new Map<Mode, Promise<ContextJson>>();
  private followedFile?: vscode.Uri;
  target?: NodeTarget;

  constructor(private readonly manager: ProjectManager) {
    this.sub = manager.onDidChange(() => {
      this.contexts.clear();
      // A followed file that belongs to no node leaves the target on its last node, while that node exists.
      const followed = this.followedFile && this.fileTarget(this.followedFile);
      if (followed) this.target = followed;
      else if (this.target && (!manager.projects.includes(this.target.p) || !this.target.p.nodes.has(this.target.node))) this.target = undefined;
      this.emitter.fire(undefined);
    });
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  setTarget(t: NodeTarget | undefined): void {
    this.followedFile = undefined;
    if (t && this.target && t.p === this.target.p && t.node === this.target.node && t.doc === this.target.doc) return;
    if (!t && !this.target) return;
    this.target = t;
    this.contexts.clear();
    this.emitter.fire(undefined);
  }

  /** Re-evaluate ownership on model changes as well as editor changes; a file of no node keeps the target. */
  followFile(uri: vscode.Uri): void {
    const t = this.fileTarget(uri);
    if (t) this.setTarget(t);
    this.followedFile = uri;
  }

  private fileTarget(uri: vscode.Uri): NodeTarget | undefined {
    const p = this.manager.projectFor(uri);
    const t = p?.target(uri.fsPath);
    return p && t && p.nodes.has(t.node) && (t.code || t.spec?.kind !== 'other')
      ? { p, node: t.node, doc: t.code ? undefined : t.doc } : undefined;
  }

  /** The `uspec context` JSON for the target, as the Node view shows it. */
  context(mode: Mode): Promise<ContextJson> {
    let c = this.contexts.get(mode);
    if (!c) {
      const t = this.target!;
      c = this.manager.json<ContextJson>(t.p, contextArgs(t, mode));
      this.contexts.set(mode, c);
    }
    return c;
  }

  async getChildren(el?: NodeEl): Promise<NodeEl[]> {
    const t = this.target;
    if (!t) return [];
    const n = t.p.nodes.get(t.node);
    if (!n) return [];
    if (!el) {
      const out: NodeEl[] = [{ kind: 'title' }];
      if (t.doc) out.push({ kind: 'template' });
      if (t.p.activeChange && (t.doc ? t.p.docState(docKey(t.node, t.doc)) : t.p.activeChange.impl.has(t.node))) out.push({ kind: 'state' });
      if (t.p.drift.has(t.node)) out.push({ kind: 'drift' });
      out.push({ kind: 'section', section: 'upstream' }, { kind: 'section', section: 'downstream' });
      if (n.code.length) out.push({ kind: 'section', section: 'code' });
      if (t.doc) out.push({ kind: 'context', mode: 'document' });
      if (t.p.hasCode(t.node)) out.push({ kind: 'context', mode: 'implement' });
      return out;
    }
    switch (el.kind) {
      case 'section':
        if (el.section === 'upstream') return n.deps.map((l) => ({ kind: 'link', node: l.node, doc: l.doc, section: l.section }));
        if (el.section === 'downstream') return (t.p.downstream.get(t.node) ?? []).map((l) => ({ kind: 'link', node: l }));
        return codePaths(t.p, t.node).map((c) => ({ kind: 'code', path: c.path, dir: c.dir }));
      case 'context': {
        try {
          const ctx = await this.context(el.mode);
          const out: NodeEl[] = [{ kind: 'instructions', mode: el.mode, name: ctx.instructions.type, text: ctx.instructions.text }];
          for (const g of CONTEXT_GROUPS) {
            const files = ctx.files[g];
            if (files?.length) out.push({ kind: 'group', mode: el.mode, group: g, files, baseline: ctx.baseline });
          }
          return out;
        } catch (e) {
          return [{ kind: 'error', text: e instanceof Error ? e.message : String(e) }];
        }
      }
      case 'group':
        return el.files.map((f) => ({ kind: 'file', path: f.path, section: f.section ?? null, note: f.note, baseline: el.baseline }));
      default:
        return [];
    }
  }

  getTreeItem(el: NodeEl): vscode.TreeItem {
    const t = this.target!;
    const p = t.p;
    const n = p.nodes.get(t.node)!;
    const type = p.typeOf(t.node);
    switch (el.kind) {
      case 'title': {
        const item = new vscode.TreeItem(showNode(t.node));
        item.description = type ? type.name : (n.type ?? 'no type');
        item.tooltip = type?.description ?? undefined;
        item.iconPath = new vscode.ThemeIcon(type?.code ? 'file-code' : 'symbol-namespace');
        item.command = { command: 'uspec.revealNode', title: 'Reveal', arguments: [p.root, t.node] };
        return item;
      }
      case 'template': {
        const td = p.typeDoc(t.node, t.doc!);
        const item = new vscode.TreeItem(`${t.doc}.md`);
        const flags = [td?.required === false ? 'optional' : 'required', td?.exposed === false ? 'internal' : 'exposed'];
        if (td?.extra) flags.push('extra files');
        if (td?.derives_from.length) flags.push(`derives from ${td.derives_from.join(', ')}`);
        item.description = flags.join(' · ');
        item.tooltip = td?.description?.trim();
        item.iconPath = new vscode.ThemeIcon('note');
        if (td?.template) item.command = { command: 'vscode.open', title: 'Open template', arguments: [p.uriOf(td.template)] };
        return item;
      }
      case 'state': {
        const change = p.activeChange!;
        if (t.doc) {
          const s = p.docState(docKey(t.node, t.doc))!;
          const item = new vscode.TreeItem(`${change.name}: ${STATE_LABEL[s.state]}`);
          item.description = s.reason ?? s.via.join('; ');
          item.tooltip = item.description;
          item.iconPath = new vscode.ThemeIcon('git-pull-request-draft');
          return item;
        }
        const item = new vscode.TreeItem(`${change.name}: ${change.impl.get(t.node) === 'done' ? 'implemented' : 'to implement'}`);
        item.iconPath = new vscode.ThemeIcon('git-pull-request-draft');
        return item;
      }
      case 'drift': {
        const item = new vscode.TreeItem('Drift');
        item.description = p.drift.get(t.node);
        item.tooltip = item.description;
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        return item;
      }
      case 'section': {
        const count = el.section === 'upstream' ? n.deps.length : el.section === 'downstream' ? (p.downstream.get(t.node)?.length ?? 0) : n.code.length;
        const label = el.section === 'upstream' ? 'Upstream' : el.section === 'downstream' ? 'Downstream' : 'Code';
        const item = new vscode.TreeItem(label, count ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        item.description = String(count);
        item.tooltip =
          el.section === 'upstream' ? 'What this node derives from: nodes, or one document or section of a node' : el.section === 'downstream' ? 'Nodes that derive from this node' : 'Code paths';
        item.iconPath = new vscode.ThemeIcon(el.section === 'upstream' ? 'arrow-up' : el.section === 'downstream' ? 'arrow-down' : 'code');
        return item;
      }
      case 'link': {
        const item = new vscode.TreeItem(showNode(el.node));
        const lt = p.typeOf(el.node);
        const type = p.nodes.get(el.node)?.type ?? 'missing';
        item.description = el.doc ? `${el.doc}.md${el.section ? `#${el.section}` : ''} · ${type}` : type;
        item.tooltip = el.doc ? `Only ${el.section ? `the ${el.section} section of ` : ''}${el.doc}.md of ${showNode(el.node)}` : (lt?.description ?? undefined);
        item.iconPath = new vscode.ThemeIcon(el.section ? 'symbol-key' : el.doc ? 'file' : lt?.code ? 'file-code' : 'symbol-namespace');
        item.command = el.doc
          ? { command: 'uspec.openSection', title: 'Open', arguments: [p.root, p.docFile(docKey(el.node, el.doc)), el.section] }
          : { command: 'uspec.revealNode', title: 'Reveal', arguments: [p.root, el.node, true] };
        return item;
      }
      case 'code': {
        const item = new vscode.TreeItem(el.dir ? `${el.path}/` : el.path);
        item.resourceUri = p.uriOf(el.path);
        item.iconPath = el.dir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        item.command = { command: 'uspec.revealPath', title: 'Reveal', arguments: [p.root, el.path] };
        return item;
      }
      case 'context': {
        const item = new vscode.TreeItem(el.mode === 'document' ? `Context: write ${t.doc}.md` : 'Context: implement', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ctx|${p.root}|${t.node}|${t.doc ?? ''}|${el.mode}|${p.activeChange?.name ?? ''}`;
        item.description = p.activeChange ? `with ${p.activeChange.name}` : undefined;
        item.tooltip = `What an agent reads: uspec ${contextArgs(t, el.mode).join(' ')}`;
        item.iconPath = new vscode.ThemeIcon('list-tree');
        item.contextValue = 'uspec.contextGroup';
        return item;
      }
      case 'instructions': {
        const item = new vscode.TreeItem('instructions');
        item.description = el.text ? `${el.name} type` : `${el.name} type: none`;
        if (el.text) {
          const md = new vscode.MarkdownString();
          md.appendCodeblock(el.text.trim(), 'text');
          item.tooltip = md;
        }
        item.iconPath = new vscode.ThemeIcon('info');
        item.command = { command: 'uspec.context.show', title: 'Show context', arguments: [{ kind: 'context', mode: el.mode }] };
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(el.group, el.group === 'ancestors' || el.group === 'code' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        item.id = `ctx|${p.root}|${t.node}|${t.doc ?? ''}|${el.mode}|${p.activeChange?.name ?? ''}|${el.group}`;
        item.description = String(el.files.length);
        item.iconPath = new vscode.ThemeIcon('folder-library');
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(el.section ? `${el.path}#${el.section}` : el.path);
        item.resourceUri = p.uriOf(el.path);
        item.description = el.note ?? (el.section ? 'this section only' : undefined);
        item.iconPath = el.path.endsWith('/') ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        if (el.note?.startsWith('diff since') && el.baseline) {
          item.command = { command: 'uspec.diffFile', title: 'Diff', arguments: [p.root, el.path, el.baseline] };
        } else if (el.path.endsWith('/')) {
          item.command = { command: 'uspec.revealPath', title: 'Reveal', arguments: [p.root, el.path] };
        } else if (el.section) {
          item.command = { command: 'uspec.openSection', title: 'Open', arguments: [p.root, el.path, el.section] };
        } else {
          item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
        }
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(el.text);
        item.tooltip = el.text;
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
        return item;
      }
    }
  }
}

export function contextArgs(t: NodeTarget, mode: Mode): string[] {
  const args = ['context', showNode(t.node), ...(mode === 'document' ? ['--document', t.doc!] : ['--implement'])];
  const change = t.p.activeChange;
  if (change) args.push('--change', change.name);
  return args;
}
