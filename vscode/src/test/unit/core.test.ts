import * as assert from 'assert';
import {
  agentPrompt,
  claudeArgs,
  describeEvent,
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
  triageInput,
  writerContextArgs,
  writerDocs,
} from '../../core/agents';
import { findToken, locateInFile, locateIssue } from '../../core/issues';
import { anchor, formatLink, headings, parseLink, sectionLine, sectionText } from '../../core/links';
import type { NextJson } from '../../core/model';
import { classifySpecPath, codeOwner, nodeKey, projectToSpec, specRootFromConfig, specToProject, splitDoc, toDocKey } from '../../core/paths';
import { isTemplateLeft, isUnwritten, leftoverGuidance, splitFrontmatter } from '../../core/templates';
import { listItems, yamlPosition } from '../../core/yaml';

describe('paths', () => {
  it('converts between spec and project paths', () => {
    assert.strictEqual(specToProject('docs', 'system/services'), 'docs/system/services');
    assert.strictEqual(specToProject('docs', ''), 'docs');
    assert.strictEqual(specToProject('', 'a/b.md'), 'a/b.md');
    assert.strictEqual(projectToSpec('docs', 'docs/a/b.md'), 'a/b.md');
    assert.strictEqual(projectToSpec('docs', 'docs'), '');
    assert.strictEqual(projectToSpec('docs', 'docsx/a'), undefined);
    assert.strictEqual(projectToSpec('docs', 'cli/src/main.rs'), undefined);
  });

  it('reads spec_root from config.yaml', () => {
    assert.strictEqual(specRootFromConfig('spec_root: docs\n'), 'docs');
    assert.strictEqual(specRootFromConfig('spec_root: spec/ # the tree\n'), 'spec');
    assert.strictEqual(specRootFromConfig('spec_root: .\n'), '');
    assert.strictEqual(specRootFromConfig(undefined), 'docs');
    assert.strictEqual(specRootFromConfig('other: x\n'), 'docs');
  });

  it('names nodes the CLI way', () => {
    assert.strictEqual(nodeKey('.'), '');
    assert.strictEqual(nodeKey('./system/'), 'system');
    assert.deepStrictEqual(splitDoc('overview.md'), { node: '', doc: 'overview' });
    assert.deepStrictEqual(splitDoc('system/services/payments/api.md'), { node: 'system/services/payments', doc: 'api' });
  });

  it('classifies files of the spec tree', () => {
    const nodes = new Set(['', 'system', 'system/payments']);
    const docs: Record<string, string[]> = { '': ['overview'], system: ['overview'], 'system/payments': ['api', 'logic'] };
    const c = (rel: string) => classifySpecPath(rel, (n) => nodes.has(n), (n, d) => docs[n]?.includes(d) ?? false);
    assert.deepStrictEqual(c('overview.md'), { kind: 'doc', node: '', doc: 'overview' });
    assert.deepStrictEqual(c('system/payments'), { kind: 'node', node: 'system/payments' });
    assert.deepStrictEqual(c('system/payments/node.yaml'), { kind: 'yaml', node: 'system/payments' });
    assert.deepStrictEqual(c('system/payments/api.md'), { kind: 'doc', node: 'system/payments', doc: 'api' });
    assert.deepStrictEqual(c('system/payments/api-extra/openapi.yaml'), { kind: 'extra', node: 'system/payments', doc: 'api' });
    assert.deepStrictEqual(c('system/payments/notes.txt'), { kind: 'other', node: 'system/payments' });
    assert.deepStrictEqual(c('system/payments/stray/x.md'), { kind: 'other', node: 'system/payments' });
  });

  it('finds the node that owns a code file by its longest code path', () => {
    const nodes = [
      { path: 'cli', code: ['cli/src/main.rs', 'cli/Cargo.toml'] },
      { path: 'cli/change', code: ['cli/src/change.rs'] },
      { path: 'services/payments', code: ['services/payments/'] },
      { path: 'services/payments/fraud', code: ['./services/payments/fraud'] },
    ];
    assert.strictEqual(codeOwner(nodes, 'cli/src/change.rs'), 'cli/change');
    assert.strictEqual(codeOwner(nodes, 'cli/src/main.rs'), 'cli');
    assert.strictEqual(codeOwner(nodes, 'services/payments/src/x.ts'), 'services/payments');
    assert.strictEqual(codeOwner(nodes, 'services/payments/fraud/rules.ts'), 'services/payments/fraud');
    assert.strictEqual(codeOwner(nodes, 'services/paymentsx/a.ts'), undefined);
  });

  it('reads document paths from agents', () => {
    assert.strictEqual(toDocKey('docs', '`docs/system/payments/api.md`'), 'system/payments/api.md');
    assert.strictEqual(toDocKey('docs', 'system/payments/api'), 'system/payments/api.md');
    assert.strictEqual(toDocKey('', './overview.md'), 'overview.md');
  });
});

describe('templates', () => {
  const template = '---\ndescription: |\n  The API.\nextra: true\n---\n\n# <Service> API\n\n<Style, base path, authentication.>\n\n## Endpoints\n';

  it('splits frontmatter like the CLI', () => {
    const { front, body } = splitFrontmatter(template);
    assert.ok(front?.includes('extra: true'));
    assert.strictEqual(body, '# <Service> API\n\n<Style, base path, authentication.>\n\n## Endpoints\n');
    assert.deepStrictEqual(splitFrontmatter('# No front\n'), { front: undefined, body: '# No front\n' });
  });

  it('knows unwritten documents', () => {
    const { body } = splitFrontmatter(template);
    assert.ok(isUnwritten('', body));
    assert.ok(isUnwritten(`\n${body}\n\n`, body));
    assert.ok(!isUnwritten('# Payments API\n', body));
  });

  it('finds guidance left from the template', () => {
    const { body } = splitFrontmatter(template);
    const doc = '# Payments API\n\n<Style, base path, authentication.>\n\nREST under /payments.\n';
    assert.deepStrictEqual(leftoverGuidance(doc, body), [2]);
  });
});

describe('yaml', () => {
  const lines = ['type: service', 'derives_from:', '  - product/checkout', '  - sys', 'code: [services/payments/, lib/]'];

  it('lists items, block and inline', () => {
    assert.deepStrictEqual(listItems(lines, 'derives_from'), ['product/checkout', 'sys']);
    assert.deepStrictEqual(listItems(lines, 'code'), ['services/payments/', 'lib/']);
    assert.deepStrictEqual(listItems(lines, 'missing'), []);
  });

  it('knows what the cursor is on', () => {
    assert.deepStrictEqual(yamlPosition(lines, 0, 4), { kind: 'key', prefix: 'type' });
    assert.deepStrictEqual(yamlPosition(lines, 0, 13), { kind: 'value', key: 'type', prefix: 'service' });
    assert.deepStrictEqual(yamlPosition(lines, 3, 7), { kind: 'item', key: 'derives_from', prefix: 'sys', existing: ['product/checkout', 'sys'] });
    const inline = yamlPosition(lines, 4, 31);
    assert.strictEqual(inline?.kind, 'item');
    assert.strictEqual(inline?.kind === 'item' && inline.key, 'code');
    assert.strictEqual(inline?.kind === 'item' && inline.prefix, 'lib/');
  });
});

describe('issues', () => {
  const files: Record<string, string> = {
    'docs/node.yaml': 'type: root\n',
    'docs/system/payments/node.yaml': 'type: service\nderives_from:\n  - product/ordering/cart\n  - system/domain\ncode:\n  - services/payments/\n',
    'docs/product/ordering/node.yaml': 'type: product-area\nderives_from:\n  - system/payments\n',
    '.uspec/node-types/screen/node-type.yaml': 'name: Screen\ndescription: x\nderives_from: [feature, services]\ndocuments:\n  - design\n',
  };
  const dirs = new Set(['docs', 'docs/system', 'docs/system/payments', 'docs/product/ordering', 'docs/system/payments/api-extra', 'docs/product/loose']);
  const ctx = { specRoot: 'docs', read: (r: string) => files[r], isDir: (r: string) => dirs.has(r) };

  it('puts a node error on the line it names', () => {
    const [at] = locateIssue({ path: 'docs/system/payments', message: 'links to product/ordering/cart of type `feature`, which isn\'t in `service`\'s derives_from' }, ctx);
    assert.deepStrictEqual(at, { file: 'docs/system/payments/node.yaml', line: 2, start: 4, end: 25, message: at.message });
  });

  it('puts a type error on the unknown id', () => {
    const [at] = locateIssue({ path: '.uspec/node-types/screen/node-type.yaml', message: '`derives_from` references unknown type `services`' }, ctx);
    assert.strictEqual(at.line, 2);
    assert.strictEqual(files[at.file].split('\n')[2].slice(at.start, at.end), 'services');
  });

  it('moves errors about folders to the enclosing node', () => {
    const [at] = locateIssue({ path: 'docs/system/payments/api-extra/', message: "document `api` doesn't allow extra files" }, ctx);
    assert.strictEqual(at.file, 'docs/system/payments/node.yaml');
    assert.ok(at.message.startsWith('api-extra/: '));
    const [loose] = locateIssue({ path: 'docs/product/loose', message: 'node has no node.yaml' }, ctx);
    assert.strictEqual(loose.file, 'docs/node.yaml');
    assert.strictEqual(loose.message, 'product/loose/: node has no node.yaml');
  });

  it('puts one error on each link of a cycle', () => {
    const at = locateIssue({ path: 'docs/', message: 'links form a cycle: product/ordering → system/payments → product/ordering' }, ctx);
    assert.deepStrictEqual(
      at.map((a) => [a.file, a.line]),
      [
        ['docs/product/ordering/node.yaml', 2],
        ['docs/system/payments/node.yaml', 2],
      ],
    );
  });

  it('reads YAML error positions', () => {
    assert.deepStrictEqual(locateInFile('a: b\nc: [d\n', 'invalid YAML: did not find expected node at line 2 column 4'), { line: 1, start: 3, end: 5 });
  });

  it('matches whole tokens only', () => {
    assert.strictEqual(findToken('derives_from:\n  - system/domain-model\n  - system/domain\n', 'system/domain')?.line, 2);
  });
});

describe('links', () => {
  it('parses links to a node, a document or a section', () => {
    assert.deepStrictEqual(parseLink('product/support/refunds/'), { raw: 'product/support/refunds', node: 'product/support/refunds' });
    assert.deepStrictEqual(parseLink('product/support/refunds/rules.md#refund-window'), {
      raw: 'product/support/refunds/rules.md#refund-window',
      node: 'product/support/refunds',
      doc: 'rules',
      section: 'refund-window',
    });
    assert.deepStrictEqual(parseLink('overview.md'), { raw: 'overview.md', node: '', doc: 'overview', section: undefined });
    assert.strictEqual(parseLink('product/support/refunds#window'), undefined);
    assert.strictEqual(parseLink('a/rules.md#'), undefined);
    assert.strictEqual(formatLink('a/b', 'rules', 'x'), 'a/b/rules.md#x');
    assert.strictEqual(formatLink('', undefined), '.');
  });

  it('finds sections by their anchors, as the CLI does', () => {
    assert.strictEqual(anchor('Refund window'), 'refund-window');
    assert.strictEqual(anchor('  POST /refunds: errors (v2)! '), 'post-refunds-errors-v2');
    const doc = '# Refunds\n\n## Refund window\n\n14 days.\n\n### Exceptions\n\nNone.\n\n## Payout ##\n\n```\n## Not a heading\n```\n#hashtag\n';
    assert.deepStrictEqual(
      headings(doc).map((h) => [h.level, h.anchor, h.line]),
      [
        [1, 'refunds', 0],
        [2, 'refund-window', 2],
        [3, 'exceptions', 6],
        [2, 'payout', 10],
      ],
    );
    assert.strictEqual(sectionLine(doc, 'payout'), 10);
    assert.strictEqual(sectionText(doc, 'refund-window'), '## Refund window\n\n14 days.\n\n### Exceptions\n\nNone.');
    assert.strictEqual(sectionText(doc, 'nope'), undefined);
  });

  it('keeps a section in a YAML list item, and drops a comment', () => {
    const lines = ['derives_from:', '  - product/support/refunds/rules.md#refund-window', '  - system/services/customer-bff   # API-first', 'code:'];
    assert.deepStrictEqual(listItems(lines, 'derives_from'), ['product/support/refunds/rules.md#refund-window', 'system/services/customer-bff']);
  });
});

describe('agents', () => {
  const next: NextJson = {
    change: 'refund-window',
    baseline: '4f2c9e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    triage: {
      read: [
        { path: '.uspec/changes/refund-window/change.md' },
        { path: 'docs/product/support/refunds/rules.md', document: 'product/support/refunds/rules.md', diff_since: '4f2c9e1aaaaaaaa' },
      ],
      batch: [
        { document: 'system/services/payments/api.md', path: 'docs/system/services/payments/api.md', via: ['links to product/support/refunds'] },
        { document: 'system/services/payments/events.md', path: 'docs/system/services/payments/events.md', via: ['links to product/support/refunds', 'derives from logic.md'] },
      ],
    },
    write: [],
    impact: null,
    plan: null,
    plan_errors: [],
    implement: [],
  };

  it('prints the triage batch as `change next` does', () => {
    assert.strictEqual(
      triageInput(next),
      [
        'triage:',
        '  read:',
        '    .uspec/changes/refund-window/change.md',
        '    docs/product/support/refunds/rules.md   diff since 4f2c9e1',
        '  batch:',
        '    docs/system/services/payments/api.md      links to product/support/refunds',
        '    docs/system/services/payments/events.md   links to product/support/refunds; derives from logic.md',
        '',
      ].join('\n'),
    );
  });

  it('builds the prompt and arguments', () => {
    assert.strictEqual(agentPrompt('You are a writer.\n', 'context\n', 'Mode: check'), 'You are a writer.\n\nMode: check\n\ncontext\n');
    const perms = permissions('writer', { documents: ['docs/a/api.md', 'docs/a/logic.md'], extraDirs: ['docs/a/api-extra'] });
    assert.ok(perms.allowed.includes('Edit(docs/a/api.md)'));
    assert.ok(perms.allowed.includes('Edit(docs/a/logic.md)'));
    assert.ok(perms.allowed.includes('Write(docs/a/api-extra/**)'));
    const impl = permissions('implementer', { codePaths: [{ path: 'services/payments', dir: true }, { path: 'cli/src/main.rs', dir: false }], implementerAllowed: ['Bash'] });
    assert.ok(impl.allowed.includes('Edit(services/payments/**)'));
    assert.ok(impl.allowed.includes('Edit(cli/src/main.rs)'));
    assert.ok(impl.allowed.includes('Bash'));
    assert.ok(!permissions('triage').tools.includes('Edit'));
    const args = claudeArgs(perms, { model: 'opus', name: 'uspec writer' });
    assert.deepStrictEqual(args.slice(0, 3), ['--strict-mcp-config', '--permission-mode', 'auto']);
    assert.ok(!args.includes('-p'), 'runs in the interactive TUI');
    assert.strictEqual(args[args.indexOf('--model') + 1], 'opus');
    assert.strictEqual(args[args.length - perms.allowed.length - 1], '--allowedTools');
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /You may edit only: docs\/a\/api\.md, docs\/a\/logic\.md, docs\/a\/api-extra\/\*\*\./);
    assert.ok(!claudeArgs(perms).includes('--model'));
  });

  it('runs triage on the triage model and the others on the agents model', () => {
    const settings = { model: '', triageModel: 'sonnet' };
    assert.strictEqual(modelFor('triage', settings), 'sonnet');
    assert.strictEqual(modelFor('writer', settings), undefined);
    assert.strictEqual(modelFor('implementer', settings), undefined);
    assert.strictEqual(modelFor('reviewer', settings), undefined);
    assert.strictEqual(modelFor('writer', { model: 'opus', triageModel: 'sonnet' }), 'opus');
    assert.strictEqual(modelFor('triage', { model: 'opus', triageModel: '' }), undefined);
  });

  it('gives one writer per node all its documents to write', () => {
    const write: NextJson = {
      ...next,
      triage: null,
      write: [
        {
          node: 'system/services/payments',
          documents: [
            { document: 'system/services/payments/api.md', path: 'docs/system/services/payments/api.md' },
            { document: 'system/services/payments/compliance.md', path: 'docs/system/services/payments/compliance.md' },
          ],
        },
        { node: '.', documents: [{ document: 'overview.md', path: 'docs/overview.md' }] },
      ],
    };
    // Run writer on a document runs its node's writer, with the node's other documents under `write`.
    assert.deepStrictEqual(writerDocs(write, 'system/services/payments/compliance.md'), {
      node: 'system/services/payments',
      documents: ['system/services/payments/api.md', 'system/services/payments/compliance.md'],
      ready: true,
    });
    assert.deepStrictEqual(writerDocs(write, 'system/services/payments/logic.md'), {
      node: 'system/services/payments',
      documents: ['system/services/payments/logic.md', 'system/services/payments/api.md', 'system/services/payments/compliance.md'],
      ready: false,
    });
    assert.deepStrictEqual(writerDocs(write, 'overview.md'), { node: '', documents: ['overview.md'], ready: true });
    assert.deepStrictEqual(writerDocs(write, 'system/overview.md'), { node: 'system', documents: ['system/overview.md'], ready: false });
    assert.deepStrictEqual(writerContextArgs('system/services/payments', ['system/services/payments/api.md', 'system/services/payments/compliance.md'], 'c'), [
      'context',
      'system/services/payments',
      '--document',
      'api',
      '--document',
      'compliance',
      '--change',
      'c',
    ]);
    assert.deepStrictEqual(writerContextArgs('', ['overview.md'], 'c'), ['context', '.', '--document', 'overview', '--change', 'c']);
  });

  it('reads triage results', () => {
    const text = [
      'Here are my decisions:',
      '```',
      'docs/system/services/payments/api.md | no-change | POST /refunds takes an order id; the window isn\'t part of the contract',
      '`system/services/payments/events.md` | affected | RefundExpired fires after 14 days | per the rules',
      'docs/other.md | affected | not in the batch',
      '',
      'Notes:',
      '- events.md may need a link to the glossary',
      '```',
    ].join('\n');
    const r = parseTriage(text, ['system/services/payments/api.md', 'system/services/payments/events.md'], 'docs');
    assert.deepStrictEqual(
      r.decisions.map((d) => [d.document, d.state]),
      [
        ['system/services/payments/api.md', 'no-change'],
        ['system/services/payments/events.md', 'affected'],
      ],
    );
    assert.strictEqual(r.decisions[1].reason, 'RefundExpired fires after 14 days | per the rules');
    assert.deepStrictEqual(r.unknown, ['other.md']);
    assert.strictEqual(r.notes, '- events.md may need a link to the glossary');
    assert.strictEqual(parseTriage('a.md | affected | x\n\nNotes:\n- none', ['a.md'], '').notes, '');
  });

  it('reads writer results, one per document', () => {
    const one = (text: string) => {
      const r = parseWriter(text, ['a/logic.md'], 'docs');
      return { result: r.results.get('a/logic.md'), notes: r.notes };
    };
    // One document: its path may be left out.
    assert.deepStrictEqual(one('updated\nThe window is 30 days.\nuser-visible: yes'), {
      result: { kind: 'updated', summary: 'The window is 30 days.', userVisible: true },
      notes: '',
    });
    assert.deepStrictEqual(one('Done.\n\n```\nupdated\nRenamed a state.\nuser-visible: no\n```\n\n- A link may be missing.'), {
      result: { kind: 'updated', summary: 'Renamed a state.', userVisible: false },
      notes: '- A link may be missing.',
    });
    assert.deepStrictEqual(one('docs/a/logic.md\n**no change**\nThe document never mentions the window.').result, { kind: 'no-change', reason: 'The document never mentions the window.' });
    assert.deepStrictEqual(one('blocked\napi.md must return the window first.').result, { kind: 'blocked', reason: 'api.md must return the window first.' });
    assert.strictEqual(one('I could not decide.').result, undefined);
    assert.strictEqual((one('updated\nSomething.').result as { userVisible: boolean }).userVisible, true);

    // Several documents: each result starts with its path, in the order given, and is read on its own.
    const docs = ['a/api.md', 'a/logic.md', 'a/events.md'];
    const text = [
      'Here are my results.',
      '```',
      'docs/a/api.md',
      'no change',
      'The API never mentions the window.',
      '',
      '`docs/a/logic.md`',
      'updated',
      'The window is 30 days.',
      'user-visible: yes',
      '',
      '### docs/a/events.md:',
      'blocked',
      'docs/b/rules.md must say when a refund expires.',
      '```',
      '',
      'A link to b/glossary may be missing.',
    ].join('\n');
    const r = parseWriter(text, docs, 'docs');
    assert.deepStrictEqual(Object.fromEntries(r.results), {
      'a/api.md': { kind: 'no-change', reason: 'The API never mentions the window.' },
      'a/logic.md': { kind: 'updated', summary: 'The window is 30 days.', userVisible: true },
      'a/events.md': { kind: 'blocked', reason: 'docs/b/rules.md must say when a refund expires.' },
    });
    assert.strictEqual(r.notes, 'A link to b/glossary may be missing.');

    // A document left without a result gets none; a path outside the run isn't a result.
    const partial = parseWriter('docs/a/logic.md\nupdated\nX.\nuser-visible: no\n\ndocs/z/other.md\nno change\nY.', docs, 'docs');
    assert.deepStrictEqual([...partial.results.keys()], ['a/logic.md']);
    // Without paths, several documents can't be told apart.
    assert.strictEqual(parseWriter('updated\nX.\nuser-visible: no', docs, 'docs').results.size, 0);
  });

  it('reads implementer and reviewer results', () => {
    assert.deepStrictEqual(parseImplementer('done\nChanged: a.ts\nVerified: npm test'), { kind: 'done', detail: 'Changed: a.ts\nVerified: npm test' });
    assert.deepStrictEqual(parseImplementer('gap\nNode: x\nMissing: y'), { kind: 'gap', detail: 'Node: x\nMissing: y' });
    assert.strictEqual(parseImplementer('All good').kind, 'invalid');
    assert.deepStrictEqual(parseReview('No findings.'), { findings: 0 });
    assert.deepStrictEqual(parseReview('contradiction\nWhere: a\n\ngap\nWhere: b'), { findings: 2 });
  });

  it('builds the inputs of impact, planner and implementer', () => {
    assert.strictEqual(impactInput('.uspec/changes/c/change.md', 'docs/  root\n'), 'Change: .uspec/changes/c/change.md\n\ndocs/  root\n');
    const contexts = [
      { node: 'system/services/payments', context: '# Instructions\n\nService type.\n' },
      { node: 'experience/ops-console/refunds', context: '# Instructions\n\nScreen type.\n' },
    ];
    assert.strictEqual(
      plannerInput({ changeMd: 'c.md', dir: 'plans/', nodes: contexts.map((c) => c.node), existing: [], contexts }),
      'Change: c.md\n\nPlans: plans/\n\nNodes to plan:\nsystem/services/payments\nexperience/ops-console/refunds\n\nExisting plans:\nnone\n\n' +
        '## system/services/payments\n\n# Instructions\n\nService type.\n\n## experience/ops-console/refunds\n\n# Instructions\n\nScreen type.\n',
    );
    assert.match(implementerInput('plans/payments.md', contexts.slice(0, 1)), /^Plan: plans\/payments\.md\n\n## system\/services\/payments\n\n# Instructions/);
    const planner = permissions('planner', { plansDir: '.uspec/changes/c/plans/' });
    assert.ok(planner.allowed.includes('Write(.uspec/changes/c/plans/**)'));
    assert.ok(!planner.allowed.some((a) => a.startsWith('Edit(docs')));
    assert.ok(!permissions('impact').tools.includes('Edit'));
    assert.strictEqual(modelFor('impact', { model: 'opus', triageModel: 'sonnet' }), 'opus');
  });

  it('reads impact results', () => {
    const exists = (k: string) => ['product/support/refunds/rules.md', 'experience/ops-console/refunds/states.md'].includes(k);
    const r = parseImpact(
      [
        'Starting documents:',
        '```',
        'docs/product/support/refunds/rules.md | The Refund window section says 14 days | change.md makes it 30',
        '- `experience/ops-console/refunds/states.md` | The Expired state names the 14-day window',
        'docs/product/support/refunds/rules.md | twice',
        'docs/nowhere.md | not in the tree',
        '',
        'Notes:',
        '- A node for disputes may be missing.',
        '```',
      ].join('\n'),
      exists,
      'docs',
    );
    assert.deepStrictEqual(r.documents, [
      { document: 'product/support/refunds/rules.md', reason: 'The Refund window section says 14 days | change.md makes it 30' },
      { document: 'experience/ops-console/refunds/states.md', reason: 'The Expired state names the 14-day window' },
    ]);
    assert.deepStrictEqual(r.unknown, ['nowhere.md']);
    assert.strictEqual(r.notes, '- A node for disputes may be missing.');
  });

  it('reads planner results', () => {
    assert.deepStrictEqual(parsePlanner('I wrote two plans.\n\nplanned\npayments | system/services/payments | after: none\nscreens | experience/ops-console/refunds | after: payments'), {
      kind: 'planned',
      plans: ['payments', 'screens'],
    });
    assert.deepStrictEqual(parsePlanner('failed\nThe refunds screen has no state for a pending review.'), { kind: 'failed', detail: 'The refunds screen has no state for a pending review.' });
    assert.deepStrictEqual(parsePlanner('Here you go.'), { kind: 'invalid' });
  });

  it('knows a change.md that is still the template', () => {
    const template = '# <Title: the change in a few words>\n\n## Why\n\n<The problem, and who has it.>\n';
    assert.ok(isTemplateLeft(template));
    assert.ok(isTemplateLeft(''));
    assert.ok(!isTemplateLeft('# Refund window: 30 days\n\n## Why\n\nCustomers miss the window.\n'));
  });

  it('knows experiments', () => {
    assert.ok(fromExperiment('---\nmode: check\n---\n# Refunds'));
    assert.ok(fromExperiment('---\r\nmode: "check" # existing code\r\n---\r\n# Refunds'));
    for (const text of ['This is not an experiment.', 'Experiments are out of scope.', 'Comes from an experiment on branch x.', 'mode: check', '---\nmode: implement\n---\nExperiment']) {
      assert.ok(!fromExperiment(text), text);
    }
    assert.ok(!fromExperiment('# Refunds\n\nThe window grows.'));
  });

  it('describes stream events for the log', () => {
    assert.deepStrictEqual(describeEvent({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', permissionMode: 'default' }), ['session s1 · m · default']);
    assert.deepStrictEqual(
      describeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'docs/a.md' } }] } }),
      ['Reading.', '→ Read docs/a.md'],
    );
    assert.deepStrictEqual(describeEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Permission denied\nmore' }] } }), ['  ✗ Permission denied']);
    assert.deepStrictEqual(describeEvent({ type: 'rate_limit_event' }), []);
    const result = describeEvent({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.1234, duration_ms: 65000, permission_denials: [{ tool_name: 'Edit', tool_input: { file_path: 'x.md' } }] });
    assert.deepStrictEqual(result, ['— success · 3 turns · $0.12 · 1m 05s', '  denied: Edit x.md']);
  });
});
