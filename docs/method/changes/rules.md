# Changes

A **change** is one unit of work on the product: what changes, why, and every document and node of code it reaches. All work is a change, and every change starts in the spec, at the highest node it affects, and only then reaches the code (see [method](../)). A single edit can reach dozens of documents and nodes, so a change rarely fits in one agent session. It is therefore stateful: it records every item it has reached and where each one stands, and the work is done in passes, each picking up the items that are ready, settling them and recording the result.

## Rules

**Change directory.** An open change is a directory `.uspec/changes/<name>/`:

```
.uspec/changes/refund-window/
├─ change.md      what changes and why, and the node it starts at
└─ status.yaml    the baseline, and every document and node to implement with its state
```

`change.md` is approved by the user before any document is edited, and every agent working on the change reads it. The edits themselves are made directly in the tree, not in a proposal that is applied later; the change directory holds only the progress. It is committed with the work, so a change can be continued on another machine, by another person, and travels with its branch.

**`status.yaml`.**

| Field | Meaning |
|---|---|
| `baseline` | The commit at which the change was opened. Every diff in the change is taken against it. |
| `created` | When the change was opened. Open changes are ordered by it. |
| `documents` | Every document the change has reached, by path relative to the spec root, with its `state`, a one-line `reason` for `affected` and `no-change`, and `via`: the propagation rules that reached it. |
| `implementation` | Every node with code paths the change has reached, with its state. |

**Structure first.** Within a change, new nodes and links are proposed and approved by the user before any of their documents are written. Shape is cheap to review and expensive to change later.

**Document states.**

| State | Meaning |
|---|---|
| `updated` | The document was edited in this change: by the user at the start, or by a writer. |
| `pending` | A candidate: an update reached it and it isn't triaged yet. Only propagation sets it. |
| `affected` | Triage found it must change, and why. A writer then makes it `updated`. |
| `no-change` | Triage, or a writer, found it needs no change, and why. |

`updated` and `no-change` are **settled**; `pending` and `affected` are not. A node under `implementation` is `pending` until its code is updated and verified against its documents, then `done`.

**Propagation.** When a document becomes `updated`, every document it reaches is added as `pending`, with the rule that reached it:

- the documents of the same node that [derive from](../node-types/) it;
- the documents of the node's descendants;
- every document of the nodes that [link](../links/) to its node, if the document is exposed.

If its node has code paths, the node is added under `implementation`. `affected` and `no-change` propagate nothing: a document that doesn't change passes nothing on, so the change stops there. When an update reaches a document that is already settled, it goes back to `pending` and is triaged again against the new diff. Propagation repeats until no candidates are left.

**Triage and write.** Candidates are triaged in batches: one agent reads `change.md`, the diffs and the batch, and marks each candidate `affected` or `no-change`. Each `affected` document then gets its own writer, with the document's [context](../context/); see [agents](../agents/).

**Readiness.** Items are handled in dependency order, so the next step can be read from `status.yaml` alone.

- A document is ready when no unsettled document can still reach it through propagation. A screen that links to a service waits for the service's exposed `api.md`, not for its internal `logic.md`.
- A node is ready to implement when the nodes it links to are `done`.
- Ready items in different nodes are handled in parallel.

**Implement.** Implementation follows the spec changes of a change, never replaces them. Each node under `implementation` gets its own implementer.

**Close.** A change closes when no item is `pending` or `affected` and the tree is valid. Its directory is then removed; git history keeps every decision and its reason.

**One at a time.** Several changes can be open at once, but they are processed one by one, oldest first: each is worked through to close before the next starts, so each starts from the tree as the previous one left it.

## Example

The refund window changes from 14 to 30 days in `product/support/refunds/rules.md`, recorded as `updated`. The `payments` service and two screens link to the refunds feature, so all their documents become candidates; the screens also link to `payments`, so they wait for it.

- `payments`: triage marks `api.md` `no-change` (the window isn't part of the API) and `logic.md` `affected`. Its writer changes the eligibility rule and records `updated`. `logic.md` is internal, so it reaches `storage.md`, which derives from it, but not the screens. `storage.md` is triaged against both diffs: `no-change`.
- The screens: triage marks both `design.md` `no-change` and both `states.md` `affected`, since they show the window to the user. Two writers update them in parallel.
- Implementation: `payments` first, then both screens in parallel.

[examples/change-flow.html](../../../examples/change-flow.html) walks through this change step by step.

Midway, `status.yaml` reads:

```yaml
baseline: 4f2c9e1
created: 1760860800
documents:
  product/support/refunds/rules.md: {state: updated}
  system/services/payments/api.md: {state: no-change, reason: "POST /refunds takes an order id; the window isn't part of the contract", via: ["links to product/support/refunds"]}
  system/services/payments/logic.md: {state: updated, reason: "The eligibility rule says 14 days", via: ["links to product/support/refunds"]}
  system/services/payments/storage.md: {state: pending, via: ["links to product/support/refunds", "derives from logic.md"]}
  experience/ops-console/refunds/states.md: {state: pending, via: ["links to product/support/refunds"]}
implementation:
  system/services/payments: pending
```
