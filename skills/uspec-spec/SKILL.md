---
name: uspec-spec
description: Change the product spec with uspec. Use when the user wants to change what the product does, add, move or remove spec nodes, continue an open uspec change, or turn an experimental code diff into a spec change. Works only on the spec tree, never on code.
allowed-tools: Bash(uspec:*)
---

# uspec-spec

You work on the spec side of a uspec change: you talk to the user, write `change.md`, make the starting edits, and hand triage and writing to subagents. The `uspec` CLI does everything mechanical: what to read, where a change goes, what is ready. The process is described in `docs/method/changes/rules.md` of the uspec project; this skill follows it.

## Rules

- **Spec only.** Never edit code, even if the user asks to "build" or "fix" something. When the spec side is done, tell the user to run `/uspec-implement`.
- **The CLI decides.** Take what to do next from `uspec change next`, and what an agent reads from `uspec context`. Don't pick files or order yourself.
- **Name the change on every call.** Say which change you work on ("Using change: refund-window"). If more than one change is open and the user hasn't said which, run `uspec change list` and ask.
- **Re-read from disk.** Files may have been edited since you last saw them. Read them again before you use them.
- **One subagent per document.** You write `change.md` and the starting edits with the user. Every other document is written by its own writer subagent.

## Pick the mode

Run `uspec change list`.

- No change is open, or the user describes a new one: **Start a change**.
- A change is open and the user wants to continue it: **Continue a change**. Changes are processed one by one, oldest first; finish the open one before starting another.
- The user has code changes made without a spec (an experiment) and wants to keep them: **From an experiment**.

## Start a change

1. Derive a short kebab-case name from the request (`refund-window`) and run `uspec change new <name>`.
2. Ask what changes and why until it's clear. Find the highest node the change affects: run `uspec tree` and read the candidate nodes' documents.
3. Write `.uspec/changes/<name>/change.md`:

   ```markdown
   # <Title>

   Starts at: <node path>

   <What changes and why, in a few sentences. Include constraints the user gave you.>
   ```

   Show it to the user and wait for approval.
4. If the change adds, moves or removes nodes, propose the structure first: one line per node with path, type and links. The user approves, renames, merges or cuts. Apply it with `uspec node new | move | remove`. Run `uspec validate`.
5. Edit the starting node's documents, or new nodes' documents in dependency order, with the user. Read `uspec context <node> --document <id> --change <name>` first and follow its instructions. Show each edit to the user.
6. Record each edited document: `uspec change set <name> <document> updated`. The output lists the candidates it reached; tell the user how many and where.
7. Continue with **Continue a change**.

## Continue a change

Repeat until `uspec change next <name>` prints nothing under `triage` and `write`:

1. Run `uspec change next <name>`.
2. **Triage.** If there's a `triage` batch, start one triage subagent. Its prompt is [triage-agent.md](triage-agent.md) followed by the batch exactly as `next` printed it (the files under `read` and the candidates under `batch`, with their reasons). Record every decision it returns:

   ```
   uspec change set <name> <document> affected --reason "<reason>"
   uspec change set <name> <document> no-change --reason "<reason>"
   ```

   Every candidate in the batch must get a decision. If one is missing, start the triage subagent again for the missing ones.
3. **Write.** For each document under `write`, run `uspec context <node> --document <id> --change <name>` and start one writer subagent. Its prompt is [writer-agent.md](writer-agent.md) followed by that output. Start all writers for one `next` in a single message, so they run in parallel.
4. Handle each writer's result:
   - **Updated.** If the change is one the user should see (an API, a user story, a business rule, text users read), show the diff and wait for approval. Then `uspec change set <name> <document> updated`.
   - **No change.** The writer found nothing to change: `uspec change set <name> <document> no-change --reason "<writer's reason>"`.
   - **Blocked.** The document can't be written without changing something upstream of it. Stop, explain the conflict to the user, and edit the upstream document with them first (as in step 5 of **Start a change**).
5. Give the user a one-line update after each round: what was triaged, what was updated.

When nothing is left to triage or write, run `uspec validate` and summarize: documents updated, documents unchanged, nodes added to implementation. Tell the user to run `/uspec-implement`.

## From an experiment

The user has code that isn't backed by the spec.

1. Read the code diff (`git diff` against the branch point, or what the user points to).
2. Find the highest node it affects and open a change as in **Start a change**. In `change.md`, say that it comes from an experiment.
3. Propose the document edits that describe the new behaviour. Ask the user to review them closely: a spec written from code tends to describe what the code does, including accidents, rather than what was intended. Only keep what the user confirms as intended.
4. Record the edits as `updated` and continue as a normal change. `/uspec-implement` will check the existing code against the spec instead of writing it.

## If you stop

The change's state lives in `.uspec/changes/<name>/`. You can stop at any point; the next session continues from `uspec change next <name>`.
