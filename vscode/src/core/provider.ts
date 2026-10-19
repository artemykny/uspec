import { claudeArgs, type Permissions } from './agents';

export type AgentProvider = 'claude' | 'codex';
export const providerLabel = (provider: AgentProvider) => provider === 'codex' ? 'Codex' : 'Claude Code';
export const resumeArgs = (provider: AgentProvider, session: string): string[] => [provider === 'codex' ? 'resume' : '--resume', session];

/** Arguments for the provider's interactive CLI; the prompt comes after them. */
export function executionArgs(provider: AgentProvider, perms: Permissions, opts: { model?: string; name?: string; sessionId?: string }): string[] {
  if (provider === 'claude') return [...claudeArgs(perms, opts), ...(opts.sessionId ? resumeArgs(provider, opts.sessionId) : [])];
  const writable = perms.allowed.some(rule => rule.startsWith('Edit('));
  // The resume subcommand comes first; it takes the same options.
  return [...(opts.sessionId ? resumeArgs(provider, opts.sessionId) : []), '-c', 'approval_policy="never"',
    '--sandbox', writable ? 'workspace-write' : 'read-only', ...(opts.model ? ['--model', opts.model] : [])];
}

export function codexScope(perms: Permissions): string {
  const paths = perms.allowed.filter(rule => rule.startsWith('Edit(')).map(rule => rule.slice(5, -1));
  return '\n\nYou run in a terminal started by the uspec VS Code extension in the project root. Work without asking questions or for approvals: the final message of your first turn is read as your result. ' +
    (paths.length ? `Edit only these assigned paths: ${paths.join(', ')}. Do not edit other files.` : 'Do not modify any files.') +
    ' Use your available native tools. Return the exact result format requested above.\n';
}
