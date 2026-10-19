# uspec-review

## When it runs

When the user asks to review, check or audit the spec: the whole tree, a subtree or a single node. It works on the spec as it is and doesn't take a change.

## Rules

- **Read-only.** It changes nothing. Each fix is made later as a change with [`uspec-spec`](../uspec-spec/behaviour.md).
- **Implementable:** for a node with code paths, an agent could write its code from its [context](../../method/context/rules.md) alone, without asking questions. Nodes without code paths are only checked for consistency.
- **Consistent:** the node doesn't contradict its ancestors, its upstream nodes, its own other documents or its type's instructions.
- **Real problems only.** A finding points to text in the spec. Style and wording aren't reviewed.

## Steps

1. Runs [`uspec validate`](../../cli/validate/usage.md) and reports any structural errors first, since the review assumes a valid tree.
2. Runs [`uspec tree [<node>]`](../../cli/tree/usage.md) for the scope the user asked for, the whole tree if they didn't say.
3. Starts one reviewer subagent per node in scope, in parallel.
4. Reports the findings grouped by node, most serious first: contradictions, then gaps that block implementation, then smaller issues. Each gives the node and document, what's wrong, and which document should change to fix it.
5. Offers to start a `uspec-spec` change for the findings the user wants fixed.

## Subagents

**Reviewer**, one per node in scope. Its prompt is `reviewer-agent.md`, followed by the node's [`uspec context`](../../cli/context/usage.md) output:

- a node with code paths: `uspec context <node> --implement`;
- a node without code paths: `uspec context <node> --document <id>...`, one `--document` per document, so all its documents share one context.

It reads every listed file but not the code, and checks the node as the rules above say. It returns one block per finding, most serious first, or `No findings.`:

```
<contradiction | gap | missing link>
Where: <document path, section>
Problem: <what's wrong, quoting the text>
Fix in: <which document should change>
```
