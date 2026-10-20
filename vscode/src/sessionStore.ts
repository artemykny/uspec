// The agent sessions of each open change (docs/vscode/overview.md#agents, Sessions): which session id
// each name has, with its provider and the number of jobs done in it, the change's triage/write round
// and the session mode chosen for it. Kept in the workspace state, so they survive reloads; terminals only live in memory.
import * as vscode from 'vscode';
import type { AgentProvider } from './core/provider';
import { EXPLORE } from './core/sessions';
import type { Project } from './projects';

export interface Session {
  /** The agent's session id, once its hooks reported it. */
  id?: string;
  provider: AgentProvider;
  /** Jobs done in the session. */
  jobs: number;
  /** The terminal of its last job, while it is open. */
  terminal?: vscode.Terminal;
}

interface Stored {
  /** The triage/write round: 1 until the first triage run. */
  round: number;
  /** The session mode chosen for the change, if any. */
  mode?: string;
  sessions: Record<string, Omit<Session, 'terminal'>>;
}

export class SessionStore {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly cache = new Map<string, Stored>();

  constructor(private readonly memento: vscode.Memento) {}

  /** Sessions belong to one change: one created at another time is another change. */
  private key(p: Project, change: string): string {
    return JSON.stringify(['uspec.sessions', p.root, change, p.change(change)?.created]);
  }

  private terminalKey(p: Project, change: string, name: string): string {
    return JSON.stringify([p.root, change, name]);
  }

  private data(p: Project, change: string): Stored {
    const key = this.key(p, change);
    return this.cache.get(key) ?? this.memento.get<Stored>(key) ?? { round: 1, sessions: {} };
  }

  /** Saved at once in memory, so jobs started one after another see each other's rounds and sessions. */
  private save(p: Project, change: string, data: Stored): void {
    const key = this.key(p, change);
    this.cache.set(key, data);
    void this.memento.update(key, data);
  }

  get(p: Project, change: string, name: string): Session | undefined {
    const s = this.data(p, change).sessions[name];
    const terminal = this.terminals.get(this.terminalKey(p, change, name));
    return s && { ...s, terminal: terminal && vscode.window.terminals.includes(terminal) ? terminal : undefined };
  }

  set(p: Project, change: string, name: string, s: Session): void {
    const data = this.data(p, change);
    const { terminal, ...stored } = s;
    this.save(p, change, { ...data, sessions: { ...data.sessions, [name]: stored } });
    if (terminal) this.terminals.set(this.terminalKey(p, change, name), terminal);
  }

  /** The user's interactive session of the change, once captured. */
  explore(p: Project, change: string): Session | undefined {
    return this.get(p, change, EXPLORE);
  }

  /** Whether a session has an id yet: there is a context a job would continue. */
  hasSessions(p: Project, change: string): boolean {
    return Object.values(this.data(p, change).sessions).some((s) => s.id);
  }

  /**
   * A new context: forgets the change's sessions, so the next job of each name starts a new one. The
   * round and mode stay; runs keep their own session ids, so they can still be continued.
   */
  forget(p: Project, change: string): void {
    this.save(p, change, { ...this.data(p, change), sessions: {} });
    for (const key of [...this.terminals.keys()]) {
      const [r, c] = JSON.parse(key) as string[];
      if (r === p.root && c === change) this.terminals.delete(key);
    }
  }

  mode(p: Project, change: string): string | undefined {
    return this.data(p, change).mode;
  }

  setMode(p: Project, change: string, mode: string): void {
    this.save(p, change, { ...this.data(p, change), mode });
  }

  round(p: Project, change: string): number {
    return this.data(p, change).round;
  }

  /** Starts the next round: a triage run does, when it starts. */
  nextRound(p: Project, change: string): number {
    const data = this.data(p, change);
    const round = data.round + 1;
    this.save(p, change, { ...data, round });
    return round;
  }

  /** Forgets a closed change's sessions. */
  clear(root: string, change: string): void {
    for (const key of new Set([...this.memento.keys(), ...this.cache.keys()])) {
      if (!key.startsWith('["uspec.sessions"')) continue;
      const [, r, c] = JSON.parse(key) as string[];
      if (r !== root || c !== change) continue;
      this.cache.delete(key);
      void this.memento.update(key, undefined);
    }
    for (const key of [...this.terminals.keys()]) {
      const [r, c] = JSON.parse(key) as string[];
      if (r === root && c === change) this.terminals.delete(key);
    }
  }
}
