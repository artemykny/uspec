# uspec-implement

## When it runs

The user runs `/uspec-implement`, or asks to implement, build or apply a change. It works on the code side of an open change, once its spec side is done: nothing is left to triage or write. It names its change as the [shared rules](../overview.md#shared-rules) say.

## Rules

- **Code only.** It edits no spec document. If the code can't be written from the spec, the gap goes back to `uspec-spec` as a change to the node that is missing something.
- **Spec first.** If `uspec change next` lists anything under `triage` or `write`, it tells the user to run `uspec-spec` first and stops.
- **Experiments.** For a change that came from an experiment, as `change.md` says, the code already exists: implementers check it against the spec and fix what doesn't match, instead of writing it.

## Steps

1. Pick the change and run `uspec change next <name>`. Stop if `triage` or `write` isn't empty.
2. For each node under `implement`, run `uspec context <node> --implement --change <name>` and start an implementer with it. All implementers of one `next` are started at once, so they run in parallel.
3. Handle each result:
   - `done`: record it with `uspec change set <name> <node> done`, and tell the user in one line what changed and how it was verified.
   - `gap`: record nothing. Show the user which node is missing what; it's fixed as a change to that node with `uspec-spec`, then implementation continues.
   - `failed`: record nothing. Show the user the failure and ask how to proceed.
4. Run `uspec change next <name>` again, and repeat until nothing is under `implement`. A node is listed only once the nodes it links to are `done`.
5. Run `uspec change close <name>`. Summarize the change for the user (documents updated and unchanged, nodes implemented) and suggest committing the spec and code together.

## Subagents

**Implementer** (`implementer-agent.md`), one per node under `implement`. Its prompt is followed by a mode line, `Mode: implement`, or `Mode: check` for a change from an experiment, then the output of `uspec context <node> --implement --change <name>`.

It reads every listed document, the code under the node's code paths, and the diffs of documents marked `diff since <commit>`. It changes what the node's documents require and nothing else, edits only files under the node's code paths, and relies on other nodes through their contracts as the upstream documents describe them. It doesn't guess: a missing rule, an undefined case or a contract the upstream doesn't provide is a gap. It verifies the code by adding or updating tests for the behaviour the documents describe, running the tests, type checks and linters that cover the code paths, and checking each changed rule, state or contract against the code.

It returns one of:

| Result | Contents |
|---|---|
| `done` | The files changed, and what was run and checked to verify them. |
| `gap` | The node whose spec is missing something, and what it would need to say. |
| `failed` | What fails, and what was tried. |
