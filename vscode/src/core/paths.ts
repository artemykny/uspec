// Paths in a uspec project (docs/cli/overview.md#paths). Node paths here are spec-relative with
// "" for the root; the CLI shows the root as ".".

/** Joins a node path and a name. */
export function join(node: string, name: string): string {
  return node ? `${node}/${name}` : name;
}

/** The CLI's name for a node: "." for the root. */
export function showNode(node: string): string {
  return node || '.';
}

/** Turns the CLI's node name into a node path: "." becomes "". */
export function nodeKey(shown: string): string {
  const s = shown.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  return s === '.' ? '' : s;
}

/** A document's key: its spec-relative path, e.g. `system/services/payments/api.md`. */
export function docKey(node: string, doc: string): string {
  return join(node, `${doc}.md`);
}

/** Splits a document key into its node path and document id. */
export function splitDoc(key: string): { node: string; doc: string } {
  const k = key.replace(/\.md$/, '');
  const i = k.lastIndexOf('/');
  return i < 0 ? { node: '', doc: k } : { node: k.slice(0, i), doc: k.slice(i + 1) };
}

export function parentOf(node: string): string | undefined {
  if (!node) return undefined;
  const i = node.lastIndexOf('/');
  return i < 0 ? '' : node.slice(0, i);
}

export function baseName(node: string): string {
  const i = node.lastIndexOf('/');
  return i < 0 ? node : node.slice(i + 1);
}

/** Whether `path` is `root` or inside it. */
export function isUnder(path: string, root: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`);
}

/** A spec-relative path as a project-relative one, for a spec root such as `docs` (or "" for `.`). */
export function specToProject(specRoot: string, rel: string): string {
  if (!specRoot) return rel;
  return rel ? `${specRoot}/${rel}` : specRoot;
}

/** A project-relative path as a spec-relative one, or undefined when it's outside the spec root. */
export function projectToSpec(specRoot: string, rel: string): string | undefined {
  if (!specRoot) return rel;
  if (rel === specRoot) return '';
  return rel.startsWith(`${specRoot}/`) ? rel.slice(specRoot.length + 1) : undefined;
}

/** Normalises the `spec_root` of `.uspec/config.yaml`: `docs/` → `docs`, `.` → "". */
export function normaliseSpecRoot(specRoot: string): string {
  const s = specRoot.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  return s === '.' ? '' : s;
}

/** Reads `spec_root` from the text of `.uspec/config.yaml`; `docs` when it isn't set. */
export function specRootFromConfig(text: string | undefined): string {
  const m = text?.match(/^spec_root:\s*["']?([^"'#\n]*?)["']?\s*(#.*)?$/m);
  return normaliseSpecRoot(m ? m[1] : 'docs');
}

export type SpecFile =
  | { kind: 'node'; node: string }
  | { kind: 'yaml'; node: string }
  | { kind: 'doc'; node: string; doc: string }
  | { kind: 'extra'; node: string; doc: string }
  | { kind: 'other'; node: string };

/**
 * What a spec-relative path is: a node directory, its node.yaml, one of its documents, a file in a
 * document's `-extra/` folder, or another file in a node. `isNode` answers whether a path is a node,
 * `declares` whether a node's type declares a document.
 */
export function classifySpecPath(
  rel: string,
  isNode: (node: string) => boolean,
  declares: (node: string, doc: string) => boolean,
): SpecFile | undefined {
  if (isNode(rel)) return { kind: 'node', node: rel };
  const parts = rel.split('/');
  // Walk up to the nearest node; a `<doc>-extra` folder on the way makes it an extra file.
  for (let i = parts.length - 1; i >= 0; i--) {
    const dir = parts.slice(0, i).join('/');
    if (!isNode(dir)) continue;
    const name = parts[i];
    if (i === parts.length - 1) {
      if (name === 'node.yaml') return { kind: 'yaml', node: dir };
      const stem = name.replace(/\.md$/, '');
      if (name.endsWith('.md') && declares(dir, stem)) return { kind: 'doc', node: dir, doc: stem };
      return { kind: 'other', node: dir };
    }
    const doc = name.endsWith('-extra') ? name.slice(0, -'-extra'.length) : undefined;
    if (doc && declares(dir, doc)) return { kind: 'extra', node: dir, doc };
    return { kind: 'other', node: dir };
  }
  return undefined;
}

/** Normalises a code path from node.yaml for matching: no `./`, no trailing `/`. */
export function normaliseCodePath(code: string): string {
  return code.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** The node whose code paths contain a project-relative file: the one with the longest matching code path. */
export function codeOwner(nodes: Iterable<{ path: string; code: string[] }>, rel: string): string | undefined {
  let best: { node: string; len: number } | undefined;
  for (const n of nodes) {
    for (const c of n.code) {
      const cp = normaliseCodePath(c);
      if (cp === '' || cp === '.' || rel === cp || rel.startsWith(`${cp}/`)) {
        const len = cp === '.' ? 0 : cp.length;
        if (!best || len > best.len) best = { node: n.path, len };
      }
    }
  }
  return best?.node;
}

/** Turns a document path from an agent or a user into a spec-relative key ending in `.md`. */
export function toDocKey(specRoot: string, input: string): string {
  let s = input.trim().replace(/^[`'"*]+|[`'"*]+$/g, '').replace(/^\.\//, '');
  s = projectToSpec(specRoot, s) ?? s;
  return s.endsWith('.md') ? s : `${s}.md`;
}
