// The Changes view: open changes, what is ready in them, their documents and nodes, and the agent
// runs working on them (docs/vscode/overview.md#views).
import * as vscode from 'vscode';
import type { DocState, PlanJson } from '../core/model';
import { nodeKey, showNode } from '../core/paths';
import type { AgentManager, AgentRun, WriterDoc } from '../agents';
import { STATE_LABEL, type ChangeData, type Project, type ProjectManager } from '../projects';
import { escapeMd } from './specTree';

export type ChangeEl =
  | { kind: 'project'; p: Project }
  | { kind: 'change'; p: Project; name: string }
  | { kind: 'group'; p: Project; name: string; group: 'agents' | 'next' | 'documents' | 'plans' | 'implementation' }
  | { kind: 'impact'; p: Project; name: string }
  | { kind: 'triage'; p: Project; name: string }
  | { kind: 'nextPlan'; p: Project; name: string }
  | { kind: 'plan'; p: Project; name: string; plan: string; section: 'implement' | 'plans' }
  | { kind: 'nextWrite'; p: Project; name: string }
  | { kind: 'writeNode'; p: Project; name: string; node: string }
  | { kind: 'nextImplement'; p: Project; name: string }
  | { kind: 'state'; p: Project; name: string; state: DocState }
  | { kind: 'doc'; p: Project; name: string; key: string; section: 'triage' | 'write' | 'documents' }
  | { kind: 'implNode'; p: Project; name: string; node: string }
  | { kind: 'file'; p: Project; name: string; rel: string; label: string }
  | { kind: 'run'; run: AgentRun }
  | { kind: 'runDoc'; run: AgentRun; key: string }
  | { kind: 'message'; p: Project; name: string; text: string; closable?: boolean; error?: boolean };

const STATES: DocState[] = ['affected', 'pending', 'updated', 'no-change'];

const STATE_ICON: Record<DocState, [string, string?]> = {
  pending: ['circle-large-outline', 'charts.yellow'],
  affected: ['circle-large-filled', 'charts.orange'],
  updated: ['pass-filled', 'charts.blue'],
  'no-change': ['pass', 'charts.green'],
};

const RUN_ICONS: Record<string, [string, string?]> = {
  running: ['loading~spin'],
  'needs-approval': ['question', 'charts.yellow'],
  recorded: ['pass', 'charts.green'],
  reviewed: ['pass', 'charts.green'],
  blocked: ['debug-pause', 'charts.orange'],
  gap: ['warning', 'charts.orange'],
  failed: ['error', 'charts.red'],
  error: ['error', 'charts.red'],
  stopped: ['debug-stop'],
  rejected: ['discard'],
};

export class ChangesViewProvider implements vscode.TreeDataProvider<ChangeEl>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ChangeEl | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly manager: ProjectManager,
    private readonly agents: AgentManager,
  ) {
    this.subs = [manager.onDidChange(() => this.emitter.fire(undefined)), agents.onDidChange(() => this.emitter.fire(undefined))];
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
  }

  getChildren(el?: ChangeEl): ChangeEl[] {
    if (!el) {
      const ps = this.manager.projects;
      if (ps.length === 1) return this.changesOf(ps[0]);
      return ps.filter((p) => p.changes.length).map((p) => ({ kind: 'project', p }));
    }
    const { p } = el as { p: Project };
    switch (el.kind) {
      case 'project':
        return this.changesOf(el.p);
      case 'change': {
        const c = p.change(el.name);
        if (!c) return [];
        if (c.error) return [{ kind: 'message', p, name: el.name, text: c.error }];
        const out: ChangeEl[] = [];
        out.push({ kind: 'group', p, name: el.name, group: 'next' });
        if (c.docs.size) out.push({ kind: 'group', p, name: el.name, group: 'documents' });
        if (c.plans.length) out.push({ kind: 'group', p, name: el.name, group: 'plans' });
        if (c.impl.size) out.push({ kind: 'group', p, name: el.name, group: 'implementation' });
        out.push(
          { kind: 'file', p, name: el.name, rel: `.uspec/changes/${el.name}/change.md`, label: 'change.md' },
          { kind: 'file', p, name: el.name, rel: `.uspec/changes/${el.name}/status.yaml`, label: 'status.yaml' },
        );
        return out;
      }
      case 'group': {
        const c = p.change(el.name);
        if (!c) return [];
        if (el.group === 'agents') return [...this.agents.runsOf(p, el.name)].reverse().map((run) => ({ kind: 'run', run }));
        if (el.group === 'next') return this.nextOf(p, c);
        if (el.group === 'documents') {
          return STATES.filter((s) => [...c.docs.values()].some((d) => d.state === s)).map((state) => ({ kind: 'state', p, name: el.name, state }));
        }
        if (el.group === 'plans') return c.plans.map((pl) => ({ kind: 'plan', p, name: el.name, plan: pl.plan, section: 'plans' }));
        return [...c.impl.keys()].map((node) => ({ kind: 'implNode', p, name: el.name, node }));
      }
      case 'state': {
        const c = p.change(el.name);
        return [...(c?.docs.values() ?? [])].filter((d) => d.state === el.state).map((d) => ({ kind: 'doc', p, name: el.name, key: d.document, section: 'documents' }));
      }
      case 'triage':
        return (p.change(el.name)?.next?.triage?.batch ?? []).map((b) => ({ kind: 'doc', p, name: el.name, key: b.document, section: 'triage' }));
      case 'nextWrite':
        return (p.change(el.name)?.next?.write ?? []).map((w) => ({ kind: 'writeNode', p, name: el.name, node: nodeKey(w.node) }));
      case 'writeNode':
        return writeEntry(p.change(el.name), el.node).map((key) => ({ kind: 'doc', p, name: el.name, key, section: 'write' }));
      case 'run':
        return el.run.docs.map((d) => ({ kind: 'runDoc', run: el.run, key: d.key }));
      case 'nextImplement':
        return (p.change(el.name)?.next?.implement ?? []).map((pl) => ({ kind: 'plan', p, name: el.name, plan: pl.plan, section: 'implement' }));
      case 'nextPlan':
        return (p.change(el.name)?.next?.plan?.nodes ?? []).map((n) => ({ kind: 'implNode', p, name: el.name, node: nodeKey(n) }));
      case 'plan':
        return (planOf(p.change(el.name), el.plan)?.nodes ?? []).map((n) => ({ kind: 'implNode', p, name: el.name, node: nodeKey(n) }));
      default:
        return [];
    }
  }

  private changesOf(p: Project): ChangeEl[] {
    return p.changes.map((c) => ({ kind: 'change', p, name: c.name }));
  }

  private nextOf(p: Project, c: ChangeData): ChangeEl[] {
    const next = c.next;
    if (!next) return [];
    const out: ChangeEl[] = [];
    if (next.impact) out.push({ kind: 'impact', p, name: c.name });
    if (next.triage) out.push({ kind: 'triage', p, name: c.name });
    if (next.write.length) out.push({ kind: 'nextWrite', p, name: c.name });
    if (next.plan) out.push({ kind: 'nextPlan', p, name: c.name });
    for (const e of next.plan_errors) out.push({ kind: 'message', p, name: c.name, text: `Plan error: ${e.plan ? `${e.plan}: ` : ''}${e.message}`, error: true });
    if (next.implement.length) out.push({ kind: 'nextImplement', p, name: c.name });
    if (out.length) return out;
    const open = c.counts.pending + c.counts.affected + c.counts.implementation_pending;
    if (!open) return [{ kind: 'message', p, name: c.name, text: 'Done: ready to close', closable: true }];
    return [{ kind: 'message', p, name: c.name, text: 'Nothing ready' }];
  }

  getParent(): undefined {
    return undefined;
  }

  getTreeItem(el: ChangeEl): vscode.TreeItem {
    switch (el.kind) {
      case 'project': {
        const item = new vscode.TreeItem(el.p.name, vscode.TreeItemCollapsibleState.Expanded);
        item.description = vscode.workspace.asRelativePath(el.p.uri);
        item.iconPath = new vscode.ThemeIcon('repo');
        return item;
      }
      case 'change':
        return this.changeItem(el.p, el.name);
      case 'group': {
        const c = el.p.change(el.name)!;
        const labels = { agents: 'Agents', next: 'Next', documents: 'Documents', plans: 'Plans', implementation: 'Implementation' };
        const icons = { agents: 'hubot', next: 'debug-step-over', documents: 'files', plans: 'checklist', implementation: 'code' };
        const expanded = el.group === 'next' || el.group === 'agents';
        const item = new vscode.TreeItem(labels[el.group], expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${el.p.root}|${el.name}|${el.group}`;
        item.iconPath = new vscode.ThemeIcon(icons[el.group]);
        if (el.group === 'documents') item.description = String(c.docs.size);
        if (el.group === 'implementation') item.description = `${c.counts.implementation_done}/${c.impl.size} done`;
        if (el.group === 'plans') item.description = `${c.plans.filter((x) => x.state === 'done').length}/${c.plans.length} done`;
        if (el.group === 'agents') {
          const running = this.agents.runsOf(el.p, el.name).filter((r) => r.state === 'running').length;
          item.description = running ? `${running} running` : undefined;
        }
        return item;
      }
      case 'impact': {
        const busy = this.agents.isBusy(el.p, el.name, 'change', 'impact');
        const item = new vscode.TreeItem('Find starting documents');
        item.id = `${el.p.root}|${el.name}|impact`;
        item.description = busy ? 'running' : 'from change.md';
        item.tooltip = 'The change has no documents yet: an impact agent reads change.md and the tree and finds the documents the change starts at, for you to review.';
        item.iconPath = new vscode.ThemeIcon(busy ? 'loading~spin' : 'search');
        item.command = { command: 'vscode.open', title: 'Open change.md', arguments: [el.p.uriOf(`.uspec/changes/${el.name}/change.md`)] };
        item.contextValue = `uspec.impact;${busy ? 'busy' : 'idle'}`;
        return item;
      }
      case 'nextPlan': {
        const n = el.p.change(el.name)?.next?.plan?.nodes.length ?? 0;
        const busy = this.agents.isBusy(el.p, el.name, 'change', 'planner');
        const item = new vscode.TreeItem('Plan', vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${el.p.root}|${el.name}|plan`;
        item.description = `${n} node${n === 1 ? '' : 's'}${busy ? ' · planning…' : ''}`;
        item.tooltip = 'Every document is settled: a planner agent writes the plans for the code of these nodes, one per independent part of the work.';
        item.iconPath = new vscode.ThemeIcon(busy ? 'loading~spin' : 'checklist');
        item.contextValue = `uspec.nextPlan;${busy ? 'busy' : 'idle'}`;
        return item;
      }
      case 'plan':
        return this.planItem(el);
      case 'triage': {
        const batch = el.p.change(el.name)?.next?.triage?.batch ?? [];
        const busy = this.agents.isBusy(el.p, el.name, 'batch');
        const item = new vscode.TreeItem('Triage', vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${el.p.root}|${el.name}|triage`;
        item.description = `${batch.length} candidate${batch.length === 1 ? '' : 's'}${busy ? ' · running' : ''}`;
        item.tooltip = 'Candidates ready for triage: one triage agent decides each as affected or no-change.';
        item.iconPath = new vscode.ThemeIcon(busy ? 'loading~spin' : 'filter');
        item.contextValue = `uspec.triage;${busy ? 'busy' : 'idle'}`;
        return item;
      }
      case 'nextWrite': {
        const write = el.p.change(el.name)?.next?.write ?? [];
        const n = write.reduce((k, w) => k + w.documents.length, 0);
        const item = new vscode.TreeItem('Write', vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${el.p.root}|${el.name}|write`;
        item.description = `${n} document${n === 1 ? '' : 's'} in ${write.length} node${write.length === 1 ? '' : 's'}`;
        item.tooltip = 'Affected documents ready to be written, by node: one writer agent per node writes its documents together.';
        item.iconPath = new vscode.ThemeIcon('edit');
        return item;
      }
      case 'writeNode': {
        const n = writeEntry(el.p.change(el.name), el.node).length;
        const busy = this.agents.writing(el.p, el.name, el.node);
        const item = new vscode.TreeItem(showNode(el.node), vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${el.p.root}|${el.name}|write|${el.node}`;
        item.description = `${n} document${n === 1 ? '' : 's'}${busy ? ' · writing…' : ''}`;
        item.tooltip = `One writer writes these documents of ${showNode(el.node)} together, with one context.`;
        item.iconPath = new vscode.ThemeIcon(busy ? 'loading~spin' : 'type-hierarchy');
        item.resourceUri = el.p.uriOf(el.p.nodeDir(el.node));
        item.command = { command: 'uspec.revealNode', title: 'Reveal', arguments: [el.p.root, el.node] };
        return item;
      }
      case 'nextImplement': {
        const n = el.p.change(el.name)?.next?.implement.length ?? 0;
        const item = new vscode.TreeItem('Implement', vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${el.p.root}|${el.name}|implement`;
        item.description = `${n} plan${n === 1 ? '' : 's'}`;
        item.tooltip = 'Plans ready to implement: one implementer agent each, in parallel.';
        item.iconPath = new vscode.ThemeIcon('tools');
        return item;
      }
      case 'state': {
        const c = el.p.change(el.name)!;
        const n = [...c.docs.values()].filter((d) => d.state === el.state).length;
        const item = new vscode.TreeItem(STATE_LABEL[el.state], el.state === 'affected' || el.state === 'pending' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${el.p.root}|${el.name}|state|${el.state}`;
        item.description = String(n);
        const [icon, color] = STATE_ICON[el.state];
        item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
        return item;
      }
      case 'doc':
        return this.docItem(el);
      case 'implNode':
        return this.implItem(el.p, el.name, el.node);
      case 'file': {
        const item = new vscode.TreeItem(el.label);
        item.resourceUri = el.p.uriOf(el.rel);
        item.iconPath = vscode.ThemeIcon.File;
        item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
        return item;
      }
      case 'run':
        return this.runItem(el.run);
      case 'runDoc':
        return this.runDocItem(el.run, el.run.docs.find((d) => d.key === el.key)!);
      case 'message': {
        const item = new vscode.TreeItem(el.text);
        item.tooltip = el.text;
        item.iconPath = el.error ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')) : new vscode.ThemeIcon(el.closable ? 'check-all' : 'info');
        if (el.closable) item.contextValue = 'uspec.closable';
        return item;
      }
    }
  }

  private changeItem(p: Project, name: string): vscode.TreeItem {
    const c = p.change(name)!;
    const active = p.activeChange?.name === name;
    const looping = this.agents.isLooping(p, name);
    const running = this.agents.isRunning(p, name);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
    item.command = { command: 'uspec.change.showState', title: 'Show state', arguments: [{ p, name }] };
    item.id = `${p.root}|change|${name}`;
    const left = summary(c);
    item.description = [active ? 'active' : '', left].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${name}**${active ? ' (active)' : ''} · baseline \`${c.baseline.slice(0, 7)}\` · opened ${new Date(c.created * 1000).toLocaleString()}\n\n`);
    md.appendMarkdown(
      `${c.counts.pending} pending, ${c.counts.affected} affected, ${c.counts.updated} updated, ${c.counts.no_change} no-change; ` +
        `${c.counts.implementation_pending} to implement, ${c.counts.implementation_done} done`,
    );
    item.tooltip = md;
    item.iconPath = new vscode.ThemeIcon(running ? 'loading~spin' : 'git-pull-request-draft');
    item.contextValue = `uspec.change;${active ? 'active' : ''};${looping ? 'looping' : ''};${running ? 'running' : ''}`;
    return item;
  }

  private docItem(el: Extract<ChangeEl, { kind: 'doc' }>): vscode.TreeItem {
    const { p, name, key } = el;
    const c = p.change(name)!;
    const d = c.docs.get(key);
    const state = d?.state ?? 'pending';
    const busy = this.agents.isBusy(p, name, key);
    const ready = el.section === 'write' || Boolean(c.next?.write.some((w) => w.documents.some((x) => x.document === key)));
    const item = new vscode.TreeItem(key);
    item.id = `${p.root}|${name}|${el.section}|${key}`;
    item.resourceUri = p.uriOf(p.docFile(key));
    const via = el.section === 'triage' ? (c.next?.triage?.batch.find((b) => b.document === key)?.via ?? []) : (d?.via ?? []);
    item.description = busy ? 'writing…' : el.section === 'documents' ? (d?.reason ?? via.join('; ')) : el.section === 'triage' ? via.join('; ') : d?.reason ?? '';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${key}** · ${STATE_LABEL[state]}\n\n`);
    if (d?.reason) md.appendMarkdown(`${escapeMd(d.reason)}\n\n`);
    if (via.length) md.appendMarkdown(`Reached by: ${via.map(escapeMd).join('; ')}\n\n`);
    item.tooltip = md;
    const [icon, color] = STATE_ICON[state];
    item.iconPath = busy ? new vscode.ThemeIcon('loading~spin') : new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
    item.contextValue = `uspec.changeDoc;${state};${ready ? 'ready' : 'waiting'};${busy ? 'busy' : 'idle'}`;
    return item;
  }

  private planItem(el: Extract<ChangeEl, { kind: 'plan' }>): vscode.TreeItem {
    const { p, name, plan } = el;
    const c = p.change(name)!;
    const pl = planOf(c, plan);
    const ready = Boolean(c.next?.implement.some((x) => x.plan === plan));
    const busy = this.agents.isBusy(p, name, plan, 'implementer');
    const state = pl && 'state' in pl ? pl.state : 'pending';
    const item = new vscode.TreeItem(plan, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `${p.root}|${name}|${el.section}|plan|${plan}`;
    const after = pl && 'after' in pl && pl.after.length ? ` · after ${pl.after.join(', ')}` : '';
    item.description = (busy ? 'implementing…' : state === 'done' ? 'done' : ready ? 'ready' : 'waiting') + after;
    item.tooltip =
      state === 'done'
        ? 'Implemented and verified.'
        : ready
          ? 'Ready: one implementer carries out this plan for all its nodes.'
          : 'Waits until every node is planned, the plans it comes after are done, and the nodes its nodes link to are done.';
    item.iconPath = busy
      ? new vscode.ThemeIcon('loading~spin')
      : new vscode.ThemeIcon(state === 'done' ? 'pass-filled' : 'checklist', new vscode.ThemeColor(state === 'done' ? 'charts.green' : 'charts.purple'));
    if (pl) {
      item.resourceUri = p.uriOf(pl.path);
      item.command = { command: 'vscode.open', title: 'Open plan', arguments: [item.resourceUri] };
    }
    item.contextValue = `uspec.plan;${state};${ready ? 'ready' : 'waiting'};${busy ? 'busy' : 'idle'}`;
    return item;
  }

  private implItem(p: Project, name: string, node: string): vscode.TreeItem {
    const c = p.change(name)!;
    const state = c.impl.get(node) ?? 'pending';
    const plan = c.plans.find((x) => x.nodes.some((n) => nodeKey(n) === node));
    const busy = plan ? this.agents.isBusy(p, name, plan.plan, 'implementer') : false;
    const item = new vscode.TreeItem(showNode(node));
    item.id = `${p.root}|${name}|impl|${node}|${plan?.plan ?? ''}`;
    item.description = busy ? 'implementing…' : state === 'done' ? 'done' : plan ? `plan ${plan.plan}` : 'not planned';
    item.tooltip =
      state === 'done'
        ? 'Implemented and verified.'
        : plan
          ? `Implemented with plan ${plan.plan}.`
          : 'Waits to be planned once every document of the change is settled.';
    item.iconPath = busy
      ? new vscode.ThemeIcon('loading~spin')
      : new vscode.ThemeIcon(state === 'done' ? 'pass-filled' : 'circle-large-outline', new vscode.ThemeColor(state === 'done' ? 'charts.green' : 'charts.purple'));
    item.resourceUri = p.uriOf(p.nodeDir(node));
    item.command = { command: 'uspec.revealNode', title: 'Reveal', arguments: [p.root, node] };
    item.contextValue = `uspec.changeNode;${state};${plan ? 'planned' : 'unplanned'};${busy ? 'busy' : 'idle'}`;
    return item;
  }

  private runItem(run: AgentRun): vscode.TreeItem {
    const item = new vscode.TreeItem(
      run.title,
      !run.docs.length ? vscode.TreeItemCollapsibleState.None : run.state === 'needs-approval' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `run|${run.id}`;
    item.description = this.agents.describe(run);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${run.title}** · ${run.state}\n\n`);
    if (run.outcome) md.appendMarkdown(`${escapeMd(run.outcome)}\n\n`);
    if (run.detail) md.appendMarkdown(`${escapeMd(run.detail.slice(0, 1500))}\n\n`);
    if (run.sessionId) md.appendMarkdown(`session \`${run.sessionId}\``);
    item.tooltip = md;
    const [icon, color] = RUN_ICONS[run.state] ?? ['circle-outline'];
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.command = { command: 'uspec.agents.showLog', title: 'Show Log', arguments: [{ kind: 'run', run }] };
    item.contextValue = `uspec.run;${run.state};${run.role};${run.sessionId ? 'session' : ''}`;
    return item;
  }

  /** One document of a writer run, with its own result. */
  private runDocItem(run: AgentRun, d: WriterDoc): vscode.TreeItem {
    const item = new vscode.TreeItem(d.key);
    item.id = `run|${run.id}|${d.key}`;
    item.description = d.state === 'running' ? (run.queued ? 'queued' : 'writing…') : d.state === 'needs-approval' ? `waiting for approval · ${d.outcome}` : d.outcome;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${d.key}** · ${d.state}\n\n`);
    if (d.outcome) md.appendMarkdown(`${escapeMd(d.outcome)}\n\n`);
    if (d.detail) md.appendMarkdown(escapeMd(d.detail.slice(0, 1500)));
    item.tooltip = md;
    const [icon, color] = RUN_ICONS[d.state] ?? ['circle-outline'];
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [run.p.uriOf(run.p.docFile(d.key))] };
    item.contextValue = `uspec.runDoc;${d.state}`;
    return item;
  }
}

/** What is left in a change, from `change next`: `2 to triage · 1 to write`. */
export function summary(c: ChangeData): string {
  const n = c.next;
  const parts: string[] = [];
  if (n?.impact) parts.push('find starting documents');
  if (n?.triage) parts.push(`${n.triage.batch.length} to triage`);
  const write = n?.write.reduce((k, w) => k + w.documents.length, 0) ?? 0;
  if (write) parts.push(`${write} to write`);
  if (n?.plan) parts.push('plan');
  if (n?.plan_errors.length) parts.push('plan errors');
  if (n?.implement.length) parts.push(`${n.implement.length} plan${n.implement.length === 1 ? '' : 's'} to implement`);
  if (!parts.length) {
    const open = c.counts.pending + c.counts.affected + c.counts.implementation_pending;
    parts.push(!c.docs.size ? 'empty' : open ? `${open} waiting` : 'ready to close');
  }
  return parts.join(' · ');
}

/** A plan of a change: from `change status`, else as `change next` lists it to implement. */
function planOf(c: ChangeData | undefined, plan: string): PlanJson | { plan: string; path: string; nodes: string[] } | undefined {
  return c?.plans.find((x) => x.plan === plan) ?? c?.next?.implement.find((x) => x.plan === plan);
}

/** The documents `change next` lists to write in a node, in order. */
function writeEntry(c: ChangeData | undefined, node: string): string[] {
  return c?.next?.write.find((w) => nodeKey(w.node) === node)?.documents.map((d) => d.document) ?? [];
}
