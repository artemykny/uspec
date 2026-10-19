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

  it('runs a change with agents from the first update to close', async function () {
    this.timeout(120_000);
    const c = 'refund-window';
    await api.manager.mutate(p, ['change', 'new', c]);
    await api.manager.load(p);
    fs.writeFileSync(file(`.uspec/changes/${c}/change.md`), '# Refund window\n\nStarts at: product/support/refunds\n\nRefunds can be requested within 30 days instead of 14.\n');
    fs.writeFileSync(file('docs/product/support/refunds/rules.md'), '# Rules\n\nRefunds can be requested within 30 days.\n');
    await vscode.commands.executeCommand('uspec.change.recordUpdated', { kind: 'doc', p, node: 'product/support/refunds', doc: 'rules' });
    await api.manager.load(p);

    const data = p.change(c)!;
    assert.strictEqual(data.docs.get('product/support/refunds/rules.md')?.state, 'updated');
    assert.ok(data.next?.triage?.batch.some((b) => b.document === 'system/services/payments/api.md'));

    // The Changes view shows the change, active, with a triage batch under Next.
    const [change] = api.changes.getChildren() as ChangeEl[];
    assert.strictEqual(change.kind, 'change');
    assert.match(String(api.changes.getTreeItem(change).description), /^active · \d+ to triage/);
    const groups = api.changes.getChildren(change).map((g) => (g.kind === 'group' ? g.group : g.kind));
    assert.deepStrictEqual(groups.slice(0, 2), ['next', 'documents']);
    const next = api.changes.getChildren({ kind: 'group', p, name: c, group: 'next' });
    assert.strictEqual(next[0].kind, 'triage');
    assert.strictEqual(api.changes.getTreeItem(next[0]).contextValue, 'uspec.triage;idle');

    await api.agents.runChange(p, c);
    await api.manager.load(p);

    const done = p.change(c)!;
    assert.strictEqual(done.counts.pending + done.counts.affected, 0, 'every document is settled');
    assert.strictEqual(done.docs.get('system/services/payments/logic.md')?.state, 'updated');
    assert.strictEqual(done.docs.get('system/services/payments/api.md')?.state, 'no-change');
    assert.strictEqual(done.impl.get('system/services/payments'), 'done');
    assert.ok(fs.readFileSync(file('docs/system/services/payments/logic.md'), 'utf8').includes('30 days'));

    const runs = api.agents.runsOf(p, c);
    assert.ok(runs.some((r) => r.role === 'triage' && r.state === 'recorded'));
    assert.ok(runs.some((r) => r.role === 'writer' && r.item === 'system/services/payments/logic.md' && r.state === 'recorded'));
    assert.ok(runs.some((r) => r.role === 'implementer' && r.state === 'recorded'));
    assert.ok(runs.every((r) => r.sessionId?.startsWith('fake-')));

    // Each role ran with its own permissions.
    const calls = fs
      .readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { role: string; args: string[] });
    const writer = calls.find((x) => x.role === 'writer')!;
    assert.ok(writer.args.includes('Edit(docs/system/services/payments/logic.md)'));
    assert.ok(!writer.args.some((a) => a.startsWith('Edit(services/')));
    const implementer = calls.find((x) => x.role === 'implementer')!;
    assert.ok(implementer.args.includes('Edit(services/payments/**)'));
    assert.ok(implementer.args.includes('Bash'));
    const triage = calls.find((x) => x.role === 'triage')!;
    assert.ok(!triage.args.some((a) => a.startsWith('Edit(')));

    // The run log has the input and the result.
    const log = (await vscode.workspace.openTextDocument(runs[0].logUri)).getText();
    assert.match(log, /--- input/);
    assert.match(log, /== recorded/);

    await vscode.commands.executeCommand('uspec.change.close', { kind: 'change', p, name: c });
    await waitFor('the change to close', () => p.changes.length === 0);
    assert.ok(!fs.existsSync(file(`.uspec/changes/${c}`)));
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
