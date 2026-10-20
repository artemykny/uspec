import * as assert from 'assert';
import { canFork, executionArgs, resumeArgs, codexScope } from '../../core/provider';
import { permissions } from '../../core/agents';

describe('agent providers', () => {
  it('runs the interactive Codex TUI with sandboxes and exact sessions, without Claude flags', () => {
    const read = executionArgs('codex', permissions('triage'), {});
    assert.ok(read.includes('read-only'));
    assert.ok(read.includes('approval_policy="never"'));
    assert.ok(!read.includes('exec') && !read.includes('--json'));
    assert.ok(!read.includes('--model'));
    const write = executionArgs('codex', permissions('writer', { documents: ['docs/a.md'] }), { model: 'test-model', sessionId: 'thread-123' });
    assert.ok(write.includes('workspace-write'));
    assert.deepStrictEqual(write.slice(0, 2), ['resume', 'thread-123']);
    assert.strictEqual(write[write.indexOf('--model') + 1], 'test-model');
    assert.ok(!write.includes('--allowedTools'));
    assert.match(codexScope(permissions('writer', { documents: ['docs/a.md'] })), /Edit only.*docs\/a.md/);
    assert.deepStrictEqual(resumeArgs('codex', 'original'), ['resume', 'original']);
    assert.deepStrictEqual(resumeArgs('claude', 'original'), ['--resume', 'original']);
    const claude = executionArgs('claude', permissions('triage'), { sessionId: 'original' });
    assert.ok(claude.includes('--resume'));
    assert.ok(!claude.includes('-p'));
  });

  it('forks a Claude Code session; Codex can’t fork', () => {
    const fork = executionArgs('claude', permissions('planner', { planFile: '.uspec/changes/c/plans/cli.md' }), { sessionId: 'build-1', fork: true });
    const at = fork.indexOf('--resume');
    assert.deepStrictEqual(fork.slice(at, at + 3), ['--resume', 'build-1', '--fork-session']);
    assert.ok(!executionArgs('claude', permissions('planner'), { sessionId: 'build-1' }).includes('--fork-session'));
    assert.ok(canFork('claude'));
    assert.ok(!canFork('codex'));
  });

  it('resumes a session with the job’s own permissions', () => {
    // An implementer resuming a session a writer used: its own tools, rules and sandbox only.
    const perms = permissions('implementer', { codePaths: [{ path: 'cli/src', dir: true }], implementerAllowed: ['Bash'] });
    const claude = executionArgs('claude', perms, { sessionId: 'shared' });
    assert.strictEqual(claude[claude.indexOf('--tools') + 1], perms.tools.join(','));
    assert.ok(claude.includes('Edit(cli/src/**)'));
    assert.ok(!claude.some((a) => a.startsWith('Edit(docs')));
    const triage = executionArgs('claude', permissions('triage'), { sessionId: 'shared' });
    assert.ok(!triage.some((a) => a.startsWith('Edit(')));
    assert.strictEqual(executionArgs('codex', permissions('triage'), { sessionId: 'shared' })[executionArgs('codex', permissions('triage'), { sessionId: 'shared' }).indexOf('--sandbox') + 1], 'read-only');
    assert.strictEqual(executionArgs('codex', perms, { sessionId: 'shared' })[executionArgs('codex', perms, { sessionId: 'shared' }).indexOf('--sandbox') + 1], 'workspace-write');
  });

  it('tells a job in a session that already did one to re-read', () => {
    const perms = permissions('writer', { documents: ['docs/a.md'] });
    assert.match(codexScope(perms, { reread: true }), /Files may have changed since those jobs.*re-read anything before relying on it.*Only this job’s input, permissions and result format apply/);
    assert.doesNotMatch(codexScope(perms), /re-read/);
    const note = (args: string[]) => args[args.indexOf('--append-system-prompt') + 1];
    assert.match(note(executionArgs('claude', perms, { sessionId: 's', reread: true })), /re-read anything before relying on it/);
    assert.doesNotMatch(note(executionArgs('claude', perms, { sessionId: 's' })), /re-read/);
  });
});
