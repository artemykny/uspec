# Workflow

How a user works with uspec, from an empty repository to day-to-day changes. Concepts are defined in [product-overview.md](product-overview.md), formats in [node-types.md](node-types.md).

The user works with an AI agent (Claude Code or Codex) through uspec [skills](skills.md). The user makes the decisions; agents write the documents and the code; the [CLI](cli.md) scaffolds, validates and tracks changes.

All work happens in one of two modes:

| Mode | What happens | Who decides |
|---|---|---|
| **Change spec** | The tree changes: nodes are added, renamed, moved or removed, and documents are written or updated. The change [propagates](#2-change-the-product) to every document that depends on it. | The user approves structure; agents write documents; the user reviews. |
| **Implement** | Agents write or update the code of nodes with code paths whose spec changed, from the node's documents and context. | Agents; checked against the spec. |

Shape is cheap to review and expensive to change later, so within a spec change structure comes first: new nodes and links (folders, `node.yaml`, one line each) are proposed and approved before any of their documents are written. Documents are then written from their templates, one agent per document, in [document dependency](node-types.md#document-dependencies) order.

Code only follows the spec: implement always comes after a spec change, never instead of one.

Both modes are tracked in a [change](#changes): a directory in the repository that records what is being changed and what is left to do, so the work can span many agent sessions.

## 1. Set up

`uspec init` creates `.uspec/config.yaml`, the node types and the root node in `docs/`:

- **From a preset.** A preset is a starter set of node types, downloaded from GitHub. Init copies its node types into `.uspec/node-types/` and creates the root node.
- **Empty.** Without a preset, init generates one basic node type and a root node of that type with a single document.

Either way the node types then belong to the project, and the user edits them. They decide how the whole tree is cut, so they are worth getting right first. From here the tree grows through ordinary [changes](#2-change-the-product).

The tree contains only what is being built. Planned work is described in the root documents, and a node is created by a change when it enters scope.

## 2. Change the product

A change always starts with a spec change at the highest node it affects:

1. **Open.** `uspec change new <name>` creates the [change directory](#changes) and records the current commit as the change's baseline. Every diff in the change is taken against it.
2. **Describe.** The user says what changes and why. The agent writes it to `change.md`, with the node the change starts at, and the user approves it. Every agent working on the change reads it.
3. **Edit.** The user edits the starting node's documents, or asks the agent to. Each edited document is recorded as `updated`.
4. **Propagate.** Every `updated` document reaches the documents that may depend on it. The CLI adds each one to the change as a pending **candidate**, with the rule that reached it:
   - the node's own documents that [derive from](node-types.md#document-dependencies) the updated one;
   - the node's descendants;
   - every document of the nodes that link to it, if the updated document is [exposed](node-types.md#exposed-documents).
5. **Triage.** Ready candidates are triaged in batches. One triage agent reads `change.md`, the diffs and the candidates of a batch, and marks each candidate `affected` or `no-change`, with a one-line reason. A document that doesn't change passes nothing on, so the change stops there.
6. **Write.** Each affected document gets its own writer agent with the document's full [context](product-overview.md#context). The writer updates the document and records it as `updated`, which propagates again (step 4). Ready documents in different nodes are written in parallel.
7. **Validate.** `uspec validate` checks the tree's structure.
8. **Implement.** A node with code paths is added to the change when one of its documents is updated. Each node gets its own implementer agent, which updates and verifies its code. A node is implemented after the nodes it links to.
9. **Close.** When nothing is left pending, the change directory is removed.

Steps 4 to 6 repeat until no candidates are left. Items are handled in dependency order: an item is ready when everything upstream of it is settled (`updated` or `no-change`).

For example, the refund window for customers changes from 14 to 30 days in `product/support/refunds/rules.md`. The `payments` service and two screens link to the refunds feature, so all their documents become candidates. The screens also link to `payments`, so they wait for it:

- `payments`: triage marks `api.md` `no-change` (the window isn't part of the API) and `logic.md` `affected`. Its writer changes the eligibility rule and records `updated`. `logic.md` is internal, so it reaches `storage.md`, which derives from it, but not the screens. `storage.md` is triaged against both diffs: `no-change`.
- The screens: one triage run marks both `design.md` `no-change` and both `states.md` `affected`, since they show the window to the user. Two writers update them in parallel.
- Implementation: `payments` first, then both screens in parallel, since they link to it.

[examples/change-flow.html](../examples/change-flow.html) walks through this change step by step.

### Changes

A change rarely fits in one agent session: a single edit can reach dozens of documents and code nodes. So a change is stateful. Its directory records every item the change has reached and where each one stands, and the work is done in passes: each session picks up items that are ready, settles them, and records the result.

```
.uspec/changes/refund-window/
├─ change.md      what changes and why, and the node it starts at
└─ status.yaml    the baseline, and every document and node to implement with its state
```

```yaml
baseline: 4f2c9e1
documents:
  product/support/refunds/rules.md: {state: updated}
  system/services/payments/api.md: {state: no-change, reason: "POST /refunds takes an order id; the window isn't part of the contract"}
  system/services/payments/logic.md: {state: updated, reason: "The eligibility rule says 14 days"}
  system/services/payments/storage.md: {state: pending}
  experience/ops-console/refunds/states.md: {state: pending}
implementation:
  system/services/payments: pending
```

- A document is `pending` while it's a candidate. Triage makes it `affected` or `no-change`, with a reason; a writer makes an `affected` document `updated`. An implementation entry is a node with code paths: `pending` until its code is updated and verified, then `done`.
- An item is ready when everything upstream of it is settled, so the next step can be read from `status.yaml` alone.
- The list grows as the work goes on: each `updated` document propagates and adds new candidates.
- Several changes can be open at once, but they are processed one by one: a change is worked through to close before the next one starts, so each change starts from the tree as the previous one left it.

The edits themselves are made directly in the tree; the change directory only holds the progress. It is committed with the work, so a change can be continued on another machine or by another person, and it travels with its branch. On close it is removed; git history keeps every decision and its reason.

### Experiments

To try something quickly, the user edits code directly on a branch, with no change and no spec. The [drift check](#3-keep-spec-and-code-in-sync) flags that code, which is correct: nothing in the spec backs it yet. When the experiment is over, it is either:

- **dropped:** the branch is deleted and the spec is untouched;
- **kept:** the user opens a change, and an agent reads the code diff, finds the highest node it affects and proposes the document edits. From there it is an ordinary change: propagate, triage, write, validate. The implement step checks the existing code against the new spec instead of writing it, and fixes what doesn't match.

An experiment can't be merged without a spec change, because the drift check fails on it. A spec written from code tends to describe what the code does, including accidents, rather than what was intended, so the user reviews it more closely than a spec written first.

## 3. Keep spec and code in sync

| Check | What it finds |
|---|---|
| `uspec validate` | Structural errors: wrong types, missing documents, broken or cyclic links, code paths on the wrong nodes ([full list](node-types.md#validation)). |
| Review | Nodes that aren't implementable from their context, and nodes that contradict their ancestors or upstream nodes. |
| Drift check | Code changed without a spec change. The code is a bug, or the spec is changed explicitly first. |

## 4. Onboard an existing codebase

> **TODO:** how to build the first spec tree for a large existing codebase. After onboarding, the steps in [Change the product](#2-change-the-product) apply.
