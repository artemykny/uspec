// Where a `uspec validate` error goes in the editor: which file, which line (docs/vscode/overview.md#editing).
import type { Issue } from './model';

export interface Located {
  /** Project-relative file (or directory, when nothing better exists). */
  file: string;
  line: number;
  start: number;
  end: number;
  message: string;
}

export interface IssueContext {
  /** Text of a project-relative file, or undefined if it doesn't exist. */
  read(rel: string): string | undefined;
  /** Whether a project-relative path is a directory. */
  isDir(rel: string): boolean;
  /** Spec root, project-relative ("" for the project root). */
  specRoot: string;
}

const trim = (p: string) => p.replace(/\/+$/, '');

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function nodeYaml(dir: string): string {
  return dir ? `${dir}/node.yaml` : 'node.yaml';
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first line holding `token` as a whole word, preferring lines that also hold `near`. */
export function findToken(text: string, token: string, near?: RegExp): { line: number; start: number; end: number } | undefined {
  const re = new RegExp(`(^|[\\s\\[,'":-])(${escape(token)})(?=$|[\\s\\],'"/:])`);
  const lines = text.split(/\r?\n/);
  let fallback: { line: number; start: number; end: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const start = m.index + m[1].length;
    const hit = { line: i, start, end: start + token.length };
    if (!near || near.test(lines[i])) return hit;
    fallback ??= hit;
  }
  if (fallback && near) {
    // A block list: the key is on an earlier line. Prefer a hit under the key.
    let key = -1;
    for (let i = 0; i < lines.length; i++) if (near.test(lines[i])) key = i;
    if (key >= 0) {
      for (let i = key; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (m) return { line: i, start: m.index + m[1].length, end: m.index + m[1].length + token.length };
        if (i > key && /^\S/.test(lines[i])) break;
      }
    }
  }
  return fallback;
}

/** The line that starts with `key:`. */
function keyLine(text: string, key: string): { line: number; start: number; end: number } | undefined {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  return i < 0 ? undefined : { line: i, start: 0, end: lines[i].length };
}

function wholeLine(text: string | undefined, line: number): { line: number; start: number; end: number } {
  const lines = (text ?? '').split(/\r?\n/);
  const l = Math.min(Math.max(line, 0), Math.max(lines.length - 1, 0));
  return { line: l, start: 0, end: lines[l]?.length ?? 0 };
}

/** Finds where in `text` the error `message` points. */
export function locateInFile(text: string | undefined, message: string): { line: number; start: number; end: number } {
  if (text === undefined) return { line: 0, start: 0, end: 0 };
  let m: RegExpMatchArray | null;
  if ((m = message.match(/at line (\d+) column (\d+)/))) {
    const line = Number(m[1]) - 1;
    const col = Math.max(Number(m[2]) - 1, 0);
    const len = text.split(/\r?\n/)[line]?.length ?? col;
    return { line, start: Math.min(col, len), end: len };
  }
  if (/^unknown type `|isn't allowed as a child of|has no `type`|has code: true, but the node lists no code paths|missing required document/.test(message)) {
    return keyLine(text, 'type') ?? wholeLine(text, 0);
  }
  if (/^lists code paths, but/.test(message)) return keyLine(text, 'code') ?? wholeLine(text, 0);
  if ((m = message.match(/^links to (\S+?)(,| of type)/))) {
    return findToken(text, m[1], /^derives_from:/) ?? keyLine(text, 'derives_from') ?? wholeLine(text, 0);
  }
  if ((m = message.match(/^`(children|derives_from)` references (?:unknown type|document) `([^`]+)`/))) {
    return findToken(text, m[2], new RegExp(`^${m[1]}:`)) ?? keyLine(text, m[1]) ?? wholeLine(text, 0);
  }
  if ((m = message.match(/^document `([^`]+)` has no template/))) {
    return findToken(text, m[1], /^documents:/) ?? keyLine(text, 'documents') ?? wholeLine(text, 0);
  }
  if ((m = message.match(/^`(\w+)` is required/))) return wholeLine(text, 0);
  if (/^`documents` must list/.test(message)) return keyLine(text, 'documents') ?? wholeLine(text, 0);
  if (/^document dependencies form a cycle/.test(message)) return keyLine(text, 'documents') ?? wholeLine(text, 0);
  if (/frontmatter/.test(message)) return wholeLine(text, 0);
  return wholeLine(text, 0);
}

/** Every place an error goes: usually one, one per link for a cycle. */
export function locateIssue(issue: Issue, ctx: IssueContext): Located[] {
  const path = trim(issue.path);
  const toFile = (p: string) => specFile(ctx.specRoot, p);

  let m = issue.message.match(/^links form a cycle: (.+)$/);
  if (m) {
    const nodes = m[1].split(' → ').map((n) => (n === '.' ? '' : n));
    const out: Located[] = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      const file = nodeYaml(toFile(nodes[i]));
      const text = ctx.read(file);
      const at = (text && findToken(text, nodes[i + 1] || '.', /^derives_from:/)) || wholeLine(text, 0);
      out.push({ file, ...at, message: issue.message });
    }
    if (out.length) return out;
  }
  m = issue.message.match(/^types form a cycle through `children`: (.+)$/);
  if (m) {
    const ids = m[1].split(' → ');
    const out: Located[] = [];
    for (let i = 0; i + 1 < ids.length; i++) {
      const file = `${path}/${ids[i]}/node-type.yaml`;
      const text = ctx.read(file);
      const at = (text && findToken(text, ids[i + 1], /^children:/)) || wholeLine(text, 0);
      out.push({ file, ...at, message: issue.message });
    }
    if (out.length) return out;
  }

  let file = path;
  let message = issue.message;
  if (ctx.isDir(path)) {
    if (ctx.read(nodeYaml(path)) !== undefined) {
      file = nodeYaml(path);
    } else if (!ctx.specRoot || path === ctx.specRoot || path.startsWith(`${ctx.specRoot}/`)) {
      // A directory without node.yaml, or a folder inside a node: put it on the enclosing node.
      let dir = dirname(path);
      while (ctx.specRoot ? dir === ctx.specRoot || dir.startsWith(`${ctx.specRoot}/`) : true) {
        if (ctx.read(nodeYaml(dir)) !== undefined) {
          file = nodeYaml(dir);
          message = `${path.slice(dir ? dir.length + 1 : 0)}/: ${issue.message}`;
          break;
        }
        if (!dir) break;
        dir = dirname(dir);
      }
    }
  }
  const text = ctx.read(file);
  return [{ file, ...locateInFile(text, issue.message), message }];
}

function specFile(specRoot: string, node: string): string {
  if (!specRoot) return node;
  return node ? `${specRoot}/${node}` : specRoot;
}
