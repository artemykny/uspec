// The drift `uspec drift` reports, by item (docs/cli/drift/usage.md).
import type { DriftJson } from './model';
import { nodeKey } from './paths';

/** The reasons of each drifting item, in the CLI's order: nodes (code and spec drift) and documents (dependency drift). */
export function parseDrift(json: DriftJson): { nodes: Map<string, string[]>; docs: Map<string, string[]> } {
  const nodes = new Map<string, string[]>();
  const docs = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, reason: string) => map.set(key, [...(map.get(key) ?? []), reason]);
  for (const d of json.drift) {
    if (d.kind === 'dependency' && d.document) add(docs, d.document, d.reason);
    else if (d.kind !== 'dependency') add(nodes, nodeKey(d.node), d.reason);
  }
  return { nodes, docs };
}
