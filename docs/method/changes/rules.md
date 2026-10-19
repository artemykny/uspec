# Changes

A **change** is one unit of work on the product: what changes, why, and every document and node of code it reaches. All work is a change, and every change starts in the spec and only then reaches the code (see [method](../)). A single edit can reach dozens of documents and nodes, so a change rarely fits in one agent session. It is therefore stateful: it records every item it has reached and where each one stands, and the work is done in passes, each picking up the items that are ready, settling them and recording the result.

## Rules

**Change directory.** An open change is a directory `.uspec/changes/<name>/`:

```
.uspec/changes/refund-window/
├─ change.md      what changes and why, with a worked example
├─ status.yaml    the baseline, and every document and node to implement with its state
└─ plans/         how the code changes, written once the documents are settled
   ├─ payments.md
   └─ refund-screens.md
```

The edits themselves are made directly in the tree, not in a proposal that is applied later; the change directory holds the description, the progress and the plans. It is committed with the work, so a change can be continued on another machine, by another person, and travels with its branch.

**Steps.** A change goes through these steps, in order; the next step to take can be read from the change directory alone.

1. **Describe.** The user and an agent write `change.md` and agree on the structure.
2. **Impact.** An agent finds the documents the change starts at.
3. **Spec.** The change propagates; candidates are triaged and affected documents written, until every document is settled.
4. **Plan.** An agent writes the plans for the code.
5. **Implement.** One implementer per plan changes and verifies the code.
6. **Close.**

**`change.md`.** The change described in full before any document is touched: a preview of it that is cheaper to review and fix than edits spread across the tree. The user iterates on it with an agent until it says exactly what they want, and approves it; every agent working on the change reads it.

| Section | Holds |
|---|---|
| Title | The change in a few words. |
| Why | The problem, and who has it. |
| What changes | The new behaviour, rule by rule; every case it touches, and what stays as it is. The constraints the user gave. |
| Worked example | One or more concrete scenarios, step by step, with real values: what the user does, what the product does, what it shows and stores. Before and after, where behaviour changes. |
| Out of scope | What the change doesn't do. |

A change kept from an [experiment](../experiments/) says so in `change.md`.

**Structure first.** Within a change, new nodes and links are proposed and approved by the user before any of their documents are written. Shape is cheap to review and expensive to change later.

**Impact.** Once `change.md` is approved, an agent reads it with the tree and finds the **starting documents**: the documents `change.md` changes directly, wherever they are in the tree, each with a one-line reason. The user reviews the list, removes and adds documents; the ones kept are recorded as `affected`, reached via `change.md`. Impact only starts the change: it doesn't have to find every document, since propagation reaches the rest from what is written. Impact runs once, while the change has no documents; after it, documents are added by propagation.

**`status.yaml`.**

| Field | Meaning |
|---|---|
| `baseline` | The commit at which the change was opened. Every diff in the change is taken against it. |
| `created` | When the change was opened. Open changes are ordered by it. |
| `documents` | Every document the change has reached, by path relative to the spec root, with its `state`, a one-line `reason` for `affected` and `no-change`, and `via`: what reached it, `change.md` or the propagation rules. |
| `implementation` | Every node with code paths the change has reached, with its state. |

**Document states.**

| State | Meaning |
|---|---|
| `updated` | The document was edited in this change, by a writer or by the user. |
| `pending` | A candidate: an update reached it and it isn't triaged yet. Only propagation sets it. |
| `affected` | Impact or triage found it must change, and why. A writer then makes it `updated`. |
| `no-change` | Triage, or a writer, found it needs no change, and why. |

`updated` and `no-change` are **settled**; `pending` and `affected` are not. A node under `implementation` is `pending` until its code is updated and verified against its documents, then `done`.

**Propagation.** When a document becomes `updated`, every document it reaches is added as `pending`, with the rule that reached it:

- the documents of the same node that [derive from](../node-types/) it;
- the documents of the node's descendants;
- every document of the nodes that [link](../links/) to its node, if the document is exposed, or that link to the document itself.

A dependency on a [section](../spec-tree/) reaches only when that section changed: its text differs from the baseline's, or it was added or removed. If its node has code paths, the node is added under `implementation`. `affected` and `no-change` propagate nothing: a document that doesn't change passes nothing on, so the change stops there. When an update reaches a document that is already settled, it goes back to `pending` and is triaged again against the new diff. Propagation repeats until no candidates are left.

**Triage and write.** Candidates are triaged in batches: one agent reads `change.md`, the diffs and the batch, and marks each candidate `affected` or `no-change`. The ready `affected` documents of one node then get one writer together, with their [context](../context/); see [agents](../agents/). The writer decides each document on its own and edits only those documents. The starting documents are written the same way.

**Readiness.** Items are handled in dependency order, so the next step can be read from `status.yaml` alone.

- A document is ready when no unsettled document can still reach it through propagation. A screen that links to a service waits for the service's exposed `api.md`, not for its internal `logic.md`. A dependency on a section counts as reaching, since the section may still change.
- A node's ready documents are written together. A document that derives from an unsettled document of its node still waits for it, so one node can get more than one writer in a change.
- Ready items in different nodes are handled in parallel.

**Plans.** Once every document is settled, split implementation into plan files before generating any implementation plan. The splitter reads the change and implementation contexts, and produces `plan-split.md` with one entry per `plans/<id>.md`, nodes and optional dependencies. The user approves this split. One independent planner then writes each assigned plan, with only that plan's node contexts and permission to edit only its file. Generation can run in parallel even when implementation is sequential. There is no global implementation plan. A plan explains the approach, concrete steps and verification for its nodes. All generated plans are reviewed before implementation starts. A plan starts with frontmatter:

| Field | Meaning |
|---|---|
| `nodes` | The nodes under `implementation` the plan implements. |
| `after` | Ids of plans that must be done before this one starts. Optional. |

The plans are valid when every node under `implementation` that isn't `done` is in exactly one plan, a plan names only such nodes, every id in `after` is a plan, and the plans don't wait for each other in a cycle. Plans are written once; when a node enters `implementation` later, for example after a gap sent the change back to the spec, the planner plans the nodes that no plan holds.

**Implement.** Implementation follows the spec changes of a change, never replaces them. Each plan gets one implementer. A plan is ready when the plans in its `after` are done and every node its nodes link to that is under `implementation` is `done` or in the plan itself. The implementer changes only the code of its plan's nodes; once the code is verified against their documents, each of them is `done`. A plan is done when all its nodes are.

**Close.** A change closes when no item is `pending` or `affected`, every node is `done`, and the tree is valid. Its directory is then removed, plans included; git history keeps every decision and its reason.

**One at a time.** Several changes can be open at once, but they are processed one by one, oldest first: each is worked through to close before the next starts, so each starts from the tree as the previous one left it.

## Example

The refund window changes from 14 to 30 days. The user writes `change.md` with an agent:

```markdown
# Refund window: 30 days

## Why
Customers who are away when an order arrives miss the 14-day window, and support grants refunds by hand.

## What changes
A refund can be requested up to 30 days after delivery, instead of 14. Partial refunds and the payout method don't change.

## Worked example
An order is delivered on 1 March. On 20 March the customer asks for a refund.
- Before: the request is rejected; the ops console shows it as Expired, "Outside the 14-day window".
- After: the request is accepted and goes to review; it would expire on 31 March.

## Out of scope
Refunds for orders delivered before the change ships.
```

Impact finds one starting document, `product/support/refunds/rules.md` ("The window section says 14 days"), and the user keeps it. Its writer changes the window and records `updated`. The `payments` service links to the refunds feature, and the ops console screen links to the refund window section, which changed, so their documents become candidates; the screen also links to `payments`, so it waits for it.

- `payments`: triage marks `api.md` `no-change` (the window isn't part of the API) and `logic.md` `affected`. Its writer changes the eligibility rule and records `updated`. `logic.md` is internal, so it reaches `storage.md`, which derives from it, but not the screen. `storage.md` is triaged against both diffs: `no-change`.
- The screen: triage marks `design.md` `no-change` and `states.md` `affected`, since it shows the window to the user. A writer updates it.
- Plan: the planner writes `payments.md` for `payments` and `refund-screens.md` for the screen; the screen links to `payments`, so its plan waits for it.
- Implementation: `payments` first, then the screen.

[examples/change-flow.html](../../../examples/change-flow.html) walks through this change step by step.

Midway, `status.yaml` reads:

```yaml
baseline: 4f2c9e1
created: 1760860800
documents:
  product/support/refunds/rules.md: {state: updated, reason: "The window section says 14 days", via: ["change.md"]}
  system/services/payments/api.md: {state: no-change, reason: "POST /refunds takes an order id; the window isn't part of the contract", via: ["links to product/support/refunds"]}
  system/services/payments/logic.md: {state: updated, reason: "The eligibility rule says 14 days", via: ["links to product/support/refunds"]}
  system/services/payments/storage.md: {state: pending, via: ["links to product/support/refunds", "derives from logic.md"]}
  experience/ops-console/refunds/states.md: {state: pending, via: ["links to product/support/refunds/rules.md#refund-window"]}
implementation:
  system/services/payments: pending
```

And `plans/refund-screens.md`:

```markdown
---
nodes: [experience/ops-console/refunds]
after: [payments]
---

# Refund screens

## Approach
The Expired state reads the window from the payments API's eligibility field instead of a constant.

## Steps
1. Remove `REFUND_WINDOW_DAYS` from the screen's state machine.
2. ...

## Verification
The state tests cover a request on day 20 (in review) and on day 31 (expired).
```
