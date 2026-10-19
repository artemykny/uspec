import * as assert from 'assert';
import { executionArgs, resumeArgs, codexScope } from '../../core/provider';
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
});
