# uspec change

```
uspec change new <name>
uspec change list
uspec change status <name>
uspec change next <name>
uspec change set <name> <document | node> <state> [--reason <text>]
uspec change close <name>
```

## Behaviour

Manages the [change directory](../../method/changes/) `.uspec/changes/<name>/` and its `status.yaml`. Every subcommand except `new` and `list` names the change it works on.

| Subcommand | What it does |
|---|---|
| `new` | Creates the directory with an empty `change.md`, and `status.yaml` with the current commit as `baseline`, the current time as `created`, and no items. The name is kebab-case: lowercase letters, digits and `-`. |
| `list` | Lists open changes, oldest first (by `created`, then by name), with a count of items per state. Changes are processed in this order. |
| `status` | Prints every item in `status.yaml` with its state, and its reason, or for a pending document the rules that reached it. |
| `next` | Prints the items that are ready, grouped by what to do with them. |
| `set` | Records an item's state and, for `updated`, propagates. |
| `close` | Runs `validate` and removes the change directory. |

### next

Prints only what can be done now, in three groups. Items that aren't [ready](../../method/changes/) are left out.

- `triage`: the ready `pending` documents as one batch, each with the rules that reached it, and the files the triage agent reads with them: `change.md` and every `updated` document that can reach a document in the batch, as a diff since the baseline.
- `write`: the ready `affected` documents, one writer each.
- `implement`: the nodes under `implementation` that aren't `done` and whose linked nodes aren't pending in the change, one implementer each. Nodes are listed only once every document in the change is settled.

A document is ready when no other unsettled document can reach it through propagation. Two unsettled documents that can reach each other don't wait for each other.

### set

| State | For | Set by | Allowed from |
|---|---|---|---|
| `updated` | document | the writer, or the user for the documents edited at the start of the change | any state, or not yet in the change |
| `affected` | document | triage; needs `--reason` | `pending`, `affected` |
| `no-change` | document | triage, or the writer when it finds nothing to change; needs `--reason` | `pending`, `affected` |
| `done` | node | the implementer, once the code is updated and verified | a node under `implementation` |

A document is named by its path, with or without `.md`, and must exist in the tree. `pending` can't be set: only propagation sets it.

Setting a document to `updated` applies the [propagation rules](../../method/changes/) one step: each document it reaches directly is added as `pending` with the rule that reached it (`derives from <id>.md`, `descendant of <node>`, `links to <node>`). A document already in the change gets the rule added to its `via`; if it was settled, it goes back to `pending` and its reason is cleared. If the document's node has code paths, the node is added under `implementation` as `pending`, or set back to `pending` if it was `done`. Propagation continues as writers set the reached documents to `updated` in turn.

### close

Fails while any document is `pending` or `affected` or any node isn't `done`. Then runs `validate`; if it finds errors, prints them to stderr and fails. Otherwise removes the change directory.

## Output

`new`:

```
$ uspec change new refund-window
Created .uspec/changes/refund-window/
  change.md     empty
  status.yaml   baseline 4f2c9e1
```

`list`:

```
$ uspec change list
refund-window   1 pending, 0 affected, 1 updated, 0 no-change; 0 to implement
```

With no open changes it prints `No open changes.`

`status`:

```
$ uspec change status refund-window
change:    refund-window
baseline:  4f2c9e1
documents:
  product/support/refunds/rules.md      updated
  system/services/payments/api.md       no-change  POST /refunds takes an order id; the window isn't part of the contract
  system/services/payments/storage.md   pending  links to product/support/refunds; derives from logic.md
implementation:
  system/services/payments   pending
```

An empty section prints `none`.

`next`:

```
$ uspec change next refund-window
triage:
  read:
    .uspec/changes/refund-window/change.md
    docs/product/support/refunds/rules.md   diff since 4f2c9e1
  batch:
    docs/system/services/payments/api.md    links to product/support/refunds
write:      none
implement:  none
```

`set` prints the item and its state (`docs/system/services/payments/api.md: no-change`, `system/services/payments: done`). For `updated` it prints what propagated: `+` for a document new to the change, `~` for one already in it.

```
$ uspec change set refund-window product/support/refunds/rules.md updated
propagated from docs/product/support/refunds/rules.md:
  + docs/system/services/payments/api.md            links to product/support/refunds
  ~ docs/experience/ops-console/refunds/states.md   links to product/support/refunds (already in the change)
```

With nothing reached it prints `propagated from <path>: nothing`.

`close` prints `validate: ok` and `removed .uspec/changes/<name>/`.

With `--json`:

| Subcommand | Object |
|---|---|
| `new` | `change`, `path`, `baseline` |
| `list` | `changes`: each with `change`, `baseline`, `created`, `counts` (`pending`, `affected`, `updated`, `no_change`, `implementation_pending`, `implementation_done`) |
| `status` | `change`, `baseline`, `documents` (`document`, `path`, `state`, `reason`, `via`), `implementation` (`node`, `state`) |
| `next` | `change`, `baseline`, `triage` (`null` when empty, else `read`: `path`, plus `document` and `diff_since` for diffs; `batch`: `document`, `path`, `via`), `write` (`document`, `path`), `implement` (`node`) |
| `set` | `change`, `document` or `node`, `state`; for `updated` also `propagated` (`document`, `path`, `via`, `already_in_change`) and `implementation` (the node added, or `null`) |
| `close` | `change`, `closed: true` |

```json
{
  "change": "refund-window",
  "baseline": "4f2c9e1...",
  "triage": {
    "read": [
      { "path": ".uspec/changes/refund-window/change.md" },
      { "path": "docs/product/support/refunds/rules.md", "document": "product/support/refunds/rules.md", "diff_since": "4f2c9e1..." }
    ],
    "batch": [
      { "document": "system/services/payments/api.md", "path": "docs/system/services/payments/api.md", "via": ["links to product/support/refunds"] }
    ]
  },
  "write": [],
  "implement": []
}
```

## Errors

- `new`: the name isn't kebab-case; the change already exists; the project has no git commit to use as the baseline.
- Any subcommand naming a change: no open change by that name (the message lists the open ones); `status.yaml` is invalid or has an unknown state.
- `set`: an unknown state; `pending`; `affected` or `no-change` without `--reason`, or on a document that isn't `pending` or `affected`; a document that doesn't exist; `done` on a node that isn't under `implementation`.
- `close`: the change isn't finished (the message gives the counts of pending, affected and nodes to implement); `validate` finds errors.
