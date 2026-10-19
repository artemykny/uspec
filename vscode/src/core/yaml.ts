// Where the cursor is in the small YAML files of a uspec project: node.yaml, node-type.yaml and
// template frontmatter. Only what completion needs: the top-level key and whether the cursor is on
// the key, its value or an item of its list.

export type YamlPosition =
  | { kind: 'key'; prefix: string }
  | { kind: 'value'; key: string; prefix: string }
  | { kind: 'item'; key: string; prefix: string; existing: string[] };

const KEY = /^([A-Za-z_][\w-]*):(.*)$/;

/** The values already listed under `key`, inline or as a block list. */
export function listItems(lines: string[], key: string): string[] {
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return [];
  const rest = lines[i].slice(key.length + 1).trim();
  if (rest.startsWith('[')) {
    return rest
      .replace(/^\[|\].*$/g, '')
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter(Boolean);
  }
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    // A comment starts at a `#` after whitespace: `rules.md#refund-window` is one value.
    const m = lines[j].match(/^\s+-\s*(.*?)(?:\s+#.*)?\s*$/);
    if (m) {
      if (m[1]) out.push(unquote(m[1]));
      continue;
    }
    if (lines[j].trim() === '' || /^\s+#/.test(lines[j])) continue;
    break;
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

/** The key whose block the line belongs to: the nearest earlier line at column 0. */
function ownerKey(lines: string[], line: number): string | undefined {
  for (let i = line; i >= 0; i--) {
    const l = lines[i];
    if (/^\s/.test(l) || l.trim() === '' || l.startsWith('#')) continue;
    const m = l.match(KEY);
    return m ? m[1] : undefined;
  }
  return undefined;
}

/** What the cursor at `line`, `character` is on. */
export function yamlPosition(lines: string[], line: number, character: number): YamlPosition | undefined {
  const text = lines[line] ?? '';
  const before = text.slice(0, character);
  if (/^[A-Za-z_][\w-]*$|^$/.test(before)) return { kind: 'key', prefix: before };
  let m = before.match(KEY);
  if (m) {
    const key = m[1];
    const rest = m[2].trimStart();
    if (rest.startsWith('[')) {
      const inner = rest.slice(1);
      const parts = inner.split(',');
      const prefix = unquote(parts[parts.length - 1].trimStart());
      return { kind: 'item', key, prefix, existing: listItems(lines, key) };
    }
    return { kind: 'value', key, prefix: unquote(rest) };
  }
  m = before.match(/^\s+-\s*(.*)$/);
  if (m) {
    const key = ownerKey(lines, line - 1);
    if (key) return { kind: 'item', key, prefix: unquote(m[1]), existing: listItems(lines, key) };
  }
  return undefined;
}

/** The frontmatter lines of a Markdown file, if `line` is inside it: [first line, last line] exclusive of the fences. */
export function frontmatterRange(lines: string[]): [number, number] | undefined {
  if (lines[0]?.trim() !== '---') return undefined;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') return [1, i - 1];
  return undefined;
}
