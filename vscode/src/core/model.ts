// The shapes of the CLI's JSON output (docs/cli/).

export interface TreeNodeJson {
  /** Spec-relative path; "." for the root. */
  node: string;
  type: string | null;
  depth: number;
  documents: string[];
  /** The links as written: a node, or a document or section of one. */
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

/** One reason an item drifts: dependency drift of a document, or code or spec drift of a node. */
export interface DriftEntryJson {
  kind: 'dependency' | 'code' | 'spec';
  /** The node, or the document's node; "." for the root. */
  node: string;
  /** The document's key, for dependency drift only. */
  document: string | null;
  path: string | null;
  /** The upstream unit, for dependency drift only; null for a document never checked. */
  unit: string | null;
  reason: string;
}

export interface DriftJson {
  drift: DriftEntryJson[];
}

/** What `uspec drift accept` recorded. */
export interface AcceptJson {
  checked: { document: string; path: string }[];
  verified: { node: string }[];
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

export interface PlanJson {
  plan: string;
  path: string;
  nodes: string[];
  after: string[];
  state: 'pending' | 'done';
}

export interface StatusJson {
  change: string;
  baseline: string;
  documents: StatusDocJson[];
  implementation: { node: string; state: 'pending' | 'done' }[];
  plans: PlanJson[];
}

export interface NextJson {
  change: string;
  baseline: string;
  /** The impact step is due: the change has no documents yet. */
  impact: null | { read: { path: string }[] };
  triage: null | {
    read: { path: string; document?: string; diff_since?: string }[];
    batch: { document: string; path: string; via: string[] }[];
  };
  /** By node: one entry per node with its ready `affected` documents, one writer each. */
  write: { node: string; documents: { document: string; path: string }[] }[];
  /** Nodes to implement that no plan holds yet, once every document is settled. */
  plan: null | { dir: string; nodes: string[] };
  plan_errors: { plan: string | null; message: string }[];
  /** Plans ready to implement: one implementer each. */
  implement: { plan: string; path: string; nodes: string[] }[];
}

export interface ContextFileJson {
  path: string;
  /** The anchor of the one section of the document that is read. */
  section: string | null;
  note: string | null;
}

export interface ContextJson {
  node: string;
  type: string;
  /** The ids of the documents being written, in the order given; `[]` with `--implement`. */
  documents: string[];
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
