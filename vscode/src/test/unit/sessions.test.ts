import * as assert from 'assert';
import { autoSplit, describeMode, parseMode, parseSessions, resolveSession, sharedSession, splitterOff } from '../../core/sessions';
import { readSplit } from '../../core/workflow';

const fallback = 'Its jobs run in new sessions until this is fixed.';

/** The presets, as a change uses them when nothing is set. */
const preset = (name: string) => ({ config: parseSessions(undefined).modes[name], problems: [] as string[] });

describe('agent sessions', () => {
  it('resolves the presets per role', () => {
    assert.deepStrictEqual(parseSessions(undefined).problems, []);
    assert.deepStrictEqual(Object.keys(parseSessions({}).modes), ['isolated', 'simple', 'complex']);
    const isolated = preset('isolated');
    assert.deepStrictEqual(isolated.config, {});
    assert.strictEqual(resolveSession(isolated.config, 'writer', { node: 'cli' }), undefined);

    const simple = preset('simple');
    assert.deepStrictEqual(simple.problems, []);
    for (const role of ['impact', 'triage', 'writer', 'planner', 'implementer']) {
      assert.deepStrictEqual(resolveSession(simple.config, role, { round: 3, node: 'cli', plan: 'tree-columns' }), { name: 'explore' }, role);
    }
    assert.ok(splitterOff(simple.config));
    assert.strictEqual(resolveSession(simple.config, 'splitter'), undefined);

    const complex = preset('complex');
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

  it('adds the modes of the setting to the presets', () => {
    const { modes, problems } = parseSessions({ fast: { impact: 'explore', implementer: 'build' }, simple: { triage: 'triage' } });
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(Object.keys(modes), ['isolated', 'simple', 'complex', 'fast']);
    assert.deepStrictEqual(resolveSession(modes.fast, 'implementer', { plan: 'cli' }), { name: 'build' });
    // A preset's name replaces the preset.
    assert.deepStrictEqual(resolveSession(modes.simple, 'triage'), { name: 'triage' });
    assert.strictEqual(resolveSession(modes.simple, 'writer'), undefined);
    assert.ok(!splitterOff(modes.simple));
  });

  it('describes a mode in a line', () => {
    assert.strictEqual(describeMode(preset('isolated').config), 'Every job in a new session');
    assert.strictEqual(describeMode(preset('simple').config), 'impact, triage, writer, planner, implementer: explore · splitter: off');
    assert.strictEqual(describeMode(parseMode('m', { triage: 'spec', writer: 'spec' }).config), 'triage, writer: spec · impact, splitter, planner, implementer: new session per job');
  });

  it('takes a mode as the whole configuration', () => {
    const { config, problems } = parseMode('m', { impact: 'explore', triage: 'triage', planner: 'plan-{plan}', implementer: 'plan-{plan}' });
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(resolveSession(config, 'triage', { round: 3 }), { name: 'triage' });
    // Roles left out get a new session per job: no merging with a preset.
    assert.strictEqual(resolveSession(config, 'writer', { node: 'cli', round: 2 }), undefined);
    assert.strictEqual(resolveSession(config, 'splitter'), undefined);
    assert.ok(!splitterOff(config));
    assert.deepStrictEqual(resolveSession(config, 'implementer', { plan: 'vscode' }), { name: 'plan-vscode' });
  });

  it('fills in the placeholders', () => {
    const { config, problems } = parseMode('m', { triage: 'triage-{round}', writer: 'w-{round}-{node}', planner: 'p-{plan}', implementer: 'i-{plan}' });
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(resolveSession(config, 'triage', { round: 2 }), { name: 'triage-2' });
    assert.deepStrictEqual(resolveSession(config, 'writer', { round: 1, node: 'cli/tree' }), { name: 'w-1-cli/tree' });
    // Before any triage run, writers are in round 1.
    assert.deepStrictEqual(resolveSession(config, 'writer', { node: 'cli' }), { name: 'w-1-cli' });
    assert.deepStrictEqual(resolveSession(config, 'planner', { plan: 'cli' }), { name: 'p-cli' });
    assert.deepStrictEqual(resolveSession(config, 'implementer', { plan: 'cli' }), { name: 'i-cli' });
  });

  it('reports each problem and runs the mode as isolated', () => {
    const check = (value: unknown, what: string) => {
      const { config, problems } = parseMode('m', value);
      assert.deepStrictEqual(config, {}, JSON.stringify(value));
      assert.ok(problems.some((p) => p.includes(what) && p.startsWith('uspec.agents.sessions: m: ') && p.endsWith(fallback)), `${JSON.stringify(value)}: ${problems.join(' | ')}`);
    };
    const { modes, problems } = parseSessions({ broken: { triage: 't-{plan}' } });
    assert.deepStrictEqual(problems, ['uspec.agents.sessions: broken: `{plan}` can\'t be used by triage. Its jobs run in new sessions until this is fixed.']);
    assert.deepStrictEqual(modes.broken, {});
    // The other modes are untouched.
    assert.ok(splitterOff(modes.simple));
    // A setting that isn't a map of modes leaves the presets.
    const legacy = parseSessions('simple');
    assert.match(legacy.problems.join(), /isn't a map from mode name to mode/);
    assert.deepStrictEqual(Object.keys(legacy.modes), ['isolated', 'simple', 'complex']);
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
    check('medium', 'isn\'t a map from role to session name');
    check({ triage: 3 }, 'the session of triage isn\'t a string');
    // A fork from explore or from an earlier stage's plain name is fine.
    assert.deepStrictEqual(parseMode('m', { triage: 't from explore', splitter: 'build', planner: 'p-{plan} from build' }).problems, []);
  });

  it('tells which sessions more than one role uses', () => {
    // Triage alone in its session keeps its own model.
    const override = parseMode('m', { impact: 'explore', triage: 'triage', planner: 'plan-{plan}', implementer: 'plan-{plan}' }).config;
    assert.ok(!sharedSession(override, 'triage'));
    assert.ok(sharedSession(override, 'planner'));
    assert.ok(sharedSession(override, 'impact'), 'the explore session is the user’s too');
    assert.ok(!sharedSession(override, 'writer'));
    assert.ok(sharedSession(preset('simple').config, 'triage'));
    assert.ok(sharedSession(preset('complex').config, 'triage'));
    assert.ok(!sharedSession(preset('complex').config, 'splitter'));
    assert.ok(!sharedSession(preset('isolated').config, 'triage'));
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
