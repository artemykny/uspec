import * as assert from 'assert';
import { executionArgs, eventAdapter, resumeArgs, codexScope } from '../../core/provider';
import { permissions } from '../../core/agents';

describe('agent providers', () => {
  it('uses Codex sandboxes, stdin and exact sessions without Claude flags', () => {
    const read = executionArgs('codex', permissions('triage'), {});
    assert.ok(read.includes('read-only'));
    assert.ok(read.includes('approval_policy="never"'));
    assert.strictEqual(read.at(-1), '-');
    assert.ok(!read.includes('--model'));
    const write = executionArgs('codex', permissions('writer', { documents: ['docs/a.md'] }), { model: 'test-model', sessionId: 'thread-123' });
    assert.ok(write.includes('workspace-write'));
    assert.deepStrictEqual(write.slice(write.indexOf('resume'), write.indexOf('resume') + 2), ['resume', 'thread-123']);
    assert.strictEqual(write[write.indexOf('--model') + 1], 'test-model');
    assert.ok(!write.includes('--allowedTools'));
    assert.match(codexScope(permissions('writer', { documents: ['docs/a.md'] })), /Edit only.*docs\/a.md/);
    assert.deepStrictEqual(resumeArgs('codex', 'original'), ['resume', 'original']);
    assert.deepStrictEqual(resumeArgs('claude', 'original'), ['--resume', 'original']);
    assert.ok(executionArgs('claude', permissions('triage'), { sessionId: 'original' }).includes('--resume'));
  });

  it('captures Codex session and final answer, not progress or tool output', () => {
    const adapt = eventAdapter('codex');
    assert.strictEqual(adapt({ type: 'thread.started', thread_id: 'thread-123' }).session_id, 'thread-123');
    adapt({ type: 'item.completed', item: { type: 'agent_message', text: 'Working…' } });
    adapt({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'irrelevant' } });
    adapt({ type: 'item.completed', item: { type: 'agent_message', text: 'updated\nDone' } });
    const result = adapt({ type: 'turn.completed' });
    assert.strictEqual(result.result, 'updated\nDone');
    assert.strictEqual(result.session_id, 'thread-123');
    assert.strictEqual(result.is_error, false);
    assert.strictEqual(result.total_cost_usd, undefined);
  });

  it('preserves failures, isolates concurrent streams, and passes Claude events through', () => {
    const a = eventAdapter('codex'), b = eventAdapter('codex');
    a({ type: 'error', message: 'Authentication failed' });
    assert.strictEqual(a({ type: 'turn.completed' }).is_error, true);
    assert.strictEqual(b({ type: 'turn.failed', error: { message: 'Disconnected' } }).result, 'Disconnected');
    const event = { type: 'result', result: 'original', subtype: 'success' };
    assert.strictEqual(eventAdapter('claude')(event), event);
  });
});
