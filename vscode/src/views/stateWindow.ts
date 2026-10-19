// The change state window: where a change is in its workflow, what it waits for and what comes next,
// in the main editor area (docs/vscode/overview.md#views, Change state).
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { inlineDiff, readSplit } from '../core/workflow';
import { splitDoc } from '../core/paths';
import { showNode } from '../core/paths';
import { isTemplateLeft } from '../core/templates';
import type { AgentManager, AgentRun, RunState } from '../agents';
import { readText, STATE_LABEL, type ChangeData, type Project, type ProjectManager } from '../projects';
import { summary } from './changesView';

export type ChangeStage = 'waiting' | 'starting' | 'spec' | 'splitting' | 'planning' | 'implementing' | 'closable';

/** The states of a change in order; `closable` comes after all of them. */
export const STAGES: Exclude<ChangeStage, 'closable'>[] = ['waiting', 'starting', 'spec', 'splitting', 'planning', 'implementing'];

export const STAGE_LABEL: Record<ChangeStage, string> = {
  waiting: 'Describe',
  starting: 'Change plan',
  spec: 'Triage and write',
  splitting: 'Split plans',
  planning: 'Implementation plans',
  implementing: 'Implement',
  closable: 'Complete',
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
export function changeStage(c: ChangeData, runs: AgentRun[], changeMd?: string, splitApproved = false): StageInfo {
  const next = c.next;
  const stage: ChangeStage = active(runs, 'impact')
    ? 'starting'
    : next?.impact
      ? 'waiting'
      : c.counts.pending + c.counts.affected > 0
        ? 'spec'
        : active(runs, 'splitter') || (next?.plan && !splitApproved)
          ? 'splitting'
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
  stage?: ChangeStage;
  edits?: { document: string; selected: boolean; comment: string }[];
}

interface Panel {
  p: Project;
  name: string;
  panel: vscode.WebviewPanel;
  nonce: string;
  html?: string;
  /** Renders in order: only the latest one is shown. */
  seq: number;
  selected?: ChangeStage;
}


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
    return changeStage(c, this.agents.runsOf(p, name), (await readText(p.abs(`.uspec/changes/${name}/change.md`))) ?? '', !!this.agents.split(p, name));
  }

  /** Reveals the change's window, or opens it. */
  async show(p: Project, name: string): Promise<void> {
    await this.manager.load(p);
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
    const body = c ? await this.body(x.p, c, x.selected) : `<p class="note">${esc(x.name)} is closed.</p>`;
    if (seq !== x.seq || !this.panels.has(key(x.p, x.name))) return;
    const html = page(x.nonce, x.name, body);
    if (html === x.html) return;
    x.html = html;
    x.panel.webview.html = html;
  }

  private async onMessage(x: Panel, m: Message): Promise<void> {
    try {
      const change = { p: x.p, name: x.name };
      const runs = this.agents.runsOf(x.p, x.name);
      const run = runs.find(r => r.id === m.run);
      const c = x.p.change(x.name);
      if (!c) return;
      if (m.action === 'navigate') {
        const actual = (await this.stage(x.p, x.name))!.stage;
        const order: ChangeStage[] = [...STAGES, 'closable'];
        if (m.stage && order.indexOf(m.stage) >= 0 && order.indexOf(m.stage) <= order.indexOf(actual)) x.selected = m.stage;
      } else if (m.action === 'process' && c.next?.impact) {
        const old = runs.find(r => r.role === 'impact' && r.state === 'needs-approval');
        if (old) await this.agents.reject(old);
        x.selected = undefined;
        void this.agents.runImpact(x.p, x.name);
      } else if (m.action === 'openAgent' && run) this.agents.openSession(run);
      else if (m.action === 'openProposal' && run?.proposal) await vscode.commands.executeCommand('vscode.open', x.p.uriOf(run.proposal));
      else if (m.action === 'reviewApprove' && run) {
        if (m.edits) await this.agents.saveReview(run, m.edits);
        await this.agents.approve(run); x.selected = undefined;
      } else if (m.action === 'rewrite' && run && m.edits) {
        await this.agents.reviseWriter(run, m.edits);
      } else if (m.action === 'generate' && m.plan) {
        x.selected = undefined; void this.agents.runPlanner(x.p, x.name, undefined, m.plan);
      } else {
        const commands: Record<string, [string, unknown] | undefined> = {
          openChangeMd: ['uspec.change.openChangeMd', change],
          runAgents: ['uspec.agents.runChange', change], stop: ['uspec.agents.stopChange', change],
          close: ['uspec.change.close', change],
          openPlan: c.plans.some(p => p.plan === m.plan) ? ['uspec.change.openPlan', { ...change, plan: m.plan }] : undefined,
          openDoc: m.key && c.docs.has(m.key) ? ['vscode.open', x.p.uriOf(x.p.docFile(m.key))] : undefined,
          approve: run && ['uspec.agents.approve', { run, key: m.key }],
          reject: run && ['uspec.agents.reject', { run, key: m.key }],
          showDiff: run && ['uspec.agents.showRunDiff', { run, key: m.key }],
          baselineDiff: m.key && c.docs.has(m.key) ? ['uspec.change.diff', { ...change, key: m.key }] : undefined,
        };
        const cmd = commands[m.action];
        if (cmd) { if (m.action === 'runAgents') x.selected = undefined; await vscode.commands.executeCommand(cmd[0], cmd[1]); }
      }
      await this.render(x);
    } catch (e) { void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)); }
  }

  private async body(p: Project, c: ChangeData, selected?: ChangeStage): Promise<string> {
    if (c.error) return `<p class="error">${esc(c.error)}</p>`;
    const runs = this.agents.runsOf(p, c.name);
    const s = changeStage(c, runs, (await readText(p.abs(`.uspec/changes/${c.name}/change.md`))) ?? '', !!this.agents.split(p, c.name));
    const stage = selected ?? s.stage;
    const steps: ChangeStage[] = [...STAGES, 'closable'];
    const current = steps.indexOf(s.stage);
    const nav = steps.map((st, i) => `<button class="step ${st === stage ? 'selected' : ''}" data-action="navigate" data-stage="${st}" ${i > current ? 'disabled' : ''} aria-current="${st === stage ? 'step' : 'false'}"><span class="step-number">${i < current ? '✓' : i + 1}</span>${esc(STAGE_LABEL[st])}</button>`).join('');
    const content = await this.current(p, c, stage, runs);
    const back = steps.indexOf(stage) > 0 ? `<button class="secondary" data-action="navigate" data-stage="${steps[steps.indexOf(stage) - 1]}">Go back</button>` : '';
    return `<nav aria-label="Change steps">${nav}</nav><main><div class="section-title">${esc(STAGE_LABEL[stage])}</div>${content}<footer>${back}${this.agents.isRunning(p, c.name) ? button('stop', 'Stop agents') : ''}</footer></main>`;
  }

  private async proposal(run: AgentRun): Promise<string> {
    const controls = `<div class="toolbar">${button('openProposal', 'Open ' + run.proposal!.split('/').pop(), { run: run.id })}${this.runLine(run)}</div>`;
    if (run.role === 'splitter') {
      const text = await readText(run.p.abs(run.proposal!));
      try {
        const existing = (run.p.change(run.change!)?.plans ?? []).filter(p => !p.nodes.some(n => run.nodes.includes(n)));
        const plans = readSplit(text ?? '', run.nodes, existing);
        return `${controls}<div class="split-list">${plans.map(p => `<div class="split-row"><strong>${esc(p.path)}</strong><span class="detail">${esc(p.nodes.join(', '))}</span>${p.after.length ? `<span class="detail">After ${esc(p.after.join(', '))}</span>` : ''}${p.reason ? `<p class="detail">${esc(p.reason)}</p>` : ''}</div>`).join('')}</div>${run.state === 'needs-approval' ? button('reviewApprove', 'Approve split', { run: run.id }) : ''}`;
      } catch (e) { return `${controls}<p class="error">${esc(String(e))}</p>`; }
    }
    try {
      const files = await this.agents.proposalFiles(run);
      const rows = files.filter(d => d.state !== 'no-change').map(d => `<div class="review-file" data-document="${esc(d.document)}"><label><input type="checkbox" checked ${run.state !== 'needs-approval' ? 'disabled' : ''}> <span class="filename" title="${esc(d.document)}">${esc(d.document.split('/').pop()!)}</span><span class="file-path">${esc(d.document.split('/').slice(0, -1).join('/'))}</span></label><div class="detail">${esc(d.reason)}</div><details class="comment-editor" ${d.comment ? 'open' : ''}><summary>${d.comment ? 'Edit comment' : 'Add comment'}</summary><input class="comment" aria-label="Comment on ${esc(d.document)}" placeholder="What should the agent change?" value="${esc(d.comment)}"></details></div>`).join('');
      return `<section data-review="${run.id}">${controls}${rows}${run.state === 'needs-approval' ? button('reviewApprove', 'Approve', { run: run.id }) : ''}</section>`;
    } catch (e) { return `${controls}<p class="error">${esc(String(e))}</p>`; }
  }

  private async current(p: Project, c: ChangeData, stage: ChangeStage, runs: AgentRun[]): Promise<string> {
    const latest = (role: string, item?: string) => [...runs].reverse().find(r => r.role === role && (item === undefined || r.item === item));
    const out: string[] = [];
    switch (stage) {
      case 'waiting':
        return button('openChangeMd', 'Open change.md') + (c.next?.impact ? button('process', 'Process change.md') : '');
      case 'starting': {
        const run = latest('impact');
        return run?.proposal ? this.proposal(run) : run ? this.runLine(run) : '';
      }
      case 'spec': {
        const triage = latest('triage');
        if (triage?.state === 'needs-approval' && triage.proposal) out.push(await this.proposal(triage));
        else if (triage?.state === 'running') out.push(this.runLine(triage));
        const nodes = new Map<string, typeof c.docs extends Map<string, infer D> ? D[] : never>();
        for (const doc of c.docs.values()) {
          if (doc.state === 'no-change') continue;
          const node = splitDoc(doc.document).node;
          const list = nodes.get(node) ?? []; list.push(doc); nodes.set(node, list);
        }
        for (const [node, docs] of nodes) {
          const writer = latest('writer', node);
          out.push(`<section class="node" data-writer="${writer?.id ?? ''}"><header><strong class="node-name" title="${esc(showNode(node))}">${pathLabel(showNode(node))}</strong>${writer ? this.runLine(writer) : ''}${writer?.state === 'needs-approval' ? button('rewrite', 'Rewrite selected', { run: writer.id }) : ''}</header>`);
          for (const doc of docs) {
            const run = [...runs].reverse().find(r => r.role === 'writer' && r.docs.some(d => d.key === doc.document));
            const d = run?.docs.find(d => d.key === doc.document);
            if (d?.outcome === 'no change') continue;
            const now = d ? await readText(p.abs(p.docFile(doc.document))) : undefined;
            const diff = d && now !== undefined ? inlineDiff(d.snapshot, now) : [];
            if (diff.length && run && d) {
              const added = diff.filter(l => l.kind === 'add').length, removed = diff.filter(l => l.kind === 'remove').length;
              out.push(`<details data-diff="${run.id}:${esc(doc.document)}" ${d.state === 'needs-approval' ? `data-document="${esc(doc.document)}"` : ''}><summary>${d.state === 'needs-approval' ? `<input type="checkbox" checked aria-label="Rewrite ${esc(doc.document)}">` : ''}<span class="filename" title="${esc(doc.document)}">${esc(doc.document.split('/').pop()!)}</span><span class="diff-count" aria-label="${added} added, ${removed} removed"><span class="added">+${added}</span><span class="removed">−${removed}</span></span><span class="detail">${esc(d.state === 'needs-approval' ? 'Review' : 'Updated')}</span>${button('showDiff', 'Open diff in VS Code', { run: run.id, key: doc.document })}</summary>${d.state === 'needs-approval' ? `<div class="file-actions">${button('approve', 'Approve', { run: run.id, key: doc.document })}${button('reject', 'Reject', { run: run.id, key: doc.document })}</div>` : ''}${d.state === 'needs-approval' ? `<details class="comment-editor"><summary>Add comment</summary><input class="comment" aria-label="Comment on ${esc(doc.document)}" placeholder="What should the agent change?"></details>` : ''}<pre class="diff">${diff.slice(0, 1500).map(l => `<span class="${l.kind}">${l.kind === 'add' ? '+' : l.kind === 'remove' ? '−' : ' '} ${esc(l.text)}</span>`).join('')}${diff.length > 1500 ? '… Open the native diff to see the full file.' : ''}</pre></details>`);
            } else {
              out.push(`<div class="file">${docLink(doc.document)} <span class="detail">${esc(doc.state)}</span>${doc.state === 'updated' ? button('baselineDiff', 'Open diff in VS Code', { key: doc.document }) : ''}</div>`);
            }
          }
          out.push('</section>');
        }
        if (!this.agents.isRunning(p, c.name) && !this.agents.waiting(p, c.name)) out.push(button('runAgents', 'Continue'));
        break;
      }
      case 'splitting': {
        const run = latest('splitter');
        if (run?.proposal) out.push(await this.proposal(run));
        else if (run) out.push(this.runLine(run));
        if (!run || !run.active) out.push(button('runAgents', 'Split plans'));
        break;
      }
      case 'planning':
      case 'implementing': {
        const entries = this.agents.split(p, c.name) ?? [];
        const ids = [...new Set([...entries.map(e => e.id), ...c.plans.map(pl => pl.plan)])];
        for (const id of ids) {
          const plan = c.plans.find(pl => pl.plan === id);
          const generating = latest('planner', id), implementing = latest('implementer', id);
          const run = stage === 'planning' ? generating : implementing ?? generating;
          const entry = entries.find(e => e.id === id);
          const actions: string[] = [];
          if (stage === 'planning') {
            if (!generating?.active) actions.push(`<button class="secondary" data-action="generate" data-plan="${esc(id)}">${plan ? 'Regenerate' : 'Generate'} plan</button>`);
            if (generating?.state === 'needs-approval') actions.push(button('approve', 'Approve plan', { run: generating.id }));
          }
          const dependencies = entry?.after ?? plan?.after ?? [];
          out.push(`<section class="plan"><header><strong>${plan ? `<a href="#" data-action="openPlan" data-plan="${esc(id)}">plans/${esc(id)}.md</a>` : `plans/${esc(id)}.md`}</strong>${run ? this.runLine(run) : `<span class="status">${esc(plan?.state === 'done' ? 'Done' : plan ? 'Ready' : 'Not generated')}</span>`}</header><div class="plan-body"><div class="plan-meta"><span>${esc((entry?.nodes ?? plan?.nodes ?? []).join(', '))}</span>${dependencies.length ? `<span>After ${esc(dependencies.join(', '))}</span>` : ''}</div>${actions.length ? `<div class="plan-actions">${actions.join('')}</div>` : ''}</div>`);
          out.push('</section>');
        }
        for (const e of c.next?.plan_errors ?? []) out.push(`<p class="error">${esc(e.message)}</p>`);
        if (!this.agents.isRunning(p, c.name) && !this.agents.waiting(p, c.name)) out.push(button('runAgents', stage === 'planning' ? 'Generate plans' : 'Implement ready plans'));
        break;
      }
      case 'closable': return button('close', 'Close change');
    }
    return out.join('');
  }

  private runLine(r: AgentRun): string {
    const label = r.state === 'running' ? (r.queued ? 'Queued' : 'Running') : r.state === 'needs-approval' ? 'Review' : r.state === 'recorded' || r.state === 'reviewed' ? 'Done' : r.state.charAt(0).toUpperCase() + r.state.slice(1);
    return `<span class="agent"><span class="status ${r.state}" role="status" title="${esc(this.agents.describe(r))}">${esc(label)}</span>${r.terminal || r.sessionId ? button('openAgent', r.state === 'running' ? 'Open agent window' : 'Continue with agent', { run: r.id }) : ''}${STUCK.includes(r.state) ? `<span class="error">${esc(r.detail || r.outcome)}</span>` : ''}</span>`;
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
  const primary = ['process', 'reviewApprove', 'approve', 'runAgents', 'close'].includes(action);
  const nativeDiff = action === 'showDiff' || action === 'baselineDiff';
  return `<button class="${primary ? 'primary' : 'secondary'}" data-action="${action}"${attrs}${nativeDiff ? ' title="Open diff in VS Code" aria-label="Open diff in VS Code"' : ''}>${esc(nativeDiff ? 'Open diff' : label)}</button>`;
}

function pathLabel(value: string): string {
  const slash = value.lastIndexOf('/');
  return slash < 0 ? esc(value) : `<span class="path-parent">${esc(value.slice(0, slash + 1))}</span>${esc(value.slice(slash + 1))}`;
}

function docLink(doc: string): string {
  return `<a class="filename" href="#" title="${esc(doc)}" data-action="openDoc" data-key="${esc(doc)}">${esc(doc.split('/').pop()!)}</a>`;
}

function page(nonce: string, name: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .page-heading { display: flex; align-items: baseline; gap: 10px; padding: 16px 20px 10px; }
  .eyebrow, .file-path, .detail { color: var(--vscode-descriptionForeground); }
  .eyebrow { font-size: 11px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .error { color: var(--vscode-errorForeground); }
  nav { display: flex; overflow-x: auto; gap: 0; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border); scrollbar-width: thin; }
  button { font: inherit; font-size: 12px; line-height: 18px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 3px 10px; margin: 0; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.step { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; background: transparent; color: var(--vscode-descriptionForeground); border: 0; border-bottom: 1px solid transparent; border-radius: 0; padding: 9px 10px; }
  button.step:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  button.selected { color: var(--vscode-foreground); border-bottom-color: var(--vscode-tab-activeBorderTop, var(--vscode-focusBorder)); }
  .step-number { font-size: 11px; opacity: .75; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  main { padding: 16px 20px 20px; max-width: 1120px; }
  .section-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  section.node, section.plan { border: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
  section.node > header, section.plan > header { background: var(--vscode-sideBarSectionHeader-background); padding: 7px 10px; }
  header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  header strong { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
  .agent { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-left: auto; font-weight: normal; font-size: 12px; }
  .status { color: var(--vscode-descriptionForeground); }
  .status.running::before { content: '●'; color: var(--vscode-progressBar-background); margin-right: 5px; }
  .status.needs-approval::before { content: '●'; color: var(--vscode-editorWarning-foreground); margin-right: 5px; }
  .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .file, summary { min-height: 34px; padding: 6px 10px; }
  summary { cursor: pointer; display: flex; align-items: center; gap: 8px; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: ''; width: 5px; height: 5px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(-45deg); flex-shrink: 0; margin: 0 4px 0 1px; }
  details[open] > summary::before { transform: rotate(45deg); }
  summary:hover, .file:hover { background: var(--vscode-list-hoverBackground); }
  details + details, .file + .file { border-top: 1px solid var(--vscode-panel-border); }
  .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .file-path { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  summary .detail { font-size: 11px; margin-left: auto; }
  summary button { background: transparent; color: var(--vscode-textLink-foreground); padding: 1px 5px; }
  summary button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .file-actions { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
  .diff { margin: 8px 0 0; overflow-x: auto; line-height: 20px; tab-size: 4; }
  .diff span { display: block; white-space: pre-wrap; padding: 0 10px; min-height: 20px; }
  .diff .add { background: var(--vscode-diffEditor-insertedLineBackground, var(--vscode-diffEditor-insertedTextBackground)); }
  .diff .remove { background: var(--vscode-diffEditor-removedLineBackground, var(--vscode-diffEditor-removedTextBackground)); }
  .split-list { border-top: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
  .split-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .split-row strong { font-weight: 500; }
  .split-row p { flex-basis: 100%; margin: 0; font-size: 12px; }
  .review-file { padding: 10px 0; border-top: 1px solid var(--vscode-panel-border); }
  .review-file label { display: flex; align-items: center; gap: 7px; }
  .review-file .detail { margin: 3px 0 6px 23px; font-size: 12px; }
  input.comment { display: block; box-sizing: border-box; width: calc(100% - 23px); max-width: 640px; font: inherit; font-size: 12px; padding: 4px 6px; margin: 0 0 0 23px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  input[type=checkbox] { margin: 0; width: 14px; height: 14px; flex-shrink: 0; accent-color: var(--vscode-focusBorder); }
  .plan-body { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; padding: 8px 10px; }
  .plan-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--vscode-descriptionForeground); font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
  .plan-actions { display: flex; gap: 6px; margin-left: auto; }
  .path-parent { color: var(--vscode-descriptionForeground); font-weight: normal; }
  .node-name { flex: 1; }
  header > .status { margin-left: auto; }
  .diff-count { display: flex; gap: 6px; margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; }
  .added { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .removed { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  summary .diff-count + .detail { margin-left: 4px; }
  .file { display: flex; align-items: center; gap: 8px; padding-left: 24px; }
  .file .detail { margin-left: auto; font-size: 11px; text-transform: capitalize; }
  .comment-editor { margin: 4px 0 0 23px; border: none; }
  .comment-editor > summary { display: inline-flex; min-height: 24px; padding: 2px 0; gap: 5px; color: var(--vscode-textLink-foreground); font-size: 12px; }
  .comment-editor > summary::before { display: none; }
  .comment-editor > summary:hover { background: transparent; text-decoration: underline; }
  .comment-editor input.comment { width: calc(100% - 10px); margin: 4px 0 8px; }
  .status.recorded::before, .status.reviewed::before { content: '✓'; color: var(--vscode-testing-iconPassed); margin-right: 5px; }
  .status.error, .status.failed, .status.blocked, .status.gap { color: var(--vscode-errorForeground); }
  main > button + button { margin-left: 6px; }
  footer { display: flex; gap: 6px; margin-top: 16px; }
  footer:empty { display: none; }
  @media (max-width: 600px) { .page-heading { padding: 12px; } main { padding: 12px; } header { flex-wrap: wrap; } header .agent { margin-left: 0; } summary { flex-wrap: wrap; } .file-path { display: none; } }
  body.vscode-high-contrast section, body.vscode-high-contrast-light section { border-color: var(--vscode-contrastBorder); }
</style>
<title>${esc(name)} · state</title>
</head>
<body>
<div class="page-heading"><span class="eyebrow">Change</span><h1>${esc(name)}</h1></div>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const navigation = document.querySelector('nav');
  const currentStep = document.querySelector('.step.selected');
  if (navigation && currentStep) navigation.scrollLeft = currentStep.offsetLeft - navigation.clientWidth / 2 + currentStep.clientWidth / 2;
  const stored = vscode.getState() || {};
  const review = document.querySelector('[data-review]')?.dataset.review;
  const saved = stored.review === review ? stored.files || {} : {};
  for (const el of document.querySelectorAll('[data-document]')) { const old = saved[el.dataset.document]; if(old) {el.querySelector('.comment').value = old.comment; if(old.comment && el.querySelector('.comment-editor')) el.querySelector('.comment-editor').open = true; el.querySelector('input[type=checkbox]').checked = old.selected;} }
  for (const el of document.querySelectorAll('[data-diff]')) el.open = !!stored.expanded?.[el.dataset.diff];
  function save() {
    const files = {}, expanded = {};
    for (const row of document.querySelectorAll('[data-document]')) files[row.dataset.document] = {comment: row.querySelector('.comment').value, selected: row.querySelector('input[type=checkbox]').checked};
    for (const el of document.querySelectorAll('[data-diff]')) expanded[el.dataset.diff] = el.open;
    vscode.setState({review, files, expanded});
  }
  document.addEventListener('input', save);
  document.addEventListener('toggle', save, true);
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    e.preventDefault();
    const m = { action: el.dataset.action };
    if (el.dataset.run) m.run = Number(el.dataset.run);
    if (el.dataset.key) m.key = el.dataset.key;
    if (el.dataset.plan) m.plan = el.dataset.plan;
    if (el.dataset.stage) m.stage = el.dataset.stage;
    if (m.action === 'reviewApprove' || m.action === 'rewrite') {
      const section = el.closest(m.action === 'rewrite' ? '[data-writer]' : '[data-review]');
      if (section) m.edits = [...section.querySelectorAll('[data-document]')].map(row => ({document: row.dataset.document, selected: row.querySelector('input[type=checkbox]').checked, comment: row.querySelector('.comment').value}));
    }
    vscode.postMessage(m);
  });
</script>
</body>
</html>`;
}
