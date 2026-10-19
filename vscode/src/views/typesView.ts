// The Node Types view, from `uspec types` (docs/vscode/overview.md#views).
import * as vscode from 'vscode';
import type { NodeTypeJson, TypeDocJson } from '../core/model';
import type { Project, ProjectManager } from '../projects';

export type TypeEl =
  | { kind: 'project'; p: Project }
  | { kind: 'type'; p: Project; t: NodeTypeJson }
  | { kind: 'doc'; p: Project; t: NodeTypeJson; d: TypeDocJson }
  | { kind: 'info'; label: string; value: string };

export class TypesViewProvider implements vscode.TreeDataProvider<TypeEl>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TypeEl | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly manager: ProjectManager) {
    this.sub = manager.onDidChange(() => this.emitter.fire(undefined));
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  getChildren(el?: TypeEl): TypeEl[] {
    if (!el) {
      const ps = this.manager.projects;
      if (ps.length === 1) return this.typesOf(ps[0]);
      return ps.map((p) => ({ kind: 'project', p }));
    }
    switch (el.kind) {
      case 'project':
        return this.typesOf(el.p);
      case 'type':
        return [
          ...el.t.documents.map((d): TypeEl => ({ kind: 'doc', p: el.p, t: el.t, d })),
          { kind: 'info', label: 'children', value: el.t.children.join(', ') || 'none' },
          { kind: 'info', label: 'derives from', value: el.t.derives_from.join(', ') || 'none' },
        ];
      default:
        return [];
    }
  }

  private typesOf(p: Project): TypeEl[] {
    return [...p.types.values()].map((t) => ({ kind: 'type', p, t }));
  }

  getTreeItem(el: TypeEl): vscode.TreeItem {
    switch (el.kind) {
      case 'project': {
        const item = new vscode.TreeItem(el.p.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('repo');
        return item;
      }
      case 'type': {
        const item = new vscode.TreeItem(el.t.type, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${el.p.root}|type|${el.t.type}`;
        item.description = `${el.t.name}${el.t.code ? ' · code' : ''}`;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${el.t.name}** (\`${el.t.type}\`)${el.t.code ? ' · describes code' : ''}\n\n${el.t.description ?? ''}\n\n`);
        if (el.t.instructions) md.appendCodeblock(el.t.instructions.trim(), 'text');
        item.tooltip = md;
        item.iconPath = new vscode.ThemeIcon(el.t.code ? 'file-code' : 'symbol-namespace');
        item.command = { command: 'vscode.open', title: 'Open', arguments: [el.p.uriOf(el.t.path)] };
        item.contextValue = 'uspec.type';
        return item;
      }
      case 'doc': {
        const d = el.d;
        const item = new vscode.TreeItem(`${d.document}.md`);
        const flags = [];
        if (!d.required) flags.push('optional');
        if (!d.exposed) flags.push('internal');
        if (d.extra) flags.push('extra');
        if (d.derives_from.length) flags.push(`derives from ${d.derives_from.join(', ')}`);
        if (!d.template) flags.push('no template');
        item.description = flags.join(' · ');
        item.tooltip = d.description?.trim();
        item.iconPath = new vscode.ThemeIcon('note');
        if (d.template) item.command = { command: 'vscode.open', title: 'Open template', arguments: [el.p.uriOf(d.template)] };
        item.contextValue = 'uspec.typeDoc';
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(el.label);
        item.description = el.value;
        item.iconPath = new vscode.ThemeIcon(el.label === 'children' ? 'type-hierarchy-sub' : 'references');
        return item;
      }
    }
  }
}
