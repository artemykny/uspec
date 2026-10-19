// Agent runs on a change: starting Claude Code per item, recording results with `uspec change set`,
// approval of writer updates, logs (docs/vscode/overview.md#agents).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  agentPrompt,
  claudeArgs,
  describeEvent,
  formatCost,
  formatDuration,
  fromExperiment,
  modelFor,
  parseImplementer,
  parseReview,
  parseTriage,
  parseWriter,
  permissions,
  PROMPTS,
  triageInput,
  writerContextArgs,
  type Permissions,
  type Role,
  type WriterResult,
} from './core/agents';
import { startClaude, type ClaudeResult } from './core/claude';
import type { NextJson, SetJson } from './core/model';
import { join, nodeKey, showNode, splitDoc } from './core/paths';
import type { ContentProvider } from './content';
import { codePaths, readText, type Project, type ProjectManager } from './projects';
import { claudeOrComplain, openClaude, promptFile } from './terminal';

export type RunState = 'running' | 'needs-approval' | 'recorded' | 'blocked' | 'gap' | 'failed' | 'error' | 'stopped' | 'rejected' | 'reviewed';

/** States after which a change's run loop stops for the user. */
const NEEDS_USER: RunState[] = ['needs-approval', 'blocked', 'gap', 'failed', 'error'];

let nextId = 1;

/** One document of a writer run: its content before the run, its result, and how to record it once approved. */
export interface WriterDoc {
  /** The document key. */
  key: string;
  /** `running` until the run's result is read; then the result of this document on its own. */
  state: RunState;
  outcome: string;
  detail: string;
  snapshot: string;
  snapshotUri?: vscode.Uri;
  record?: () => Promise<string>;
}

export class AgentRun {
  readonly id = nextId++;
  state: RunState = 'running';
  /** A short result, shown next to the run. */
  outcome = '';
  /** What the user should read: a reason, a gap, notes. */
  detail = '';
  readonly started = Date.now();
  ended?: number;
  costUsd?: number;
  sessionId?: string;
  readonly log: string[] = [];
  logUri!: vscode.Uri;
  /** A writer's documents, in the order given, each with its own result. */
  docs: WriterDoc[] = [];
  /** What a writer added after its results. */
  notes = '';
  kill?: () => void;
  stopped = false;
  /** Waiting for a free slot: at most `uspec.agents.maxParallel` runs per change at once. */
  queued = true;

  constructor(
    readonly p: Project,
    readonly change: string | undefined,
    readonly role: Role,
    /** The node path (implementer, reviewer, writer) or `batch` (triage) the run works on. */
    readonly item: string,
    private readonly label?: string,
  ) {}

  get title(): string {
    return `${this.role}: ${this.label ?? (this.role === 'triage' ? this.item : showNode(this.item))}`;
  }

  get active(): boolean {
    return this.state === 'running' || this.state === 'needs-approval';
  }

  get elapsed(): string {
    return formatDuration((this.ended ?? Date.now()) - this.started);
  }
}

/** At most `size` tasks at once. */
class Slots {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly size: () => number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= Math.max(1, this.size())) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

export class AgentManager implements vscode.Disposable {
  runs: AgentRun[] = [];
  private readonly emitter = new vscode.EventEmitter<AgentRun | undefined>();
  readonly onDidChange = this.emitter.event;
  private readonly loops = new Map<string, { stopped: boolean }>();
  private readonly slots = new Map<string, Slots>();
  private readonly ticker: NodeJS.Timeout;

  constructor(
    private readonly manager: ProjectManager,
    private readonly content: ContentProvider,
    private readonly extensionPath: string,
  ) {
    // Elapsed times of running agents.
    this.ticker = setInterval(() => {
      if (this.runs.some((r) => r.state === 'running')) this.emitter.fire(undefined);
    }, 5000);
  }

  dispose(): void {
    clearInterval(this.ticker);
    for (const r of this.runs) r.kill?.();
    this.emitter.dispose();
  }

  private config() {
    return vscode.workspace.getConfiguration('uspec');
  }

  private changeKey(p: Project, change: string | undefined): string {
    return `${p.root}|${change ?? ''}`;
  }

  runsOf(p: Project, change: string | undefined): AgentRun[] {
    return this.runs.filter((r) => r.p === p && r.change === change);
  }

  /**
   * Whether an item has a run that is running or waiting for approval: the triage `batch`, a node
   * (of `role`, when given), or a document a writer is writing or that waits for approval.
   */
  isBusy(p: Project, change: string, item: string, role?: Role): boolean {
    return this.runs.some(
      (r) =>
        r.p === p &&
        r.change === change &&
        r.active &&
        (!role || r.role === role) &&
        (r.item === item || r.docs.some((d) => d.key === item && (d.state === 'running' || d.state === 'needs-approval'))),
    );
  }

  /** Updates waiting for the user: a writer's documents one by one, other runs as one. */
  waiting(p: Project, change: string): number {
    return this.runsOf(p, change).reduce((n, r) => n + (r.docs.length ? r.docs.filter((d) => d.state === 'needs-approval').length : r.state === 'needs-approval' ? 1 : 0), 0);
  }

  isLooping(p: Project, change: string): boolean {
    return this.loops.has(this.changeKey(p, change));
  }

  isRunning(p: Project, change: string): boolean {
    return this.isLooping(p, change) || this.runs.some((r) => r.p === p && r.change === change && r.state === 'running');
  }

  private slotsFor(p: Project, change: string | undefined): Slots {
    const key = this.changeKey(p, change);
    let s = this.slots.get(key);
    if (!s) {
      s = new Slots(() => this.config().get<number>('agents.maxParallel', 4));
      this.slots.set(key, s);
    }
    return s;
  }

  private newRun(p: Project, change: string | undefined, role: Role, item: string, label?: string): AgentRun {
    const run = new AgentRun(p, change, role, item, label);
    run.logUri = this.content.register('run', String(run.id), `${run.title.replace(/[/\\:]/g, '_')}.log`, () => run.log.join('\n') + '\n');
    run.log.push(`# ${run.title}`, `project: ${p.root}${change ? ` · change: ${change}` : ''} · started ${new Date(run.started).toLocaleTimeString()}`, '');
    this.runs.push(run);
    this.emitter.fire(run);
    return run;
  }

  private append(run: AgentRun, ...lines: string[]): void {
    run.log.push(...lines);
    this.content.changed(run.logUri);
  }

  private finish(run: AgentRun, state: RunState, outcome: string, detail = ''): AgentRun {
    run.state = state;
    run.outcome = outcome;
    run.detail = detail;
    run.ended ??= Date.now();
    run.kill = undefined;
    // A writer that ended without a result recorded nothing for any of its documents.
    for (const d of run.docs) if (d.state === 'running') Object.assign(d, { state, outcome: 'nothing recorded', detail: '' });
    this.append(run, '', `== ${state}: ${outcome}`, ...(detail ? [detail] : []));
    this.emitter.fire(run);
    return run;
  }

  /** Starts Claude Code with a role's prompt and input; returns its result, or undefined when the run ended without one. */
  private async execute(run: AgentRun, input: string, perms: Permissions, mode?: string): Promise<ClaudeResult | undefined> {
    const { skill, file } = PROMPTS[run.role];
    const promptPath = promptFile(run.p, this.extensionPath, skill, file);
    if (!promptPath) {
      this.finish(run, 'error', `no prompt ${skill}/${file}`, 'Install the skills, or reinstall the extension.');
      return undefined;
    }
    const claude = claudeOrComplain();
    if (!claude) {
      this.finish(run, 'error', 'Claude Code not found');
      return undefined;
    }
    const prompt = agentPrompt(fs.readFileSync(promptPath, 'utf8'), input, mode);
    const model = modelFor(run.role, {
      model: this.config().get<string>('agents.model', ''),
      triageModel: this.config().get<string>('agents.triageModel', 'sonnet'),
    });
    const args = claudeArgs(perms, { model, name: `uspec ${run.title}` });
    this.append(
      run,
      `prompt: ${promptPath}`,
      `model: ${model ?? "Claude Code's default"}`,
      `tools: ${perms.tools.join(', ')}`,
      `allowed: ${perms.allowed.join(' ')}`,
      '',
      '--- input',
      ...(mode ? [mode, ''] : []),
      input.trimEnd(),
      '',
      '--- run',
    );
    run.queued = false;
    this.emitter.fire(run);
    const proc = startClaude({
      claudePath: claude,
      cwd: run.p.root,
      args,
      prompt,
      onEvent: (e) => {
        if (e.session_id && !run.sessionId) {
          run.sessionId = e.session_id;
          this.emitter.fire(run);
        }
        const lines = describeEvent(e);
        if (lines.length) this.append(run, ...lines);
      },
    });
    run.kill = proc.kill;
    const res = await proc.done;
    run.sessionId = res.sessionId ?? run.sessionId;
    run.costUsd = res.costUsd;
    run.ended = Date.now();
    this.append(run, '', '--- result', res.text || '(none)');
    if (run.stopped) {
      this.finish(run, 'stopped', 'stopped');
      return undefined;
    }
    if (res.isError) {
      const why = res.text || res.stderr.trim().split('\n').pop() || `claude exited with ${res.exitCode ?? res.signal}`;
      this.finish(run, 'error', why.split('\n')[0].slice(0, 200), res.stderr.trim());
      return undefined;
    }
    return res;
  }

  private async guard(run: AgentRun, task: () => Promise<AgentRun>): Promise<AgentRun> {
    try {
      return await task();
    } catch (e) {
      return this.finish(run, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  // --- Triage ------------------------------------------------------------------------------------

  async runTriage(p: Project, change: string, next?: NextJson): Promise<AgentRun | undefined> {
    if (this.isBusy(p, change, 'batch')) return undefined;
    next ??= await this.manager.json<NextJson>(p, ['change', 'next', change]);
    if (!next.triage) {
      void vscode.window.showInformationMessage(`${change}: nothing to triage.`);
      return undefined;
    }
    const batch = next.triage.batch.map((b) => b.document);
    const run = this.newRun(p, change, 'triage', 'batch', `${batch.length} candidate${batch.length === 1 ? '' : 's'}`);
    return this.slotsFor(p, change).run(() =>
      this.guard(run, async () => {
        if (run.stopped) return run;
        const res = await this.execute(run, triageInput(next!), permissions('triage'));
        if (!res) return run;
        const parsed = parseTriage(res.text, batch, p.specRoot);
        if (parsed.unknown.length) this.append(run, `ignored, not in the batch: ${parsed.unknown.join(', ')}`);
        if (!parsed.decisions.length) return this.finish(run, 'error', 'no decisions in the result', 'The result names no document of the batch as affected or no-change.');
        for (const d of parsed.decisions) {
          await this.manager.mutate<SetJson>(p, ['change', 'set', change, d.document, d.state, '--reason', d.reason]);
          this.append(run, `recorded ${d.document}: ${d.state} — ${d.reason}`);
        }
        const affected = parsed.decisions.filter((d) => d.state === 'affected').length;
        const missing = batch.length - parsed.decisions.length;
        const outcome = `${affected} affected, ${parsed.decisions.length - affected} no-change${missing ? `, ${missing} undecided` : ''}`;
        if (parsed.notes) void vscode.window.showInformationMessage(`Triage notes (${change}): ${parsed.notes}`, 'Show Log').then((a) => a && this.showLog(run));
        return this.finish(run, 'recorded', outcome, parsed.notes);
      }),
    );
  }

  // --- Writer ------------------------------------------------------------------------------------

  /** Whether a writer of `node` is running. */
  writing(p: Project, change: string, node: string): boolean {
    return this.runs.some((r) => r.p === p && r.change === change && r.role === 'writer' && r.item === node && r.state === 'running');
  }

  /**
   * Runs one writer on documents of one node (keys, in order), with one context for all of them, and
   * handles its result for each document on its own.
   */
  async runWriter(p: Project, change: string, node: string, documents: string[]): Promise<AgentRun | undefined> {
    if (!documents.length || this.writing(p, change, node) || documents.some((d) => this.isBusy(p, change, d))) return undefined;
    const label = `${showNode(node)} · ${documents.map((d) => `${splitDoc(d).doc}.md`).join(', ')}`;
    const run = this.newRun(p, change, 'writer', node, label);
    run.docs = documents.map((key) => ({ key, state: 'running', outcome: '', detail: '', snapshot: '' }));
    return this.slotsFor(p, change).run(() =>
      this.guard(run, async () => {
        if (run.stopped) return run;
        const input = await this.manager.text(p, writerContextArgs(node, documents, change));
        // Saved before the run: what Show Diff compares with and Reject puts back.
        for (const [i, d] of run.docs.entries()) {
          const file = p.docFile(d.key);
          d.snapshot = (await readText(p.abs(file))) ?? '';
          d.snapshotUri = this.content.register('before', `${run.id}.${i}`, path.basename(file), () => d.snapshot);
        }
        const extras = documents.flatMap((key) => {
          const { doc } = splitDoc(key);
          return p.typeDoc(node, doc)?.extra ? [join(p.nodeDir(node), `${doc}-extra`)] : [];
        });
        const res = await this.execute(run, input, permissions('writer', { documents: documents.map((d) => p.docFile(d)), extraDirs: extras }));
        if (!res) return run;
        const { results, notes } = parseWriter(res.text, documents, p.specRoot);
        if (!results.size) {
          return this.finish(run, 'error', 'unreadable result', 'Expected one result per document: its path, then `updated`, `no change` or `blocked`.');
        }
        run.notes = notes;
        const approve = this.config().get<string>('agents.approveWrites', 'user-visible');
        for (const d of run.docs) await this.handleWriterResult(run, d, results.get(d.key), approve);
        this.settleWriter(run);
        this.notifyWriter(run);
        return run;
      }),
    );
  }

  /** Records one document's result, or leaves it for approval. */
  private async handleWriterResult(run: AgentRun, d: WriterDoc, result: WriterResult | undefined, approve: string): Promise<void> {
    const p = run.p;
    const change = run.change!;
    const set = (state: RunState, outcome: string, detail = '') => {
      Object.assign(d, { state, outcome, detail });
      this.append(run, `${d.key}: ${state} — ${outcome}${detail ? ` — ${detail.split('\n')[0]}` : ''}`);
    };
    if (!result) return set('error', 'no result for this document', 'Nothing was recorded; it stays affected.');
    const edited = ((await readText(p.abs(p.docFile(d.key)))) ?? '') !== d.snapshot;
    switch (result.kind) {
      case 'updated': {
        if (!edited) return set('error', 'said updated, but the document is unchanged', 'Nothing was recorded; it stays affected.');
        d.record = async () => {
          const out = await this.manager.mutate<SetJson>(p, ['change', 'set', change, d.key, 'updated']);
          const reached = out.propagated?.length ?? 0;
          return `updated · reached ${reached} document${reached === 1 ? '' : 's'}${out.implementation ? `, + ${out.implementation} to implement` : ''}`;
        };
        if (approve === 'always' || (approve === 'user-visible' && result.userVisible)) {
          return set('needs-approval', result.summary || 'updated', 'Review the diff, then approve or reject.');
        }
        return set('recorded', await d.record(), result.summary);
      }
      case 'no-change':
        if (edited) return set('error', 'said no change, but edited the document', 'Nothing was recorded; check the document.');
        await this.manager.mutate<SetJson>(p, ['change', 'set', change, d.key, 'no-change', '--reason', result.reason]);
        return set('recorded', 'no change', result.reason);
      case 'blocked':
        return set('blocked', 'blocked', result.reason);
    }
  }

  /** A writer run's state from its documents': what needs the user first. */
  private settleWriter(run: AgentRun): AgentRun {
    const has = (s: RunState) => run.docs.some((d) => d.state === s);
    const state: RunState = has('needs-approval')
      ? 'needs-approval'
      : has('blocked')
        ? 'blocked'
        : has('error')
          ? 'error'
          : run.docs.every((d) => d.state === 'rejected')
            ? 'rejected'
            : 'recorded';
    let outcome: string;
    let detail: string;
    if (run.docs.length === 1) {
      const [d] = run.docs;
      outcome = d.outcome;
      detail = [d.detail, run.notes].filter(Boolean).join('\n\n');
    } else {
      const counts = new Map<string, number>();
      for (const d of run.docs) {
        const l = writerLabel(d);
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      outcome = [...counts].map(([l, n]) => `${n} ${l}`).join(', ');
      const lines = run.docs.map((d) => `${d.key}: ${d.outcome}${d.detail ? ` — ${d.detail}` : ''}`);
      detail = [lines.join('\n'), run.notes].filter(Boolean).join('\n\n');
    }
    return this.finish(run, state, outcome, detail);
  }

  /** Tells the user what a writer left for them: blocked documents and updates to approve. */
  private notifyWriter(run: AgentRun): void {
    const change = run.change!;
    for (const d of run.docs.filter((x) => x.state === 'blocked')) {
      void vscode.window.showWarningMessage(`Writer of ${d.key} is blocked: ${d.detail}`, 'Show Log').then((a) => a && this.showLog(run));
    }
    const waiting = run.docs.filter((d) => d.state === 'needs-approval');
    if (waiting.length === 1) {
      const [d] = waiting;
      void vscode.window
        .showInformationMessage(`${d.key} was updated (${d.outcome}). Approve it to record it in ${change}.`, 'Show Diff', 'Approve', 'Reject')
        .then((a) => (a === 'Show Diff' ? this.showDiff(run, d.key) : a === 'Approve' ? this.approve(run, d.key) : a === 'Reject' ? this.reject(run, d.key) : undefined));
    } else if (waiting.length > 1) {
      void vscode.window
        .showInformationMessage(`${waiting.length} documents of ${showNode(run.item)} were updated. Approve them to record them in ${change}.`, 'Show Diff', 'Approve All', 'Reject All')
        .then((a) => (a === 'Show Diff' ? this.showDiff(run) : a === 'Approve All' ? this.approve(run) : a === 'Reject All' ? this.reject(run) : undefined));
    }
  }

  /** A writer's documents an action applies to: the one named, else every one waiting for approval. */
  private waitingDocs(run: AgentRun, key?: string): WriterDoc[] {
    return run.docs.filter((d) => d.state === 'needs-approval' && (key === undefined || d.key === key));
  }

  /** Approves a writer's update of one document, or of every document of the run that waits. */
  async approve(run: AgentRun, key?: string): Promise<void> {
    const docs = this.waitingDocs(run, key);
    if (!docs.length) return;
    for (const d of docs) {
      try {
        const outcome = await d.record!();
        Object.assign(d, { state: 'recorded', detail: d.outcome, outcome });
        this.append(run, `${d.key}: approved — ${outcome}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Couldn't record ${d.key}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.settleWriter(run);
    this.offerToContinue(run, docs.map((d) => d.key).join(', '));
  }

  /** Once nothing of a change waits for the user, offers to go on running its agents. */
  private offerToContinue(run: AgentRun, what: string): void {
    const change = run.change;
    if (!change || this.isLooping(run.p, change) || this.runsOf(run.p, change).some((r) => r.active)) return;
    void vscode.window
      .showInformationMessage(`${what} ${what.includes(', ') ? 'are' : 'is'} recorded. Continue running agents on ${change}?`, 'Run Agents')
      .then((a) => a && this.runChange(run.p, change));
  }

  /** Puts a document back as it was before the writer, or every document of the run that waits; they stay affected. */
  async reject(run: AgentRun, key?: string): Promise<void> {
    const docs = this.waitingDocs(run, key);
    if (!docs.length) return;
    for (const d of docs) {
      await fs.promises.writeFile(run.p.abs(run.p.docFile(d.key)), d.snapshot);
      Object.assign(d, { state: 'rejected', outcome: 'rejected; the document is back as it was and still affected', detail: '' });
      this.append(run, `${d.key}: rejected`);
    }
    this.settleWriter(run);
  }

  /** Compares a writer's document, or all of them, with what it was before the run. */
  async showDiff(run: AgentRun, key?: string): Promise<void> {
    const docs = run.docs.filter((d) => d.snapshotUri && (key === undefined || d.key === key));
    const pairs = docs.map((d) => [d.snapshotUri!, run.p.uriOf(run.p.docFile(d.key))] as const);
    if (pairs.length === 1) {
      const [[before, file]] = pairs;
      await vscode.commands.executeCommand('vscode.diff', before, file, `${path.basename(file.fsPath)} (before writer ↔ now)`);
      return;
    }
    if (!pairs.length) return;
    try {
      await vscode.commands.executeCommand('vscode.changes', `${run.title} (before writer ↔ now)`, pairs.map(([before, file]) => [file, before, file]));
    } catch {
      for (const [before, file] of pairs) await vscode.commands.executeCommand('vscode.diff', before, file, `${path.basename(file.fsPath)} (before writer ↔ now)`);
    }
  }

  // --- Implementer -------------------------------------------------------------------------------

  async runImplementer(p: Project, change: string, node: string): Promise<AgentRun | undefined> {
    if (this.isBusy(p, change, node, 'implementer')) return undefined;
    const run = this.newRun(p, change, 'implementer', node);
    return this.slotsFor(p, change).run(() =>
      this.guard(run, async () => {
        if (run.stopped) return run;
        const input = await this.manager.text(p, ['context', showNode(node), '--implement', '--change', change]);
        const changeMd = (await readText(p.abs(`.uspec/changes/${change}/change.md`))) ?? '';
        const mode = fromExperiment(changeMd) ? 'Mode: check' : 'Mode: implement';
        const perms = permissions('implementer', {
          codePaths: codePaths(p, node),
          implementerAllowed: this.config().get<string[]>('agents.implementerAllowedTools', ['Bash']),
        });
        const res = await this.execute(run, input, perms, mode);
        if (!res) return run;
        const result = parseImplementer(res.text);
        switch (result.kind) {
          case 'done':
            await this.manager.mutate<SetJson>(p, ['change', 'set', change, showNode(node), 'done']);
            return this.finish(run, 'recorded', 'done', result.detail);
          case 'gap':
          case 'failed':
            void vscode.window
              .showWarningMessage(`Implementer of ${showNode(node)}: ${result.kind}. ${result.detail.split('\n')[0]}`, 'Show Log')
              .then((a) => a && this.showLog(run));
            return this.finish(run, result.kind, result.kind, result.detail);
          default:
            return this.finish(run, 'error', 'unreadable result', 'Expected `done`, `gap` or `failed`.');
        }
      }),
    );
  }

  // --- Reviewer ----------------------------------------------------------------------------------

  async runReviewer(p: Project, node: string): Promise<AgentRun | undefined> {
    if (this.runs.some((r) => r.p === p && r.role === 'reviewer' && r.item === node && r.active)) return undefined;
    const run = this.newRun(p, undefined, 'reviewer', node);
    return this.slotsFor(p, undefined).run(() =>
      this.guard(run, async () => {
        let input: string;
        if (p.hasCode(node)) {
          input = await this.manager.text(p, ['context', showNode(node), '--implement']);
        } else {
          const docs = p.nodes.get(node)?.documents ?? [];
          if (!docs.length) return this.finish(run, 'error', 'the node has no documents');
          // One context for all the node's documents, as uspec-review gives it.
          input = await this.manager.text(p, ['context', showNode(node), ...docs.flatMap((d) => ['--document', d])]);
        }
        const res = await this.execute(run, input, permissions('reviewer'));
        if (!res) return run;
        const { findings } = parseReview(res.text);
        void vscode.window
          .showInformationMessage(`Review of ${showNode(node)}: ${findings ? `${findings} finding${findings === 1 ? '' : 's'}` : 'no findings'}.`, 'Show Findings')
          .then((a) => a && this.showLog(run));
        return this.finish(run, 'reviewed', findings ? `${findings} finding${findings === 1 ? '' : 's'}` : 'no findings', res.text);
      }),
    );
  }

  // --- A whole change ----------------------------------------------------------------------------

  /** Runs rounds of agents until nothing is ready or something needs the user. */
  async runChange(p: Project, change: string): Promise<void> {
    const key = this.changeKey(p, change);
    if (this.loops.has(key)) return;
    const ctl = { stopped: false };
    this.loops.set(key, ctl);
    this.emitter.fire(undefined);
    let reason = '';
    try {
      for (let round = 1; !ctl.stopped; round++) {
        const next = await this.manager.json<NextJson>(p, ['change', 'next', change]);
        const jobs: Promise<AgentRun | undefined>[] = [];
        if (next.triage && !this.isBusy(p, change, 'batch')) jobs.push(this.runTriage(p, change, next));
        // One writer per node, on its documents that aren't already written or waiting for approval.
        for (const w of next.write) {
          const node = nodeKey(w.node);
          const docs = w.documents.map((d) => d.document).filter((d) => !this.isBusy(p, change, d));
          if (docs.length && !this.writing(p, change, node)) jobs.push(this.runWriter(p, change, node, docs));
        }
        if (!next.triage && !next.write.length) {
          for (const n of next.implement) if (!this.isBusy(p, change, nodeKey(n.node), 'implementer')) jobs.push(this.runImplementer(p, change, nodeKey(n.node)));
        }
        if (!jobs.length) {
          const waiting = this.waiting(p, change);
          reason = waiting
            ? `${waiting} update${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} for your approval`
            : next.triage || next.write.length || next.implement.length
              ? 'the ready items are already running'
              : 'nothing is ready';
          break;
        }
        this.manager.output.appendLine(`${change}: round ${round}, ${jobs.length} agent${jobs.length === 1 ? '' : 's'}`);
        const runs = (await Promise.all(jobs)).filter((r): r is AgentRun => Boolean(r));
        const stuck = runs.filter((r) => NEEDS_USER.includes(r.state));
        if (stuck.length) {
          reason = stuck.map((r) => `${r.title}: ${r.state}`).join('; ');
          break;
        }
        if (runs.some((r) => r.state === 'stopped')) break;
        await this.manager.load(p);
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    } finally {
      this.loops.delete(key);
      this.emitter.fire(undefined);
    }
    if (ctl.stopped) return;
    await this.manager.load(p);
    const c = p.change(change);
    const done = c && c.counts.pending + c.counts.affected === 0 && c.counts.implementation_pending === 0;
    if (done) {
      void vscode.window.showInformationMessage(`${change}: every document is settled and every node implemented.`, 'Close Change').then(
        (a) => a && vscode.commands.executeCommand('uspec.change.close', { kind: 'change', p, name: change }),
      );
    } else if (reason) {
      void vscode.window.showInformationMessage(`${change}: agents stopped — ${reason}.`);
    }
  }

  stopChange(p: Project, change: string): void {
    const ctl = this.loops.get(this.changeKey(p, change));
    if (ctl) ctl.stopped = true;
    for (const r of this.runsOf(p, change)) if (r.state === 'running') this.stop(r);
    this.emitter.fire(undefined);
  }

  stop(run: AgentRun): void {
    if (run.state !== 'running') return;
    run.stopped = true;
    if (run.kill) run.kill();
    else this.finish(run, 'stopped', 'stopped');
  }

  async showLog(run: AgentRun): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(run.logUri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  openSession(run: AgentRun): void {
    if (run.sessionId) openClaude(run.p, ['--resume', run.sessionId], `Claude Code · ${run.title}`);
  }

  clearFinished(): void {
    this.runs = this.runs.filter((r) => r.active);
    this.emitter.fire(undefined);
  }

  describe(run: AgentRun): string {
    const now = run.state === 'running' ? (run.queued ? 'queued' : 'running') : run.state === 'needs-approval' ? 'waiting for approval' : run.outcome || run.state;
    const parts = [now, run.elapsed];
    if (run.costUsd !== undefined) parts.push(formatCost(run.costUsd));
    return parts.join(' · ');
  }
}

/** A writer document's result in a run's summary. */
function writerLabel(d: WriterDoc): string {
  if (d.state === 'needs-approval') return 'to approve';
  if (d.state === 'recorded') return d.outcome === 'no change' ? 'no change' : 'updated';
  return d.state;
}
