// The extension in VS Code against a copy of the example product: loading, problems, the views, and
// a change run by (fake) agents from the first update to close.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { UspecApi } from '../../extension';
import type { Project } from '../../projects';
import type { ChangeEl } from '../../views/changesView';
import type { SpecEl } from '../../views/specTree';
import { renderOverview, NodeWindow } from '../../views/nodeWindow';
import { NodeViewProvider } from '../../views/nodeView';
import { changeStage } from '../../views/stateWindow';
import { Decorations } from '../../decorations';

const work = process.env.USPEC_TEST_WORKSPACE!;
const file = (rel: string) => path.join(work, ...rel.split('/'));

async function waitFor<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A call of the fake agent: its role, arguments, prompt and the session it reported. */
interface Call {
  role: string;
  args: string[];
  input: string;
  session: string;
}

function calls(): Call[] {
  const log = process.env.FAKE_CLAUDE_LOG!;
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
}

const codex = process.env.USPEC_TEST_PROVIDER === 'codex';

/** The session a call resumes, if any. */
function resumes(call: Call): string | undefined {
  const at = call.args.indexOf(codex ? 'resume' : '--resume');
  return at < 0 ? undefined : call.args[at + 1];
}

/** Answers the extension's warnings instead of the user, and keeps what they said. */
function answerWarnings(): { shown: string[]; restore(): void } {
  const window = vscode.window as { showWarningMessage: (...args: any[]) => Thenable<unknown> };
  const original = window.showWarningMessage;
  const shown: string[] = [];
  window.showWarningMessage = async (message: string, ...rest: any[]) => {
    shown.push(message);
    const items = rest.filter((x) => typeof x === 'string');
    return items.find((x) => x === 'End and Continue' || x === 'Run Anyway');
  };
  return { shown, restore: () => { window.showWarningMessage = original; } };
}

/** Puts the example's documents back as they were committed. */
function resetDocs(): void {
  execFileSync('git', ['checkout', '--', 'docs'], { cwd: work });
}

describe('uspec extension', () => {
  let api: UspecApi;
  let p: Project;

  /** Runs a change's agents, approving every review, until every node is implemented. */
  async function drive(c: string): Promise<void> {
    for (let round = 0; round < 30; round++) {
      await api.agents.runChange(p, c);
      await api.manager.load(p);
      const data = p.change(c)!;
      if (data.counts.pending + data.counts.affected === 0 && data.counts.implementation_pending === 0 && data.plans.length && data.plans.every((x) => x.state === 'done')) return;
      const runs = api.agents.runsOf(p, c);
      const waiting = runs.filter((r) => r.state === 'needs-approval');
      const stuck = runs.filter((r) => ['error', 'failed', 'blocked', 'gap'].includes(r.state)).map((r) => `${r.title}: ${r.outcome} ${r.detail}`);
      assert.ok(waiting.length, `the agents stopped without a review: ${stuck.join('; ') || 'nothing stuck'}`);
      for (const run of waiting) await api.agents.approve(run);
    }
    assert.fail(`${c} wasn't implemented`);
  }

  /** Removes a change, finished or not, as closing it would. */
  async function discard(c: string): Promise<void> {
    fs.rmSync(file(`.uspec/changes/${c}`), { recursive: true, force: true });
    await api.manager.load(p);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<UspecApi>('uspec.uspec')!;
    api = await ext.activate();
    await api.ready;
    p = api.manager.projects[0];
  });

  it('loads the project from the CLI', () => {
    assert.strictEqual(api.manager.projects.length, 1);
    assert.strictEqual(p.specRoot, 'docs');
    assert.strictEqual(p.nodes.size, 72);
    assert.strictEqual(p.types.size, 16);
    assert.strictEqual(p.issues.length, 0);
    assert.deepStrictEqual(p.nodes.get('system/services/payments')?.extras, ['api']);
    assert.ok(p.downstream.get('product/support/refunds')?.includes('system/services/payments'));
    // A section link makes the screen downstream of the feature's node.
    assert.ok(p.downstream.get('product/support/refunds')?.includes('experience/ops-console/refunds'));
    assert.deepStrictEqual(p.nodes.get('experience/ops-console/refunds')?.deps[0], {
      raw: 'product/support/refunds/rules.md#refund-window',
      node: 'product/support/refunds',
      doc: 'rules',
      section: 'refund-window',
    });
    assert.strictEqual(p.target(file('services/payments/src/index.ts'))?.node, 'system/services/payments');
    assert.ok(p.unwritten.size > 0, 'most example documents are empty');
  });

  it('shows the tree as nodes and documents', async () => {
    const roots = api.specTree.getChildren() as SpecEl[];
    assert.deepStrictEqual(roots.map(r => api.specTree.getTreeItem(r).label), ['Changes', 'Node types', 'Specification']);
    assert.strictEqual(api.specTree.getTreeItem(roots[0]).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    const [root] = api.specTree.getChildren(roots[2]);
    assert.deepStrictEqual([root.kind, (root as { node: string }).node], ['node', '']);
    const payments: SpecEl = { kind: 'node', p, node: 'system/services/payments' };
    const kids = api.specTree.getChildren(payments).map((k) => (k.kind === 'doc' ? `${k.doc}.md` : k.kind));
    assert.deepStrictEqual(kids, ['api.md', 'logic.md', 'storage.md', 'events.md', 'compliance.md']);
    const item = api.specTree.getTreeItem(payments);
    assert.strictEqual(item.description, 'service · </>');
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'symbol-namespace');
    assert.match(String(item.contextValue), /^uspec\.node;code;child/);
  });

  it('renders type names and opens wrapped type/template actions', async () => {
    const types = api.specTree.getChildren({ kind: 'root', branch: 'types' });
    const service = types.find(e => api.specTree.getTreeItem(e).label === 'Service')!;
    const item = api.specTree.getTreeItem(service);
    assert.strictEqual(item.description, 'service · </>');
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'symbol-class');
    assert.ok((item.tooltip as vscode.MarkdownString).value.includes('.uspec/node-types/service/node-type.yaml'));
    await vscode.commands.executeCommand('uspec.type.open', service);
    assert.ok(vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('service/node-type.yaml'));
    const logic = api.specTree.getChildren(service).find(e => api.specTree.getTreeItem(e).label === 'logic.md')!;
    assert.match(String(api.specTree.getTreeItem(logic).description), /internal/);
    await vscode.commands.executeCommand('uspec.type.open', logic);
    assert.ok(vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('service/logic.md'));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
    const menus = manifest.contributes.menus['view/item/context'];
    for (const command of ['uspec.type.open', 'uspec.node.openYaml', 'uspec.context.show']) {
      assert.ok(menus.some((m: any) => m.command === command && m.group.startsWith('inline')));
      assert.ok(menus.some((m: any) => m.command === command && !m.group.startsWith('inline')));
    }
  });

  it('retains document order, missing files, extra folders and themed state symbols', () => {
    const node = 'system/services/payments';
    const info = p.nodes.get(node)!;
    const documents = info.documents;
    const issues = p.issues;
    const decorations = new Decorations(api.manager);
    try {
      const apiDoc: SpecEl = { kind: 'doc', p, node, doc: 'api' };
      const [extra] = api.specTree.getChildren(apiDoc);
      assert.strictEqual((api.specTree.getTreeItem(extra).iconPath as vscode.ThemeIcon).id, 'folder');
      assert.match(String(api.specTree.getTreeItem(extra).tooltip), /docs\/system\/services\/payments\/api-extra/);
      const [file] = api.specTree.getChildren(extra);
      assert.strictEqual((api.specTree.getTreeItem(file).iconPath as vscode.ThemeIcon).id, 'file');
      info.documents = documents.filter(d => d !== 'api');
      const [missing] = api.specTree.getChildren({ kind: 'node', p, node });
      assert.strictEqual(api.specTree.getTreeItem(missing).contextValue, 'uspec.missingDoc');
      assert.strictEqual(api.specTree.getTreeItem(missing).command, undefined);
      p.issues = [{ path: p.nodeDir(node), message: 'missing required document api.md' }];
      const icon = api.specTree.getTreeItem({ kind: 'node', p, node }).iconPath as vscode.ThemeIcon;
      assert.strictEqual(icon.id, 'error');
      assert.deepStrictEqual(icon.color, new vscode.ThemeColor('list.errorForeground'));
      p.drift.set(node, 'uncommitted code changes without a spec change');
      api.manager.notify(p);
      const badge = decorations.provideFileDecoration(p.uriOf(p.nodeDir(node)))!;
      assert.strictEqual(badge.badge, 'D');
      assert.deepStrictEqual(badge.color, new vscode.ThemeColor('list.warningForeground'));
    } finally {
      info.documents = documents;
      p.issues = issues;
      p.drift.delete(node);
      decorations.dispose();
      api.manager.notify(p);
    }
  });

  it('renders ordered overview sections and binds context actions to their target', async () => {
    const target = { p, node: 'system/services/payments', doc: 'logic' };
    api.nodeView.setTarget(target);
    const { html, actions } = renderOverview(target, 'document', { mode: 'document', value: await api.nodeView.context('document') }, 'test-nonce', 1);
    let previous = html.indexOf('Open the template of logic.md');
    for (const heading of ['Upstream', 'Downstream', 'Code paths', 'Active change', 'Drift', 'Context']) {
      const index = html.indexOf(`>${heading}</h2>`);
      assert.ok(index > previous, heading);
      previous = index;
    }
    for (const text of ['>required<', '>internal<', 'No active change', '>Write<', '>Implement<', 'Instructions · ', ':focus-visible']) assert.ok(html.includes(text), text);
    const copy = actions.find(a => a.command === 'uspec.context.copy' && (a.args[0] as any).mode === 'document')!;
    api.nodeView.setTarget({ p, node: 'product/support/refunds', doc: 'rules' });
    await vscode.commands.executeCommand(copy.command, ...copy.args);
    assert.strictEqual(await vscode.env.clipboard.readText(), await api.manager.text(p, ['context', target.node, '--document', 'logic']));
    const contents = actions.find(a => a.command === 'uspec.context.copyWithContents' && (a.args[0] as any).mode === 'document')!;
    await vscode.commands.executeCommand(contents.command, ...contents.args);
    assert.match(await vscode.env.clipboard.readText(), /===== docs\/system\/services\/payments\/logic.md =====/);
    const screen = renderOverview({ p, node: 'experience/ops-console/refunds' }, undefined, undefined, 'nonce', 2);
    const link = screen.actions.find(a => a.command === 'uspec.openSection' && a.args[2] === 'refund-window')!;
    await vscode.commands.executeCommand(link.command, ...link.args);
    const editor = vscode.window.activeTextEditor!;
    assert.match(editor.document.lineAt(editor.selection.start.line).text, /Refund window/);
  });

  it('follows documents and metadata without stealing focus on refresh', async () => {
    const node = 'system/services/payments';
    api.nodeWindow.show({ p, node });
    const panel = api.nodeWindow.currentPanel!;
    await vscode.window.showTextDocument(vscode.Uri.file(file(`docs/${node}/logic.md`)));
    await waitFor('document template', () => panel.webview.html.includes('Open the template of logic.md'));
    assert.strictEqual(api.nodeView.target?.doc, 'logic');
    await vscode.commands.executeCommand('uspec.revealNode', p.root, node);
    assert.strictEqual(api.nodeView.target?.doc, 'logic', 'programmatic reveal retains document context');
    await vscode.window.showTextDocument(vscode.Uri.file(file(`docs/${node}/node.yaml`)));
    await waitFor('metadata target', () => api.nodeView.target?.node === node && !api.nodeView.target.doc);
    const editor = vscode.window.activeTextEditor;
    p.drift.set(node, 'test drift');
    api.manager.notify(p);
    await waitFor('drift refresh', () => panel.webview.html.includes('test drift'));
    assert.strictEqual(vscode.window.activeTextEditor, editor);
    p.drift.delete(node);
    api.manager.notify(p);
    panel.dispose();
  });

  it('shows a linked node in the one overview tab', async () => {
    await vscode.commands.executeCommand('uspec.showOverview', p.root, 'product/support/refunds');
    const panel = api.nodeWindow.currentPanel!;
    assert.ok(panel);
    assert.strictEqual(api.nodeView.target?.node, 'product/support/refunds');
    await vscode.commands.executeCommand('uspec.showOverview', p.root, 'system/services/payments');
    assert.strictEqual(api.nodeWindow.currentPanel, panel);
    assert.strictEqual(api.nodeView.target?.node, 'system/services/payments');
    panel.dispose();
  });

  it('re-evaluates code ownership and clears removed nodes on model refresh', () => {
    const view = new NodeViewProvider(api.manager);
    const payments = p.nodes.get('system/services/payments')!;
    const nested = p.nodes.get('system/services/orders')!;
    const previousCode = nested.code;
    try {
      view.followFile(p.uriOf('services/payments/nested/index.ts'));
      assert.strictEqual(view.target?.node, payments.path);
      view.followFile(p.uriOf('unowned/notes.txt'));
      assert.strictEqual(view.target?.node, payments.path, 'a file of no node keeps the last node');
      view.followFile(p.uriOf('services/payments/nested/index.ts'));
      nested.code = ['services/payments/nested/'];
      api.manager.notify(p);
      assert.strictEqual(view.target?.node, nested.path);
      view.setTarget({ p, node: nested.path });
      p.nodes.delete(nested.path);
      api.manager.notify(p);
      assert.strictEqual(view.target, undefined);
    } finally {
      nested.code = previousCode;
      p.nodes.set(nested.path, nested);
      view.dispose();
      api.manager.notify(p);
    }
  });

  it('discards stale context responses and clears removed targets', async () => {
    const view = new NodeViewProvider(api.manager);
    const window = new NodeWindow(view);
    const node = 'system/services/payments';
    const original = await api.manager.json<any>(p, ['context', node, '--implement']);
    let resolve!: (value: any) => void;
    view.context = () => new Promise(r => { resolve = r; });
    window.show({ p, node });
    const panel = window.currentPanel!;
    view.setTarget({ p, node: 'product/support/refunds' });
    resolve(original);
    await new Promise(r => setTimeout(r, 30));
    assert.ok(!panel.webview.html.includes('services/payments/'));
    view.setTarget(undefined);
    assert.match(panel.webview.html, /No node selected/);
    window.dispose();
    view.dispose();
  });

  it('turns validate errors into problems on the right file', async () => {
    const stray = file('docs/product/stray.txt');
    fs.writeFileSync(stray, 'x');
    api.manager.refresh(p, 0);
    const uri = vscode.Uri.file(stray);
    await waitFor('the stray-file problem', () => vscode.languages.getDiagnostics(uri).find((d) => d.message.includes("isn't node.yaml or a document")));
    fs.rmSync(stray);
    api.manager.refresh(p, 0);
    await waitFor('the problem to go', () => vscode.languages.getDiagnostics(uri).length === 0);

    const yaml = file('docs/system/services/payments/node.yaml');
    const original = fs.readFileSync(yaml, 'utf8');
    fs.writeFileSync(yaml, original.replace('  - system/domain-model\n', '  - system/nowhere\n'));
    api.manager.refresh(p, 0);
    const d = await waitFor('the broken-link problem', () => vscode.languages.getDiagnostics(vscode.Uri.file(yaml)).find((x) => x.message.includes('system/nowhere')));
    assert.strictEqual(original.split('\n')[d.range.start.line].trim(), '- system/domain-model');
    fs.writeFileSync(yaml, original);
    api.manager.refresh(p, 0);
    await waitFor('the tree to be valid again', () => p.issues.length === 0 && vscode.languages.getDiagnostics(vscode.Uri.file(yaml)).length === 0);
  });

  it('runs a change with agents from change.md to close', async function () {
    this.timeout(120_000);
    const c = 'refund-window';
    await api.manager.mutate(p, ['change', 'new', c]);
    await api.manager.load(p);
    assert.ok(fs.readFileSync(file(`.uspec/changes/${c}/change.md`), 'utf8').includes('## Worked example'), 'change.md starts from the template');
    // The state window: waiting for the user, who still has the template to fill in.
    let stage = (await api.stateWindows.stage(p, c))!;
    assert.deepStrictEqual([stage.stage, stage.waitsFor, stage.templateLeft], ['waiting', 'user', true]);
    assert.deepStrictEqual(stage.marks, { waiting: 'current', starting: 'todo', spec: 'todo', splitting: 'todo', planning: 'todo', implementing: 'todo' });
    fs.writeFileSync(
      file(`.uspec/changes/${c}/change.md`),
      '# Refund window: 30 days\n\n## Why\n\nCustomers miss the window.\n\n## What changes\n\nA refund can be requested up to 30 days after delivery.\n\n' +
        '## Worked example\n\nDelivered on 1 March, refund asked on 20 March: accepted.\n\n## Out of scope\n\nPayouts.\n',
    );
    await api.manager.load(p);
    stage = (await api.stateWindows.stage(p, c))!;
    assert.deepStrictEqual([stage.stage, stage.templateLeft], ['waiting', false]);

    // Show state opens one window per change; showing it again reveals the same one.
    await vscode.commands.executeCommand('uspec.change.showState', { p, name: c });
    const panel = api.stateWindows.panelFor(p, c)!;
    assert.ok(panel);
    await vscode.commands.executeCommand('uspec.change.showState', { p, name: c });
    assert.strictEqual(api.stateWindows.size, 1);
    assert.strictEqual(api.stateWindows.panelFor(p, c), panel);
    await waitFor('the window to show the state', () => panel.webview.html.includes('Process change.md'));

    // The Changes view shows the change, active, with the impact step under Next.
    const [change] = api.changes.getChildren() as ChangeEl[];
    assert.strictEqual(change.kind, 'change');
    assert.match(String(api.changes.getTreeItem(change).description), /^active · find starting documents/);
    const next = api.changes.getChildren({ kind: 'group', p, name: c, group: 'next' });
    assert.strictEqual(next[0].kind, 'impact');
    assert.strictEqual(api.changes.getTreeItem(next[0]).contextValue, 'uspec.impact;idle');

    // Impact finds the starting documents and waits for the user to keep them.
    await api.agents.runChange(p, c);
    const impact = api.agents.runsOf(p, c).find((r) => r.role === 'impact')!;
    assert.strictEqual(impact.state, 'needs-approval');
    assert.deepStrictEqual(impact.starting.map((d) => d.document), ['product/support/refunds/rules.md']);
    stage = changeStage(p.change(c)!, api.agents.runsOf(p, c));
    assert.deepStrictEqual([stage.stage, stage.waitsFor, stage.approvals], ['starting', 'user', [impact]]);
    assert.strictEqual(stage.marks.waiting, 'done');
    await api.agents.keepStarting(impact, ['product/support/refunds/rules.md']);
    await api.manager.load(p);
    const started = p.change(c)!.docs.get('product/support/refunds/rules.md')!;
    assert.deepStrictEqual([started.state, started.via], ['affected', ['change.md']]);

    // Review every triage batch, then approve the split before separate planners run.
    for (let round = 0; round < 20; round++) {
      await api.agents.runChange(p, c);
      await api.manager.load(p);
      const waiting = api.agents.runsOf(p, c).filter(r => r.state === 'needs-approval');
      assert.ok(waiting.length, 'workflow stops at a review gate');
      if (waiting.some(r => r.role === 'planner')) break;
      for (const run of waiting) {
        if (run.role === 'triage') {
          assert.ok(run.proposal?.endsWith('.md'));
          assert.ok((await api.agents.proposalFiles(run)).length);
        }
        await api.agents.approve(run);
      }
    }
    let data = p.change(c)!;
    assert.strictEqual(data.counts.pending + data.counts.affected, 0, 'every document is settled');
    assert.strictEqual(data.docs.get('product/support/refunds/rules.md')?.state, 'updated');
    assert.match(fs.readFileSync(file('docs/product/support/refunds/rules.md'), 'utf8'), /## Refund window\n\n.*30 days/);
    assert.ok(data.docs.get('experience/ops-console/refunds/states.md')?.via.includes('links to product/support/refunds/rules.md#refund-window'));
    assert.strictEqual(data.docs.get('system/services/payments/logic.md')?.state, 'updated');
    assert.strictEqual(data.docs.get('system/services/payments/api.md')?.state, 'no-change');
    assert.strictEqual(data.docs.get('system/services/payments/compliance.md')?.state, 'updated');
    // The overview uses both CLI context modes with the active change and native baseline diffs.
    const target = { p, node: 'system/services/payments', doc: 'logic' };
    api.nodeView.setTarget(target);
    const contexts = await Promise.all((['document', 'implement'] as const).map(async mode => ({ mode, value: await api.nodeView.context(mode) })));
    const overview = renderOverview(target, 'document', contexts[0], 'test-nonce', 5);
    assert.ok(contexts.every(ctx => ctx.value.files.change.some(f => f.path === `.uspec/changes/${c}/change.md`)));
    const diff = overview.actions.find(a => a.command === 'uspec.diffFile')!;
    assert.ok(diff);
    await vscode.commands.executeCommand(diff.command, ...diff.args);
    const diffInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(diffInput instanceof vscode.TabInputTextDiff);
    assert.strictEqual(diffInput.modified.fsPath, p.abs(diff.args[1] as string));
    const copy = overview.actions.find(a => a.command === 'uspec.context.copyWithContents' && (a.args[0] as any).mode === 'document')!;
    await vscode.commands.executeCommand(copy.command, ...copy.args);
    assert.match(await vscode.env.clipboard.readText(), /===== git diff .* -- docs\/product\/support\/refunds\/rules.md =====/);
    let planner = api.agents.runsOf(p, c).find((r) => r.role === 'planner')!;
    assert.strictEqual(planner.state, 'needs-approval');
    stage = changeStage(data, api.agents.runsOf(p, c));
    assert.strictEqual(stage.stage, 'planning');
    assert.deepStrictEqual(stage.marks, { waiting: 'done', starting: 'done', spec: 'done', splitting: 'done', planning: 'current', implementing: 'todo' });
    assert.strictEqual(stage.approvals.length, 2);
    assert.ok(stage.approvals.every(r => r.role === 'planner' && r.plans.length === 1));
    assert.deepStrictEqual(data.plans.map((x) => [x.plan, x.nodes, x.state]), [
      ['payments', ['system/services/payments'], 'pending'],
      ['refunds', ['experience/ops-console/refunds'], 'pending'],
    ]);
    // The screen's plan waits for the service's, through the screen's link.
    assert.deepStrictEqual(data.next?.implement.map((x) => x.plan), ['payments']);
    const planEls = api.changes.getChildren({ kind: 'group', p, name: c, group: 'plans' });
    assert.deepStrictEqual(planEls.map((e) => api.changes.getTreeItem(e).contextValue), ['uspec.plan;pending;ready;idle', 'uspec.plan;pending;waiting;idle']);

    // Re-running the loop or launching a plan directly must not bypass approval.
    await api.agents.runChange(p, c);
    await api.agents.runImplementer(p, c, 'payments');
    assert.ok(!api.agents.runsOf(p, c).some((r) => r.role === 'implementer'));
    // Losing the in-memory runs (as on reload) must recreate a review.
    const originalRuns = [...api.agents.runs];
    const originalPlanner = planner;
    api.agents.runs = [];
    await api.agents.runImplementer(p, c, 'payments');
    planner = api.agents.runsOf(p, c).find((r) => r.role === 'planner')!;
    assert.strictEqual(planner.state, 'needs-approval');
    for (const run of originalRuns.filter(r => r.role === 'planner')) await api.agents.approve(run);
    for (const run of api.agents.runsOf(p, c).filter(r => r.role === 'planner')) await api.agents.approve(run);
    // Changing approved content invalidates approval.
    fs.appendFileSync(file(planner.plans[0]), '\nReview amendment.\n');
    await api.agents.runImplementer(p, c, 'payments');
    planner = api.agents.runsOf(p, c).find((r) => r.role === 'planner' && r.state === 'needs-approval')!;
    assert.ok(planner);
    await api.agents.approve(planner);
    // Approved fingerprints remain usable without the in-memory review.
    api.agents.runs = [];
    assert.strictEqual(planner.state, 'recorded');
    await api.agents.runChange(p, c);
    api.agents.runs.unshift(...originalRuns);
    await api.manager.load(p);
    data = p.change(c)!;
    assert.strictEqual(data.impl.get('system/services/payments'), 'done');
    assert.strictEqual(data.impl.get('experience/ops-console/refunds'), 'done');
    assert.ok(data.plans.every((x) => x.state === 'done'));
    stage = changeStage(data, api.agents.runsOf(p, c));
    assert.strictEqual(stage.stage, 'closable');
    assert.ok(Object.values(stage.marks).every((m) => m === 'done'));
    await waitFor('the window to offer Close', () => panel.webview.html.includes('data-action="close"'));

    const runs = api.agents.runsOf(p, c);
    assert.ok(runs.some((r) => r.role === 'triage' && r.state === 'recorded'));
    // One writer for the two documents of payments that were ready together, each with its own result;
    // logic.md, which waited for api.md, got a writer run of its own.
    const writers = runs.filter((r) => r.role === 'writer');
    const both = writers.find((r) => r.docs.length === 2)!;
    assert.ok(both, 'one writer run wrote two documents');
    assert.strictEqual(both.item, 'system/services/payments');
    assert.strictEqual(both.state, 'recorded');
    assert.deepStrictEqual(
      both.docs.map((d) => [d.key, d.state, d.outcome.split(' ·')[0]]),
      [
        ['system/services/payments/api.md', 'recorded', 'no change'],
        ['system/services/payments/compliance.md', 'recorded', 'updated'],
      ],
    );
    assert.ok(writers.some((r) => r.item === 'system/services/payments' && r.docs.map((d) => d.key).join() === 'system/services/payments/logic.md' && r.state === 'recorded'));
    // One implementer per plan, one after the other.
    const implementers = runs.filter((r) => r.role === 'implementer');
    assert.deepStrictEqual(implementers.map((r) => [r.item, r.state]), [
      ['payments', 'recorded'],
      ['refunds', 'recorded'],
    ]);
    assert.ok(runs.every((r) => r.sessionId?.startsWith('fake-')));

    // Each role ran with its own permissions.
    const calls = fs
      .readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { role: string; args: string[]; input: string });
    if (process.env.USPEC_TEST_PROVIDER === 'codex') {
      assert.ok(runs.every(r => r.provider === 'codex'));
      assert.ok(runs.filter(r => r.sessionId).every(r => r.sessionId!.startsWith('fake-')));
      for (const call of calls) {
        assert.ok(!call.args.includes('exec') && !call.args.includes('--json'), 'Codex runs in its interactive TUI');
        const readOnly = ['impact', 'triage', 'splitter', 'reviewer'].includes(call.role);
        assert.strictEqual(call.args[call.args.indexOf('--sandbox') + 1], readOnly ? 'read-only' : 'workspace-write');
        assert.ok(call.args.includes('approval_policy="never"'));
        assert.ok(!call.args.includes('--model'), 'Claude model aliases must not reach Codex');
        assert.match(call.input, /You run in a terminal started by the uspec VS Code extension/);
      }
    }
    // With `isolated`, the default, every automated job runs in a new session.
    assert.ok(!calls.some((x) => x.args.includes('resume') || x.args.includes('--resume')), 'no job resumes a session');
    if (process.env.USPEC_TEST_PROVIDER !== 'codex') {
    const writer = calls.find((x) => x.role === 'writer' && x.args.includes('Edit(docs/system/services/payments/compliance.md)'))!;
    assert.ok(writer.args.includes('Edit(docs/system/services/payments/api.md)'));
    assert.ok(writer.args.includes('Edit(docs/system/services/payments/api-extra/**)'));
    assert.ok(!writer.args.includes('Edit(docs/system/services/payments/logic.md)'));
    assert.ok(!writer.args.some((a) => a.startsWith('Edit(services/')));
    // Triage runs on the triage model (`sonnet` by default); the others on Claude Code's default.
    const model = (x: { args: string[] }) => (x.args.includes('--model') ? x.args[x.args.indexOf('--model') + 1] : undefined);
    assert.ok(calls.filter((x) => x.role === 'triage').every((x) => model(x) === 'sonnet'));
    assert.ok(calls.filter((x) => x.role !== 'triage').every((x) => model(x) === undefined));
    const plannerCall = calls.find((x) => x.role === 'planner')!;
    assert.ok(plannerCall.args.some(a => /^Write\(.+\/plans\/(payments|refunds)\.md\)$/.test(a)));
    assert.ok(!plannerCall.args.some(a => a.includes('plans/**')));
    assert.ok(!plannerCall.args.some((a) => a.startsWith('Edit(docs') || a.startsWith('Edit(services')));
    const implementer = calls.find((x) => x.role === 'implementer')!;
    assert.ok(implementer.args.includes('Edit(services/payments/**)'));
    assert.ok(implementer.args.includes('Bash'));
    for (const role of ['impact', 'triage']) assert.ok(!calls.find((x) => x.role === role)!.args.some((a) => a.startsWith('Edit(')), role);

    }

    // The run log has the input and the result.
    const log = (await vscode.workspace.openTextDocument(runs[0].logUri)).getText();
    assert.match(log, /--- input/);
    assert.match(log, /== recorded/);

    const sessions = runs.map((r) => r.terminal).filter((t) => t && vscode.window.terminals.includes(t));
    assert.ok(sessions.length, 'the runs’ sessions stay open');
    await vscode.commands.executeCommand('uspec.change.close', { kind: 'change', p, name: c });
    await waitFor('the change to close', () => p.changes.length === 0);
    await waitFor('the change’s agent sessions to close', () => !sessions.some((t) => vscode.window.terminals.includes(t!)));
    assert.ok(!fs.existsSync(file(`.uspec/changes/${c}`)));
    await waitFor('the window to say the change is closed', () => panel.webview.html.includes(`${c} is closed.`));
    panel.dispose();
    assert.strictEqual(api.stateWindows.size, 0);
  });

  it('runs a document’s node writer from Run writer', async function () {
    this.timeout(60_000);
    const c = 'run-writer';
    const docs = ['api', 'compliance'].map((d) => `system/services/payments/${d}.md`);
    const rules = file('docs/product/support/refunds/rules.md');
    const before = docs.map((d) => fs.readFileSync(file(`docs/${d}`), 'utf8'));
    const rulesBefore = fs.readFileSync(rules, 'utf8');
    await api.manager.mutate(p, ['change', 'new', c]);
    fs.writeFileSync(file(`.uspec/changes/${c}/change.md`), '# Refund window: 31 days\n\n## Why\n\nRefunds within 31 days.\n');
    fs.writeFileSync(rules, rulesBefore.replace(/\d+ days/, '31 days'));
    await api.manager.mutate(p, ['change', 'set', c, 'product/support/refunds/rules.md', 'updated']);
    for (const d of docs) await api.manager.mutate(p, ['change', 'set', c, d, 'affected', '--reason', 'The window changes.']);
    await api.manager.load(p);
    assert.deepStrictEqual(
      p.change(c)?.next?.write.map((w) => [w.node, w.documents.map((d) => d.document)]),
      [['system/services/payments', docs]],
    );
    // Affected documents make Triage and write the current state.
    const stage = changeStage(p.change(c)!, api.agents.runsOf(p, c));
    assert.deepStrictEqual([stage.stage, stage.marks.waiting, stage.marks.starting, stage.marks.planning], ['spec', 'done', 'done', 'todo']);

    // Next lists the documents to write grouped by node.
    const write = api.changes.getChildren({ kind: 'nextWrite', p, name: c });
    assert.deepStrictEqual(write.map((w) => w.kind === 'writeNode' && w.node), ['system/services/payments']);
    assert.deepStrictEqual(api.changes.getChildren(write[0]).map((d) => d.kind === 'doc' && d.key), docs);

    try {
      // Run writer on one document runs its node's writer, with the node's other document under `write`.
      await vscode.commands.executeCommand('uspec.agents.runWriter', { kind: 'doc', p, name: c, key: docs[1], section: 'write' });
      const run = api.agents.runsOf(p, c).find((r) => r.role === 'writer')!;
      assert.strictEqual(run.item, 'system/services/payments');
      assert.deepStrictEqual(run.docs.map((d) => d.key), docs);
      assert.deepStrictEqual(api.changes.getChildren({ kind: 'run', run }).map((d) => d.kind === 'runDoc' && d.key), docs);
      await api.manager.load(p);
      assert.strictEqual(p.change(c)?.docs.get(docs[0])?.state, 'no-change');
      assert.strictEqual(p.change(c)?.docs.get(docs[1])?.state, 'updated');
    } finally {
      docs.forEach((d, i) => fs.writeFileSync(file(`docs/${d}`), before[i]));
      fs.writeFileSync(rules, rulesBefore);
      fs.rmSync(file(`.uspec/changes/${c}`), { recursive: true, force: true });
      await api.manager.load(p);
    }
  });

  it('keeps writer reviews collapsed, opens native diffs and restores the same author session', async function () {
    this.timeout(60_000);
    const originalProvider = vscode.workspace.getConfiguration('uspec').get<string>('agents.provider', 'claude');
    const c = 'review-recovery', key = 'system/services/payments/compliance.md';
    const target = file(`docs/${key}`), original = fs.readFileSync(target, 'utf8');
    const config = vscode.workspace.getConfiguration('uspec');
    await config.update('agents.approveWrites', 'always', vscode.ConfigurationTarget.Workspace);
    await api.manager.mutate(p, ['change', 'new', c]);
    await api.manager.mutate(p, ['change', 'set', c, key, 'affected', '--reason', 'Review test']);
    // Earlier changes closed with their agents' terminals: the user's own terminal is the active one.
    const own = vscode.window.createTerminal('own');
    try {
      const run = (await api.agents.runWriter(p, c, 'system/services/payments', [key]))!;
      assert.strictEqual(run.state, 'needs-approval');
      assert.ok(run.terminal && vscode.window.terminals.includes(run.terminal));
      assert.notStrictEqual(vscode.window.activeTerminal, run.terminal, 'agent terminal starts hidden');
      await api.stateWindows.show(p, c);
      const panel = api.stateWindows.panelFor(p, c)!;
      await waitFor('the writer review to finish rendering', () => panel.webview.html.includes('data-action="showDiff"'));
      assert.match(panel.webview.html, /Open diff in VS Code/);
      assert.match(panel.webview.html, /<details data-diff=/);
      assert.ok(!/<details[^>]*\sopen(?:[ >])/.test(panel.webview.html), 'diffs default to collapsed');
      assert.ok(!panel.webview.html.includes('write-review.md'));
      await api.agents.showDiff(run, key);
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputTextDiff, 'opens the native diff editor');
      assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), original);
      const session = run.sessionId;
      await config.update('agents.provider', originalProvider === 'codex' ? 'claude' : 'codex', vscode.ConfigurationTarget.Workspace);
      await api.agents.reviseWriter(run, [{ document: key, selected: true, comment: 'Explain the rule clearly' }]);
      assert.strictEqual(run.sessionId, session, 'revision resumes the writer session');
      assert.strictEqual(run.docs[0].snapshot, original, 'revision retains the original review base');
      api.agents.runs = [];
      api.agents.restore();
      const restored = api.agents.runsOf(p, c).find(r => r.role === 'writer')!;
      assert.strictEqual(restored.sessionId, session);
      assert.strictEqual(restored.provider, originalProvider, 'restore retains the author provider after settings change');
      assert.strictEqual(restored.state, 'needs-approval');
      assert.strictEqual((await vscode.workspace.openTextDocument(restored.docs[0].snapshotUri!)).getText(), original);
      await api.agents.approve(restored);
      await api.manager.load(p);
      assert.strictEqual(p.change(c)?.docs.get(key)?.state, 'updated');
      panel.dispose();
    } finally {
      own.dispose();
      await config.update('agents.provider', originalProvider, vscode.ConfigurationTarget.Workspace);
      await config.update('agents.approveWrites', 'never', vscode.ConfigurationTarget.Workspace);
      fs.writeFileSync(target, original);
      fs.rmSync(file(`.uspec/changes/${c}`), { recursive: true, force: true });
      await api.manager.load(p);
    }
  });

  it('runs a whole change in the explore session with `simple`', async function () {
    this.timeout(120_000);
    const c = 'simple-window';
    const config = vscode.workspace.getConfiguration('uspec');
    const warnings = answerWarnings();
    const from = calls().length;
    resetDocs();
    try {
      await config.update('agents.sessions', 'simple', vscode.ConfigurationTarget.Workspace);
      await api.manager.mutate(p, ['change', 'new', c]);
      fs.writeFileSync(file(`.uspec/changes/${c}/change.md`), '# Refund window: 30 days\n\n## What changes\n\nA refund can be requested up to 30 days after delivery.\n');
      await api.manager.load(p);

      // Continue with Agent opens the user's session; its hooks give the change its explore session.
      await vscode.commands.executeCommand('uspec.claude.continueChange', { p, name: c });
      const explore = await waitFor('the explore session', () => api.agents.sessions.explore(p, c)?.id);
      const user = api.agents.sessions.explore(p, c)!.terminal!;
      assert.ok(user && vscode.window.terminals.includes(user));
      await drive(c);

      // The first job asked before ending the user's agent, then ran in its terminal.
      assert.ok(warnings.shown.some((m) => /continues the agent session explore, which is still open/.test(m)), warnings.shown.join(' | '));
      const runs = api.agents.runsOf(p, c);
      assert.strictEqual(runs.find((r) => r.role === 'impact')!.terminal, user);
      const made = calls().slice(from);
      assert.strictEqual(made[0].role, 'explore');
      const jobs = made.slice(1);
      assert.deepStrictEqual([...new Set(jobs.map((x) => x.role))].sort(), ['impact', 'implementer', 'planner', 'triage', 'writer']);
      for (const call of jobs) assert.strictEqual(resumes(call), explore, `${call.role} resumes the explore session`);
      // Each job had its own role's permissions.
      if (!codex) {
        const edits = (x: Call) => x.args.filter((a) => a.startsWith('Edit('));
        for (const x of jobs.filter((x) => x.role === 'impact' || x.role === 'triage')) assert.deepStrictEqual(edits(x), [], x.role);
        for (const x of jobs.filter((x) => x.role === 'writer')) assert.ok(edits(x).length && edits(x).every((a) => a.startsWith('Edit(docs/')), edits(x).join());
        const implementer = jobs.find((x) => x.role === 'implementer')!;
        assert.ok(implementer.args.includes('Edit(services/payments/**)'));
        assert.ok(!edits(implementer).some((a) => a.startsWith('Edit(docs/')));
        // One session, one model: triage doesn't switch to the triage model.
        assert.ok(jobs.every((x) => !x.args.includes('--model')));
        // Every job after the first is told to re-read.
        const note = (x: Call) => x.args[x.args.indexOf('--append-system-prompt') + 1];
        assert.doesNotMatch(note(jobs[0]), /re-read/);
        assert.ok(jobs.slice(1).every((x) => /re-read anything before relying on it/.test(note(x))));
      }
      // No splitter: the extension's split holds every node in one plan, approved without asking.
      assert.ok(!jobs.some((x) => x.role === 'splitter'));
      assert.ok(!runs.some((r) => r.role === 'splitter'));
      const split = fs.readFileSync(file(`.uspec/changes/${c}/plan-split.md`), 'utf8');
      assert.match(split, new RegExp(`^### plans/${c}\\.md$`, 'm'));
      const data = p.change(c)!;
      assert.deepStrictEqual(data.plans.map((x) => [x.plan, [...x.nodes].sort()]), [[c, ['experience/ops-console/refunds', 'system/services/payments']]]);
      // Every run's log says where it ran.
      for (const r of runs) assert.match(r.log.join('\n'), /^session: explore \(resumed\)$/m, r.title);
      assert.ok(runs.every((r) => r.session?.name === 'explore' && r.session.how === 'resumed'));
    } finally {
      warnings.restore();
      await config.update('agents.sessions', undefined, vscode.ConfigurationTarget.Workspace);
      await discard(c);
      resetDocs();
    }
  });

  it('runs stages in their own sessions with `complex`', async function () {
    this.timeout(120_000);
    const c = 'complex-window';
    const config = vscode.workspace.getConfiguration('uspec');
    const warnings = answerWarnings();
    const from = calls().length;
    const rules = file('docs/product/support/refunds/rules.md');
    const ready = ['system/services/orders/api.md', 'system/services/payments/compliance.md'];
    resetDocs();
    try {
      await config.update('agents.sessions', 'complex', vscode.ConfigurationTarget.Workspace);
      await api.manager.mutate(p, ['change', 'new', c]);
      fs.writeFileSync(file(`.uspec/changes/${c}/change.md`), '# Refund window: 30 days\n\n## What changes\n\nA refund can be requested up to 30 days after delivery.\n');
      fs.writeFileSync(rules, fs.readFileSync(rules, 'utf8').replace('14 days', '30 days'));
      await api.manager.mutate(p, ['change', 'set', c, 'product/support/refunds/rules.md', 'updated']);
      for (const d of ready) await api.manager.mutate(p, ['change', 'set', c, d, 'affected', '--reason', 'The window changes.']);
      await api.manager.load(p);
      assert.deepStrictEqual(p.change(c)!.next!.write.map((w) => w.node), ['system/services/orders', 'system/services/payments']);
      assert.ok(p.change(c)!.next!.triage);

      // One pass: the writers of both nodes share `spec` in round 1, as one job; triage starts round 2
      // in the same pass and resumes `spec` after it.
      await api.agents.runChange(p, c);
      const writer = api.agents.runsOf(p, c).find((r) => r.role === 'writer')!;
      const triage = api.agents.runsOf(p, c).find((r) => r.role === 'triage')!;
      assert.deepStrictEqual(writer.nodes, ['system/services/orders', 'system/services/payments']);
      assert.deepStrictEqual(writer.docs.map((d) => d.key), ready);
      assert.deepStrictEqual(writer.session, { name: 'spec', how: 'new' });
      assert.deepStrictEqual(triage.session, { name: 'spec', how: 'resumed' });
      assert.strictEqual(api.agents.sessions.round(p, c), 2);
      let made = calls().slice(from);
      const w = made.findIndex((x) => x.role === 'writer'), t = made.findIndex((x) => x.role === 'triage');
      assert.ok(w >= 0 && t > w, 'triage ran after the writer');
      assert.strictEqual(resumes(made[w]), undefined);
      assert.strictEqual(resumes(made[t]), made[w].session);
      assert.match(made[w].input, /^## system\/services\/orders$/m);
      assert.match(made[w].input, /^## system\/services\/payments$/m);
      if (!codex) {
        for (const d of ready) assert.ok(made[w].args.includes(`Edit(docs/${d})`), d);
        // `spec` is used by triage and writers: triage runs on the agents model.
        assert.ok(!made[t].args.includes('--model'));
      }

      // Session names and the round survive a reload.
      const names = api.agents.runsOf(p, c).map((r) => [r.role, r.session?.name]);
      api.agents.runs = [];
      api.agents.restore();
      assert.deepStrictEqual(api.agents.runsOf(p, c).map((r) => [r.role, r.session?.name]), names);
      assert.strictEqual(api.agents.sessions.round(p, c), 2);
      assert.strictEqual(api.agents.sessions.get(p, c, 'spec')?.id, made[w].session);

      await drive(c);
      made = calls().slice(from);
      const runs = api.agents.runsOf(p, c);
      const splitter = runs.find((r) => r.role === 'splitter')!;
      assert.deepStrictEqual(splitter.session, { name: 'build', how: 'new' });
      const planners = runs.filter((r) => r.role === 'planner' && r.session);
      const implementers = runs.filter((r) => r.role === 'implementer');
      assert.ok(planners.length >= 2, 'one planner per plan');
      const planCall = (id: string) => made.find((x) => x.role === 'planner' && x.input.includes(`Assigned plan: .uspec/changes/${c}/plans/${id}.md`))!;
      for (const planner of planners) {
        const call = planCall(planner.item);
        if (codex) {
          // Codex can't fork: the planner gets a new session, and the log says why.
          assert.strictEqual(resumes(call), undefined);
          assert.match(planner.log.join('\n'), new RegExp(`^session: plan-${planner.item} \\(new; Codex can't fork build\\)$`, 'm'));
        } else {
          assert.strictEqual(resumes(call), splitter.sessionId);
          assert.ok(call.args.includes('--fork-session'));
          assert.deepStrictEqual(planner.session, { name: `plan-${planner.item}`, how: 'forked', from: 'build' });
          assert.notStrictEqual(planner.sessionId, splitter.sessionId);
        }
      }
      // Each implementer continues its planner.
      for (const impl of implementers) {
        const call = made.find((x) => x.role === 'implementer' && x.input.includes(`Plan: .uspec/changes/${c}/plans/${impl.item}.md`))!;
        assert.strictEqual(resumes(call), planners.find((r) => r.item === impl.item)!.sessionId);
        assert.deepStrictEqual(impl.session, { name: `plan-${impl.item}`, how: 'resumed' });
      }
      assert.ok(!warnings.shown.some((m) => /still open in its terminal/.test(m)), 'no automated job asks');
    } finally {
      warnings.restore();
      await config.update('agents.sessions', undefined, vscode.ConfigurationTarget.Workspace);
      await discard(c);
      resetDocs();
    }
  });

  it('runs every job in a new session while the sessions setting has a problem', async function () {
    this.timeout(60_000);
    const c = 'invalid-sessions';
    const config = vscode.workspace.getConfiguration('uspec');
    const warnings = answerWarnings();
    const from = calls().length;
    const key = 'system/services/payments/compliance.md';
    resetDocs();
    try {
      await config.update('agents.sessions', { triage: 't-{plan}', writer: 'explore' }, vscode.ConfigurationTarget.Workspace);
      await waitFor('the warning', () => warnings.shown.includes('uspec.agents.sessions: `{plan}` can\'t be used by triage. Agents run in new sessions until this is fixed.'));
      await api.manager.mutate(p, ['change', 'new', c]);
      await api.manager.mutate(p, ['change', 'set', c, key, 'affected', '--reason', 'Invalid sessions test']);
      await api.manager.load(p);
      const run = (await api.agents.runWriter(p, c, 'system/services/payments', [key]))!;
      assert.strictEqual(run.session, undefined);
      assert.match(run.log.join('\n'), /^session: new$/m);
      const call = calls().slice(from).find((x) => x.role === 'writer')!;
      assert.strictEqual(resumes(call), undefined);
    } finally {
      warnings.restore();
      await config.update('agents.sessions', undefined, vscode.ConfigurationTarget.Workspace);
      await discard(c);
      resetDocs();
    }
  });

  it('copies a document’s context as the CLI prints it', async () => {
    await vscode.commands.executeCommand('uspec.context.copy', { kind: 'doc', p, node: 'system/services/payments', doc: 'logic' });
    const text = await vscode.env.clipboard.readText();
    assert.ok(text.startsWith('# Instructions'));
    assert.ok(text.includes('docs/system/services/payments/api.md'));
  });

  it('reviews a node with a reviewer agent', async () => {
    const run = await api.agents.runReviewer(p, 'product/support/refunds');
    assert.strictEqual(run?.state, 'reviewed');
    assert.strictEqual(run?.outcome, 'no findings');
  });
});
