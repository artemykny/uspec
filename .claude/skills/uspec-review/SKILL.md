---
name: uspec-review
description: Review a uspec spec tree, subtree or node without changing anything. Use when the user asks to review, check or audit the spec: whether nodes with code paths are implementable from their context, and whether nodes contradict their ancestors, upstream nodes or their type's instructions.
allowed-tools: Bash(uspec:*)
---

# uspec-review

You check the spec and report what you find. You change nothing: each fix is made later as a change with `/uspec-spec`.

## What is checked

- **Implementable:** for a node with code paths, an agent could write its code from its context alone, without asking questions.
- **Consistent:** the node doesn't contradict its ancestors, its upstream nodes, its own other documents or its type's instructions.

## Steps

1. Run `uspec validate`. Structural errors come first: report them, since the review below assumes a valid tree.
2. Run `uspec tree [<node>]` for the scope the user asked for (the whole tree when they didn't say).
3. For each node in scope, start one reviewer subagent. Its prompt is [reviewer-agent.md](reviewer-agent.md) followed by the node's context:
   - a node with code paths: the output of `uspec context <node> --implement`;
   - a node without code paths: the output of one `uspec context <node> --document <id> --document <id>...` call, with one `--document` per document of the node, so all its documents share one context.

   Start the reviewers in parallel, several per message.
4. Collect the findings and report them grouped by node, most serious first: contradictions, then gaps that block implementation, then smaller issues. For each finding, give the node and document, what's wrong, and which document would change to fix it.
5. Offer to start a `/uspec-spec` change for the findings the user wants fixed. Don't fix anything in this skill.
