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
  parseImplementer,
  parseReview,
  parseTriage,
  parseWriter,
  permissions,
  PROMPTS,
  triageInput,
  type Permissions,
  type Role,
} from './core/agents';
import { startClaude, type ClaudeResult } from './core/claude';
import type { NextJson, SetJson } from './core/model';
import { join, showNode, splitDoc } from './core/paths';
import type { ContentProvider } from './content';
import { codePaths, readText, type Project, type ProjectManager } from './projects';
import { claudeOrComplain, openClaude, promptFile } from './terminal';

export type RunState = 'running' | 'needs-approval' | 'recorded' | 'blocked' | 'gap' | 'failed' | 'error' | 'stopped' | 'rejected' | 'reviewed';

/** States after which a change's run loop stops for the user. */
const NEEDS_USER: RunState[] = ['needs-approval', 'blocked', 'gap', 'failed', 'error'];

let nextId = 1;

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
  /** A writer's document before it ran, and how to record its update once approved. */
  snapshot?: string;
  snapshotUri?: vscode.Uri;
  record?: () => Promise<string>;
  kill?: () => void;
  stopped = false;
  /** Waiting for a free slot: at most `uspec.agents.maxParallel` runs per change at once. */
  queued = true;

  constructor(
    readonly p: Project,
    readonly change: string | undefined,
    readonly role: Role,
    /** The document key, node path or `batch` the run works on. */
    readonly item: string,
    private readonly label?: string,
  ) {}

  get title(): string {
    return `${this.role}: ${this.label ?? (this.role === 'implementer' || this.role === 'reviewer' ? showNode(this.item) : this.item)}`;
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

  /** Whether an item has a run that is running or waiting for approval. */
  isBusy(p: Project, change: string, item: string): boolean {
    return this.runs.some((r) => r.p === p && r.change === change && r.item === item && r.active);
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
    const args = claudeArgs(perms, { model: this.config().get<string>('agents.model', '') || undefined, name: `uspec ${run.title}` });
    this.append(
      run,
      `prompt: ${promptPath}`,
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

  async runWriter(p: Project, change: string, key: string): Promise<AgentRun | undefined> {
    if (this.isBusy(p, change, key)) return undefined;
    const { node, doc } = splitDoc(key);
    const run = this.newRun(p, change, 'writer', key);
    return this.slotsFor(p, change).run(() =>
      this.guard(run, async () => {
        if (run.stopped) return run;
        const input = await this.manager.text(p, ['context', showNode(node), '--document', doc, '--change', change]);
        const file = p.docFile(key);
        const abs = p.abs(file);
        run.snapshot = (await readText(abs)) ?? '';
        run.snapshotUri = this.content.register('before', String(run.id), path.basename(file), () => run.snapshot ?? '');
        const extra = p.typeDoc(node, doc)?.extra ? join(p.nodeDir(node), `${doc}-extra`) : undefined;
        const res = await this.execute(run, input, permissions('writer', { document: file, extraDir: extra }));
        if (!res) return run;
        const result = parseWriter(res.text);
        const now = (await readText(abs)) ?? '';
        const edited = now !== run.snapshot;
        switch (result.kind) {
          case 'updated': {
            if (!edited) return this.finish(run, 'error', 'said updated, but the document is unchanged');
            run.record = async () => {
              const set = await this.manager.mutate<SetJson>(p, ['change', 'set', change, key, 'updated']);
              const reached = set.propagated?.length ?? 0;
              return `updated · reached ${reached} document${reached === 1 ? '' : 's'}${set.implementation ? `, + ${set.implementation} to implement` : ''}`;
            };
            const approve = this.config().get<string>('agents.approveWrites', 'user-visible');
            if (approve === 'always' || (approve === 'user-visible' && result.userVisible)) {
              this.finish(run, 'needs-approval', result.summary || 'updated', ['Review the diff, then approve or reject.', result.notes].filter(Boolean).join('\n\n'));
              void vscode.window
                .showInformationMessage(`${key} was updated (${result.summary}). Approve it to record it in ${change}.`, 'Show Diff', 'Approve', 'Reject')
                .then((a) => (a === 'Show Diff' ? this.showDiff(run) : a === 'Approve' ? this.approve(run) : a === 'Reject' ? this.reject(run) : undefined));
              return run;
            }
            return this.finish(run, 'recorded', await run.record(), [result.summary, result.notes].filter(Boolean).join('\n\n'));
          }
          case 'no-change':
            if (edited) return this.finish(run, 'error', 'said no change, but edited the document', 'Nothing was recorded; check the document.');
            await this.manager.mutate<SetJson>(p, ['change', 'set', change, key, 'no-change', '--reason', result.reason]);
            return this.finish(run, 'recorded', 'no change', result.reason);
          case 'blocked':
            void vscode.window.showWarningMessage(`Writer of ${key} is blocked: ${result.reason}`, 'Show Log').then((a) => a && this.showLog(run));
            return this.finish(run, 'blocked', 'blocked', result.reason);
          default:
            return this.finish(run, 'error', 'unreadable result', 'Expected `updated`, `no change` or `blocked`.');
        }
      }),
    );
  }

  async approve(run: AgentRun): Promise<void> {
    if (run.state !== 'needs-approval' || !run.record) return;
    try {
      this.finish(run, 'recorded', await run.record(), run.outcome);
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't record ${run.item}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    this.offerToContinue(run);
  }

  /** Once nothing of a change waits for the user, offers to go on running its agents. */
  private offerToContinue(run: AgentRun): void {
    const change = run.change;
    if (!change || this.isLooping(run.p, change) || this.runsOf(run.p, change).some((r) => r.active)) return;
    void vscode.window
      .showInformationMessage(`${run.item} is recorded. Continue running agents on ${change}?`, 'Run Agents')
      .then((a) => a && this.runChange(run.p, change));
  }

  async reject(run: AgentRun): Promise<void> {
    if (run.state !== 'needs-approval' || run.snapshot === undefined) return;
    await fs.promises.writeFile(run.p.abs(run.p.docFile(run.item)), run.snapshot);
    this.finish(run, 'rejected', 'rejected; the document is back as it was and still affected');
  }

  async showDiff(run: AgentRun): Promise<void> {
    if (!run.snapshotUri) return;
    const file = run.p.uriOf(run.p.docFile(run.item));
    await vscode.commands.executeCommand('vscode.diff', run.snapshotUri, file, `${path.basename(file.fsPath)} (before writer ↔ now)`);
  }

  // --- Implementer -------------------------------------------------------------------------------

  async runImplementer(p: Project, change: string, node: string): Promise<AgentRun | undefined> {
    if (this.isBusy(p, change, node)) return undefined;
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
          const parts = await Promise.all(docs.map((d) => this.manager.text(p, ['context', showNode(node), '--document', d])));
          input = parts.join('\n');
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
        for (const w of next.write) if (!this.isBusy(p, change, w.document)) jobs.push(this.runWriter(p, change, w.document));
        if (!next.triage && !next.write.length) {
          for (const n of next.implement) if (!this.isBusy(p, change, n.node === '.' ? '' : n.node)) jobs.push(this.runImplementer(p, change, n.node === '.' ? '' : n.node));
        }
        if (!jobs.length) {
          const waiting = this.runsOf(p, change).filter((r) => r.state === 'needs-approval').length;
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
