import { claudeArgs, type Permissions } from './agents';

export type AgentProvider = 'claude' | 'codex';
export const providerLabel = (provider: AgentProvider) => provider === 'codex' ? 'Codex' : 'Claude Code';
export const resumeArgs = (provider: AgentProvider, session: string): string[] => [provider === 'codex' ? 'resume' : '--resume', session];

export function executionArgs(provider: AgentProvider, perms: Permissions, opts: { model?: string; name?: string; sessionId?: string }): string[] {
  if (provider === 'claude') return [...claudeArgs(perms, opts), ...(opts.sessionId ? resumeArgs(provider, opts.sessionId) : [])];
  const writable = perms.allowed.some(rule => rule.startsWith('Edit('));
  // Exec's sandbox option precedes the resume subcommand; approval policy is global.
  return ['-c', 'approval_policy="never"', 'exec', '--sandbox', writable ? 'workspace-write' : 'read-only',
    ...(opts.sessionId ? ['resume', opts.sessionId] : []), '--json', ...(opts.model ? ['--model', opts.model] : []), '-'];
}

export function codexScope(perms: Permissions): string {
  const paths = perms.allowed.filter(rule => rule.startsWith('Edit(')).map(rule => rule.slice(5, -1));
  return '\n\nYou run non-interactively in the project root. No one can answer questions or permission prompts. ' +
    (paths.length ? `Edit only these assigned paths: ${paths.join(', ')}. Do not edit other files.` : 'Do not modify any files.') +
    ' Use your available native tools. Return the exact result format requested above.\n';
}

/** Adapt Codex JSONL to the common event shape consumed by the workflow and logs. */
export function eventAdapter(provider: AgentProvider): (event: any) => any {
  let session: string | undefined, text = '', failure = '';
  return e => {
    if (provider === 'claude') return e;
    if (e.type === 'thread.started') { session = e.thread_id; return { type: 'system', subtype: 'init', session_id: session, model: 'Codex', permissionMode: 'sandbox' }; }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') {
      text = e.item.text ?? '';
      return { type: 'assistant', session_id: session, message: { content: [{ type: 'text', text }] } };
    }
    if (e.type === 'error' || e.type === 'turn.failed') failure = e.message ?? e.error?.message ?? 'Codex turn failed';
    if (e.type === 'turn.completed' || e.type === 'turn.failed') return {
      type: 'result', session_id: session, result: failure || text, subtype: failure ? 'error' : 'success', is_error: !!failure,
    };
    if (e.type === 'item.started' || e.type === 'item.completed') return { type: 'assistant', message: { content: [
      { type: 'tool_use', name: e.item?.type ?? 'activity', input: { command: e.item?.command ?? JSON.stringify(e.item) } },
    ] } };
    return e;
  };
}
