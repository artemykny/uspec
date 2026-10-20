# Drift

**Drift** is anything that changed since it was last checked: a document whose dependencies changed, a node whose spec changed since its code was last verified against it, and code that changed since then. Code follows the spec (see [method](../)), and every change starts in the spec and reaches everything that depends on it through a [change](../changes/). Agents and people still edit documents and code directly, and nothing stops them, so the documents that depend on an edit are never triaged, code is never verified against a new spec, and the spec silently stops describing what the code does. Drift is detected by recording what each item was last checked against and comparing it with what is there now, so it is found at once, not by accident.

## Rules

**What is recorded.** For each item, what it was last checked against:

- **Documents.** For each document, its **upstream units**: every unit whose update reaches it directly under the propagation rules of [changes](../changes/), that is, a document of its node it derives from, or a section of it; every document of its parent; every exposed document of a node it links to; and a document or section it links to. For each unit, a hash of its content when the document was last checked.
- **Nodes with code.** For each node whose type has code and that has code paths, a hash of its **spec** (its `node.yaml`, its documents and its extra files) and a hash of its **code** (the files under its code paths that git tracks, or that are untracked but not ignored), when its code was last verified against its spec.

Hashes are of exact content: any edit, whitespace included, counts. A section's hash covers the section's text only, so an edit elsewhere in its document doesn't change it. Code is hashed as it is in the working tree, so uncommitted changes count.

**Records file.** The records live in one file, `.uspec/checks.yaml`, written only by uspec and committed with the work. It has one line per document–unit pair and one per node, sorted by path, so branches that check different items merge without conflicts:

```yaml
documents:
  cli/drift/usage.md:
    cli/overview.md: 4be2f0a91c3d7e18
    method/drift/rules.md: 9c41e0a27d5b3f60
nodes:
  cli/drift: {spec: 1b77d3c08e2a4f95, code: 4e0a9f12c6b8d371}
```

**What records a check.**

- **Closing a change** records every settled document of the change as checked against its current upstream units, and every node under `implementation` as verified against its current spec and code (see [changes](../changes/)). Items the change didn't reach keep their records.
- **Accepting** records the given items as checked, as they are now. It states "I looked, and this still holds": a refactor that keeps the behaviour, or a typo fixed in an upstream document that changes nothing downstream. It needs no change and doesn't touch the spec. A project without records has every item never checked; accepting every item is how it starts recording.

**Kinds of drift.**

- **Dependency drift.** A document drifts when one of its upstream units differs from its record: the unit changed, was added (a new unit now reaches it, such as a new exposed document of a linked node) or was removed. Each such unit is a reason. A record against a document of a higher ancestor, not the parent, isn't an upstream unit: it is ignored and not reported as drift, and the document's next check drops it.
- **Code drift.** A node drifts when its code hash differs from its record. Reverting the code to the verified content clears it.
- **Spec drift.** A node drifts when its spec hash differs from its record: its spec changed and its code was never verified against it.

A node can have code drift and spec drift at once; both are reported. An item with no record drifts as never checked, so documents and nodes created outside a change are found too.

**Open changes.** A document listed in an open change's `documents`, in any state, is skipped: propagation and triage handle it. A node under `implementation` in an open change is skipped for code and spec drift: its spec is changing and its code is expected to catch up (see [changes](../changes/)).

**Resolving drift.** Drifting code is a bug, unless the spec is changed explicitly first.

- **Dependency drift:** a change takes in the upstream document as `updated`, so propagation adds the drifting documents as candidates, they are triaged, and closing records them. If the upstream edit plainly changes nothing downstream, the drifting documents are accepted instead.
- **Code drift:** the code is brought back to what the spec says, or a change updates the node's spec to the intended behaviour and the code then follows it as usual. If the code was refactored and still matches its spec, the node is accepted.
- **Spec drift:** a change takes in the edited documents as `updated`, so the node enters `implementation` and its code is verified against them; or the spec edit is reverted.

The spec is never edited only to match the code without a change.

**Merging.** Code that is merged matches the spec, so nothing that drifts, of any kind, is merged until its drift is resolved.

## Example

Every item of the tree was accepted. A developer fixes a rounding bug directly in the code of `system/services/payments` and commits it. Its code hash no longer matches its record, so `payments` has code drift. The fix changes how refunds are rounded, which `logic.md` doesn't describe, so a change is opened: `logic.md` is updated with the rounding rule, `payments` is added under `implementation` and skipped while the change is open, `storage.md`, which derives from `logic.md`, is triaged `no-change`, and the code of `payments` is verified against the new `logic.md`. Closing the change records `logic.md` and `storage.md` as checked against their current upstream units and `payments` as verified against its current spec and code, so nothing drifts.

Had the developer only renamed a local variable, the code drift would be the same; they check the code against its spec, accept `payments`, and commit the records with the refactor.
