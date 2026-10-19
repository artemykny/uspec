// Agent runs (docs/vscode/overview.md#agents): what each role reads, what it may do, and how its
// result is read. Nothing here touches VS Code or starts a process.
import { splitFrontmatter } from './templates';
import type { NextJson } from './model';
import { nodeKey, normaliseCodePath, splitDoc, toDocKey } from './paths';

export type Role = 'impact' | 'triage' | 'writer' | 'splitter' | 'planner' | 'implementer' | 'reviewer';

/** Each role's prompt: a file next to a skill (docs/skills/overview.md#agent-prompts). */
export const PROMPTS: Record<Role, { skill: string; file: string }> = {
  impact: { skill: 'uspec-spec', file: 'impact-agent.md' },
  triage: { skill: 'uspec-spec', file: 'triage-agent.md' },
  writer: { skill: 'uspec-spec', file: 'writer-agent.md' },
  splitter: { skill: 'uspec-spec', file: 'splitter-agent.md' },
  planner: { skill: 'uspec-spec', file: 'planner-agent.md' },
  implementer: { skill: 'uspec-spec', file: 'implementer-agent.md' },
  reviewer: { skill: 'uspec-review', file: 'reviewer-agent.md' },
};

/** Aligns rows in two columns as the CLI's text output does. */
function columns(rows: [string, string][], indent: string): string {
  const width = Math.max(0, ...rows.filter(([, b]) => b).map(([a]) => a.length));
  return rows.map(([a, b]) => (b ? `${indent}${a.padEnd(width)}   ${b}` : `${indent}${a}`)).join('\n') + '\n';
}

/** The triage batch exactly as `uspec change next` prints it: `read`, then `batch`. */
export function triageInput(next: NextJson): string {
  if (!next.triage) return '';
  const short = (s: string) => s.slice(0, 7);
  const read: [string, string][] = next.triage.read.map((r) => [r.path, r.diff_since ? `diff since ${short(r.diff_since)}` : '']);
  const batch: [string, string][] = next.triage.batch.map((b) => [b.path, b.via.join('; ')]);
  return `triage:\n  read:\n${columns(read, '    ')}  batch:\n${columns(batch, '    ')}`;
}

/** The impact agent's input: the path of `change.md`, then `uspec tree` as it prints it. */
export function impactInput(changeMd: string, tree: string): string {
  return `Change: ${changeMd}\n\n${tree.trimEnd()}\n`;
}

/** One `## <node>` block per node, each followed by its `uspec context <node> --implement` output. */
function nodeContexts(contexts: { node: string; context: string }[]): string {
  return contexts.map((c) => `## ${c.node}\n\n${c.context.trimEnd()}\n`).join('\n');
}

/** The planner's input: where plans go, what to plan, the plans already written, then each node's context. */
export function plannerInput(o: { changeMd: string; dir: string; nodes: string[]; existing: string[]; contexts: { node: string; context: string }[] }): string {
  return [
    `Change: ${o.changeMd}`,
    `Plans: ${o.dir}`,
    `Nodes to plan:\n${o.nodes.join('\n')}`,
    `Existing plans:\n${o.existing.length ? o.existing.join('\n') : 'none'}`,
    nodeContexts(o.contexts),
  ].join('\n\n');
}

/** An implementer's input after the mode line: the plan's path, then each of its nodes' context. */
export function implementerInput(plan: string, contexts: { node: string; context: string }[]): string {
  return `Plan: ${plan}\n\n${nodeContexts(contexts)}`;
}

/**
 * The documents a writer works on when it is started from document `key`: its node's documents under
 * `write` in `change next`, in that order, with `key` first when `next` doesn't list it as ready.
 */
export function writerDocs(next: NextJson, key: string): { node: string; documents: string[]; ready: boolean } {
  const { node } = splitDoc(key);
  const listed = next.write.find((w) => nodeKey(w.node) === node)?.documents.map((d) => d.document) ?? [];
  const ready = listed.includes(key);
  return { node, documents: ready ? listed : [key, ...listed], ready };
}

/** The `uspec context` arguments of a writer: one `--document` per document, in order. */
export function writerContextArgs(node: string, documents: string[], change: string): string[] {
  const shown = node === '' ? '.' : node;
  return ['context', shown, ...documents.flatMap((d) => ['--document', splitDoc(d).doc]), '--change', change];
}

/** The model a role runs on: triage on `uspec.agents.triageModel`, the others on `uspec.agents.model`; empty is Claude Code's default. */
export function modelFor(role: Role, settings: { model?: string; triageModel?: string }): string | undefined {
  const m = role === 'triage' ? settings.triageModel : settings.model;
  return m?.trim() || undefined;
}

/** Joins a role's prompt and its input. */
export function agentPrompt(prompt: string, input: string, mode?: string): string {
  const parts = [prompt.trimEnd()];
  if (mode) parts.push(mode);
  parts.push(input.trimEnd());
  return parts.join('\n\n') + '\n';
}

/** Whether `change.md` says the change comes from an experiment, so implementers check instead of write. */
export function fromExperiment(changeMd: string): boolean {
  const { front } = splitFrontmatter(changeMd);
  return /^mode:\s*(?:check|"check"|'check')\s*(?:#.*)?$/m.test(front ?? '');
}

export interface Permissions {
  /** Built-in tools the run has at all. */
  tools: string[];
  /** Permission rules it gets without asking; the auto-mode classifier approves or blocks anything else. */
  allowed: string[];
}

const READ = ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git log:*)'];

/** Editing rules for a project-relative path: a file, or a directory and everything under it. */
function editRules(path: string, dir: boolean): string[] {
  const p = dir ? `${normaliseCodePath(path)}/**` : path;
  return [`Edit(${p})`, `Write(${p})`];
}

export function permissions(
  role: Role,
  opts: { documents?: string[]; extraDirs?: string[]; plansDir?: string; planFile?: string; codePaths?: { path: string; dir: boolean }[]; implementerAllowed?: string[] } = {},
): Permissions {
  switch (role) {
    case 'impact':
    case 'triage':
    case 'reviewer':
    case 'splitter':
      return { tools: ['Read', 'Glob', 'Grep', 'Bash'], allowed: READ };
    case 'planner':
      return { tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'], allowed: [...READ, ...(opts.planFile ? editRules(opts.planFile, false) : opts.plansDir ? editRules(opts.plansDir, true) : [])] };
    case 'writer': {
      const allowed = [...READ];
      for (const d of opts.documents ?? []) allowed.push(...editRules(d, false));
      for (const d of opts.extraDirs ?? []) allowed.push(...editRules(d, true));
      return { tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'], allowed };
    }
    case 'implementer': {
      const allowed = [...READ];
      for (const c of opts.codePaths ?? []) allowed.push(...editRules(c.path, c.dir));
      allowed.push(...(opts.implementerAllowed ?? []));
      return { tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'], allowed };
    }
  }
}

/**
 * What a run is told about where it runs, so it doesn't spend turns on commands that may be blocked:
 * compound shell commands and `git -C` don't match the allowed rules.
 */
export function runNote(p: Permissions): string {
  const edits = p.allowed.filter((a) => a.startsWith('Edit(')).map((a) => a.slice(5, -1));
  return [
    'You run in a terminal started by the uspec VS Code extension in the project root. Permission prompts are not shown: anything outside your allowed tools is approved or blocked automatically.',
    'Work without asking questions: the final message of your first turn is read as your result.',
    'Read files with the Read tool, one call per file. Run git as `git diff <commit> -- <path>` from the current directory: no `git -C`, no pipes, loops or chained commands.',
    edits.length ? `You may edit only: ${edits.join(', ')}.` : 'You may not edit any file.',
  ].join(' ');
}

/** Arguments for interactive `claude`; the prompt comes after them. */
export function claudeArgs(p: Permissions, opts: { model?: string; name?: string } = {}): string[] {
  const args = ['--strict-mcp-config', '--permission-mode', 'auto'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.name) args.push('--name', opts.name);
  args.push('--append-system-prompt', runNote(p));
  args.push('--tools', p.tools.join(','));
  if (p.allowed.length) args.push('--allowedTools', ...p.allowed);
  return args;
}

/** The lines of a result, without code fences, emphasis and surrounding backticks. */
export function resultLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*```/.test(l))
    .map((l) => l.replace(/\*\*/g, '').trim());
}

/**
 * The verdict of a result: the first line that is one of `words` (`updated`, `no change`, `done`, …),
 * and the lines after it. Agents sometimes write a sentence before the block they were asked for.
 */
function verdict(lines: string[], words: string[]): { word: string; rest: string[] } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const word = lines[i].replace(/^[`#>\s-]+|[`.:\s]+$/g, '').toLowerCase();
    if (words.includes(word)) return { word, rest: lines.slice(i + 1) };
  }
  return undefined;
}

export interface StartingDocument {
  document: string;
  reason: string;
}

/**
 * Reads an impact result: each line `<document> | <reason>` naming a document `exists` knows, once, in
 * order; the documents it doesn't know; and the notes.
 */
export function parseImpact(text: string, exists: (key: string) => boolean, specRoot: string): { documents: StartingDocument[]; unknown: string[]; notes: string } {
  const lines = resultLines(text);
  const documents: StartingDocument[] = [];
  const unknown: string[] = [];
  let notesAt = -1;
  lines.forEach((line, i) => {
    if (/^notes:?$/i.test(line.replace(/^#+\s*/, ''))) notesAt = notesAt < 0 ? i : notesAt;
    if (notesAt >= 0) return;
    const parts = line.replace(/^[-*]\s+/, '').split('|');
    if (parts.length < 2) return;
    const doc = toDocKey(specRoot, parts[0]);
    const reason = parts.slice(1).join('|').trim();
    if (!reason) return;
    if (!exists(doc)) unknown.push(doc);
    else if (!documents.some((d) => d.document === doc)) documents.push({ document: doc, reason });
  });
  const notes = notesAt >= 0 ? lines.slice(notesAt + 1).join('\n').trim() : '';
  return { documents, unknown, notes: /^[-*\s]*(none|n\/a|nothing)\.?$/i.test(notes) ? '' : notes };
}

export type PlannerResult = { kind: 'planned'; plans: string[] } | { kind: 'failed'; detail: string } | { kind: 'invalid' };

/** Reads a planner result: `planned` and a line per plan, or `failed` and why. */
export function parsePlanner(text: string): PlannerResult {
  const v = verdict(resultLines(text), ['planned', 'failed']);
  if (!v) return { kind: 'invalid' };
  const rest = v.rest.filter((l) => l !== '');
  if (v.word === 'failed') return { kind: 'failed', detail: rest.join('\n') };
  return { kind: 'planned', plans: rest.filter((l) => l.includes('|')).map((l) => l.split('|')[0].replace(/^[-*]\s+/, '').trim()) };
}

export interface TriageDecision {
  document: string;
  state: 'affected' | 'no-change';
  reason: string;
}

/** Reads a triage result: one decision per batch document it names, in batch order, and its notes. */
export function parseTriage(text: string, batch: string[], specRoot: string): { decisions: TriageDecision[]; unknown: string[]; notes: string } {
  const lines = resultLines(text);
  const wanted = new Set(batch);
  const found = new Map<string, TriageDecision>();
  const unknown: string[] = [];
  let notesAt = -1;
  lines.forEach((line, i) => {
    if (/^notes:?$/i.test(line.replace(/^#+\s*/, ''))) notesAt = notesAt < 0 ? i : notesAt;
    const parts = line.replace(/^[-*]\s+/, '').split('|');
    if (parts.length < 3) return;
    const state = parts[1].trim().replace(/`/g, '').toLowerCase().replace(/\s+/g, '-');
    if (state !== 'affected' && state !== 'no-change') return;
    const doc = toDocKey(specRoot, parts[0]);
    const reason = parts.slice(2).join('|').trim();
    if (!wanted.has(doc)) {
      unknown.push(doc);
      return;
    }
    if (!found.has(doc) && reason) found.set(doc, { document: doc, state, reason });
  });
  const decisions = batch.filter((d) => found.has(d)).map((d) => found.get(d)!);
  const notes = notesAt >= 0 ? lines.slice(notesAt + 1).join('\n').trim() : '';
  return { decisions, unknown, notes: /^[-*\s]*(none|n\/a|nothing)\.?$/i.test(notes) ? '' : notes };
}

export type WriterResult =
  | { kind: 'updated'; summary: string; userVisible: boolean }
  | { kind: 'no-change'; reason: string }
  | { kind: 'blocked'; reason: string };

const WRITER_WORDS = ['updated', 'no change', 'no-change', 'blocked'];

/** One document's result from its verdict line on: the verdict, its paragraph, and what follows it. */
function writerBlock(lines: string[]): { result: WriterResult; trailing: string[] } | undefined {
  const v = verdict(lines, WRITER_WORDS);
  if (!v) return undefined;
  // The result is the paragraph after the verdict; for `updated` it ends at `user-visible:`.
  const rest = v.rest;
  let from = 0;
  while (from < rest.length && rest[from] === '') from++;
  let end = from;
  while (end < rest.length && rest[end] !== '') {
    end++;
    if (v.word === 'updated' && /^user-visible:/i.test(rest[end - 1])) break;
  }
  const para = rest.slice(from, end);
  const trailing = rest.slice(end);
  if (v.word === 'updated') {
    const uv = para.find((l) => /^user-visible:/i.test(l));
    // When the writer doesn't say, ask rather than record unseen.
    return { result: { kind: 'updated', summary: para.find((l) => !/^user-visible:/i.test(l)) ?? '', userVisible: uv ? !/:\s*no\b/i.test(uv) : true }, trailing };
  }
  if (v.word === 'blocked') return { result: { kind: 'blocked', reason: para.join('\n') }, trailing };
  return { result: { kind: 'no-change', reason: para.join(' ') || 'The writer found nothing to change.' }, trailing };
}

/** The document a line names on its own (`docs/a/logic.md`, `` `a/logic.md` ``, `### a/logic.md:`), when it is one of `docs`. */
function namedDoc(line: string, docs: Set<string>, specRoot: string): string | undefined {
  const s = line.replace(/^[#>\s*-]+/, '').replace(/[:\s]+$/, '');
  if (!s || /\s/.test(s)) return undefined;
  const key = toDocKey(specRoot, s);
  return docs.has(key) ? key : undefined;
}

/**
 * Reads a writer's results: one per document, each starting with the document's path on its own line,
 * then `updated`, `no change` or `blocked`. A run with one document may leave out the path. Anything the
 * writer adds after a result is kept as notes. A document without a result isn't in `results`.
 */
export function parseWriter(text: string, docs: string[], specRoot: string): { results: Map<string, WriterResult>; notes: string } {
  const lines = resultLines(text);
  const wanted = new Set(docs);
  const heads: { at: number; doc: string }[] = [];
  lines.forEach((line, i) => {
    const doc = namedDoc(line, wanted, specRoot);
    if (!doc) return;
    const next = lines.slice(i + 1).find((l) => l !== '');
    if (next !== undefined && WRITER_WORDS.includes(next.replace(/^[`#>\s-]+|[`.:\s]+$/g, '').toLowerCase())) heads.push({ at: i, doc });
  });
  const results = new Map<string, WriterResult>();
  const notes: string[] = [];
  const add = (doc: string, block: string[]) => {
    const b = writerBlock(block);
    if (!b) return;
    if (!results.has(doc)) results.set(doc, b.result);
    const t = b.trailing.join('\n').trim();
    if (t) notes.push(t);
  };
  if (!heads.length && docs.length === 1) add(docs[0], lines);
  heads.forEach((h, k) => add(h.doc, lines.slice(h.at + 1, k + 1 < heads.length ? heads[k + 1].at : lines.length)));
  return { results, notes: notes.join('\n\n') };
}

export type ImplementerResult = { kind: 'done' | 'gap' | 'failed'; detail: string } | { kind: 'invalid' };

export function parseImplementer(text: string): ImplementerResult {
  const v = verdict(resultLines(text), ['done', 'gap', 'failed']);
  if (!v) return { kind: 'invalid' };
  const detail = v.rest.filter((l) => l !== '').join('\n');
  if (v.word === 'done' || v.word === 'gap' || v.word === 'failed') return { kind: v.word, detail };
  return { kind: 'invalid' };
}

/** What a reviewer found: `No findings.` or the number of finding blocks. */
export function parseReview(text: string): { findings: number } {
  const lines = resultLines(text);
  if (lines.some((l) => /^no findings\.?$/i.test(l))) return { findings: 0 };
  return { findings: lines.filter((l) => /^(contradiction|gap|missing link)\b/i.test(l)).length };
}

/** One line of a run's log for a message of Claude Code's transcript (as in its stream-json output), or none. */
export function describeEvent(e: any): string[] {
  switch (e?.type) {
    case 'system':
      if (e.subtype === 'init') return [`session ${e.session_id} · ${e.model} · ${e.permissionMode}`];
      return [];
    case 'assistant': {
      const out: string[] = [];
      for (const c of e.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) out.push(c.text.trim());
        if (c.type === 'tool_use') out.push(`→ ${c.name} ${toolSummary(c.input)}`.trimEnd());
      }
      return out;
    }
    case 'user': {
      const out: string[] = [];
      for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (c.type === 'tool_result' && c.is_error) {
          const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x.text ?? '').join(' ');
          out.push(`  ✗ ${String(text).split('\n')[0].slice(0, 200)}`);
        }
      }
      return out;
    }
    case 'result': {
      const out = [
        `— ${e.subtype}${e.is_error ? ' (error)' : ''} · ${e.num_turns ?? '?'} turns · ${formatCost(e.total_cost_usd)} · ${formatDuration(e.duration_ms)}`,
      ];
      for (const d of e.permission_denials ?? []) out.push(`  denied: ${d.tool_name} ${toolSummary(d.tool_input)}`.trimEnd());
      return out;
    }
    default:
      return [];
  }
}

function toolSummary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.url ?? '';
  return String(v).split('\n')[0].slice(0, 160);
}

export function formatCost(usd: unknown): string {
  return typeof usd === 'number' ? `$${usd.toFixed(2)}` : '$?';
}

export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number') return '?';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
