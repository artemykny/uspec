// Links and sections (docs/method/links/rules.md, docs/method/spec-tree/rules.md#sections): a link
// names a node, or narrows to one document or one section of it. Nothing here touches VS Code.
import { docKey, nodeKey, showNode } from './paths';

export interface Link {
  /** As written in node.yaml, without a trailing `/`. */
  raw: string;
  /** The target node's path; "" for the root. */
  node: string;
  /** The document id it narrows to. */
  doc?: string;
  /** The section anchor it narrows to. */
  section?: string;
}

/** Parses a link as `uspec` does; undefined when it isn't valid (a section without a document). */
export function parseLink(input: string): Link | undefined {
  const raw = input.trim().replace(/\/+$/, '');
  const hash = raw.indexOf('#');
  const path = hash < 0 ? raw : raw.slice(0, hash);
  const section = hash < 0 ? undefined : raw.slice(hash + 1);
  if (section === '') return undefined;
  if (path.endsWith('.md')) {
    const stem = path.slice(0, -3);
    const i = stem.lastIndexOf('/');
    return { raw, node: i < 0 ? '' : stem.slice(0, i), doc: i < 0 ? stem : stem.slice(i + 1), section };
  }
  if (section !== undefined) return undefined;
  return { raw, node: nodeKey(path) };
}

/** A link written for `node`, keeping the document and section. */
export function formatLink(node: string, doc?: string, section?: string): string {
  const base = doc ? docKey(node, doc) : showNode(node);
  return section ? `${base}#${section}` : base;
}

/** A heading's anchor, as Markdown renderers link to it. */
export function anchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

export interface Heading {
  level: number;
  text: string;
  anchor: string;
  /** The heading's line, counted from 0. */
  line: number;
}

/** The ATX headings of a Markdown document, outside fenced code blocks. */
export function headings(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | undefined;
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trimStart();
    if (fence) {
      if (t.startsWith(fence)) fence = undefined;
      return;
    }
    if (t.startsWith('```') || t.startsWith('~~~')) {
      fence = t.slice(0, 3);
      return;
    }
    const m = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/);
    if (!m) return;
    const h = (m[2] ?? '').replace(/(^|[ \t]+)#+$/, '').trim();
    out.push({ level: m[1].length, text: h, anchor: anchor(h), line: i });
  });
  return out;
}

/** The line a section starts at, or undefined when the document has no such section. */
export function sectionLine(text: string, sectionAnchor: string): number | undefined {
  return headings(text).find((h) => h.anchor === sectionAnchor)?.line;
}

/** The text of a section: its heading and everything up to the next heading of the same or a higher level. */
export function sectionText(text: string, sectionAnchor: string): string | undefined {
  const hs = headings(text);
  const at = hs.findIndex((h) => h.anchor === sectionAnchor);
  if (at < 0) return undefined;
  const end = hs.slice(at + 1).find((h) => h.level <= hs[at].level)?.line;
  return text.split(/\r?\n/).slice(hs[at].line, end).join('\n').trimEnd();
}
