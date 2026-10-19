// The shapes of the CLI's JSON output (docs/cli/).

export interface TreeNodeJson {
  /** Spec-relative path; "." for the root. */
  node: string;
  type: string | null;
  depth: number;
  documents: string[];
  derives_from: string[];
  code: string[];
}

export interface TreeJson {
  nodes: TreeNodeJson[];
}

export interface TypeDocJson {
  document: string;
  template: string | null;
  description: string | null;
  required: boolean;
  derives_from: string[];
  exposed: boolean;
  extra: boolean;
}

export interface NodeTypeJson {
  type: string;
  name: string;
  description: string | null;
  path: string;
  code: boolean;
  children: string[];
  derives_from: string[];
  documents: TypeDocJson[];
  instructions: string | null;
}

export interface TypesJson {
  types: NodeTypeJson[];
}

export interface Issue {
  path: string;
  message: string;
}

export interface ValidateJson {
  valid: boolean;
  errors: Issue[];
}

export interface DriftJson {
  drift: { node: string; reason: string }[];
}

export interface ChangeCounts {
  pending: number;
  affected: number;
  updated: number;
  no_change: number;
  implementation_pending: number;
  implementation_done: number;
}

export interface ChangeListJson {
  changes: { change: string; baseline: string; created: number; counts: ChangeCounts }[];
}

export type DocState = 'pending' | 'affected' | 'updated' | 'no-change';

export interface StatusDocJson {
  document: string;
  path: string;
  state: DocState;
  reason: string | null;
  via: string[];
}

export interface StatusJson {
  change: string;
  baseline: string;
  documents: StatusDocJson[];
  implementation: { node: string; state: 'pending' | 'done' }[];
}

export interface NextJson {
  change: string;
  baseline: string;
  triage: null | {
    read: { path: string; document?: string; diff_since?: string }[];
    batch: { document: string; path: string; via: string[] }[];
  };
  write: { document: string; path: string }[];
  implement: { node: string }[];
}

export interface ContextFileJson {
  path: string;
  note: string | null;
}

export interface ContextJson {
  node: string;
  type: string;
  document: string | null;
  instructions: { type: string; text: string | null };
  files: Record<string, ContextFileJson[]>;
  baseline: string | null;
}

export interface SetJson {
  change: string;
  document?: string;
  node?: string;
  state: string;
  propagated?: { document: string; path: string; via: string; already_in_change: boolean }[];
  implementation?: string | null;
}

/** The order `uspec context` prints its groups in; JSON objects come back with sorted keys. */
export const CONTEXT_GROUPS = ['document', 'ancestors', 'upstream', 'documents', 'change', 'template', 'code'];
