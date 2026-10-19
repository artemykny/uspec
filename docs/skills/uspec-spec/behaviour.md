# uspec-spec

Works on the spec side of a [change](../../method/changes/rules.md): it talks to the user, writes `change.md`, makes the starting edits, and hands triage and writing to subagents. It never touches code; implementation is left to [`uspec-implement`](../uspec-implement/behaviour.md).

## When it runs

The user wants to change what the product does, add, move or remove spec nodes, continue an open change, or keep the code of an [experiment](../../method/experiments/rules.md) by turning it into a spec change.

The skill runs `uspec change list` and picks a mode:

- **Start a change:** no change is open, or the user describes a new one.
- **Continue a change:** a change is open and the user wants to go on with it. Changes are processed one at a time, oldest first, so the open one is finished before another starts.
- **From an experiment:** the user has code made without a spec and wants to keep it.

## Rules

The [shared rules](../overview.md#shared-rules) of all skills apply. In addition:

- **Spec only.** It never edits code, even when the user asks to "build" or "fix" something.
- **Re-read from disk.** Files may have changed since the skill last read them, so it reads them again before using them.
- **The main agent writes only the start.** It writes `change.md` and the starting edits with the user; every other document is written by a writer subagent.

## Steps

**Start a change.**

1. Derives a short kebab-case name from the request and runs `uspec change new <name>`.
2. Asks what changes and why until it's clear, and finds the highest node the change affects, using `uspec tree` and the candidate nodes' documents.
3. Writes `.uspec/changes/<name>/change.md`: a title, `Starts at: <node path>`, and what changes and why in a few sentences, with the constraints the user gave. The user approves it.
4. If the change adds, moves or removes nodes, proposes the structure first, one line per node with path, type and links. The user approves, renames, merges or cuts. The skill applies it with `uspec node new | move | remove` and runs `uspec validate`.
5. Edits the starting node's documents, or the new nodes' documents in dependency order, with the user. Before each it reads `uspec context <node> --document <id> --change <name>` and follows its instructions, and shows the edit to the user.
6. Records each edited document with `uspec change set <name> <document> updated`, and tells the user how many candidates it reached and where.
7. Continues with **Continue a change**.

**Continue a change.** Repeats until `uspec change next <name>` has nothing under `triage` and `write`:

1. Runs `uspec change next <name>`.
2. **Triage.** For a `triage` batch, starts one triage subagent and records each decision with `uspec change set <name> <document> affected | no-change --reason "<reason>"`. A candidate left without a decision goes to a new triage run.
3. **Write.** For each node under `write`, runs `uspec context <node> --document <id>... --change <name>`, with one `--document` per document listed for the node, and starts one writer subagent with it. All writers of one `next` start at once and run in parallel.
4. Handles each writer's results, one per document:
   - `updated`: if it is user-visible, shows the diff and waits for approval; then records `updated`, which propagates.
   - `no change`: records `no-change` with the writer's reason.
   - `blocked`: stops, explains the conflict to the user, and edits the upstream document with them as in step 5 of **Start a change** ([nothing travels upstream](../../method/agents/rules.md)).
5. Gives the user a one-line update after each round: what was triaged, what was updated.

When nothing is left to triage or write, it runs `uspec validate`, summarizes the documents updated, the documents unchanged and the nodes added to implementation, and tells the user to run `/uspec-implement`.

**From an experiment.**

1. Reads the code diff: `git diff` against the branch point, or what the user points to.
2. Finds the highest node it affects and opens a change as in **Start a change**; `change.md` says it comes from an experiment.
3. Proposes the document edits that describe the new behaviour. The user reviews them closely and keeps only what was intended.
4. Records the edits as `updated` and continues as a normal change.

## Subagents

Each subagent's prompt is a file next to the skill, followed by the CLI output it reads.

| Subagent | Prompt | Started with | Returns |
|---|---|---|---|
| Triage | `triage-agent.md` | the batch exactly as `uspec change next` printed it: the files under `read` and the candidates under `batch` with the rules that reached them | one line per candidate, in batch order: `<document path> \| affected \| <reason>` or `<document path> \| no-change \| <reason>`, then optional notes, such as a link that seems missing |
| Writer | `writer-agent.md` | the output of `uspec context <node> --document <id>... --change <name>`, one `--document` per document of the node under `write` | one result per document, in the order given: `updated` with a one-line summary and `user-visible: yes \| no`; `no change` with a reason; or `blocked` with the upstream document that needs to change and why |

Triage edits no file; it decides every candidate on its own text, with a one-line reason that can be checked against the document. Triage runs on Sonnet, since it only judges; writers run on the main agent's model. A writer edits only its documents and decides each one on its own. A change is user-visible when it touches an API, a user story, a business rule or text users read.
