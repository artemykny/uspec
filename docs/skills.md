# Skills

The user works with uspec through skills for Claude Code and Codex. Skills do the work that needs judgement: talking to the user, proposing structure, writing documents and code. They call the [CLI](cli.md) for everything mechanical: what to read, where a change goes, what is left to do. The process is described in [workflow.md](workflow.md).

| Skill | Mode | What it does |
|---|---|---|
| [`uspec-spec`](#uspec-spec) | Change spec | Starts a change, or continues the open one: triages candidates and writes affected documents. |
| [`uspec-implement`](#uspec-implement) | Implement | Writes and verifies the code of pending nodes, then closes the change. |
| [`uspec-review`](#uspec-review) | — | Checks that nodes are implementable and consistent with their upstream. |
| [`uspec-onboard`](#uspec-onboard) | — | Builds the first tree from an existing codebase. |

## Agents

A skill is run by the agent the user talks to, the **main agent**. It talks to the user, writes `change.md` and makes the starting edits with them, runs the CLI and records results with `uspec change set`. The rest of the work goes to fresh subagents:

| Subagent | One run per | Reads | Records |
|---|---|---|---|
| Triage | batch of candidates from `uspec change next` | `change.md`, the diffs and the candidates | `affected` or `no-change`, with a reason, for each candidate |
| Writer | affected document | the output of `uspec context <node> --document <id>` | `updated` |
| Implementer | node to implement | the output of `uspec context <node> --implement` | `done` |

Writers and implementers have [one responsibility](product-overview.md#agents): one document of one node, or the code of one node. Ready items in different nodes are handled in parallel.

Every CLI call names the change. A skill says which change it works on ("Using change: refund-window"), and asks when more than one is open and the user hasn't said.

Because the state lives in the change directory, a skill can stop at any point and be run again in a new session. It picks up from `uspec change next`.

## uspec-spec

Works on the spec side of a change. What it does depends on whether a change is open.

**Start a change.** No change is open, or the user describes a new one:

1. Opens the change with `uspec change new`.
2. Asks what changes and why, finds the highest node it affects, and writes `change.md`. The user approves it.
3. If the change adds, moves or removes nodes, proposes the structure first: paths, types, links, one line each. The user approves, renames, merges or cuts. Then it applies it with `uspec node`.
4. Edits the starting node's documents, or new nodes' documents in dependency order, and the user reviews them.
5. Records each edited document as `updated`, which propagates the change.

**Continue a change.** A change is open. The skill repeats until `uspec change next` returns nothing to triage or write:

- **Triage:** a triage subagent decides the batch, and the skill records each decision with its reason.
- **Write:** one writer subagent per ready document. The skill records each as `updated`, which can add new candidates.

Updates the user should see, such as a changed API or a new user story, are shown for review before they are recorded.

**From an experiment.** Started with a code diff instead of a description ([experiments](workflow.md#experiments)): the skill reads the diff, finds the highest node it affects and proposes the document edits. The user reviews them closely, since they describe what the code does rather than what was intended. Then it continues as a normal change.

## uspec-implement

Works on the code side of the open change. Runs once no documents are pending or affected.

1. Takes the ready nodes from `uspec change next`. A node is ready when the nodes it links to are done.
2. For each, an implementer subagent reads `uspec context <node> --implement`, updates the code at the node's code paths and verifies it against the node's documents.
3. Records `done`. If the code can't be written from the spec, the gap goes back to `uspec-spec` as a change to the node that is missing something.
4. When nothing is left, runs `uspec change close`.

For a change that started from an experiment, the code already exists: the implementer checks it against the spec and fixes what doesn't match.

## uspec-review

Checks the tree, a subtree or a single node, without changing anything:

- **Implementable:** an agent could write the node's code from its context alone, without asking questions.
- **Consistent:** the node doesn't contradict its ancestors, its upstream nodes or its type's `instructions`.

It reports what it finds, and each fix is made as a change with `uspec-spec`.

## uspec-onboard

> **TODO:** how the first tree is built from an existing codebase ([workflow.md](workflow.md#4-onboard-an-existing-codebase)).
