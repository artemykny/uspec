import * as assert from 'assert';
import { renderOverview } from '../../views/nodeOverview';
import type { NodeTarget } from '../../views/nodeView';
import type { ContextJson } from '../../core/model';

function target(): NodeTarget {
  const node = { type: 'service', documents: ['logic'], deps: [{ node: 'refunds', doc: 'rules', section: 'refund-window' }], code: ['services/payments/'] };
  const p = {
    root: '/project', rootLabel: 'docs', nodes: new Map([['payments', node]]),
    typeOf: () => ({ name: 'Service', type: 'service', path: '.uspec/node-types/service/node-type.yaml', description: '<script>unsafe</script>' }),
    typeDoc: () => ({ description: 'Business rules', required: true, exposed: false, derives_from: ['api#errors'], template: '.uspec/node-types/service/logic.md' }),
    nodeDir: (n: string) => `docs/${n}`, docFile: (key: string) => `docs/${key}`, hasCode: () => true,
    downstream: new Map(), drift: new Map(), nodeIssues: () => [], activeChange: undefined,
  };
  return { p, node: 'payments', doc: 'logic' } as unknown as NodeTarget;
}

describe('node overview presentation', () => {
  it('orders sections, escapes metadata and exposes distinct bounded actions', () => {
    const t = target();
    const { html, actions } = renderOverview(t, [], 'nonce', 7);
    let last = html.indexOf('Business rules');
    for (const name of ['Upstream', 'Downstream', 'Code paths', 'Active change', 'Drift', 'Context']) {
      const at = html.indexOf(`<h2>${name}</h2>`);
      assert.ok(at > last, name); last = at;
    }
    assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
    assert.ok(!html.includes('<script>unsafe'));
    assert.match(html, /No active change/);
    assert.match(html, /Required/);
    assert.match(html, /Internal/);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /generation:7/);
    assert.match(html, /:focus-visible/);
    assert.match(html, /@media\(max-width:600px\)/);
    assert.ok(actions.some(a => a.command === 'uspec.openSection' && a.args[2] === 'refund-window'));
    assert.ok(actions.some(a => a.command === 'uspec.openSection' && a.args[2] === 'errors'));
    assert.ok(actions.some(a => a.command === 'uspec.revealPath' && a.args[1] === 'services/payments/'));
    const copies = actions.filter(a => a.command === 'uspec.context.copy');
    assert.deepStrictEqual(copies.map(a => (a.args[0] as any).mode), ['document', 'implement']);
    assert.ok(copies.every(a => (a.args[0] as any).target.node === t.node));
  });

  it('distinguishes context errors and routes baseline entries to native diffs', () => {
    const value: ContextJson = { node: 'payments', type: 'service', documents: [], instructions: { type: 'Service', text: null }, baseline: 'abc123', files: { change: [{ path: 'docs/refunds/rules.md', section: 'refund-window', note: 'diff since abc123' }] } };
    const { html, actions } = renderOverview(target(), [{ mode: 'document', error: 'CLI <failure>' }, { mode: 'implement', value }], 'nonce', 1);
    assert.match(html, /role="alert">⚠ CLI &lt;failure&gt;/);
    assert.deepStrictEqual(actions.find(a => a.command === 'uspec.diffFile')?.args, ['/project', 'docs/refunds/rules.md', 'abc123']);
    assert.match(html, /diff since abc123/);
  });

  it('shows an active change without inventing a node state', () => {
    const t = target();
    t.p.changes = [];
    Object.assign(t.p, { activeChange: { name: 'review', docs: new Map(), impl: new Map() } });
    const { html } = renderOverview(t, [], 'nonce', 1);
    const section = html.slice(html.indexOf('<h2>Active change'), html.indexOf('<h2>Drift'));
    assert.match(section, /review\/change.md/);
    assert.match(section, /None/);
    assert.ok(!section.includes('No active change'));
  });

  it('renders empty sections without context actions for a node without code', () => {
    const t = target();
    t.doc = undefined;
    Object.assign(t.p.nodes.get(t.node)!, { deps: [], code: [] });
    t.p.hasCode = () => false;
    const { html, actions } = renderOverview(t, [], 'nonce', 1);
    for (const name of ['Upstream', 'Downstream', 'Code paths', 'Drift', 'Context']) {
      const start = html.indexOf(`<h2>${name}</h2>`);
      assert.match(html.slice(start, html.indexOf('</section>', start)), /None/);
    }
    assert.ok(!actions.some(a => a.command.startsWith('uspec.context.')));
  });

  it('keeps full long paths, state explanations and theme tokens', () => {
    const t = target();
    const longPath = `services/${'long-name-'.repeat(30)}/`;
    t.p.nodes.get(t.node)!.code = [longPath];
    t.p.drift.set(t.node, 'code changed <after> spec');
    Object.assign(t.p, { activeChange: { name: 'review', docs: new Map([['payments/logic.md', {
      document: 'payments/logic.md', path: 'docs/payments/logic.md', state: 'affected', reason: 'Update <eligibility>', via: [],
    }]]), impl: new Map([['payments', 'pending']]) } });
    const { html, actions } = renderOverview(t, [], 'nonce', 1);
    assert.ok(html.includes(longPath));
    assert.ok(actions.some(a => a.command === 'uspec.revealPath' && a.args[1] === longPath));
    assert.match(html, /title="Update &lt;eligibility&gt;">affected/);
    assert.match(html, /⚠ Drift: code changed &lt;after&gt; spec/);
    for (const token of ['--vscode-editor-background', '--vscode-editor-font-family', '--vscode-focusBorder', '--vscode-contrastBorder', '--vscode-list-warningForeground']) assert.ok(html.includes(token));
    assert.match(html, /overflow-wrap:anywhere/);
  });
});
