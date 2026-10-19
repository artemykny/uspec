# Agents

An **agent** is one run of a model doing one job of a [change](../changes/). There are no separately defined agents: the job decides what an agent reads, which is its [context](../context/), and the document's template and the type's instructions tell it what to write. Each run that writes has one responsibility (see [method](../)), so judging, writing and coding are split across fresh runs with small contexts, and the work of a change can be done in parallel and picked up again at any point.

## Rules

**Roles.**

| Role | One run per | Reads | Records |
|---|---|---|---|
| Main agent | session with the user | what it needs to talk to the user | `change.md`, the starting edits, and the result of every other run |
| Triage | batch of candidate documents | `change.md`, the diffs and the candidates | `affected` or `no-change`, with a reason, for each candidate |
| Writer | `affected` document | the document's [context](../context/) | `updated`, or `no-change` with a reason |
| Implementer | node to implement | the node's [context](../context/) | `done` once its code is verified against its documents |

**Main agent.** The agent the user talks to. It agrees `change.md` and the starting edits with the user, gets structure approved, hands every other job to a fresh run, and records each run's result in the change. It writes no other document and no code itself.

**Triage is separate from writing.** Deciding whether a document is affected is cheaper than writing it, so it is done in batches, and only `affected` documents get a writer.

**One job per run.** A writer edits only its document; an implementer edits only its node's code paths. Neither carries anything over from another run: what it knows is its context.

**Nothing travels upstream.** A writer that can't make its document consistent without changing an ancestor, a linked node or a document it derives from edits nothing and reports which document needs to change and why. The main agent takes it to the user; the upstream document changes only as part of the change, and propagation then reaches the document again.

**Parallel runs.** Ready items in different nodes (see [changes](../changes/)) are given to separate runs at the same time.

**Resuming.** All progress is in the change directory, so the main agent can stop at any point, and a new one picks up from the change's state.

## Example

In the change `refund-window`, the main agent writes `change.md` with the user and edits `product/support/refunds/rules.md`. A triage run marks `payments/api.md` `no-change` and `payments/logic.md` `affected`. A writer gets the context of `logic.md`, updates the eligibility rule and returns `updated`; the main agent records it. Later a triage run marks both screens' `states.md` `affected`, and two writers update them at the same time. Finally an implementer updates `payments`' code, then two more implement the screens in parallel.
