// Editing help in node.yaml, node-type.yaml and template frontmatter: completion, hovers and links
// (docs/vscode/overview.md#editing).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findToken } from './core/issues';
import { nodeKey, normaliseCodePath, parentOf, showNode } from './core/paths';
import { frontmatterRange, listItems, yamlPosition, type YamlPosition } from './core/yaml';
import type { Project, ProjectManager } from './projects';

const NODE_KEYS = ['type', 'derives_from', 'code'];
const TYPE_KEYS = ['name', 'description', 'code', 'children', 'derives_from', 'documents', 'instructions'];
const TEMPLATE_KEYS = ['description', 'required', 'derives_from', 'exposed', 'extra'];

type FileKind = { kind: 'node'; p: Project; node: string } | { kind: 'type'; p: Project; type: string } | { kind: 'template'; p: Project; type: string; doc: string };

function kindOf(manager: ProjectManager, uri: vscode.Uri): FileKind | undefined {
  const p = manager.projectFor(uri);
  if (!p) return undefined;
  const rel = p.rel(uri.fsPath);
  const m = rel.match(/^\.uspec\/node-types\/([^/]+)\/([^/]+)$/);
  if (m) {
    if (m[2] === 'node-type.yaml') return { kind: 'type', p, type: m[1] };
    if (m[2].endsWith('.md')) return { kind: 'template', p, type: m[1], doc: m[2].slice(0, -3) };
    return undefined;
  }
  if (path.basename(uri.fsPath) === 'node.yaml') {
    const t = p.target(uri.fsPath);
    if (t?.spec?.kind === 'yaml') return { kind: 'node', p, node: t.node };
  }
  return undefined;
}

function item(label: string, kind: vscode.CompletionItemKind, detail?: string, doc?: string): vscode.CompletionItem {
  const c = new vscode.CompletionItem(label, kind);
  c.detail = detail;
  if (doc) c.documentation = new vscode.MarkdownString(doc);
  return c;
}

function keyItems(keys: string[], existing: string[], prefix: string): vscode.CompletionItem[] {
  return keys
    .filter((k) => !existing.includes(k) && k.startsWith(prefix))
    .map((k) => {
      const c = item(k, vscode.CompletionItemKind.Property);
      c.insertText = `${k}: `;
      c.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
      return c;
    });
}

function presentKeys(lines: string[]): string[] {
  return lines.map((l) => l.match(/^([A-Za-z_][\w-]*):/)?.[1]).filter((k): k is string => Boolean(k));
}

export class Editing implements vscode.CompletionItemProvider, vscode.HoverProvider, vscode.DocumentLinkProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly manager: ProjectManager) {
    const yaml: vscode.DocumentSelector = [
      { scheme: 'file', pattern: '**/node.yaml' },
      { scheme: 'file', pattern: '**/.uspec/node-types/*/node-type.yaml' },
    ];
    const templates: vscode.DocumentSelector = [{ scheme: 'file', pattern: '**/.uspec/node-types/*/*.md' }];
    this.disposables = [
      vscode.languages.registerCompletionItemProvider([...yaml, ...templates], this, ':', ' ', '-', '/', ',', '['),
      vscode.languages.registerHoverProvider(yaml, this),
      vscode.languages.registerDocumentLinkProvider([...yaml, ...templates], this),
    ];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    const k = kindOf(this.manager, doc.uri);
    if (!k) return undefined;
    let lines = doc.getText().split(/\r?\n/);
    if (k.kind === 'template') {
      const fm = frontmatterRange(lines);
      if (!fm || pos.line < fm[0] || pos.line > fm[1]) return undefined;
      lines = lines.slice(0, fm[1] + 1).map((l, i) => (i < fm[0] ? '' : l));
    }
    const at = yamlPosition(lines, pos.line, pos.character);
    if (!at) return undefined;
    const items = k.kind === 'node' ? this.nodeYaml(k.p, k.node, at, lines) : k.kind === 'type' ? this.typeYaml(k.p, k.type, at, lines) : this.frontmatter(k.p, k.type, at, lines);
    if (at.kind !== 'key') {
      const range = new vscode.Range(pos.line, pos.character - at.prefix.length, pos.line, pos.character);
      for (const c of items) c.range = range;
    }
    return items;
  }

  private nodeYaml(p: Project, node: string, at: YamlPosition, lines: string[]): vscode.CompletionItem[] {
    if (at.kind === 'key') {
      const t = p.typeOf(node);
      return keyItems(NODE_KEYS.filter((k) => k !== 'code' || t?.code !== false), presentKeys(lines), at.prefix);
    }
    if (at.key === 'type' && at.kind === 'value') {
      const parent = parentOf(node);
      const parentType = parent !== undefined ? p.typeOf(parent) : undefined;
      const allowed = parentType
        ? parentType.children
        : [...p.types.values()].filter((t) => ![...p.types.values()].some((o) => o.children.includes(t.type))).map((t) => t.type);
      return allowed
        .map((id) => p.types.get(id))
        .filter((t) => t !== undefined)
        .map((t) => item(t.type, vscode.CompletionItemKind.Class, t.name, t.description ?? undefined));
    }
    if (at.key === 'derives_from') {
      const t = p.typeOf(node);
      const existing = at.kind === 'item' ? at.existing : [];
      return [...p.nodes.values()]
        .filter((n) => n.path !== node && n.type && t?.derives_from.includes(n.type) && !existing.includes(showNode(n.path)))
        .map((n) => {
          const c = item(showNode(n.path), vscode.CompletionItemKind.Reference, n.type ?? undefined, p.types.get(n.type!)?.description ?? undefined);
          c.filterText = showNode(n.path);
          return c;
        });
    }
    if (at.key === 'code') return this.paths(p, at.prefix);
    return [];
  }

  /** Files and directories of the project under a typed prefix, for code paths. */
  private paths(p: Project, prefix: string): vscode.CompletionItem[] {
    const dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(p.abs(dir.replace(/\/$/, '')), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => {
        const label = `${dir}${e.name}${e.isDirectory() ? '/' : ''}`;
        const c = item(label, e.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File);
        if (e.isDirectory()) c.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
        return c;
      });
  }

  private typeYaml(p: Project, type: string, at: YamlPosition, lines: string[]): vscode.CompletionItem[] {
    if (at.kind === 'key') return keyItems(TYPE_KEYS, presentKeys(lines), at.prefix);
    if (at.key === 'code' && at.kind === 'value') return ['true', 'false'].map((b) => item(b, vscode.CompletionItemKind.Value));
    if ((at.key === 'children' || at.key === 'derives_from') && at.kind !== 'value') {
      return [...p.types.values()]
        .filter((t) => !at.existing.includes(t.type))
        .map((t) => item(t.type, vscode.CompletionItemKind.Class, t.name, t.description ?? undefined));
    }
    if (at.key === 'documents' && at.kind !== 'value') {
      // Templates in the type's directory that aren't listed yet.
      let files: string[] = [];
      try {
        files = fs.readdirSync(p.abs(`.uspec/node-types/${type}`)).filter((f) => f.endsWith('.md'));
      } catch {
        // No directory yet.
      }
      return files
        .map((f) => f.slice(0, -3))
        .filter((d) => !at.existing.includes(d))
        .map((d) => item(d, vscode.CompletionItemKind.File, `${d}.md`));
    }
    return [];
  }

  private frontmatter(p: Project, type: string, at: YamlPosition, lines: string[]): vscode.CompletionItem[] {
    if (at.kind === 'key') return keyItems(TEMPLATE_KEYS, presentKeys(lines), at.prefix);
    if (['required', 'exposed', 'extra'].includes(at.key) && at.kind === 'value') return ['true', 'false'].map((b) => item(b, vscode.CompletionItemKind.Value));
    if (at.key === 'derives_from' && at.kind !== 'value') {
      const docs = p.types.get(type)?.documents.map((d) => d.document) ?? [];
      return docs.filter((d) => !at.existing.includes(d)).map((d) => item(d, vscode.CompletionItemKind.File, `${d}.md`));
    }
    return [];
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const k = kindOf(this.manager, doc.uri);
    if (!k) return undefined;
    const range = doc.getWordRangeAtPosition(pos, /[\w./-]+/);
    if (!range) return undefined;
    const word = doc.getText(range);
    const p = k.p;
    const t = p.types.get(word);
    const key = ownerKey(doc, pos.line);
    if (t && (key === 'type' || key === 'children' || key === 'derives_from')) {
      const md = new vscode.MarkdownString(`**${t.name}** (\`${t.type}\`)${t.code ? ' · describes code' : ''}\n\n${t.description ?? ''}\n\n`);
      md.appendMarkdown(`Documents: ${t.documents.map((d) => `\`${d.document}.md\``).join(', ')}\n\n`);
      if (t.children.length) md.appendMarkdown(`Children: ${t.children.join(', ')}\n\n`);
      return new vscode.Hover(md, range);
    }
    if (k.kind === 'node' && key === 'derives_from') {
      const n = p.nodes.get(nodeKey(word));
      if (!n) return new vscode.Hover(`No node at \`${word}\``, range);
      const nt = p.typeOf(n.path);
      const exposed = nt?.documents.filter((d) => d.exposed && n.documents.includes(d.document)).map((d) => `\`${d.document}.md\``) ?? [];
      return new vscode.Hover(
        new vscode.MarkdownString(`**${showNode(n.path)}** · ${nt?.name ?? n.type ?? '?'}\n\n${nt?.description ?? ''}\n\nThis node reads its ${exposed.join(', ') || 'no documents'}.`),
        range,
      );
    }
    if (k.kind === 'node' && key === 'code') {
      const exists = fs.existsSync(p.abs(normaliseCodePath(word)));
      return new vscode.Hover(exists ? `Code path \`${word}\`` : `\`${word}\` doesn't exist yet.`, range);
    }
    return undefined;
  }

  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    const k = kindOf(this.manager, doc.uri);
    if (!k) return [];
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const links: vscode.DocumentLink[] = [];
    const link = (token: string, near: RegExp, target: vscode.Uri, tooltip: string) => {
      const at = findToken(text, token, near);
      if (!at) return;
      const l = new vscode.DocumentLink(new vscode.Range(at.line, at.start, at.line, at.end), target);
      l.tooltip = tooltip;
      links.push(l);
    };
    const p = k.p;
    if (k.kind === 'node') {
      for (const l of listItems(lines, 'derives_from')) {
        if (p.nodes.has(nodeKey(l))) link(l, /^derives_from:/, p.uriOf(p.nodeYaml(nodeKey(l))), `Open ${l}/node.yaml`);
      }
      for (const c of listItems(lines, 'code')) {
        const args = encodeURIComponent(JSON.stringify([p.root, normaliseCodePath(c)]));
        link(c, /^code:/, vscode.Uri.parse(`command:uspec.revealPath?${args}`), `Reveal ${c}`);
      }
      const type = lines.find((l) => l.startsWith('type:'))?.slice(5).trim();
      if (type && p.types.has(type)) link(type, /^type:/, p.uriOf(p.types.get(type)!.path), `Open the ${type} type`);
    } else if (k.kind === 'type') {
      for (const id of [...listItems(lines, 'children'), ...listItems(lines, 'derives_from')]) {
        const t = p.types.get(id);
        if (t) link(id, /^(children|derives_from):/, p.uriOf(t.path), `Open the ${id} type`);
      }
      for (const d of listItems(lines, 'documents')) {
        const f = `.uspec/node-types/${k.type}/${d}.md`;
        if (fs.existsSync(p.abs(f))) link(d, /^documents:/, p.uriOf(f), `Open the ${d}.md template`);
      }
    } else {
      const fm = frontmatterRange(lines);
      if (!fm) return [];
      const front = lines.slice(0, fm[1] + 1).join('\n');
      for (const d of listItems(lines.slice(0, fm[1] + 1), 'derives_from')) {
        const f = `.uspec/node-types/${k.type}/${d}.md`;
        const at = findToken(front, d, /^derives_from:/);
        if (at && fs.existsSync(p.abs(f))) links.push(new vscode.DocumentLink(new vscode.Range(at.line, at.start, at.line, at.end), p.uriOf(f)));
      }
    }
    return links;
  }
}

/** The top-level key the line belongs to. */
function ownerKey(doc: vscode.TextDocument, line: number): string | undefined {
  for (let i = line; i >= 0; i--) {
    const l = doc.lineAt(i).text;
    if (/^\s/.test(l) || l.trim() === '') continue;
    return l.match(/^([A-Za-z_][\w-]*):/)?.[1];
  }
  return undefined;
}
