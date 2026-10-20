import * as assert from 'assert';
import { autoSplit, parseSessions, resolveSession, sharedSession, splitterOff } from '../../core/sessions';
import { readSplit } from '../../core/workflow';

const fallback = 'Agents run in new sessions until this is fixed.';

describe('agent sessions', () => {
  it('resolves the presets per role', () => {
    const isolated = parseSessions('isolated');
    assert.deepStrictEqual(isolated, { config: {}, problems: [] });
    assert.strictEqual(resolveSession(isolated.config, 'writer', { node: 'cli' }), undefined);
    // The default, as VS Code gives it when nothing is set.
    assert.deepStrictEqual(parseSessions(undefined), { config: {}, problems: [] });

    const simple = parseSessions('simple');
    assert.deepStrictEqual(simple.problems, []);
    for (const role of ['impact', 'triage', 'writer', 'planner', 'implementer']) {
      assert.deepStrictEqual(resolveSession(simple.config, role, { round: 3, node: 'cli', plan: 'tree-columns' }), { name: 'explore' }, role);
    }
    assert.ok(splitterOff(simple.config));
    assert.strictEqual(resolveSession(simple.config, 'splitter'), undefined);

    const complex = parseSessions('complex');
    assert.deepStrictEqual(complex.problems, []);
    assert.ok(!splitterOff(complex.config));
    assert.deepStrictEqual(resolveSession(complex.config, 'impact'), { name: 'explore' });
    assert.deepStrictEqual(resolveSession(complex.config, 'triage', { round: 2 }), { name: 'spec' });
    assert.deepStrictEqual(resolveSession(complex.config, 'writer', { round: 2, node: 'vscode' }), { name: 'spec' });
    assert.deepStrictEqual(resolveSession(complex.config, 'splitter'), { name: 'build' });
    assert.deepStrictEqual(resolveSession(complex.config, 'planner', { plan: 'cli' }), { name: 'plan-cli', from: 'build' });
    assert.deepStrictEqual(resolveSession(complex.config, 'implementer', { plan: 'cli' }), { name: 'plan-cli' });
    // The reviewer is never named.
    assert.strictEqual(resolveSession(complex.config, 'reviewer'), undefined);
  });

  it('takes a map as the whole configuration', () => {
    const { config, problems } = parseSessions({ impact: 'explore', triage: 'triage', planner: 'plan-{plan}', implementer: 'plan-{plan}' });
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(resolveSession(config, 'triage', { round: 3 }), { name: 'triage' });
    // Roles left out get a new session per job: no merging with a preset.
    assert.strictEqual(resolveSession(config, 'writer', { node: 'cli', round: 2 }), undefined);
    assert.strictEqual(resolveSession(config, 'splitter'), undefined);
    assert.ok(!splitterOff(config));
    assert.deepStrictEqual(resolveSession(config, 'implementer', { plan: 'vscode' }), { name: 'plan-vscode' });
  });

  it('fills in the placeholders', () => {
    const { config, problems } = parseSessions({ triage: 'triage-{round}', writer: 'w-{round}-{node}', planner: 'p-{plan}', implementer: 'i-{plan}' });
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(resolveSession(config, 'triage', { round: 2 }), { name: 'triage-2' });
    assert.deepStrictEqual(resolveSession(config, 'writer', { round: 1, node: 'cli/tree' }), { name: 'w-1-cli/tree' });
    // Before any triage run, writers are in round 1.
    assert.deepStrictEqual(resolveSession(config, 'writer', { node: 'cli' }), { name: 'w-1-cli' });
    assert.deepStrictEqual(resolveSession(config, 'planner', { plan: 'cli' }), { name: 'p-cli' });
    assert.deepStrictEqual(resolveSession(config, 'implementer', { plan: 'cli' }), { name: 'i-cli' });
  });

  it('reports each problem and falls back to isolated', () => {
    const check = (value: unknown, what: string) => {
      const { config, problems } = parseSessions(value);
      assert.deepStrictEqual(config, {}, JSON.stringify(value));
      assert.ok(problems.some((p) => p.includes(what) && p.startsWith('uspec.agents.sessions: ') && p.endsWith(fallback)), `${JSON.stringify(value)}: ${problems.join(' | ')}`);
    };
    assert.deepStrictEqual(parseSessions({ triage: 't-{plan}' }).problems, [
      'uspec.agents.sessions: `{plan}` can\'t be used by triage. Agents run in new sessions until this is fixed.',
    ]);
    check({ triage: 't-{plan}' }, '`{plan}` can\'t be used by triage');
    check({ impact: 'i-{round}' }, '`{round}` can\'t be used by impact');
    check({ implementer: 'i-{node}' }, '`{node}` can\'t be used by implementer');
    check({ writer: 'off' }, '`off` can\'t be used by writer');
    check({ planner: 'p from nowhere' }, 'planner forks from `nowhere`, which no earlier stage uses');
    // A later stage's session isn't there to fork when the job starts.
    check({ triage: 'spec from build', splitter: 'build' }, 'triage forks from `build`, which no earlier stage uses');
    // Only a plain name can be forked.
    check({ triage: 't-{round}', planner: 'p from t-{round}' }, 'planner forks from `t-{round}`');
    check({ splitter: 'off', planner: 'plan-{plan} from build' }, 'planner forks from `build`, but the splitter is `off`');
    check({ reviewer: 'r' }, '`reviewer` can\'t be named');
    check({ judge: 'j' }, '`judge` isn\'t a role');
    check('medium', '`medium` isn\'t a preset');
    check({ triage: 3 }, 'the session of triage isn\'t a string');
    check(42, 'neither a preset nor a map');
    // A fork from explore or from an earlier stage's plain name is fine.
    assert.deepStrictEqual(parseSessions({ triage: 't from explore', splitter: 'build', planner: 'p-{plan} from build' }).problems, []);
  });

  it('tells which sessions more than one role uses', () => {
    // Triage alone in its session keeps its own model.
    const override = parseSessions({ impact: 'explore', triage: 'triage', planner: 'plan-{plan}', implementer: 'plan-{plan}' }).config;
    assert.ok(!sharedSession(override, 'triage'));
    assert.ok(sharedSession(override, 'planner'));
    assert.ok(sharedSession(override, 'impact'), 'the explore session is the user’s too');
    assert.ok(!sharedSession(override, 'writer'));
    assert.ok(sharedSession(parseSessions('simple').config, 'triage'));
    assert.ok(sharedSession(parseSessions('complex').config, 'triage'));
    assert.ok(!sharedSession(parseSessions('complex').config, 'splitter'));
    assert.ok(!sharedSession(parseSessions('isolated').config, 'triage'));
  });

  it('writes one plan for every unplanned node when the splitter is off', () => {
    const nodes = ['cli/tree', 'skills/uspec-review'];
    const text = autoSplit('tree-columns', nodes, []);
    assert.deepStrictEqual(readSplit(text, nodes, []), [
      { id: 'tree-columns', path: 'plans/tree-columns.md', nodes, after: [], reason: 'The splitter is off: one plan holds every unplanned node.' },
    ]);
    // After a gap: the next free plan, after the existing ones.
    const existing = [{ plan: 'tree-columns', after: [] }];
    const later = readSplit(autoSplit('tree-columns', ['vscode'], ['tree-columns']), ['vscode'], existing);
    assert.deepStrictEqual(later.map((p) => [p.path, p.nodes, p.after]), [['plans/tree-columns-2.md', ['vscode'], ['tree-columns']]]);
    const third = readSplit(autoSplit('tree-columns', ['cli'], ['tree-columns', 'tree-columns-2']), ['cli'], [...existing, { plan: 'tree-columns-2', after: ['tree-columns'] }]);
    assert.deepStrictEqual(third.map((p) => [p.path, p.after]), [['plans/tree-columns-3.md', ['tree-columns', 'tree-columns-2']]]);
  });
});
