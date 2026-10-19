// The extension in VS Code against a copy of the example product: loading, problems, the views, and
// a change run by (fake) agents from the first update to close.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { UspecApi } from '../../extension';
import type { Project } from '../../projects';
import type { ChangeEl } from '../../views/changesView';
import type { SpecEl } from '../../views/specTree';

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

describe('uspec extension', () => {
  let api: UspecApi;
  let p: Project;

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
    const [root] = api.specTree.getChildren() as SpecEl[];
    assert.deepStrictEqual([root.kind, (root as { node: string }).node], ['node', '']);
    const payments: SpecEl = { kind: 'node', p, node: 'system/services/payments' };
    const kids = api.specTree.getChildren(payments).map((k) => (k.kind === 'doc' ? `${k.doc}.md` : k.kind));
    assert.deepStrictEqual(kids, ['api.md', 'logic.md', 'storage.md', 'events.md', 'compliance.md']);
    const item = api.specTree.getTreeItem(payments);
    assert.strictEqual(item.description, 'service');
    assert.match(String(item.contextValue), /^uspec\.node;code;child/);
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
    fs.writeFileSync(
      file(`.uspec/changes/${c}/change.md`),
      '# Refund window: 30 days\n\n## Why\n\nCustomers miss the window.\n\n## What changes\n\nA refund can be requested up to 30 days after delivery.\n\n' +
        '## Worked example\n\nDelivered on 1 March, refund asked on 20 March: accepted.\n\n## Out of scope\n\nPayouts.\n',
    );
    await api.manager.load(p);

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
    await api.agents.keepStarting(impact, ['product/support/refunds/rules.md']);
    await api.manager.load(p);
    const started = p.change(c)!.docs.get('product/support/refunds/rules.md')!;
    assert.deepStrictEqual([started.state, started.via], ['affected', ['change.md']]);

    // Then the spec side and the planner, which waits for the plans to be read.
    await api.agents.runChange(p, c);
    await api.manager.load(p);
    let data = p.change(c)!;
    assert.strictEqual(data.counts.pending + data.counts.affected, 0, 'every document is settled');
    assert.strictEqual(data.docs.get('product/support/refunds/rules.md')?.state, 'updated');
    assert.match(fs.readFileSync(file('docs/product/support/refunds/rules.md'), 'utf8'), /## Refund window\n\n.*30 days/);
    assert.ok(data.docs.get('experience/ops-console/refunds/states.md')?.via.includes('links to product/support/refunds/rules.md#refund-window'));
    assert.strictEqual(data.docs.get('system/services/payments/logic.md')?.state, 'updated');
    assert.strictEqual(data.docs.get('system/services/payments/api.md')?.state, 'no-change');
    assert.strictEqual(data.docs.get('system/services/payments/compliance.md')?.state, 'updated');
    const planner = api.agents.runsOf(p, c).find((r) => r.role === 'planner')!;
    assert.strictEqual(planner.state, 'needs-approval');
    assert.deepStrictEqual(data.plans.map((x) => [x.plan, x.nodes, x.state]), [
      ['payments', ['system/services/payments'], 'pending'],
      ['refunds', ['experience/ops-console/refunds'], 'pending'],
    ]);
    // The screen's plan waits for the service's, through the screen's link.
    assert.deepStrictEqual(data.next?.implement.map((x) => x.plan), ['payments']);
    const planEls = api.changes.getChildren({ kind: 'group', p, name: c, group: 'plans' });
    assert.deepStrictEqual(planEls.map((e) => api.changes.getTreeItem(e).contextValue), ['uspec.plan;pending;ready;idle', 'uspec.plan;pending;waiting;idle']);

    await api.agents.approve(planner);
    assert.strictEqual(planner.state, 'recorded');
    await api.agents.runChange(p, c);
    await api.manager.load(p);
    data = p.change(c)!;
    assert.strictEqual(data.impl.get('system/services/payments'), 'done');
    assert.strictEqual(data.impl.get('experience/ops-console/refunds'), 'done');
    assert.ok(data.plans.every((x) => x.state === 'done'));

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
      .map((l) => JSON.parse(l) as { role: string; args: string[] });
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
    assert.ok(plannerCall.args.includes(`Write(.uspec/changes/${c}/plans/**)`));
    assert.ok(!plannerCall.args.some((a) => a.startsWith('Edit(docs') || a.startsWith('Edit(services')));
    const implementer = calls.find((x) => x.role === 'implementer')!;
    assert.ok(implementer.args.includes('Edit(services/payments/**)'));
    assert.ok(implementer.args.includes('Bash'));
    for (const role of ['impact', 'triage']) assert.ok(!calls.find((x) => x.role === role)!.args.some((a) => a.startsWith('Edit(')), role);

    // The run log has the input and the result.
    const log = (await vscode.workspace.openTextDocument(runs[0].logUri)).getText();
    assert.match(log, /--- input/);
    assert.match(log, /== recorded/);

    await vscode.commands.executeCommand('uspec.change.close', { kind: 'change', p, name: c });
    await waitFor('the change to close', () => p.changes.length === 0);
    assert.ok(!fs.existsSync(file(`.uspec/changes/${c}`)));
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
