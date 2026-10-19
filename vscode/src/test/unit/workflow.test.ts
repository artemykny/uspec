import * as assert from 'assert';
import { fileProposal, readFileProposal, readSplit, inlineDiff } from '../../core/workflow';
import { permissions } from '../../core/agents';

describe('review artifacts', () => {
  it('round-trips decisions and comments as Markdown and rejects incomplete triage', () => {
    const files = [
      { document: 'cli/usage.md', state: 'affected' as const, reason: 'New flag', comment: 'Keep the old flag too' },
      { document: 'cli/rules.md', state: 'no-change' as const, reason: 'No rule changes', comment: '' },
    ];
    const text = fileProposal('Triage review', files);
    assert.deepStrictEqual(readFileProposal(text, files.map(d => d.document), true), files);
    assert.throws(() => readFileProposal(text, ['cli/usage.md'], true), /Unknown/);
    assert.throws(() => readFileProposal(fileProposal('Review', files.slice(0, 1)), files.map(d => d.document), true), /Every candidate/);
    assert.throws(() => readFileProposal(text.replace('affected', 'approved'), files.map(d => d.document)), /Invalid decision/);
  });

  it('validates plan ownership, safe paths and dependencies before generating anything', () => {
    const text = '# Split plans\n\n## Plans\n\n### plans/cli.md\n- Nodes: cli\n- After:\n\n### plans/vscode.md\n- Nodes: vscode\n- After: cli\n';
    assert.deepStrictEqual(readSplit(text, ['cli', 'vscode']).map(p => p.path), ['plans/cli.md', 'plans/vscode.md']);
    assert.throws(() => readSplit(text.replace('Nodes: vscode', 'Nodes: cli'), ['cli', 'vscode']), /exactly one/);
    assert.throws(() => readSplit(text.replace('After:\n', 'After: vscode\n'), ['cli', 'vscode']), /cycle/);
    assert.throws(() => readSplit(text.replace('After: cli', 'After: unknown'), ['cli', 'vscode']), /Unknown/);
    assert.throws(() => readSplit(text.replace('plans/cli.md', '../cli.md'), ['cli', 'vscode']), /Invalid/);
    assert.throws(() => readSplit(text, ['cli', 'vscode'], [{ plan: 'cli', after: [] }]), /existing/);
  });

  it('restricts a planner to its assigned file and keeps splitting read-only', () => {
    const perms = permissions('planner', { planFile: '.uspec/changes/c/plans/cli.md' });
    assert.ok(perms.allowed.includes('Write(.uspec/changes/c/plans/cli.md)'));
    assert.ok(!perms.allowed.some(p => p.includes('**')));
    assert.ok(!permissions('splitter').tools.includes('Write'));
  });

  it('renders additions and deletions and handles unchanged/empty files', () => {
    assert.deepStrictEqual(inlineDiff('same', 'same'), []);
    const diff = inlineDiff('a\nold\nc', 'a\nnew\nc');
    assert.deepStrictEqual(diff.map(d => [d.kind, d.text]), [['same', 'a'], ['remove', 'old'], ['add', 'new'], ['same', 'c']]);
    assert.ok(inlineDiff('', 'new').some(d => d.kind === 'add' && d.text === 'new'));
  });
});
