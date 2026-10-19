// The extension on this repository: its own spec tree, with the example product as a nested project.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { UspecApi } from '../../extension';
import type { SpecEl } from '../../views/specTree';

const work = process.env.USPEC_TEST_WORKSPACE!;
const file = (rel: string) => path.join(work, ...rel.split('/'));

describe('uspec extension on nested projects', () => {
  let api: UspecApi;

  before(async () => {
    api = await vscode.extensions.getExtension<UspecApi>('uspec.uspec')!.activate();
    await api.ready;
  });

  it('finds both projects', () => {
    const roots = api.manager.projects.map((p) => path.relative(work, p.root) || '.');
    assert.deepStrictEqual(roots, ['.', 'examples/example_product']);
    const [repo, example] = api.manager.projects;
    assert.ok(repo.nodes.has('vscode'));
    assert.strictEqual(repo.issues.length, 0, repo.issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
    assert.strictEqual(example.nodes.size, 72);
  });

  it('gives each file to the nearest project', () => {
    const [repo, example] = api.manager.projects;
    assert.strictEqual(api.manager.projectFor(vscode.Uri.file(file('examples/example_product/docs/overview.md'))), example);
    assert.strictEqual(api.manager.projectFor(vscode.Uri.file(file('docs/overview.md'))), repo);
    assert.deepStrictEqual(repo.target(file('cli/src/change.rs')), { node: 'cli/change', code: true });
    assert.deepStrictEqual(repo.target(file('vscode/src/agents.ts')), { node: 'vscode', code: true });
    assert.strictEqual(repo.target(file('docs/method/changes/rules.md'))?.doc, 'rules');
  });

  it('follows files in the nearest project and uses the longest code path', async () => {
    const [repo, example] = api.manager.projects;
    await vscode.window.showTextDocument(example.uriOf('docs/system/services/payments/logic.md'));
    assert.strictEqual(api.nodeView.target?.p, example);
    assert.strictEqual(api.nodeView.target?.doc, 'logic');
    await vscode.window.showTextDocument(repo.uriOf('cli/src/change.rs'));
    assert.strictEqual(api.nodeView.target?.p, repo);
    assert.strictEqual(api.nodeView.target?.node, 'cli/change');
    assert.strictEqual(api.nodeView.target?.doc, undefined);
    const types = api.specTree.getChildren({ kind: 'root', branch: 'types' });
    assert.strictEqual(types.length, 2);
    assert.ok(types.every(t => t.kind === 'foreign' && t.value.kind === 'project'));
  });

  it('shows one root per project', () => {
    const roots = api.specTree.getChildren({ kind: 'root', branch: 'specification' }) as SpecEl[];
    assert.deepStrictEqual(
      roots.map((r) => r.kind),
      ['project', 'project'],
    );
    const [root] = api.specTree.getChildren(roots[0]);
    assert.strictEqual(api.specTree.getTreeItem(root).label, 'docs');
    assert.deepStrictEqual(
      api.changes.getChildren().map(el => el.kind === 'project' ? el.p.root : undefined),
      api.manager.projects.filter(p => p.changes.length > 0).map(p => p.root),
    );
  });
});
