# Agents

An **agent** is one run of a model doing one job of a [change](../changes/). There are no separately defined agents: the job decides what an agent reads, which is its [context](../context/), and the documents' templates and the type's instructions tell it what to write. Each run that writes has one responsibility (see [method](../)), so judging, writing, planning and coding are split across fresh runs with small contexts, and the work of a change can be done in parallel and picked up again at any point.

## Rules

**Roles.**

| Role | One run per | Reads | Returns |
|---|---|---|---|
| Main agent | session with the user | what it needs to talk to the user | `change.md`, the structure, and the upstream edits the user makes with it |
| Impact | change, before it has documents | `change.md` and the tree | the starting documents, each with a reason |
| Triage | batch of candidate documents | `change.md`, the diffs and the candidates | `affected` or `no-change`, with a reason, for each candidate |
| Writer | node with ready `affected` documents | the [context](../context/) of those documents | for each document, `updated`, or `no-change` with a reason |
| Splitter | settled change with unplanned nodes | change and implementation contexts | Markdown split proposal: plan paths, nodes and dependencies |
| Planner | approved plan | change and contexts of that plan’s nodes | one implementation plan |
| Implementer | ready plan | the plan and the [context](../context/) of its nodes | `done` once the code is verified against their documents |

**Main agent.** The agent the user talks to. It writes `change.md` with the user until it is approved, and gets structure approved. When a run can't go on without the user, a blocked writer or a gap in the spec, it resolves it with them: the upstream document is edited with the user and recorded as `updated`. It writes no other document and no code, and starts no other run.

**Orchestrator.** The other runs are started by an orchestrator, a tool, not an agent: it reads what is ready from the change, starts a fresh run per item, records each result in the change, and stops when the user is needed: to approve the starting documents, a writer's update or the plans, or to resolve a blocked writer, a gap or a failure. In uspec it is the [VS Code extension](../../vscode/overview.md).

**Impact is a start.** Impact decides where the change starts, not everything it reaches: it reads `change.md` and the tree and names the documents `change.md` changes directly. The user reviews the list before anything is recorded. Propagation and triage find the rest.

**Triage is separate from writing.** Deciding whether a document is affected is cheaper than writing it, so it is done in batches, and only `affected` documents get a writer. Triage edits no spec; its Markdown recommendations wait for user approval, with optional file comments, before recording. Triage writes nothing, so it can run on a cheaper, faster model than writers and implementers.

**Plan before code.** Split first: a splitter proposes independent plan files and their node ownership/dependencies. The user approves the split. Each plan then gets its own planner and session; generation can run in parallel. There is no global implementation plan. Every generated plan is reviewed before implementation begins; dependencies constrain implementation, not generation.

**One job per run.** A writer edits only its documents, and decides each one on its own; a planner writes only plans; an implementer edits only the code paths of its plan's nodes. None carries anything over from another run: what it knows is its context.

**Nothing travels upstream.** A writer that can't make a document consistent without changing an ancestor, a linked node or a document it derives from doesn't edit that document, and reports which document needs to change and why; an implementer that can't write the code from the spec reports the gap. The orchestrator stops, and the user resolves it with the main agent; the upstream document changes only as part of the change, and propagation then reaches the document again.

**Parallel runs.** Ready items in different nodes (see [changes](../changes/)), and ready plans, are given to separate runs at the same time.

**Resuming.** All progress is in the change directory, so the orchestrator can stop at any point and pick up from the change's state.

## Example

In the change `refund-window`, the user writes `change.md` with the main agent, with the worked example of a refund requested on day 20. In VS Code, the impact run names `product/support/refunds/rules.md`, and the user keeps it. A writer updates it. A triage run marks `payments/api.md` `no-change` and `payments/logic.md` `affected`. A writer gets the context of `logic.md`, updates the eligibility rule and returns `updated`; the extension records it. Later a triage run marks the screen's `states.md` `affected`, and a writer updates it. The splitter proposes two plans, each generated by a separate planner after approval, `payments` and `refund-screens`, the second after the first; the user reads them, and two implementers run one after the other.
