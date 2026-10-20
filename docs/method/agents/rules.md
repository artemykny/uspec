# Agents

An **agent** is one run of a model doing one job of a [change](../changes/). There are no separately defined agents: the job decides what an agent reads, which is its [context](../context/), and the documents' templates and the type's instructions tell it what to write. Each run that writes has one responsibility (see [method](../)), so judging, writing, planning and coding are split across separate runs with small contexts, which may share a session, and the work of a change can be done in parallel and picked up again at any point.

## Rules

**Roles.**

| Role | One run per | Reads | Returns |
|---|---|---|---|
| Main agent | session with the user | what it needs to talk to the user | `change.md`, the structure, and the upstream edits the user makes with it |
| Impact | change, before it has documents | `change.md` and the tree | the starting documents, each with a reason |
| Triage | batch of candidate documents | `change.md`, the diffs and the candidates | `affected` or `no-change`, with a reason, for each candidate |
| Writer | node with ready `affected` documents | the [context](../context/) of those documents | for each document, `updated`, or `no-change` with a reason |
| Splitter | settled change with unplanned nodes, unless the split is skipped | change and implementation contexts | Markdown split proposal: plan paths, nodes and dependencies |
| Planner | approved plan | change and contexts of that plan’s nodes | one implementation plan |
| Implementer | ready plan | the plan and the [context](../context/) of its nodes | `done` once the code is verified against their documents |

**Main agent.** The agent the user talks to. It writes `change.md` with the user until it is approved, and gets structure approved. When a run can't go on without the user, a blocked writer or a gap in the spec, it resolves it with them: the upstream document is edited with the user and recorded as `updated`. Its session can also be given jobs of the change (see sessions): for such a run the job's permissions and result apply, not the main agent's, and afterwards the session is the user's again. Outside such jobs it writes no other document and no code, and starts no other run.

**Orchestrator.** The other runs are started by an orchestrator, a tool, not an agent: it reads what is ready from the change, starts a run per item, in the session its configuration names, records each result in the change, and stops when the user is needed: to approve the starting documents, a writer's update or the plans, or to resolve a blocked writer, a gap or a failure. In uspec it is the [VS Code extension](../../vscode/overview.md).

**Impact is a start.** Impact decides where the change starts, not everything it reaches: it reads `change.md` and the tree and names the documents `change.md` changes directly. The user reviews the list before anything is recorded. Propagation and triage find the rest.

**Triage is separate from writing.** Deciding whether a document is affected is cheaper than writing it, so it is done in batches, and only `affected` documents get a writer. Triage edits no spec; its Markdown recommendations wait for user approval, with optional file comments, before recording. Triage writes nothing, so it can run on a cheaper, faster model than writers and implementers, in a session no other role uses.

**Plan before code.** Split first: a splitter proposes independent plan files and their node ownership/dependencies. The user approves the split. The split can be skipped by configuration: one plan then holds every unplanned node, and there is no split to approve. Each plan then gets its own planner run; generation can run in parallel. There is no global implementation plan. Every generated plan is reviewed before implementation begins; dependencies constrain implementation, not generation.

**One job per run.** A writer edits only its documents, and decides each one on its own; a planner writes only plans; an implementer edits only the code paths of its plan's nodes. A run returns only its own job's result. What a run builds on is its context; in a shared session it also holds the earlier runs of that session, but that isn't part of its context (see [context](../context/)).

**Sessions.** Every run is in a session. The configuration names, per role, the session its runs go to; a name can include the item, the round of triage and writing, the node or the plan, so a role can have one session per item. Runs of one change whose names are the same share one session: each next run continues it with its own job. A name not used yet starts a new session, or, if the configuration says so, a fork of an earlier session: it starts with that session's history, and the two then go on separately. A role with no name gets a new session for every run; this is the default, and then nothing carries over between runs. The main agent's session can be named, so runs continue the session the user described the change in. The user chooses the configuration per change, from named ones, and can change it at any step; each run takes its name from the configuration when it starts. When a session's context grows too large, the user can start a new context: the change's sessions are forgotten, and the next run of each name starts a new session that later runs continue. Sessions belong to one change and close when it closes. A session keeps one model: a role's own model applies only in a session no other role uses.

**Shared sessions.** A run in a session that already did a job doesn't rely on what earlier runs read: the user or other runs may have changed those files since, so it re-reads anything before relying on it. Its permissions, input and result are its own job's, never those of an earlier run in the session.

**Nothing travels upstream.** A writer that can't make a document consistent without changing its parent, a linked node or a document it derives from doesn't edit that document, and reports which document needs to change and why; an implementer that can't write the code from the spec reports the gap. The orchestrator stops, and the user resolves it with the main agent; the upstream document changes only as part of the change, and propagation then reaches the document again.

**Parallel runs.** Ready items in different nodes (see [changes](../changes/)), and ready plans, are given to separate runs at the same time. Runs in the same session wait for each other: a session does one job at a time.

**Resuming.** All progress is in the change directory, so the orchestrator can stop at any point and pick up from the change's state.

## Example

In the change `refund-window`, the user writes `change.md` with the main agent, with the worked example of a refund requested on day 20. In VS Code, the impact run names `product/support/refunds/rules.md`, and the user keeps it. A writer updates it. A triage run marks `payments/api.md` `no-change` and `payments/logic.md` `affected`. A writer gets the context of `logic.md`, updates the eligibility rule and returns `updated`; the extension records it. Later a triage run marks the screen's `states.md` `affected`, and a writer updates it. The splitter proposes two plans, each generated by a separate planner after approval, `payments` and `refund-screens`, the second after the first; the user reads them, and two implementers run one after the other. Every run here is in a new session, the default. Had the configuration named the main agent's session for every role and skipped the split, each of these runs would have continued that one session, one after the other, and one plan would have held both nodes.
