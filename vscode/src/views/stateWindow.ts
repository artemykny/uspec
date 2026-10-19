// The change state window: where a change is in its workflow, what it waits for and what comes next,
// in the main editor area (docs/vscode/overview.md#views, Change state).
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { DocState } from '../core/model';
import { showNode } from '../core/paths';
import { isTemplateLeft } from '../core/templates';
import type { AgentManager, AgentRun, RunState } from '../agents';
import { readText, STATE_LABEL, type ChangeData, type Project, type ProjectManager } from '../projects';
import { summary } from './changesView';

export type ChangeStage = 'waiting' | 'starting' | 'spec' | 'planning' | 'implementing' | 'closable';

/** The states of a change in order; `closable` comes after all of them. */
export const STAGES: Exclude<ChangeStage, 'closable'>[] = ['waiting', 'starting', 'spec', 'planning', 'implementing'];

export const STAGE_LABEL: Record<ChangeStage, string> = {
  waiting: 'Waiting for the user',
  starting: 'Selecting starting documents',
  spec: 'Triage and write',
  planning: 'Making plans',
  implementing: 'Running plans',
  closable: 'Ready to close',
};

export type StageMark = 'done' | 'current' | 'todo';

export interface StageInfo {
  stage: ChangeStage;
  /** Each state in order, marked done, current or to come. */
  marks: Record<Exclude<ChangeStage, 'closable'>, StageMark>;
  /** Running agents while any run of the change runs; else the user. */
  waitsFor: 'user' | 'agents';
  /** Runs running now. */
  running: AgentRun[];
  /** Runs waiting for the user's approval. */
  approvals: AgentRun[];
  /** The latest run of an item that is blocked, found a gap or failed. */
  stuck: AgentRun[];
  /** In `waiting`, when change.md was given: whether it is still the template. */
  templateLeft?: boolean;
}

const STUCK: RunState[] = ['blocked', 'gap', 'failed', 'error'];

const active = (runs: AgentRun[], role: string) => runs.some((r) => r.role === role && (r.state === 'running' || r.state === 'needs-approval'));

/**
 * Where a change is in its workflow, from `change next`, `change status` and its agent runs; no rule
 * of the method is worked out here. `changeMd` is the text of its change.md, to tell whether it is
 * still the template.
 */
export function changeStage(c: ChangeData, runs: AgentRun[], changeMd?: string): StageInfo {
  const next = c.next;
  const stage: ChangeStage = active(runs, 'impact')
    ? 'starting'
    : next?.impact
      ? 'waiting'
      : c.counts.pending + c.counts.affected > 0
        ? 'spec'
        : next?.plan || next?.plan_errors.length || active(runs, 'planner')
          ? 'planning'
          : next?.implement.length || c.counts.implementation_pending > 0
            ? 'implementing'
            : 'closable';
  const at = stage === 'closable' ? STAGES.length : STAGES.indexOf(stage);
  const marks = Object.fromEntries(STAGES.map((s, i) => [s, i < at ? 'done' : i === at ? 'current' : 'todo'])) as StageInfo['marks'];
  // A later run of the same item supersedes an earlier one that got stuck.
  const latest = new Map<string, AgentRun>();
  for (const r of runs) latest.set(`${r.role}|${r.item}`, r);
  const running = runs.filter((r) => r.state === 'running');
  return {
    stage,
    marks,
    waitsFor: running.length ? 'agents' : 'user',
    running,
    approvals: runs.filter((r) => r.state === 'needs-approval'),
    stuck: [...latest.values()].filter((r) => STUCK.includes(r.state)),
    templateLeft: stage === 'waiting' && changeMd !== undefined ? isTemplateLeft(changeMd) : undefined,
  };
}

/** A message from the window: a button and what it is on. */
interface Message {
  action: string;
  run?: number;
  key?: string;
  plan?: string;
}

interface Panel {
  p: Project;
  name: string;
  panel: vscode.WebviewPanel;
  nonce: string;
  html?: string;
  /** Renders in order: only the latest one is shown. */
  seq: number;
}

const DOC_STATES: DocState[] = ['affected', 'pending', 'updated', 'no-change'];

/** One state window per open change, live like the views. */
export class StateWindows implements vscode.Disposable {
  private readonly panels = new Map<string, Panel>();
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly manager: ProjectManager,
    private readonly agents: AgentManager,
  ) {
    this.subs = [manager.onDidChange(() => this.renderAll()), agents.onDidChange(() => this.renderAll())];
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    for (const x of [...this.panels.values()]) x.panel.dispose();
    this.panels.clear();
  }

  /** The open window of a change. */
  panelFor(p: Project, name: string): vscode.WebviewPanel | undefined {
    return this.panels.get(key(p, name))?.panel;
  }

  get size(): number {
    return this.panels.size;
  }

  /** The state of a change, reading its change.md. */
  async stage(p: Project, name: string): Promise<StageInfo | undefined> {
    const c = p.change(name);
    if (!c) return undefined;
    return changeStage(c, this.agents.runsOf(p, name), (await readText(p.abs(`.uspec/changes/${name}/change.md`))) ?? '');
  }

  /** Reveals the change's window, or opens it. */
  async show(p: Project, name: string): Promise<void> {
    const k = key(p, name);
    const open = this.panels.get(k);
    if (open) {
      open.panel.reveal();
      await this.render(open);
      return;
    }
    const panel = vscode.window.createWebviewPanel('uspec.changeState', `${name} · state`, vscode.ViewColumn.Active, { enableScripts: true });
    const x: Panel = { p, name, panel, nonce: randomBytes(16).toString('base64'), seq: 0 };
    this.panels.set(k, x);
    panel.onDidDispose(() => this.panels.delete(k));
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(x, m));
    await this.render(x);
  }

  private renderAll(): void {
    for (const x of this.panels.values()) void this.render(x);
  }

  private async render(x: Panel): Promise<void> {
    const seq = ++x.seq;
    const c = x.p.change(x.name);
    const body = c ? await this.body(x.p, c) : `<p class="note">${esc(x.name)} is closed.</p>`;
    if (seq !== x.seq || !this.panels.has(key(x.p, x.name))) return;
    const html = page(x.nonce, x.name, body);
    if (html === x.html) return;
    x.html = html;
    x.panel.webview.html = html;
  }

  private onMessage(x: Panel, m: Message): void {
    const change = { p: x.p, name: x.name };
    const run = m.run !== undefined ? this.agents.runs.find((r) => r.id === m.run) : undefined;
    const runArg = run ? { run, key: m.key } : undefined;
    const commands: Record<string, [string, unknown] | undefined> = {
      openChangeMd: ['uspec.change.openChangeMd', change],
      continue: ['uspec.claude.continueChange', change],
      runAgents: ['uspec.agents.runChange', change],
      stop: ['uspec.agents.stopChange', change],
      close: ['uspec.change.close', change],
      openPlan: m.plan ? ['uspec.change.openPlan', { ...change, plan: m.plan }] : undefined,
      openDoc: m.key ? ['vscode.open', x.p.uriOf(x.p.docFile(m.key))] : undefined,
      approve: runArg && ['uspec.agents.approve', runArg],
      reject: runArg && ['uspec.agents.reject', runArg],
      showDiff: runArg && ['uspec.agents.showRunDiff', runArg],
      showLog: runArg && ['uspec.agents.showLog', runArg],
    };
    const cmd = commands[m.action];
    if (cmd) void vscode.commands.executeCommand(cmd[0], cmd[1]);
  }

  private async body(p: Project, c: ChangeData): Promise<string> {
    if (c.error) return `<p class="error">${esc(c.error)}</p>`;
    const s = changeStage(c, this.agents.runsOf(p, c.name), (await readText(p.abs(`.uspec/changes/${c.name}/change.md`))) ?? '');
    const item = (stage: Exclude<ChangeStage, 'closable'>, n: string) =>
      `<li class="${s.marks[stage]}"><span class="mark">${MARK[s.marks[stage]]}</span> ${n} ${esc(STAGE_LABEL[stage])}${s.marks[stage] === 'current' ? this.current(p, c, s) : ''}</li>`;
    const impl: StageMark = s.marks.planning === 'current' || s.marks.implementing === 'current' ? 'current' : s.marks.implementing === 'done' ? 'done' : 'todo';
    const list = [
      '<ol class="states">',
      item('waiting', '1.'),
      item('starting', '2.'),
      item('spec', '3.'),
      `<li class="${impl}"><span class="mark">${MARK[impl]}</span> 4. Implementation<ol class="sub">${item('planning', '')}${item('implementing', '')}</ol></li>`,
      '</ol>',
    ].join('');
    const closable = s.stage === 'closable' ? `<section class="current"><h2>${esc(STAGE_LABEL.closable)}</h2><p>Every document is settled and every node implemented: the change can be closed.</p>${button('close', 'Close')}</section>` : '';
    const looping = this.agents.isLooping(p, c.name);
    const controls = [
      s.stage !== 'waiting' && s.stage !== 'closable' && !looping ? button('runAgents', 'Run agents') : '',
      this.agents.isRunning(p, c.name) ? button('stop', 'Stop') : '',
    ].join('');
    const head = `<p class="summary">${esc(summary(c))} · baseline <code>${esc(c.baseline.slice(0, 7))}</code></p>`;
    return `${head}${controls ? `<p>${controls}</p>` : ''}${list}${closable}`;
  }

  /** The current state: what it waits for, its content and its actions. */
  private current(p: Project, c: ChangeData, s: StageInfo): string {
    const out: string[] = [`<div class="current"><p class="waits">${this.waits(s)}</p>`];
    const runs = this.agents.runsOf(p, c.name);
    const latest = (role: string) => [...runs].reverse().find((r) => r.role === role);
    switch (s.stage) {
      case 'waiting':
        out.push(
          `<p>${s.templateLeft ? 'change.md is still the template: describe the change, then run the agents to find its starting documents.' : 'change.md is written: run the agents to find the starting documents.'}</p>`,
          `<p>${button('openChangeMd', 'Open change.md')}${button('continue', 'Continue in Claude Code')}${this.agents.isLooping(p, c.name) ? '' : button('runAgents', 'Run agents')}</p>`,
        );
        break;
      case 'starting': {
        const run = latest('impact');
        if (!run) break;
        if (run.state === 'running') out.push(`<p>${this.runLine(run)}</p>`);
        else {
          out.push('<ul>', ...run.starting.map((d) => `<li>${docLink(d.document)} — ${esc(d.reason)}</li>`), '</ul>');
          out.push(`<p>${button('approve', 'Approve', { run: run.id })}${button('reject', 'Reject', { run: run.id })}</p>`);
        }
        break;
      }
      case 'spec': {
        for (const state of DOC_STATES) {
          const docs = [...c.docs.values()].filter((d) => d.state === state);
          if (!docs.length) continue;
          out.push(`<h3>${esc(STATE_LABEL[state])} (${docs.length})</h3><ul>`, ...docs.map((d) => `<li>${docLink(d.document)}${d.reason ? ` — ${esc(d.reason)}` : d.via.length ? ` — ${esc(d.via.join('; '))}` : ''}</li>`), '</ul>');
        }
        const going = s.running.filter((r) => r.role === 'triage' || r.role === 'writer');
        if (going.length) out.push('<h3>Running</h3><ul>', ...going.map((r) => `<li>${this.runLine(r)}</li>`), '</ul>');
        const approvals = s.approvals.filter((r) => r.role === 'writer').flatMap((r) => r.docs.filter((d) => d.state === 'needs-approval').map((d) => ({ r, d })));
        if (approvals.length) {
          out.push(
            '<h3>Waiting for approval</h3><ul>',
            ...approvals.map(
              ({ r, d }) =>
                `<li>${docLink(d.key)} — ${esc(d.outcome)} ${button('showDiff', 'Show diff', { run: r.id, key: d.key })}${button('approve', 'Approve', { run: r.id, key: d.key })}${button('reject', 'Reject', { run: r.id, key: d.key })}</li>`,
            ),
            '</ul>',
          );
        }
        const blocked = s.stuck.filter((r) => r.role === 'writer').flatMap((r) => r.docs.filter((d) => d.state === 'blocked').map((d) => ({ r, d })));
        if (blocked.length) {
          out.push(
            '<h3>Blocked</h3><ul>',
            ...blocked.map(({ r, d }) => `<li>${docLink(d.key)} — <span class="detail">${esc(d.detail)}</span> ${button('continue', 'Continue in Claude Code')}${button('showLog', 'Show log', { run: r.id })}</li>`),
            '</ul>',
          );
        }
        break;
      }
      case 'planning': {
        const run = latest('planner');
        if (run) {
          out.push(`<p>${this.runLine(run)}</p>`);
          if (run.state === 'needs-approval') {
            out.push('<ul>', ...run.plans.map((f) => `<li><code>${esc(f)}</code></li>`), '</ul>');
            out.push(`<p>${button('approve', 'Approve', { run: run.id })}${button('reject', 'Reject', { run: run.id })}</p>`);
          }
        }
        const nodes = c.next?.plan?.nodes ?? [];
        if (nodes.length) out.push('<h3>Nodes to plan</h3><ul>', ...nodes.map((n) => `<li>${esc(showNode(n))}</li>`), '</ul>');
        const errors = c.next?.plan_errors ?? [];
        if (errors.length) out.push('<h3>Plan errors</h3><ul>', ...errors.map((e) => `<li class="error">${e.plan ? `${esc(e.plan)}: ` : ''}${esc(e.message)}</li>`), '</ul>');
        break;
      }
      case 'implementing': {
        out.push('<ul>');
        for (const pl of c.plans) {
          const ready = c.next?.implement.some((x) => x.plan === pl.plan);
          const state = pl.state === 'done' ? 'done' : ready ? 'ready' : 'waiting';
          const impl = runs.filter((r) => r.role === 'implementer' && r.item === pl.plan);
          out.push(
            `<li><a href="#" data-action="openPlan" data-plan="${esc(pl.plan)}">${esc(pl.plan)}</a> — ${state}`,
            `<div class="detail">nodes: ${esc(pl.nodes.map(showNode).join(', '))}${pl.after.length ? ` · after ${esc(pl.after.join(', '))}` : ''}</div>`,
            impl.length ? `<ul>${impl.map((r) => `<li>${this.runLine(r)}</li>`).join('')}</ul>` : '',
            '</li>',
          );
        }
        out.push('</ul>');
        break;
      }
    }
    out.push('</div>');
    return out.join('');
  }

  /** What the current state waits for. */
  private waits(s: StageInfo): string {
    if (s.waitsFor === 'agents') return `Waits for running agents (${s.running.length}).`;
    const why: string[] = [];
    if (s.approvals.length) why.push(`${s.approvals.length} run${s.approvals.length === 1 ? '' : 's'} to approve`);
    if (s.stuck.length) why.push(s.stuck.map((r) => `${r.title}: ${r.state}`).join('; '));
    if (s.templateLeft) why.push('change.md is still the template');
    if (!why.length) why.push(s.stage === 'closable' ? 'close the change' : 'nothing is running');
    return `Waits for you: ${esc(why.join(' · '))}.`;
  }

  private runLine(r: AgentRun): string {
    const detail = STUCK.includes(r.state) && r.detail ? `<div class="detail">${esc(r.detail.slice(0, 1500))}</div>` : '';
    return `${esc(r.title)} — ${esc(this.agents.describe(r))} ${button('showLog', 'Log', { run: r.id })}${r.state === 'needs-approval' && !r.docs.length ? `${button('approve', 'Approve', { run: r.id })}${button('reject', 'Reject', { run: r.id })}` : ''}${detail}`;
  }
}

const MARK: Record<StageMark, string> = { done: '✓', current: '▶', todo: '○' };

function key(p: Project, name: string): string {
  return `${p.root}|${name}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function button(action: string, label: string, data: { run?: number; key?: string } = {}): string {
  const attrs = [data.run !== undefined ? ` data-run="${data.run}"` : '', data.key !== undefined ? ` data-key="${esc(data.key)}"` : ''].join('');
  return `<button data-action="${action}"${attrs}>${esc(label)}</button>`;
}

function docLink(doc: string): string {
  return `<a href="#" data-action="openDoc" data-key="${esc(doc)}">${esc(doc)}</a>`;
}

function page(nonce: string, name: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 1.5em 2em; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: var(--vscode-editor-font-family); }
  .summary, .detail, .todo { color: var(--vscode-descriptionForeground); }
  .detail { white-space: pre-wrap; margin: 0.2em 0; }
  .error { color: var(--vscode-errorForeground); }
  ol.states, ol.sub { list-style: none; padding-left: 0; }
  ol.sub { padding-left: 1.5em; }
  ol.states li { margin: 0.4em 0; }
  li.done > .mark { color: var(--vscode-charts-green); }
  li.current > .mark { color: var(--vscode-charts-blue); }
  li.current { font-weight: 600; }
  div.current, section.current { font-weight: normal; color: var(--vscode-foreground); border-left: 2px solid var(--vscode-focusBorder); margin: 0.5em 0 0.5em 0.4em; padding: 0.2em 0 0.2em 1em; }
  .waits { font-style: italic; }
  h3 { font-size: 1em; margin: 0.8em 0 0.3em; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; margin: 2px 6px 2px 0; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
<title>${esc(name)} · state</title>
</head>
<body>
<h1>${esc(name)}</h1>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    e.preventDefault();
    const m = { action: el.dataset.action };
    if (el.dataset.run) m.run = Number(el.dataset.run);
    if (el.dataset.key) m.key = el.dataset.key;
    if (el.dataset.plan) m.plan = el.dataset.plan;
    vscode.postMessage(m);
  });
</script>
</body>
</html>`;
}
