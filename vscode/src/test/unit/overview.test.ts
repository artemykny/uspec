import * as assert from 'assert';
import { renderOverview } from '../../views/nodeOverview';
import type { NodeTarget } from '../../views/nodeView';
import { CONTEXT_GROUPS, type ContextJson } from '../../core/model';

function target(): NodeTarget {
  const node = { type: 'service', documents: ['logic'], deps: [
    { node: 'refunds', doc: 'rules', section: 'refund-window' }, { node: 'api', doc: 'contract' }, { node: 'platform' },
  ], code: ['services/payments/'] };
  const p = {
    root: '/project', rootLabel: 'docs', nodes: new Map<string, any>([['payments', node], ['ops', { documents: [], deps: [{ node: 'payments', doc: 'logic', section: 'x' }], code: [] }]]),
    typeOf: () => ({ name: 'Service', type: 'service', code: true, path: '.uspec/node-types/service/node-type.yaml', description: '<script>unsafe</script>' }),
    typeDoc: () => ({ description: 'Business rules', required: true, exposed: false, extra: false, derives_from: ['api#errors'], template: '.uspec/node-types/service/logic.md' }),
    nodeDir: (n: string) => `docs/${n}`, docFile: (key: string) => `docs/${key}`, hasCode: () => true,
    downstream: new Map([['payments', ['ops']]]), drift: new Map(), nodeIssues: () => [], activeChange: undefined,
  };
  return { p, node: 'payments', doc: 'logic' } as unknown as NodeTarget;
}
const sectionOf = (html: string, name: string) => {
  const start = html.indexOf(`>${name}</h2>`);
  return html.slice(start, html.indexOf('</section>', start));
};
const context = (files: ContextJson['files'], baseline: string | null = null): ContextJson =>
  ({ node: 'payments', type: 'service', documents: [], instructions: { type: 'Service', text: null }, baseline, files });

describe('node overview presentation', () => {
  it('orders sections from the header down, without Documents or Problems sections', () => {
    const { html } = renderOverview(target(), 'document', undefined, 'nonce', 7);
    let last = html.indexOf('<h1>payments</h1>');
    assert.ok(last >= 0);
    for (const text of ['&lt;script&gt;unsafe', 'Business rules', '>Upstream</h2>', '>Downstream</h2>', '>Code paths</h2>', '>Active change</h2>', '>Drift</h2>', '>Context</h2>']) {
      const at = html.indexOf(text);
      assert.ok(at > last, text); last = at;
    }
    assert.ok(html.indexOf('>About</h2>') < html.indexOf('Business rules'));
    assert.ok(!html.includes('>Documents</h2>') && !html.includes('>Problems</h2>'));
    assert.ok(!html.includes('<script>unsafe'));
    assert.match(html, /default-src 'none'/);
    assert.match(html, /generation:7/);
  });

  it('words template flags as uspec types does and labels the type with its id', () => {
    const t = target();
    t.p.typeDoc = (() => ({ description: 'Business rules', required: true, exposed: false, extra: true, derives_from: ['api#errors'], template: 'x.md' })) as any;
    const { html } = renderOverview(t, 'document', undefined, 'nonce', 1);
    const about = sectionOf(html, 'About');
    for (const word of ['>required<', '>internal<', '>extra<', '>derives from api#errors<']) assert.ok(about.includes(word), word);
    assert.match(html, /<header>.*title="service">Service</s);
  });

  it('links upstream sections, documents and nodes, and downstream overviews', () => {
    const { html, actions } = renderOverview(target(), 'document', undefined, 'nonce', 1);
    assert.ok(actions.some(a => a.command === 'uspec.openSection' && a.args[1] === 'docs/refunds/rules.md' && a.args[2] === 'refund-window'));
    assert.ok(actions.some(a => a.command === 'uspec.openSection' && a.args[1] === 'docs/api/contract.md' && a.args.length === 2));
    assert.ok(actions.some(a => a.command === 'uspec.showOverview' && a.args[1] === 'platform'));
    const down = sectionOf(html, 'Downstream');
    assert.ok(down.includes('logic.md') && down.includes('#x'));
    assert.ok(actions.some(a => a.command === 'uspec.showOverview' && a.args[1] === 'ops'));
  });

  it('reveals code paths and says No code for a type without code', () => {
    const t = target();
    assert.ok(renderOverview(t, 'document', undefined, 'nonce', 1).actions.some(a => a.command === 'uspec.revealPath' && a.args[1] === 'services/payments/'));
    t.p.hasCode = () => false;
    assert.match(sectionOf(renderOverview(t, 'document', undefined, 'nonce', 1).html, 'Code paths'), /No code/);
  });

  it('shows the active change state of the node', () => {
    const t = target();
    assert.match(sectionOf(renderOverview(t, 'document', undefined, 'nonce', 1).html, 'Active change'), /No active change/);
    Object.assign(t.p, { activeChange: { name: 'review', docs: new Map(), impl: new Map() } });
    let section = sectionOf(renderOverview(t, 'document', undefined, 'nonce', 1).html, 'Active change');
    assert.match(section, />review</);
    assert.match(section, /Not in this change/);
    assert.ok(!section.includes('No active change'));
    Object.assign(t.p, { activeChange: { name: 'review', docs: new Map([['payments/logic.md', {
      document: 'payments/logic.md', path: 'docs/payments/logic.md', state: 'affected', reason: 'Update <eligibility>', via: [],
    }]]), impl: new Map([['payments', 'pending']]) } });
    section = sectionOf(renderOverview(t, 'document', undefined, 'nonce', 1).html, 'Active change');
    assert.match(section, /title="[^"]*Update &lt;eligibility&gt;">affected</);
    assert.match(section, /Implementation.*>pending</s);
    assert.ok(!section.includes('Not in this change'));
    Object.assign(t.p, { activeChange: { name: 'review', docs: new Map([['payments/logic.md', {
      document: 'payments/logic.md', path: 'docs/payments/logic.md', state: 'pending', reason: null, via: ['links to refunds/rules.md'],
    }]]), impl: new Map() } });
    assert.match(sectionOf(renderOverview(t, 'document', undefined, 'nonce', 1).html, 'Active change'), /via links to refunds\/rules.md/);
  });

  it('escapes the drift reason and says None without drift', () => {
    const t = target();
    assert.match(sectionOf(renderOverview(t, 'document', undefined, 'nonce', 1).html, 'Drift'), /None/);
    t.p.drift.set(t.node, 'code changed <after> spec');
    assert.match(sectionOf(renderOverview(t, 'document', undefined, 'nonce', 1).html, 'Drift'), /⚠ drift<\/span> code changed &lt;after&gt; spec/);
  });

  it('switches context modes and binds copy actions to the selected one', () => {
    const t = target();
    const both = renderOverview(t, 'implement', undefined, 'nonce', 1);
    const ctx = sectionOf(both.html, 'Context');
    assert.match(ctx, /data-mode="document" aria-pressed="false"[^>]*>Write</);
    assert.match(ctx, /data-mode="implement" aria-pressed="true"[^>]*>Implement</);
    assert.match(ctx, /role="status">Loading context/);
    const copies = both.actions.filter(a => a.command.startsWith('uspec.context.'));
    assert.deepStrictEqual(copies.map(a => a.command), ['uspec.context.copy', 'uspec.context.copyWithContents']);
    assert.ok(copies.every(a => (a.args[0] as any).mode === 'implement' && (a.args[0] as any).target.node === t.node));
    t.doc = undefined;
    const single = renderOverview(t, 'implement', undefined, 'nonce', 1);
    assert.ok(!single.html.includes('data-mode='));
    assert.match(sectionOf(single.html, 'Context'), />Implement</);
    t.p.hasCode = () => false;
    const none = renderOverview(t, undefined, undefined, 'nonce', 1);
    assert.match(sectionOf(none.html, 'Context'), /Open one of its documents to see the context of writing it/);
    assert.ok(!none.actions.some(a => a.command.startsWith('uspec.context.')));
  });

  it('renders context groups in CLI order, errors and baseline diffs', () => {
    const files = Object.fromEntries([...CONTEXT_GROUPS].reverse().map(g => [g, [{ path: `docs/${g}.md`, section: null, note: null }]])) as ContextJson['files'];
    files.change = [{ path: 'docs/refunds/rules.md', section: 'refund-window', note: 'diff since abc123' }];
    const { html, actions } = renderOverview(target(), 'document', { mode: 'document', value: context(files, 'abc123') }, 'nonce', 1);
    let last = html.indexOf('Instructions · Service');
    assert.ok(last >= 0);
    for (const g of CONTEXT_GROUPS) { const at = html.indexOf(`<h3>${g}</h3>`); assert.ok(at > last, g); last = at; }
    assert.deepStrictEqual(actions.find(a => a.command === 'uspec.diffFile')?.args, ['/project', 'docs/refunds/rules.md', 'abc123']);
    assert.match(html, /diff since abc123/);
    const failed = renderOverview(target(), 'document', { mode: 'document', error: 'CLI <failure>' }, 'nonce', 1);
    assert.match(failed.html, /role="alert">⚠ CLI &lt;failure&gt;/);
  });

  it('counts validation errors with a Problems panel action', () => {
    const t = target();
    t.p.nodeIssues = (() => [{ path: 'docs/payments', message: 'a' }, { path: 'docs/payments', message: 'b' }]) as any;
    const { html, actions } = renderOverview(t, 'document', undefined, 'nonce', 1);
    assert.match(html, />2 problems</);
    assert.ok(actions.some(a => a.command === 'workbench.actions.view.problems'));
  });

  it('says None for empty sections', () => {
    const t = target();
    Object.assign(t.p.nodes.get(t.node)!, { deps: [], code: [] });
    t.p.downstream.clear();
    const { html } = renderOverview(t, 'document', undefined, 'nonce', 1);
    for (const name of ['Upstream', 'Downstream', 'Code paths', 'Drift']) assert.match(sectionOf(html, name), /None/, name);
  });

  it('keeps full long paths, accessibility and theme tokens', () => {
    const t = target();
    const longPath = `services/${'long-name-'.repeat(30)}/`;
    t.p.nodes.get(t.node)!.code = [longPath];
    const { html, actions } = renderOverview(t, 'document', undefined, 'nonce', 1);
    assert.match(html, new RegExp(`title="${longPath}"`));
    assert.ok(actions.some(a => a.command === 'uspec.revealPath' && a.args[1] === longPath));
    assert.match(html, /text-overflow:ellipsis/);
    assert.match(html, /:focus-visible/);
    assert.match(html, /@media\(max-width:600px\)/);
    for (const token of ['--vscode-editor-background', '--vscode-editor-font-family', '--vscode-panel-border', '--vscode-focusBorder', '--vscode-contrastBorder']) assert.ok(html.includes(token), token);
  });
});
