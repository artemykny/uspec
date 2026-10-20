// Agent runs on a change: starting the selected agent per item, recording results with `uspec change set`,
// approval of writer updates, logs (docs/vscode/overview.md#agents).
import { type AgentProvider, providerLabel, executionArgs, resumeArgs, codexScope, canFork } from './core/provider';
import * as fs from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  agentPrompt,
  describeEvent,
  formatCost,
  formatDuration,
  fromExperiment,
  impactInput,
  implementerInput,
  modelFor,
  parseImpact,
  parseImplementer,
  parsePlanner,
  parseReview,
  parseTriage,
  parseWriter,
  permissions,
  plannerInput,
  PROMPTS,
  triageInput,
  writerContextArgs,
  writerInput,
  type Permissions,
  type Role,
  type StartingDocument,
  type WriterResult,
} from './core/agents';
import type { ClaudeResult } from './core/claude';
import { agentAlive, endAgent, isInteractive, startTerminalAgent, revealAgentTerminal } from './agentTerminal';
import { fileProposal, readFileProposal, readSplit, type FileDecision, type SplitPlan } from './core/workflow';
import type { NextJson, SetJson } from './core/model';
import { isTemplateLeft } from './core/templates';
import { join, nodeKey, showNode, splitDoc } from './core/paths';
import { autoSplit, DEFAULT_MODE, describeMode, EXPLORE, parseSessions, resolveSession, sharedSession, splitterOff, type SessionConfig, type SessionItem } from './core/sessions';
import type { ContentProvider } from './content';
import { codePaths, readText, type Project, type ProjectManager } from './projects';
import { SessionStore } from './sessionStore';
import { agentOrComplain, closeChangeSessions, openAgent, selectedProvider, promptFile, tagChange } from './terminal';

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
  provider: AgentProvider = 'claude';
  readonly log: string[] = [];
  logUri!: vscode.Uri;
  /** A writer's documents, in the order given, each with its own result. */
  docs: WriterDoc[] = [];
  /** An impact run's starting documents, waiting for the user to keep them. */
  starting: StartingDocument[] = [];
  /** A writer's nodes (several when their writers share a session), or the nodes of a split or plan. */
  nodes: string[] = [];
  /** The plan files a planner wrote. */
  plans: string[] = [];
  planApprovals: Record<string, string> = {};
  /** What a writer added after its results. */
  notes = '';
  proposal?: string;
  candidates: string[] = [];
  terminal?: vscode.Terminal;
  /** Whether the user continued the run's session in its terminal. */
  resumed = false;
  kill?: () => void;
  stopped = false;
  /** Waiting for its session or a free slot: at most `uspec.agents.maxParallel` runs per change at once. */
  queued = true;
  /** The named session the run went to, and whether it was new, resumed or forked (and from which). */
  session?: { name: string; how: 'new' | 'resumed' | 'forked'; from?: string };
  /** The session the run is to go to: a name from `uspec.agents.sessions`, or, for a revision, the session id to resume. */
  want?: { name?: string; from?: string; resume?: string };

  constructor(
    readonly p: Project,
    readonly change: string | undefined,
    readonly role: Role,
    /** The node path (reviewer, writer: its first node), the plan id (implementer), `batch` (triage) or `change` (impact, planner) the run works on. */
    readonly item: string,
    private readonly label?: string,
  ) {}

  get title(): string {
    const what = this.label ?? (this.role === 'triage' || this.role === 'impact' || this.role === 'planner' ? this.item : this.role === 'implementer' ? `plan ${this.item}` : showNode(this.item));
    return `${this.role}: ${what}`;
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

/** A session the user opened with the agent, until its change has it as its explore session. */
interface PendingExplore {
  root: string;
  change?: string;
  terminal?: vscode.Terminal;
  id?: string;
  provider?: AgentProvider;
}

export class AgentManager implements vscode.Disposable {
  runs: AgentRun[] = [];
  private readonly emitter = new vscode.EventEmitter<AgentRun | undefined>();
  readonly onDidChange = this.emitter.event;
  private readonly loops = new Map<string, { stopped: boolean }>();
  private readonly slots = new Map<string, Slots>();
  /** One job at a time per session, in the order jobs are started. */
  private readonly locks = new Map<string, Slots>();
  private readonly ticker: NodeJS.Timeout;
  /** The open changes of each project root, as last loaded. */
  private readonly openChanges = new Map<string, Set<string>>();
  private readonly watcher: vscode.Disposable;
  private readonly configWatcher: vscode.Disposable;
  /** The agent sessions of each change, by name. */
  readonly sessions: SessionStore;
  /** Start Change with Agent sessions still waiting for their change to appear. */
  private pendingExplore: PendingExplore[] = [];

  constructor(
    private readonly manager: ProjectManager,
    private readonly content: ContentProvider,
    private readonly extensionPath: string,
    private readonly approvals: vscode.Memento,
  ) {
    this.sessions = new SessionStore(approvals);
    // Elapsed times of running agents.
    this.ticker = setInterval(() => {
      if (this.runs.some((r) => r.state === 'running')) this.emitter.fire(undefined);
    }, 5000);
    // A change that is no longer open takes its agents' sessions with it; one that appears takes the
    // session Start Change with Agent opened.
    this.watcher = manager.onDidChange((p) => {
      for (const q of p ? [p] : manager.projects) {
        const open = new Set(q.changes.map((c) => c.name));
        const before = this.openChanges.get(q.root);
        for (const change of before ?? []) if (!open.has(change)) this.closeSessions(q, change);
        if (before) for (const change of open) if (!before.has(change)) this.adoptExplore(q, change);
        this.openChanges.set(q.root, open);
      }
    });
    this.checkSessions();
    this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('uspec.agents.sessions') || e.affectsConfiguration('uspec.agents.sessionMode')) this.checkSessions();
    });
  }

  dispose(): void {
    clearInterval(this.ticker);
    this.watcher.dispose();
    this.configWatcher.dispose();
    for (const r of this.runs) r.kill?.();
    this.emitter.dispose();
  }

  private config() {
    return vscode.workspace.getConfiguration('uspec');
  }

  /** The session modes: the presets and those of `uspec.agents.sessions`; a mode with a problem is `isolated`. */
  modes(): Record<string, SessionConfig> {
    return parseSessions(this.config().get('agents.sessions')).modes;
  }

  /** The mode of a change that chose none: `uspec.agents.sessionMode`, while it names a mode. */
  defaultMode(): string {
    const mode = this.config().get<string>('agents.sessionMode', DEFAULT_MODE);
    return mode in this.modes() ? mode : DEFAULT_MODE;
  }

  /** The session mode of a change: the one chosen for it while it is still a mode, else the default. */
  mode(p: Project, change: string): string {
    const mode = this.sessions.mode(p, change);
    return mode !== undefined && mode in this.modes() ? mode : this.defaultMode();
  }

  setMode(p: Project, change: string, mode: string): void {
    this.sessions.setMode(p, change, mode);
    this.emitter.fire(undefined);
  }

  /** Asks how the change's agents go on: the session mode of its next jobs. Undefined when the user cancels. */
  async chooseMode(p: Project, change: string): Promise<string | undefined> {
    const current = this.mode(p, change);
    const modes = this.modes();
    const names = [current, ...Object.keys(modes).filter((m) => m !== current)];
    const pick = await vscode.window.showQuickPick(
      names.map((name) => ({ label: name, description: name === current ? 'current' : name === this.defaultMode() ? 'default' : undefined, detail: describeMode(modes[name]), name })),
      { placeHolder: `${change}: which jobs share an agent session?`, ignoreFocusOut: true },
    );
    if (!pick) return undefined;
    this.setMode(p, change, pick.name);
    return pick.name;
  }

  /** Which jobs of a change share a session, from its mode. */
  private sessionConfig(p: Project, change: string): SessionConfig {
    return this.modes()[this.mode(p, change)] ?? {};
  }

  /** Warns about each problem of `uspec.agents.sessions` and `uspec.agents.sessionMode`. */
  private checkSessions(): void {
    for (const problem of parseSessions(this.config().get('agents.sessions')).problems) void vscode.window.showWarningMessage(problem);
    const mode = this.config().get<string>('agents.sessionMode', DEFAULT_MODE);
    if (!(mode in this.modes())) void vscode.window.showWarningMessage(`uspec.agents.sessionMode: \`${mode}\` isn't a session mode. Changes use ${DEFAULT_MODE} until this is fixed.`);
  }

  /** Whether the change's next jobs would continue a session: a new context can start them afresh. */
  canStartNewContext(p: Project, change: string): boolean {
    return Object.keys(this.sessionConfig(p, change)).length > 0 && this.sessions.hasSessions(p, change) && !this.isRunning(p, change);
  }

  /**
   * Starts the change's next jobs in new sessions: its named sessions are forgotten, and each name's next
   * job starts a new one, which the jobs after it continue (docs/vscode/overview.md#agents, Sessions).
   */
  newContext(p: Project, change: string): void {
    if (this.isRunning(p, change)) {
      void vscode.window.showWarningMessage(`${change}: agents are running. Stop them before starting a new context.`);
      return;
    }
    this.sessions.forget(p, change);
    this.emitter.fire(undefined);
    void vscode.window.showInformationMessage(`${change}: the next jobs start in new agent sessions.`);
  }

  // --- Explore sessions --------------------------------------------------------------------------

  /**
   * Opens the user's interactive `uspec-spec` session (Start/Continue with Agent). Its session id,
   * from the agent's hooks, becomes the explore session of `change`, replacing an earlier one; started
   * before the change exists, of the first change that appears while its terminal is open.
   */
  openExplore(p: Project, prompt: string, change?: string): void {
    const x: PendingExplore = { root: p.root, change };
    x.terminal = openAgent(p, [], {
      prompt,
      name: change ? `Agent · ${change}` : undefined,
      change,
      onSession: (id, provider) => {
        Object.assign(x, { id, provider });
        this.claimExplore(x);
      },
    });
    if (x.terminal && !change) this.pendingExplore.push(x);
  }

  private adoptExplore(p: Project, change: string): void {
    this.pendingExplore = this.pendingExplore.filter((x) => x.terminal && vscode.window.terminals.includes(x.terminal));
    const x = this.pendingExplore.find((y) => y.root === p.root);
    if (!x || this.sessions.explore(p, change)?.id) return;
    this.pendingExplore = this.pendingExplore.filter((y) => y !== x);
    x.change = change;
    tagChange(x.terminal!, p.root, change);
    this.claimExplore(x);
  }

  private claimExplore(x: PendingExplore): void {
    const p = this.manager.projects.find((q) => q.root === x.root);
    if (!p || !x.change || !x.id || !x.provider || !p.change(x.change)) return;
    this.sessions.set(p, x.change, EXPLORE, { id: x.id, provider: x.provider, jobs: 0, terminal: x.terminal });
  }

  private changeKey(p: Project, change: string | undefined): string {
    return `${p.root}|${change ?? ''}`;
  }

  runsOf(p: Project, change: string | undefined): AgentRun[] {
    return this.runs.filter((r) => r.p === p && r.change === change);
  }

  /**
   * Whether an item has a run that is running or waiting for approval: the triage `batch`, a node
   * (of `role`, when given; one of a writer's nodes), or a document a writer is writing or that waits
   * for approval.
   */
  isBusy(p: Project, change: string, item: string, role?: Role): boolean {
    return this.runs.some(
      (r) =>
        r.p === p &&
        r.change === change &&
        r.active &&
        (!role || r.role === role) &&
        (r.item === item ||
          (r.role === 'writer' && r.nodes.includes(item)) ||
          r.docs.some((d) => d.key === item && (d.state === 'running' || d.state === 'needs-approval'))),
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

  private lockFor(p: Project, change: string | undefined, session: string): Slots {
    const key = `${this.changeKey(p, change)}|${session}`;
    let s = this.locks.get(key);
    if (!s) {
      s = new Slots(() => 1);
      this.locks.set(key, s);
    }
    return s;
  }

  /**
   * Names the run's session from its role and item (a revision already has its own), then runs `task`
   * once the session's earlier jobs are done and the change has a free slot. Call it as the job starts:
   * jobs of a session run in the order they are queued.
   */
  private queue(run: AgentRun, item: SessionItem, task: () => Promise<AgentRun>): Promise<AgentRun> {
    if (!run.want && run.change && run.role !== 'reviewer') run.want = resolveSession(this.sessionConfig(run.p, run.change), run.role, item);
    const key = run.want?.name ?? (run.want?.resume ? `id:${run.want.resume}` : undefined);
    const slot = () => this.slotsFor(run.p, run.change).run(task);
    return key ? this.lockFor(run.p, run.change, key).run(slot) : slot();
  }

  private newRun(p: Project, change: string | undefined, role: Role, item: string, label?: string): AgentRun {
    const run = new AgentRun(p, change, role, item, label);
    run.provider = selectedProvider();
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
    this.persist();
    this.emitter.fire(run);
    return run;
  }

  /**
   * Starts the run’s provider with a role's prompt and input in the run's session: the named session
   * resumed, a fork of its source, or a new one (docs/vscode/overview.md#agents, Sessions). Returns its
   * result, or undefined when the run ended without one or wasn't started.
   */
  private async execute(run: AgentRun, input: string, perms: Permissions, mode?: string): Promise<ClaudeResult | undefined> {
    const want = run.want ?? {};
    const known = want.name && run.change ? this.sessions.get(run.p, run.change, want.name) : undefined;
    let how: 'new' | 'resumed' | 'forked' = 'new';
    let terminal: vscode.Terminal | undefined;
    let jobsBefore = 0;
    let why = '';
    if (want.resume) {
      // A revision resumes the session that produced it, with its provider.
      run.sessionId = want.resume;
      how = 'resumed';
      terminal = run.terminal;
      jobsBefore = 1;
    } else if (known?.id) {
      Object.assign(run, { provider: known.provider, sessionId: known.id });
      how = 'resumed';
      terminal = known.terminal;
      jobsBefore = known.jobs;
    } else if (want.from && run.change) {
      const source = this.sessions.get(run.p, run.change, want.from);
      if (source?.id && canFork(source.provider)) {
        Object.assign(run, { provider: source.provider, sessionId: source.id });
        how = 'forked';
        jobsBefore = source.jobs;
      } else why = source?.id ? `${providerLabel(source.provider)} can't fork ${want.from}` : `${want.from} has no session yet`;
    }
    // A session does one job at a time: an agent still open in its terminal is ended first, after
    // asking when the user is talking to it; the job then runs in that terminal.
    if (terminal && !vscode.window.terminals.includes(terminal)) terminal = undefined;
    if (terminal && agentAlive(terminal)) {
      if (isInteractive(terminal) || this.runs.some((r) => r.terminal === terminal && r.resumed)) {
        const pick = await vscode.window.showWarningMessage(
          `${run.title} continues the agent session ${want.name ?? run.sessionId}, which is still open in its terminal. End it and continue there?`,
          { modal: true },
          'End and Continue',
        );
        if (pick !== 'End and Continue') return this.cancel(run);
      }
      await endAgent(terminal);
    }
    if (terminal) for (const r of this.runs) if (r.terminal === terminal) r.resumed = false;
    const { skill, file } = PROMPTS[run.role];
    const promptPath = promptFile(run.p, this.extensionPath, skill, file, run.provider);
    if (!promptPath) {
      this.finish(run, 'error', `no prompt ${skill}/${file}`, 'Install the skills, or reinstall the extension.');
      return undefined;
    }
    const executable = agentOrComplain(run.provider);
    if (!executable) {
      this.finish(run, 'error', `${providerLabel(run.provider)} not found`);
      return undefined;
    }
    const reread = jobsBefore > 0;
    const shared = want.name && run.change ? sharedSession(this.sessionConfig(run.p, run.change), run.role) : false;
    const prompt = agentPrompt(fs.readFileSync(promptPath, 'utf8'), input, mode) + (run.provider === 'codex' ? codexScope(perms, { reread }) : '');
    const model = modelFor(run.role, {
      model: this.config().get<string>(run.provider === 'codex' ? 'agents.codexModel' : 'agents.model', ''),
      triageModel: this.config().get<string>(run.provider === 'codex' ? 'agents.codexTriageModel' : 'agents.triageModel', run.provider === 'codex' ? '' : 'sonnet'),
    }, shared);
    const args = executionArgs(run.provider, perms, { model, name: `uspec ${run.title}`, sessionId: run.sessionId, fork: how === 'forked', reread });
    if (want.name) run.session = { name: want.name, how, ...(how === 'forked' ? { from: want.from } : {}) };
    this.append(
      run,
      `prompt: ${promptPath}`,
      `model: ${model ?? `${providerLabel(run.provider)} default`}`,
      `provider: ${providerLabel(run.provider)}`,
      ...(run.provider === 'claude' ? [`tools: ${perms.tools.join(', ')}`, `allowed: ${perms.allowed.join(' ')}`] : [codexScope(perms, { reread }).trim()]),
      `session: ${want.name ? `${want.name} (${how === 'forked' ? `forked from ${want.from}` : how}${why ? `; ${why}` : ''})` : how}`,
      '',
      '--- input',
      ...(mode ? [mode, ''] : []),
      input.trimEnd(),
      '',
      '--- run',
    );
    run.queued = false;
    this.persist();
    this.emitter.fire(run);
    const proc = startTerminalAgent({
      name: `uspec · ${run.change ?? "review"} · ${want.name ? `${want.name} · ` : ''}${run.title}`,
      terminal,
      executable,
      provider: run.provider,
      cwd: run.p.root,
      args,
      prompt,
      onEvent: (e) => {
        if (e.session_id && e.session_id !== run.sessionId) {
          run.sessionId = e.session_id;
          this.persist();
          this.emitter.fire(run);
        }
        const lines = describeEvent(e);
        if (lines.length) this.append(run, ...lines);
      },
    });
    run.terminal = proc.terminal;
    run.kill = proc.kill;
    const res = await proc.done;
    run.sessionId = res.sessionId ?? run.sessionId;
    run.costUsd = res.costUsd;
    run.ended = Date.now();
    // The session now continues from this job, in its terminal.
    if (want.name && run.change && run.sessionId) {
      this.sessions.set(run.p, run.change, want.name, { id: run.sessionId, provider: run.provider, jobs: (known?.jobs ?? 0) + 1, terminal: run.terminal });
    }
    this.append(run, '', '--- result', res.text || '(none)');
    if (run.stopped) {
      this.finish(run, 'stopped', 'stopped');
      return undefined;
    }
    if (res.isError) {
      const why = res.text || res.stderr.trim().split('\n').pop() || `${providerLabel(run.provider)} exited with ${res.exitCode ?? res.signal}`;
      this.finish(run, 'error', why.split('\n')[0].slice(0, 200), res.stderr.trim());
      return undefined;
    }
    return res;
  }

  /**
   * A job the user didn't let end its session's open agent: it isn't started, and the change's run
   * loop stops. A revision's documents wait for the user again.
   */
  private cancel(run: AgentRun): undefined {
    const ctl = this.loops.get(this.changeKey(run.p, run.change));
    if (ctl) ctl.stopped = true;
    run.ended = Date.now();
    run.queued = false;
    if (run.want?.resume) {
      for (const d of run.docs) if (d.state === 'running') d.state = 'needs-approval';
      run.state = 'needs-approval';
    } else {
      run.state = 'stopped';
      run.stopped = true;
      this.runs = this.runs.filter((r) => r !== run);
    }
    this.persist();
    this.emitter.fire(undefined);
    return undefined;
  }

  private async guard(run: AgentRun, task: () => Promise<AgentRun>): Promise<AgentRun> {
    try {
      return await task();
    } catch (e) {
      return this.finish(run, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  /** Offers to resolve what a run couldn't with the run’s original agent. */
  private offerSession(run: AgentRun, message: string): void {
    void vscode.window.showWarningMessage(message, 'Continue with Agent', 'Show Log').then((a) => {
      if (a === 'Show Log') void this.showLog(run);
      if (a === 'Continue with Agent') void this.openSession(run);
    });
  }

  // --- Impact ------------------------------------------------------------------------------------

  /** Finds the starting documents of a change that has none; they wait for the user to keep them. */
  async runImpact(p: Project, change: string): Promise<AgentRun | undefined> {
    if (this.isBusy(p, change, 'change', 'impact')) return undefined;
    const changeMd = `.uspec/changes/${change}/change.md`;
    if (isTemplateLeft((await readText(p.abs(changeMd))) ?? '')) {
      const pick = await vscode.window.showWarningMessage(
        `${change}: change.md still has template guidance. The starting documents are found from it, so describe the change first.`,
        { modal: true },
        'Find Anyway',
        'Write with Agent',
      );
      if (pick === 'Write with Agent') void vscode.commands.executeCommand('uspec.claude.continueChange', { p, name: change });
      if (pick !== 'Find Anyway') return undefined;
    }
    const run = this.newRun(p, change, 'impact', 'change', 'starting documents');
    return this.queue(run, {}, () =>
      this.guard(run, async () => {
        if (run.stopped) return run;
        const tree = await this.manager.text(p, ['tree']);
        const res = await this.execute(run, impactInput(changeMd, tree), permissions('impact'));
        if (!res) return run;
        const exists = (key: string) => {
          const { node, doc } = splitDoc(key);
          return Boolean(p.nodes.get(node)?.documents.includes(doc));
        };
        const allowed = [...p.nodes].flatMap(([node, n]) => n.documents.map(d => `${node ? node + '/' : ''}${d}.md`));
        const legacy = parseImpact(res.text, exists, p.specRoot);
        const markdown = /^### /m.test(res.text) ? res.text : fileProposal('Change plan', legacy.documents.map(d => ({ ...d, state: 'affected', comment: '' })));
        run.proposal = `.uspec/changes/${change}/change-plan.md`;
        run.candidates = allowed;
        await fs.promises.writeFile(p.abs(run.proposal), markdown);
        const decisions = readFileProposal(markdown, allowed);
        const parsed = { documents: decisions.filter(d => d.state === 'affected'), notes: '' };
        if (!parsed.documents.length) return this.finish(run, 'error', 'no starting documents');
        run.starting = parsed.documents;
        const n = parsed.documents.length;
        const detail = [parsed.documents.map((d) => `${d.document}: ${d.reason}`).join('\n'), parsed.notes].filter(Boolean).join('\n\n');
        this.finish(run, 'needs-approval', `${n} starting document${n === 1 ? '' : 's'}`, detail);
        void vscode.window
          .showInformationMessage(`${change}: ${n} starting document${n === 1 ? '' : 's'} found${parsed.notes ? `. Notes: ${parsed.notes}` : ''}. Review them to start the change.`, 'Review', 'Show Log')
          .then((a) => (a === 'Review' ? this.approve(run) : a === 'Show Log' ? this.showLog(run) : undefined));
        return run;
      }),
    );
  }

  /** Lets the user keep the starting documents they want, and records them as affected. */
  private async approveImpact(run: AgentRun): Promise<void> {
    const picks = await vscode.window.showQuickPick(
      run.starting.map((d) => ({ label: d.document, detail: d.reason, picked: true, d })),
      { canPickMany: true, placeHolder: `Starting documents of ${run.change}: keep the ones the change starts at`, ignoreFocusOut: true },
    );
    if (!picks) return;
    await this.keepStarting(run, picks.map((x) => x.d.document));
  }

  /** Records the starting documents the user kept as affected, with their reasons; none kept rejects them all. */
  async keepStarting(run: AgentRun, keep: string[]): Promise<void> {
    if (run.state !== 'needs-approval' || run.role !== 'impact') return;
    const decisions = await this.proposalFiles(run);
    const kept = decisions.filter(d => keep.includes(d.document));
    await fs.promises.writeFile(run.p.abs(run.proposal!), fileProposal('Change plan', decisions.map(d => ({ ...d, state: keep.includes(d.document) ? 'affected' : 'no-change' }))));
    if (!kept.length) return this.rejectImpact(run);
    for (const d of kept) {
      await this.approvals.update(this.commentKey(run.p, run.change!, d.document), d.comment);
      await this.manager.mutate<SetJson>(run.p, ['change', 'set', run.change!, d.document, 'affected', '--reason', d.reason]);
      this.append(run, `recorded ${d.document}: affected — ${d.reason}`);
    }
    const dropped = run.starting.length - kept.length;
    this.finish(run, 'recorded', `${kept.length} starting document${kept.length === 1 ? '' : 's'}${dropped ? `, ${dropped} dropped` : ''}`, run.detail);
    this.offerToContinue(run, `The starting documents of ${run.change}`);
  }

  private rejectImpact(run: AgentRun): void {
    this.finish(run, 'rejected', 'nothing recorded', run.detail);
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
    // Every triage run starts the next round of the change.
    return this.queue(run, { round: this.sessions.nextRound(p, change) }, () =>
      this.guard(run, async () => {
        if (run.stopped) return run;
        const res = await this.execute(run, triageInput(next!), permissions('triage'));
        if (!res) return run;
        const legacy = parseTriage(res.text, batch, p.specRoot);
        const markdown = /^### /m.test(res.text) ? res.text : fileProposal('Triage review', legacy.decisions.map(d => ({ ...d, comment: '' })));
        run.proposal = `.uspec/changes/${change}/triage-${Date.now()}-${run.id}.md`;
        run.candidates = batch;
        await fs.promises.writeFile(p.abs(run.proposal), markdown);
        const decisions = readFileProposal(markdown, batch, true);
        return this.finish(run, 'needs-approval', `${decisions.filter(d => d.state === 'affected').length} files to review`);

      }),
    );
  }

  // --- Writer ------------------------------------------------------------------------------------

  /** Whether a writer of `node` is running, on its own or with other nodes. */
  writing(p: Project, change: string, node: string): boolean {
    return this.runs.some((r) => r.p === p && r.change === change && r.role === 'writer' && (r.item === node || r.nodes.includes(node)) && r.state === 'running');
  }

  /**
   * Runs one writer on documents (keys, in order) of one node, or of the nodes of a round whose
   * writers share a session, with each node's context, and handles its result for each document on
   * its own.
   */
  async runWriter(p: Project, change: string, node: string | string[], documents: string[]): Promise<AgentRun | undefined> {
    if (!p.change(change)) await this.manager.load(p);
    const nodes = typeof node === 'string' ? [node] : node;
    if (!nodes.length || !documents.length || nodes.some((n) => this.writing(p, change, n)) || documents.some((d) => this.isBusy(p, change, d))) return undefined;
    const docsOf = (n: string) => documents.filter((d) => splitDoc(d).node === n);
    const label = nodes.map((n) => `${showNode(n)} · ${docsOf(n).map((d) => `${splitDoc(d).doc}.md`).join(', ')}`).join('; ');
    const run = this.newRun(p, change, 'writer', nodes[0], label);
    run.nodes = nodes;
    run.docs = documents.map((key) => ({ key, state: 'running', outcome: '', detail: '', snapshot: '' }));
    // Writers belong to the round of the last triage run before them.
    return this.queue(run, { round: this.sessions.round(p, change), node: nodes[0] }, () =>
      this.guard(run, async () => {
        if (run.stopped) return run;
        const contexts = await Promise.all(nodes.map(async (n) => ({ node: n, context: await this.manager.text(p, writerContextArgs(n, docsOf(n), change)) })));
        const input = writerInput(contexts) + '\nUser review comments:\n' + documents.map(d => `${d}: ${this.approvals.get<string>(this.commentKey(p, change, d), '')}`).join('\n');
        // Saved before the run: what Show Diff compares with and Reject puts back.
        for (const [i, d] of run.docs.entries()) {
          const file = p.docFile(d.key);
          d.snapshot = (await readText(p.abs(file))) ?? '';
          d.snapshotUri = this.content.register('before', `${run.id}.${i}`, path.basename(file), () => d.snapshot);
        }
        const extras = documents.flatMap((key) => {
          const { node: n, doc } = splitDoc(key);
          return p.typeDoc(n, doc)?.extra ? [join(p.nodeDir(n), `${doc}-extra`)] : [];
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

  /**
   * Revises selected files in the author's session, keeping the original review snapshots. It waits
   * for the session's other jobs, and asks before ending the session's agent the user still has open.
   */
  async reviseWriter(run: AgentRun, edits: { document: string; selected: boolean; comment: string }[]): Promise<void> {
    if (run.role !== 'writer' || run.state !== 'needs-approval') return;
    const docs = run.docs.filter(d => d.state === 'needs-approval' && edits.some(e => e.document === d.key && e.selected));
    if (!docs.length) return;
    run.state = 'running'; run.ended = undefined; run.stopped = false; run.queued = true;
    for (const d of docs) d.state = 'running';
    run.want = { name: run.session?.name, resume: run.sessionId };
    this.emitter.fire(run);
    await this.queue(run, {}, () => this.guard(run, async () => {
      const nodes = [...new Set(docs.map(d => splitDoc(d.key).node))];
      const contexts = await Promise.all(nodes.map(async n => ({ node: n, context: await this.manager.text(run.p, writerContextArgs(n, docs.filter(d => splitDoc(d.key).node === n).map(d => d.key), run.change!)) })));
      const comments = edits.filter(e => docs.some(d => d.key === e.document)).map(e => `${e.document}: ${e.comment}`).join('\n');
      const res = await this.execute(run, writerInput(contexts) + '\nRevise only these selected files. User comments:\n' + comments, permissions('writer', { documents: docs.map(d => run.p.docFile(d.key)) }));
      if (!res) return run;
      const parsed = parseWriter(res.text, docs.map(d => d.key), run.p.specRoot);
      for (const d of docs) await this.handleWriterResult(run, d, parsed.results.get(d.key), 'always');
      return this.settleWriter(run);
    }));
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
    for (const d of run.docs.filter((x) => x.state === 'blocked')) this.offerSession(run, `Writer of ${d.key} is blocked: ${d.detail}`);
    const waiting = run.docs.filter((d) => d.state === 'needs-approval');
    if (waiting.length === 1) {
      const [d] = waiting;
      void vscode.window
        .showInformationMessage(`${d.key} was updated (${d.outcome}). Approve it to record it in ${change}.`, 'Show Diff', 'Approve', 'Reject')
        .then((a) => (a === 'Show Diff' ? this.showDiff(run, d.key) : a === 'Approve' ? this.approve(run, d.key) : a === 'Reject' ? this.reject(run, d.key) : undefined));
    } else if (waiting.length > 1) {
      void vscode.window
        .showInformationMessage(`${waiting.length} documents of ${(run.nodes.length ? run.nodes : [run.item]).map(showNode).join(', ')} were updated. Approve them to record them in ${change}.`, 'Show Diff', 'Approve All', 'Reject All')
        .then((a) => (a === 'Show Diff' ? this.showDiff(run) : a === 'Approve All' ? this.approve(run) : a === 'Reject All' ? this.reject(run) : undefined));
    }
  }

  /** A writer's documents an action applies to: the one named, else every one waiting for approval. */
  private waitingDocs(run: AgentRun, key?: string): WriterDoc[] {
    return run.docs.filter((d) => d.state === 'needs-approval' && (key === undefined || d.key === key));
  }

  /** Approves a run that waits: the starting documents, the plans, or a writer's update of one document or every one that waits. */
  async approve(run: AgentRun, key?: string): Promise<void> {
    if (run.state !== 'needs-approval') return;
    if (run.role === 'impact') return this.approveProposal(run);
    if (run.role === 'triage') return this.approveProposal(run);
    if (run.role === 'splitter') return this.approveSplit(run);
    if (run.state === 'needs-approval' && run.role === 'planner') {
      const current = await this.planFingerprints(run.p, run.change!, run.plans);
      if (JSON.stringify(current) !== JSON.stringify(run.planApprovals)) {
        run.planApprovals = current; this.persist();
        throw new Error('The plan changed. Review its current content, then approve again.');
      }
      for (const [key, hash] of Object.entries(run.planApprovals)) await this.approvals.update(key, hash);
      this.finish(run, 'recorded', run.outcome.replace(/ to review$/, ''), run.detail);
      this.offerToContinue(run, `The plans of ${run.change}`);
      return;
    }
    const docs = this.waitingDocs(run, key);
    if (!docs.length) return;
    for (const d of docs) {
      try {
        const outcome = d.record ? await d.record() : (await this.manager.mutate(run.p, ['change', 'set', run.change!, d.key, 'updated']), 'updated');
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
      .showInformationMessage(`${what} ${what.includes(', ') || /^The /.test(what) ? 'are' : 'is'} recorded. Continue running agents on ${change}?`, 'Run Agents')
      .then((a) => a && this.runChange(run.p, change));
  }

  /** Rejects a run that waits: records no starting document, defers plan review, or puts a writer's document(s) back as they were. */
  async reject(run: AgentRun, key?: string): Promise<void> {
    if (run.state === 'needs-approval' && run.role === 'impact') return this.rejectImpact(run);
    if (run.role === 'planner' || run.role === 'splitter' || run.role === 'triage') {
      this.finish(run, 'rejected', 'review deferred');
      return;
    }
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

  // --- Planner ---------------------------------------------------------------------------------

  /** Writes the plans for the nodes no plan holds; they wait for the user with `uspec.agents.approvePlans`. */
  split(p: Project, change: string): SplitPlan[] | undefined {
    const saved = this.approvals.get<{ hash: string; plans: SplitPlan[] }>(this.splitKey(p, change));
    const file = p.abs(`.uspec/changes/${change}/plan-split.md`);
    if (!saved || !fs.existsSync(file) || saved.hash !== this.hash(fs.readFileSync(file, 'utf8'))) return undefined;
    const unplanned = p.change(change)?.next?.plan?.nodes ?? [];
    return unplanned.every(n => saved.plans.some(pl => pl.nodes.includes(n))) ? saved.plans : undefined;
  }

  private hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
  private splitKey(p: Project, change: string): string {
    return JSON.stringify(['uspec.split', p.root, change, p.change(change)?.baseline, p.change(change)?.created]);
  }

  async runSplitter(p: Project, change: string, next?: NextJson): Promise<AgentRun | undefined> {
    if (this.isBusy(p, change, 'split', 'splitter')) return;
    next ??= await this.manager.json<NextJson>(p, ['change', 'next', change]);
    if (!next.plan) return;
    const nodes = next.plan.nodes;
    const run = this.newRun(p, change, 'splitter', 'split');
    run.nodes = nodes;
    return this.queue(run, {}, () => this.guard(run, async () => {
      if (run.stopped) return run;
      const contexts = await Promise.all(nodes.map(async node => ({ node, context: await this.manager.text(p, ['context', node, '--implement', '--change', change]) })));
      const res = await this.execute(run, plannerInput({ changeMd: `.uspec/changes/${change}/change.md`, dir: next!.plan!.dir, nodes, existing: p.change(change)!.plans.map(pl => pl.path), contexts }), permissions('splitter'));
      if (!res) return run;
      readSplit(res.text, nodes, p.change(change)!.plans);
      run.proposal = `.uspec/changes/${change}/plan-split.md`;
      await fs.promises.writeFile(p.abs(run.proposal), res.text);
      return this.finish(run, 'needs-approval', 'split to review');
    }));
  }

  private async approveSplit(run: AgentRun): Promise<void> {
    const text = await fs.promises.readFile(run.p.abs(run.proposal!), 'utf8');
    const next = await this.manager.json<NextJson>(run.p, ['change', 'next', run.change!]);
    if (!next.plan || next.triage || next.write.length) throw new Error('The split is no longer current.');
    const plans = readSplit(text, next.plan.nodes, run.p.change(run.change!)!.plans);
    await this.approvals.update(this.splitKey(run.p, run.change!), { hash: this.hash(text), plans });
    this.finish(run, 'recorded', 'split approved');
  }

  /**
   * With the splitter `off`, the extension's own split: one plan owning every unplanned node, after the
   * existing plans, recorded as approved without asking.
   */
  private async writeSplit(p: Project, change: string, next: NextJson): Promise<SplitPlan[] | undefined> {
    if (!next.plan) return undefined;
    const existing = p.change(change)?.plans ?? [];
    const text = autoSplit(change, next.plan.nodes, existing.map((pl) => pl.plan));
    const plans = readSplit(text, next.plan.nodes, existing);
    await fs.promises.writeFile(p.abs(`.uspec/changes/${change}/plan-split.md`), text);
    await this.approvals.update(this.splitKey(p, change), { hash: this.hash(text), plans });
    return plans;
  }

  async runPlanner(p: Project, change: string, next?: NextJson, planId?: string): Promise<AgentRun | undefined> {
    let split = this.split(p, change);
    if (!split && splitterOff(this.sessionConfig(p, change))) split = await this.writeSplit(p, change, next ?? (await this.manager.json<NextJson>(p, ['change', 'next', change])));
    if (!split) return this.runSplitter(p, change, next);
    const entry = planId ? split.find(pl => pl.id === planId) : split.find(pl => !p.change(change)?.plans.some(existing => existing.plan === pl.id));
    if (!entry || this.isBusy(p, change, entry.id, 'planner')) return;
    next ??= await this.manager.json<NextJson>(p, ['change', 'next', change]);
    if (next.impact || next.triage || next.write.length) return;
    const file = `.uspec/changes/${change}/${entry.path}`;
    const run = this.newRun(p, change, 'planner', entry.id);
    run.plans = [file]; run.nodes = entry.nodes;
    return this.queue(run, { plan: entry.id }, () => this.guard(run, async () => {
      if (run.stopped) return run;
      const contexts = await Promise.all(entry.nodes.map(async node => ({ node, context: await this.manager.text(p, ['context', node, '--implement', '--change', change]) })));
      const input = plannerInput({ changeMd: `.uspec/changes/${change}/change.md`, dir: `.uspec/changes/${change}/plans`, nodes: entry.nodes, existing: p.change(change)!.plans.map(pl => pl.path), contexts }) + `\nAssigned plan: ${file}\nAssigned nodes: ${entry.nodes.join(', ')}\nAfter: ${entry.after.join(', ')}\nWrite exactly the Assigned plan file and no other plan. Preserve its assigned nodes and dependencies. The split is approved; do not split or rename it.\n`;
      const res = await this.execute(run, input, permissions('planner', { planFile: file }));
      if (!res) return run;
      const parsed = parsePlanner(res.text);
      if (parsed.kind !== 'planned') return this.finish(run, 'failed', 'plan generation failed', res.text);
      await this.manager.load(p);
      const actual = p.change(change)?.plans.find(pl => pl.plan === entry.id);
      if (!actual || [...actual.nodes].sort().join() !== [...entry.nodes].sort().join() || [...actual.after].sort().join() !== [...entry.after].sort().join()) return this.finish(run, 'error', 'Plan does not match the approved split');
      run.planApprovals = await this.planFingerprints(p, change, [file]);
      return this.finish(run, 'needs-approval', 'plan to review');
    }));
  }

  private commentKey(p: Project, change: string, document: string): string {
    return JSON.stringify(['uspec.comment', p.root, change, p.change(change)?.created, document]);
  }

  async proposalFiles(run: AgentRun): Promise<FileDecision[]> {
    return readFileProposal(await fs.promises.readFile(run.p.abs(run.proposal!), 'utf8'), run.candidates, run.role === 'triage');
  }

  async saveReview(run: AgentRun, edits: { document: string; selected: boolean; comment: string }[]): Promise<void> {
    if (run.state !== 'needs-approval') return;
    const files = await this.proposalFiles(run);
    for (const d of files) {
      const edit = edits.find(e => e.document === d.document);
      if (edit) { d.state = edit.selected ? 'affected' : 'no-change'; d.comment = edit.comment; }
      await this.approvals.update(this.commentKey(run.p, run.change!, d.document), d.comment);
    }
    await fs.promises.writeFile(run.p.abs(run.proposal!), fileProposal(run.role === 'impact' ? 'Change plan' : 'Triage review', files));
  }

  async approveProposal(run: AgentRun): Promise<void> {
    if (run.state !== 'needs-approval') return;
    const files = await this.proposalFiles(run);
    if (run.role === 'impact') return this.keepStarting(run, files.filter(d => d.state === 'affected').map(d => d.document));
    const next = await this.manager.json<NextJson>(run.p, ['change', 'next', run.change!]);
    if (files.some(d => !next.triage?.batch.some(b => b.document === d.document))) throw new Error('Triage has changed. Run triage again.');
    for (const d of files) {
      await this.approvals.update(this.commentKey(run.p, run.change!, d.document), d.comment);
      await this.manager.mutate(run.p, ['change', 'set', run.change!, d.document, d.state, '--reason', d.reason]);
    }
    this.finish(run, 'recorded', 'triage approved');
  }

  // --- Implementer -------------------------------------------------------------------------------

  private async planFingerprints(p: Project, change: string, files: string[]): Promise<Record<string, string>> {
    const baseline = p.change(change)?.baseline;
    if (!baseline) throw new Error(`Cannot read baseline for ${change}`);
    const entries = await Promise.all(files.map(async (file) => [
      JSON.stringify(['uspec.planApproval', p.root, change, baseline, p.change(change)?.created, file]),
      createHash('sha256').update(await fs.promises.readFile(p.abs(file))).digest('hex'),
    ]));
    return Object.fromEntries(entries);
  }

  /** Recreate a review after reload; approval belongs to the exact plan contents and baseline. */
  private async plansApproved(p: Project, change: string, files: string[]): Promise<boolean> {
    if (!this.config().get<boolean>('agents.approvePlans', true)) return true;
    if (this.runsOf(p, change).some((r) => r.role === 'planner' && r.active)) return false;
    const fingerprints = await this.planFingerprints(p, change, files);
    if (Object.entries(fingerprints).every(([key, hash]) => this.approvals.get<string>(key) === hash)) return true;
    if (this.runsOf(p, change).some((r) => r.role === 'planner' && r.active)) return false;
    for (const file of files) {
      const fp = await this.planFingerprints(p, change, [file]);
      if (Object.entries(fp).every(([key, hash]) => this.approvals.get<string>(key) === hash)) continue;
      const review = this.newRun(p, change, 'planner', path.basename(file, '.md'));
      review.plans = [file]; review.planApprovals = fp;
      this.finish(review, 'needs-approval', 'plan to review', file);
    }
    return false;
  }

  /** Implements one plan: one run for all its nodes, which are recorded as done together. */
  async runImplementer(p: Project, change: string, plan: string): Promise<AgentRun | undefined> {
    if (this.isBusy(p, change, plan, 'implementer')) return undefined;
    const next = await this.manager.json<NextJson>(p, ['change', 'next', change]);
    const info = next.implement.find((x) => x.plan === plan);
    if (next.plan || next.plan_errors.length || next.triage || next.write.length) return undefined;
    if (!info) {
      void vscode.window.showWarningMessage(`${change}: plan ${plan} is not ready to implement.`);
      return undefined;
    }
    if (!(await this.plansApproved(p, change, p.change(change)!.plans.map(pl => pl.path)))) return undefined;
    const run = this.newRun(p, change, 'implementer', plan);
    run.nodes = info.nodes;
    return this.queue(run, { plan }, () =>
      this.guard(run, async () => {
        if (run.stopped) return run;
        const contexts = await Promise.all(
          info.nodes.map(async (node) => ({ node, context: await this.manager.text(p, ['context', node, '--implement', '--change', change]) })),
        );
        if (!(await this.plansApproved(p, change, p.change(change)!.plans.map(pl => pl.path)))) return this.finish(run, 'blocked', 'plan needs approval');
        const changeMd = (await readText(p.abs(`.uspec/changes/${change}/change.md`))) ?? '';
        const mode = fromExperiment(changeMd) ? 'Mode: check' : 'Mode: implement';
        const perms = permissions('implementer', {
          codePaths: info.nodes.flatMap((n) => codePaths(p, nodeKey(n))),
          implementerAllowed: this.config().get<string[]>('agents.implementerAllowedTools', ['Bash']),
        });
        const res = await this.execute(run, implementerInput(info.path, contexts), perms, mode);
        if (!res) return run;
        const result = parseImplementer(res.text);
        switch (result.kind) {
          case 'done': {
            const pending = info.nodes.filter((n) => p.change(change)?.impl.get(nodeKey(n)) !== 'done');
            for (const n of pending) await this.manager.mutate<SetJson>(p, ['change', 'set', change, n, 'done']);
            return this.finish(run, 'recorded', 'done', result.detail);
          }
          case 'gap':
          case 'failed':
            this.offerSession(run, `Implementer of plan ${plan}: ${result.kind}. ${result.detail.split('\n')[0]}`);
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
        if (this.waiting(p, change)) { reason = 'review is required'; break; }
        const next = await this.manager.json<NextJson>(p, ['change', 'next', change]);
        const jobs: Promise<AgentRun | undefined>[] = [];
        // The change's steps in order: impact; triage and write; plan; implement.
        if (next.impact) {
          if (!this.isBusy(p, change, 'change', 'impact')) jobs.push(this.runImpact(p, change));
        } else if (next.triage || next.write.length) {
          // One writer per node, on its documents that aren't already written or waiting for approval;
          // one for the nodes whose writers share a session in this round.
          const round = this.sessions.round(p, change);
          const config = this.sessionConfig(p, change);
          const writers = new Map<string, { nodes: string[]; docs: string[] }>();
          for (const w of next.write) {
            const node = nodeKey(w.node);
            const docs = w.documents.map((d) => d.document).filter((d) => !this.isBusy(p, change, d));
            if (!docs.length || this.writing(p, change, node)) continue;
            const key = resolveSession(config, 'writer', { round, node })?.name ?? `\0${node}`;
            const g = writers.get(key) ?? { nodes: [], docs: [] };
            g.nodes.push(node);
            g.docs.push(...docs);
            writers.set(key, g);
          }
          // Writers start first: a round's writers take their session before the triage run that starts the next round.
          for (const g of writers.values()) jobs.push(this.runWriter(p, change, g.nodes, g.docs));
          if (next.triage && !this.isBusy(p, change, 'batch')) jobs.push(this.runTriage(p, change, next));
        } else if (next.plan) {
          let split = this.split(p, change);
          if (!split && splitterOff(this.sessionConfig(p, change))) split = await this.writeSplit(p, change, next);
          if (!split) jobs.push(this.runSplitter(p, change, next));
          else for (const pl of split) if (!p.change(change)?.plans.some(x => x.plan === pl.id)) jobs.push(this.runPlanner(p, change, next, pl.id));
        } else if (next.plan_errors.length) {
          const e = next.plan_errors[0];
          reason = `the plans have errors (${e.plan ? `${e.plan}: ` : ''}${e.message})`;
          break;

        } else {
          for (const pl of next.implement) if (!this.isBusy(p, change, pl.plan, 'implementer')) jobs.push(this.runImplementer(p, change, pl.plan));
        }
        if (!jobs.length) {
          const waiting = this.waiting(p, change);
          reason = waiting
            ? `${waiting} item${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} for your approval`
            : next.impact || next.triage || next.write.length || next.plan || next.implement.length
              ? 'the ready items are already running'
              : 'nothing is ready';
          break;
        }
        this.manager.output.appendLine(`${change}: round ${round}, ${jobs.length} agent${jobs.length === 1 ? '' : 's'}`);
        const runs = (await Promise.all(jobs)).filter((r): r is AgentRun => Boolean(r));
        if (!runs.length) break;
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

  private closeSessions(p: Project, change: string): void {
    this.stopChange(p, change);
    for (const r of this.runs) if (r.p.root === p.root && r.change === change && r.terminal && vscode.window.terminals.includes(r.terminal)) r.terminal.dispose();
    closeChangeSessions(p, change);
    this.sessions.clear(p.root, change);
    for (const key of [...this.locks.keys()]) if (key.startsWith(`${this.changeKey(p, change)}|`)) this.locks.delete(key);
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

  /**
   * Opens a run's session for the user. After its first turn the agent's session stays open in its
   * terminal; once it has exited, its exact session is resumed there with its original provider, after
   * the session's running job.
   */
  async openSession(run: AgentRun): Promise<void> {
    const open = run.terminal && vscode.window.terminals.includes(run.terminal) ? run.terminal : undefined;
    if (open && (agentAlive(open) || run.state === 'running' || !run.sessionId)) {
      if (agentAlive(open)) run.resumed ||= run.state !== 'running';
      return revealAgentTerminal(open);
    }
    if (!run.sessionId || run.state === 'running') return;
    const sessionId = run.sessionId;
    await this.lockFor(run.p, run.change, run.session?.name ?? `id:${sessionId}`).run(async () => {
      const terminal = run.terminal && vscode.window.terminals.includes(run.terminal) && !agentAlive(run.terminal) ? run.terminal : undefined;
      const opened = openAgent(run.p, resumeArgs(run.provider, sessionId), {
        name: `${providerLabel(run.provider)} · ${run.title}`,
        provider: run.provider,
        terminal,
        change: run.change,
        prompt: run.proposal ? `Continue reviewing ${run.proposal}. Apply agreed revisions to that Markdown document, preserving its review format.` : undefined,
      });
      if (!opened) return;
      run.terminal = opened;
      run.resumed = true;
      this.emitter.fire(run);
    });
  }

  clearFinished(): void {
    this.runs = this.runs.filter((r) => r.active);
    this.emitter.fire(undefined);
  }

  private persist(): void {
    void this.approvals.update('uspec.reviews', this.runs.filter(r => r.change).map(r => ({
      root: r.p.root, change: r.change, created: r.p.change(r.change!)?.created, baseline: r.p.change(r.change!)?.baseline,
      started: r.started, ended: r.ended, role: r.role, item: r.item, state: r.state, outcome: r.outcome, detail: r.detail,
      provider: r.provider, sessionId: r.sessionId, proposal: r.proposal, candidates: r.candidates, starting: r.starting,
      plans: r.plans, nodes: r.nodes, planApprovals: r.planApprovals, session: r.session,
      docs: r.docs.map(({ record, snapshotUri, ...d }) => d),
    })));
  }

  restore(): void {
    const saved = this.approvals.get<any[]>('uspec.reviews', []);
    for (const data of saved) {
      const p = this.manager.projects.find(p => p.root === data.root);
      if (!p || !p.change(data.change) || p.change(data.change)?.created !== data.created || p.change(data.change)?.baseline !== data.baseline) continue;
      const run = this.newRun(p, data.change, data.role, data.item);
      const { root, created, baseline, ...fields } = data;
      Object.assign(run, fields, { provider: data.provider === 'codex' ? 'codex' : 'claude' });
      if (run.state === 'running') { run.state = 'stopped'; run.outcome = 'Interrupted by reload'; }
      for (const [i, d] of run.docs.entries()) {
        if (d.state === 'running') d.state = 'stopped';
        d.snapshotUri = this.content.register('before', `${run.id}.${i}`, path.basename(p.docFile(d.key)), () => d.snapshot);
      }
    }
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
