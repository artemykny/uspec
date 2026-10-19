# uspec drift

```
uspec drift
```

## Behaviour

Applies the [drift rules](../../method/drift/) to every node in the tree:

1. Collects the nodes under `implementation` in every change in `.uspec/changes/`, whatever their state. These are skipped. A change that can't be read is ignored.
2. Checks each other node whose type has `code: true` and that has code paths. Its code is its code paths; its spec is its documents, their `-extra/` folders and its `node.yaml`.
3. The node drifts, with the first reason that applies:
   - its code has uncommitted changes (untracked files included) and its spec has none: `uncommitted code changes without a spec change`;
   - the last commit that touched its code has a later commit time than the last commit that touched its spec: `code changed in <sha> after the spec last changed`;
   - its code has a commit and its spec has none: `code changed in <sha>, spec never committed`.

   Commits are compared by commit time, not by ancestry, so code and spec changed in the same commit don't drift. Code with no commit and no uncommitted changes doesn't drift.

The check is a heuristic: it assumes the spec and code of a change are committed together.

## Output

One line per drifting node, `<node>: <reason>`, in tree order. `<sha>` is the commit's short hash (7 characters):

```
$ uspec drift
system/services/payments: code changed in 9b1d0a3 after the spec last changed
web/checkout: uncommitted code changes without a spec change
```

Without drift:

```
No drift: every node's code matches a committed spec change.
```

With `--json`, the drifting nodes as a list, empty without drift:

```json
{
  "drift": [
    {
      "node": "system/services/payments",
      "reason": "code changed in 9b1d0a3 after the spec last changed"
    }
  ]
}
```

Exits with 1 when any node drifts (after printing the output), with 0 otherwise.

## Errors

Only the errors shared by all commands (see [CLI](../#errors-and-exit-codes)): no project, or a missing spec root. Git failures don't fail the command: a git call that fails counts as no commit and no uncommitted changes, so outside a git repository no node drifts.
