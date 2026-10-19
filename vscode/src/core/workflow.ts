// Markdown review artifacts. Parsing is deliberately strict: invalid proposals cannot mutate state.
export interface FileDecision { document: string; state: 'affected' | 'no-change'; reason: string; comment: string }
export interface SplitPlan { id: string; path: string; nodes: string[]; after: string[]; reason: string }

function entries(text: string): { path: string; fields: Record<string, string> }[] {
  const out: { path: string; fields: Record<string, string> }[] = [];
  let entry: typeof out[number] | undefined;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const heading = /^### ([^\n]+)$/.exec(line);
    if (heading) { entry = { path: heading[1].trim(), fields: {} }; out.push(entry); continue; }
    if (/^#{1,2} /.test(line)) entry = undefined;
    const field = /^- (Decision|Reason|Comment|Nodes|After):\s*(.*)$/.exec(line);
    if (field && entry) {
      if (field[1] in entry.fields) throw new Error(`Duplicate ${field[1]} for ${entry.path}`);
      entry.fields[field[1]] = field[2].trim();
    }
  }
  if (!out.length) throw new Error('The proposal has no entries.');
  if (new Set(out.map(e => e.path)).size !== out.length) throw new Error('The proposal has duplicate entries.');
  return out;
}

const line = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
export function fileProposal(title: string, files: FileDecision[]): string {
  return `# ${line(title)}\n\n## Files\n\n` + files.map(d => `### ${d.document}\n- Decision: ${d.state}\n- Reason: ${line(d.reason)}\n- Comment: ${line(d.comment)}\n`).join('\n');
}
export function readFileProposal(text: string, allowed: string[], complete = false): FileDecision[] {
  const rows = entries(text).map(e => {
    if (!allowed.includes(e.path)) throw new Error(`Unknown document: ${e.path}`);
    const state = e.fields.Decision;
    if (state !== 'affected' && state !== 'no-change') throw new Error(`Invalid decision: ${e.path}`);
    if (!e.fields.Reason) throw new Error(`Missing reason: ${e.path}`);
    return { document: e.path, state, reason: e.fields.Reason, comment: e.fields.Comment ?? '' } as FileDecision;
  });
  if (complete && rows.length !== allowed.length) throw new Error('Every candidate needs a decision.');
  return rows;
}
export function readSplit(text: string, nodes: string[], existing: { plan: string; after: string[] }[] = []): SplitPlan[] {
  const rows = entries(text).map(e => {
    const m = /^plans\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(e.path);
    if (!m || existing.some(p => p.plan === m[1])) throw new Error(`Invalid or existing plan path: ${e.path}`);
    const list = (s: string = '') => s.split(',').map(x => x.trim()).filter(Boolean);
    const ns = list(e.fields.Nodes);
    if (!ns.length || ns.some(n => !nodes.includes(n))) throw new Error(`Invalid nodes: ${e.path}`);
    return { id: m[1], path: e.path, nodes: ns, after: list(e.fields.After), reason: e.fields.Reason ?? '' };
  });
  const owners = rows.flatMap(p => p.nodes);
  if (owners.length !== nodes.length || new Set(owners).size !== nodes.length || nodes.some(n => !owners.includes(n))) throw new Error('Assign every node to exactly one plan.');
  const graph = new Map([...existing.map(p => [p.plan, p.after] as const), ...rows.map(p => [p.id, p.after] as const)]);
  const visit = (id: string, stack: Set<string>) => {
    if (!graph.has(id)) throw new Error(`Unknown dependency: ${id}`);
    if (stack.has(id)) throw new Error('Plan dependencies contain a cycle.');
    for (const dep of graph.get(id)!) visit(dep, new Set([...stack, id]));
  };
  for (const row of rows) visit(row.id, new Set());
  return rows;
}

/** Linear-space compact diff; unchanged prefix/suffix retained as context. Native diff is authoritative. */
export function inlineDiff(before: string, after: string): { kind: 'same' | 'remove' | 'add'; text: string }[] {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === a.length && start === b.length) return [];
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [
    ...a.slice(Math.max(0, start - 3), start).map(text => ({ kind: 'same' as const, text })),
    ...a.slice(start, a.length - end).map(text => ({ kind: 'remove' as const, text })),
    ...b.slice(start, b.length - end).map(text => ({ kind: 'add' as const, text })),
    ...b.slice(b.length - end, b.length - end + 3).map(text => ({ kind: 'same' as const, text })),
  ];
}
