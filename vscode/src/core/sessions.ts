// Named agent sessions (docs/vscode/overview.md#agents, Sessions): which jobs of a change share an
// agent session, from the session mode the change uses (`uspec.agents.sessions`). Nothing here touches
// VS Code or starts a process.

export type SessionRole = 'impact' | 'triage' | 'writer' | 'splitter' | 'planner' | 'implementer';

export const SESSION_ROLES: SessionRole[] = ['impact', 'triage', 'writer', 'splitter', 'planner', 'implementer'];

/** The order of a change's stages: a session can start as a fork only of an earlier stage's. */
const STAGE: Record<SessionRole, number> = { impact: 0, triage: 1, writer: 1, splitter: 2, planner: 3, implementer: 4 };

/** The placeholders each role's name can use. */
const PLACEHOLDERS: Record<SessionRole, string[]> = {
  impact: [],
  triage: ['round'],
  writer: ['round', 'node'],
  splitter: [],
  planner: ['plan'],
  implementer: ['plan'],
};

/** The user's interactive `uspec-spec` session of the change, the main agent. */
export const EXPLORE = 'explore';

/** The session modes there always are; `uspec.agents.sessions` adds its own, or replaces one by name. */
export const PRESETS: Record<string, Partial<Record<SessionRole, string>>> = {
  isolated: {},
  simple: { impact: 'explore', triage: 'explore', writer: 'explore', splitter: 'off', planner: 'explore', implementer: 'explore' },
  complex: { impact: 'explore', triage: 'spec', writer: 'spec', splitter: 'build', planner: 'plan-{plan} from build', implementer: 'plan-{plan}' },
};

/** The mode of a change that chose none, while `uspec.agents.sessionMode` doesn't name a mode. */
export const DEFAULT_MODE = 'isolated';

/** A role's session: a name, maybe with placeholders, and the session it starts as a fork of. */
export interface SessionEntry {
  name: string;
  from?: string;
}

export type SessionConfig = Partial<Record<SessionRole, SessionEntry | 'off'>>;

/** What a job's session name is made from. */
export interface SessionItem {
  round?: number;
  node?: string;
  plan?: string;
}

const problem = (mode: string, what: string) => `uspec.agents.sessions: ${mode}: ${what}. Its jobs run in new sessions until this is fixed.`;

const placeholders = (name: string) => [...name.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);

/**
 * Reads `uspec.agents.sessions`: a map from mode name to mode, on top of the presets. A mode with a
 * problem runs every job in a new session, as `isolated` does.
 */
export function parseSessions(value: unknown): { modes: Record<string, SessionConfig>; problems: string[] } {
  const problems: string[] = [];
  const all: Record<string, unknown> = { ...PRESETS };
  if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(all, value);
  else if (value !== undefined && value !== null) problems.push('uspec.agents.sessions: it isn\'t a map from mode name to mode. Only isolated, simple and complex can be chosen until this is fixed.');
  const modes: Record<string, SessionConfig> = {};
  for (const [name, mode] of Object.entries(all)) {
    const parsed = parseMode(name, mode);
    modes[name] = parsed.config;
    problems.push(...parsed.problems);
  }
  return { modes, problems };
}

/** Reads one session mode: a map from role to session name. Any problem makes it `isolated`, every job in a new session. */
export function parseMode(mode: string, value: unknown): { config: SessionConfig; problems: string[] } {
  const problems: string[] = [];
  const at = (what: string) => problems.push(problem(mode, what));
  let map: Record<string, unknown> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) map = value as Record<string, unknown>;
  else at('it isn\'t a map from role to session name');

  const config: SessionConfig = {};
  for (const [role, v] of Object.entries(map)) {
    if (role === 'reviewer') {
      at("`reviewer` can't be named: the reviewer always gets a new session");
      continue;
    }
    if (!SESSION_ROLES.includes(role as SessionRole)) {
      at(`\`${role}\` isn't a role that can be named (impact, triage, writer, splitter, planner or implementer)`);
      continue;
    }
    const r = role as SessionRole;
    if (typeof v !== 'string') {
      at(`the session of ${r} isn't a string`);
      continue;
    }
    const text = v.trim();
    if (text === 'off') {
      if (r === 'splitter') config[r] = 'off';
      else at(`\`off\` can't be used by ${r}; only the splitter can be off`);
      continue;
    }
    const m = /^(.+?)\s+from\s+(.+)$/.exec(text);
    const entry: SessionEntry = m ? { name: m[1].trim(), from: m[2].trim() } : { name: text };
    if (!entry.name) {
      at(`the session of ${r} is empty`);
      continue;
    }
    for (const ph of placeholders(entry.name)) if (!PLACEHOLDERS[r].includes(ph)) at(`\`{${ph}}\` can't be used by ${r}`);
    config[r] = entry;
  }

  // A fork starts from `explore`, or from the plain name (no placeholder, no fork) of an earlier stage's role.
  for (const r of SESSION_ROLES) {
    const e = config[r];
    if (!e || e === 'off' || e.from === undefined || e.from === EXPLORE) continue;
    const earlier = SESSION_ROLES.some((o) => {
      const x = config[o];
      return STAGE[o] < STAGE[r] && x && x !== 'off' && x.from === undefined && !placeholders(x.name).length && x.name === e.from;
    });
    if (earlier) continue;
    if (STAGE[r] > STAGE.splitter && config.splitter === 'off') at(`${r} forks from \`${e.from}\`, but the splitter is \`off\` and has no session`);
    else at(`${r} forks from \`${e.from}\`, which no earlier stage uses`);
  }
  return { config: problems.length ? {} : config, problems };
}

/** A mode in a line, for choosing one: the roles of each session. */
export function describeMode(config: SessionConfig): string {
  const sessions = new Map<string, SessionRole[]>();
  for (const r of SESSION_ROLES) {
    const e = config[r];
    if (!e) continue;
    const name = e === 'off' ? 'off' : e.from === undefined ? e.name : `${e.name} from ${e.from}`;
    sessions.set(name, [...(sessions.get(name) ?? []), r]);
  }
  if (!sessions.size) return 'Every job in a new session';
  const rest = SESSION_ROLES.filter((r) => !config[r]);
  return [...[...sessions].map(([name, roles]) => `${roles.join(', ')}: ${name}`), ...(rest.length ? [`${rest.join(', ')}: new session per job`] : [])].join(' · ');
}

/** The session a role's job runs in, with its placeholders filled in; none when the job gets a new session. */
export function resolveSession(config: SessionConfig, role: string, item: SessionItem = {}): SessionEntry | undefined {
  const e = config[role as SessionRole];
  if (!e || e === 'off') return undefined;
  const name = e.name.replace(/\{(round|node|plan)\}/g, (_, ph: string) => (ph === 'round' ? String(item.round ?? 1) : ph === 'node' ? item.node ?? '' : item.plan ?? ''));
  return e.from === undefined ? { name } : { name, from: e.from };
}

/** Whether a role's session is used by another role too, or is the main agent's: every job in it then runs on one model. */
export function sharedSession(config: SessionConfig, role: string): boolean {
  const e = config[role as SessionRole];
  if (!e || e === 'off') return false;
  if (e.name === EXPLORE) return true;
  return SESSION_ROLES.some((o) => {
    const x = config[o];
    return o !== role && x && x !== 'off' && x.name === e.name;
  });
}

/** Whether no splitter runs: the extension writes the split itself. */
export function splitterOff(config: SessionConfig): boolean {
  return config.splitter === 'off';
}

/**
 * The split the extension writes when the splitter is off: one plan owning every unplanned node,
 * `plans/<change>.md` or the first free `plans/<change>-<n>.md`, after every existing plan.
 */
export function autoSplit(change: string, nodes: string[], existing: string[]): string {
  let id = change;
  for (let n = 2; existing.includes(id); n++) id = `${change}-${n}`;
  return `# Split plans\n\n## Plans\n\n### plans/${id}.md\n- Nodes: ${nodes.join(', ')}\n- After: ${existing.join(', ')}\n- Reason: The splitter is off: one plan holds every unplanned node.\n`;
}
