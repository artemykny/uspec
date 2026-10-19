# uspec-spec

Works on the parts of a [change](../../method/changes/rules.md) that need a conversation with the user: it writes `change.md` with them until it is approved, agrees on the structure, and later resolves what an agent couldn't. It never touches code, and it starts no agent that works on the change: the [VS Code extension](../../vscode/overview.md) runs the impact, triage, writer, planner and implementer agents, and the skill hands the change over to it.

## When it runs

The user wants to change what the product does, add, move or remove spec nodes, go on with an open change, or keep the code of an [experiment](../../method/experiments/rules.md) by turning it into a spec change.

The skill runs `uspec change list` and picks a mode:

- **Start a change:** no change is open, or the user describes a new one.
- **Continue a change:** a change is open and the user wants to go on with it. Changes are processed one at a time, oldest first, so the open one is finished before another starts.
- **From an experiment:** the user has code made without a spec and wants to keep it.

## Rules

The [shared rules](../overview.md#shared-rules) of all skills apply. In addition:

- **Spec only.** It never edits code, even when the user asks to "build" or "fix" something.
- **Re-read from disk.** Files may have changed since the skill last read them, so it reads them again before using them.
- **The preview comes first.** No document is edited until `change.md` is approved. `change.md` is detailed enough that someone who hasn't seen the conversation could make the change from it: every rule, every case, and a worked example with real values.
- **The skill writes only what the user writes with it.** `change.md`, the structure, and the upstream edits that resolve a blocked writer or a gap. Every other document is written by the extension's agents.

## Steps

**Start a change.**

1. Derives a short kebab-case name from the request and runs `uspec change new <name>`, which creates `change.md` from the change template.
2. Reads `uspec tree` and the documents the request is about, so it knows what the product does today.
3. Writes `change.md` with the user, section by section as the template has them. It asks about what is unclear and proposes the cases the user hasn't named, and writes the worked example with concrete values, before and after. It shows `change.md` and revises it until the user approves it.
4. If the change adds, moves or removes nodes, proposes the structure: one line per node with path, type and links, the links as narrow as what the node is built from (a document or a section). The user approves, renames, merges or cuts. The skill applies it with `uspec node new | move | remove` and runs `uspec validate`.
5. Hands the change over: tells the user to open the uspec Changes view in VS Code and run **Run Agents** on the change, which finds the starting documents for them to review, then propagates, triages, writes, plans and implements, stopping whenever it needs them.

**Continue a change.** Runs `uspec change next <name>` and acts on what it finds:

- The impact step is due: offers to revise `change.md` with the user, then hands over as in step 5.
- The user brings a blocked writer or an implementer's gap: finds the upstream document that must change, reads `uspec context <node> --document <id> --change <name>` and follows its instructions, edits the document with the user, shows the edit, and records it with `uspec change set <name> <document> updated` ([nothing travels upstream](../../method/agents/rules.md)). It tells the user how many candidates it reached, then hands over.
- Anything else: tells the user what is next, from `next`, and hands over.

**From an experiment.**

1. Reads the code diff: `git diff` against the branch point, or what the user points to.
2. Opens a change as in **Start a change**, and writes `change.md` from the diff with the user: the behaviour the code introduces, with a worked example. `change.md` says it comes from an experiment. The user reviews it closely and keeps only what was intended.
3. Hands over as in step 5. Implementers check the existing code instead of writing it.

## Agent prompts

The prompts of the change's agents sit next to the skill, so they are installed with it; the extension runs them (see [skills](../overview.md#agent-prompts) and [VS Code](../../vscode/overview.md#agents)).

| Agent | Prompt | Input after the prompt | Returns |
|---|---|---|---|
| Impact | `impact-agent.md` | the path of `change.md` and the output of `uspec tree` | one line per starting document: `<document path> \| <reason>`, then optional notes, such as a node that seems missing |
| Triage | `triage-agent.md` | the batch exactly as `uspec change next` prints it: the files under `read` and the candidates under `batch` with the rules that reached them | one line per candidate, in batch order: `<document path> \| affected \| <reason>` or `<document path> \| no-change \| <reason>`, then optional notes, such as a link that seems missing |
| Writer | `writer-agent.md` | the output of `uspec context <node> --document <id>... --change <name>`, one `--document` per document of the node under `write` | one result per document, in the order given: `updated` with a one-line summary and `user-visible: yes \| no`; `no change` with a reason; or `blocked` with the upstream document that needs to change and why |
| Planner | `planner-agent.md` | the plans directory, the nodes to plan and the plans already written, then the output of `uspec context <node> --implement --change <name>` for each node to plan | `planned`, then one line per plan written: `<plan id> \| <nodes> \| after: <ids>`; or `failed` with why |
| Implementer | `implementer-agent.md` | a mode line, `Mode: implement`, or `Mode: check` for a change from an experiment; the plan's path; then the output of `uspec context <node> --implement --change <name>` for each of its nodes | `done` with the files changed and what was run to verify them; `gap` with the node whose spec is missing something and what; or `failed` with what fails |

Impact names only documents `change.md` changes directly, each with a one-line reason that can be checked against `change.md`; it edits nothing. Triage edits no file; it decides every candidate on its own text, with a one-line reason that can be checked against the document. A writer edits only its documents and decides each one on its own. A change is user-visible when it touches an API, a user story, a business rule or text users read. The planner writes only in the plans directory, a plan per independent part of the work, in the [plan format](../../method/changes/rules.md). An implementer edits only files under its plan's nodes' code paths, relies on other nodes through their contracts as the upstream documents describe them, and doesn't guess: a missing rule, an undefined case or a contract the upstream doesn't provide is a gap. It verifies the code by adding or updating tests for the behaviour the documents describe, running the tests, type checks and linters that cover the code paths, and checking each changed rule, state or contract against the code.
