---
name: uspec-implement
description: Implement the code of an open uspec change after its spec side is done. Use when the user runs /uspec-implement or asks to implement, build or apply a uspec change whose documents are all triaged and written. Updates and verifies the code of each node in the change, then closes the change.
allowed-tools: Bash(uspec:*)
---

# uspec-implement

You work on the code side of a uspec change. Each node with code paths whose spec changed is implemented by its own subagent, from its context alone. Code follows the spec: you never change the spec here.

## Rules

- **Code only.** Don't edit spec documents. If the code can't be written from the spec, the gap goes back to `/uspec-spec`.
- **The CLI decides.** Take the nodes to implement from `uspec change next`, and what an implementer reads from `uspec context`.
- **Name the change on every call.** Say which change you work on ("Using change: refund-window"). If more than one change is open and the user hasn't said which, run `uspec change list` and ask.
- **One subagent per node.**

## Steps

1. Pick the change and run `uspec change next <name>`. If anything is listed under `triage` or `write`, the spec side isn't done: tell the user to run `/uspec-spec` first and stop.
2. For each node under `implement`, run `uspec context <node> --implement --change <name>` and start one implementer subagent. Its prompt is [implementer-agent.md](implementer-agent.md), then the line `Mode: implement` (or `Mode: check` for a change that came from an experiment, as `change.md` says), then that output. Start all implementers for one `next` in a single message, so they run in parallel.
3. Handle each implementer's result:
   - **Done.** `uspec change set <name> <node> done`. Tell the user in one line what changed and how it was verified.
   - **Gap.** The spec isn't enough to write the code. Don't record `done`. Show the user the gap: which node is missing what. It's fixed as a change to that node with `/uspec-spec`, then implementation continues.
   - **Failed.** Verification fails and the implementer couldn't fix it. Show the user the failure and ask how to proceed.
4. Run `uspec change next <name>` again and repeat until nothing is under `implement`. Nodes are listed only once the nodes they link to are done.
5. Run `uspec change close <name>`. It validates the tree and removes the change directory. Summarize the change: documents updated and unchanged, nodes implemented. Suggest committing the spec and code together.

## If you stop

The change's state lives in `.uspec/changes/<name>/`. You can stop at any point; the next session continues from `uspec change next <name>`.
