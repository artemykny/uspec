---
name: uspec-spec
description: Describe a product change with uspec. Use when the user wants to change what the product does, add, move or remove spec nodes, continue an open uspec change, resolve a blocked writer or an implementation gap, or turn an experimental code diff into a spec change. Writes change.md and the structure with the user, then hands the change to the uspec VS Code extension. Works only on the spec tree, never on code.
allowed-tools: Bash(uspec:*)
---

# uspec-spec

You do the parts of a uspec change that need a conversation with the user: you write `change.md` with them until they approve it, agree on the structure, and resolve what an agent couldn't. The `uspec` CLI does everything mechanical. The process is described in `docs/method/changes/rules.md` of the uspec project; this skill follows it.

You don't run the change. The uspec VS Code extension orchestrates it: it finds the starting documents, propagates, triages, writes, plans and implements, with the agent prompts next to this skill (`impact-agent.md`, `triage-agent.md`, `writer-agent.md`, `planner-agent.md`, `implementer-agent.md`). Never start those agents yourself. When that work is next, tell the user to continue in VS Code.

## Rules

- **Spec only.** Never edit code, even if the user asks to "build" or "fix" something.
- **The preview comes first.** Edit no spec document until `change.md` is approved.
- **You write only what the user writes with you.** `change.md`, the structure, and the upstream edits that resolve a blocked writer or a gap. Every other document is written by the extension's agents.
- **The CLI decides.** Take what is open and ready from `uspec change list` and `uspec change next`, and what to read for a document from `uspec context`. Don't pick files or order yourself.
- **Name the change on every call.** Say which change you work on ("Using change: refund-window"). If more than one change is open and the user hasn't said which, run `uspec change list` and ask.
- **Re-read from disk.** Files may have been edited since you last saw them. Read them again before you use them.

## Pick the mode

Run `uspec change list`.

- No change is open, or the user describes a new one: **Start a change**.
- A change is open and the user wants to go on with it, or brings a blocked writer or a gap: **Continue a change**. Changes are processed one by one, oldest first; finish the open one before starting another.
- The user has code changes made without a spec (an experiment) and wants to keep them: **From an experiment**.

## Start a change

1. Derive a short kebab-case name from the request (`refund-window`) and run `uspec change new <name>`. It creates `.uspec/changes/<name>/change.md` from the change template.
2. Run `uspec tree` and read the documents the request is about, so you know what the product does today.
3. Write `change.md` with the user, following the template's sections:

   - **Why**: the problem, and who has it.
   - **What changes**: the new behaviour, rule by rule; every case it touches, and what stays as it is; the constraints the user gave.
   - **Worked example**: one or more concrete scenarios, step by step, with real values: what the user does, what the product does, what it shows and stores. Before and after, where behaviour changes.
   - **Out of scope**: what the change doesn't do.

   It must be detailed enough that someone who hasn't seen this conversation could make the change from it alone: agents that read it later have nothing else. Ask about what is unclear, and propose the cases the user hasn't named (limits, errors, existing data, who sees what). Replace every `<…>` of the template. Show `change.md` and revise it until the user approves it.
4. If the change adds, moves or removes nodes, propose the structure: one line per node with path, type and links. Make links as narrow as what the node is built from: a node (`product/support/refunds`), a document (`product/support/refunds/rules.md`) or a section (`product/support/refunds/rules.md#refund-window`, the heading's anchor). The user approves, renames, merges or cuts. Apply it with `uspec node new | move | remove` and run `uspec validate`.
5. Hand the change over. Tell the user: open the uspec **Changes** view in VS Code and run **Run Agents** on `<name>`. It first finds the starting documents and asks them to review the list, then propagates, triages and writes the documents, plans the code and implements the plans, stopping whenever it needs them.

## Continue a change

Run `uspec change next <name>` and act on what it says:

- **`impact` is due.** `change.md` isn't used yet. Offer to revise it with the user, then hand over as in step 5.
- **The user brings a blocked writer or a gap.** A writer couldn't make a document consistent without an upstream change, or an implementer found the spec missing something. Find the upstream document that must change. Read `uspec context <node> --document <id> --change <name>` and follow its instructions. Edit the document with the user, show the edit, and record it: `uspec change set <name> <document> updated`. The output lists the candidates it reached; tell the user how many and where. Then hand over as in step 5.
- **Anything else.** Tell the user in one line what is next (documents to triage or write, plans to write, plans to implement) and hand over as in step 5.

## From an experiment

The user has code that isn't backed by the spec.

1. Read the code diff (`git diff` against the branch point, or what the user points to).
2. Open a change as in **Start a change**, and write `change.md` from the diff with the user: the behaviour the code introduces, with a worked example. Say in `change.md` that the change comes from an experiment. Ask the user to review it closely: a spec written from code tends to describe what the code does, including accidents, rather than what was intended. Keep only what the user confirms as intended.
3. Hand over as in step 5. Implementers will check the existing code against the spec instead of writing it.

## If you stop

The change's state lives in `.uspec/changes/<name>/`. You can stop at any point; the extension and the next session continue from `uspec change next <name>`.
