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

Manages the [change directory](../../method/changes/) `.uspec/changes/<name>/`: its `status.yaml`, and the plans in `plans/`, which it reads but never writes. Every subcommand except `new` and `list` names the change it works on.

| Subcommand | What it does |
|---|---|
| `new` | Creates the directory with `change.md` as a copy of the change template below, and `status.yaml` with the current commit as `baseline`, the current time as `created`, and no items. The name is kebab-case: lowercase letters, digits and `-`. |
| `list` | Lists open changes, oldest first (by `created`, then by name), with a count of items per state. Changes are processed in this order. |
| `status` | Prints every item in `status.yaml` with its state, and its reason, or for a pending document the rules that reached it; then the plans with their state. |
| `next` | Prints the items that are ready, grouped by what to do with them. |
| `set` | Records an item's state and, for `updated`, propagates. |
| `close` | Runs `validate`, records what the change checked, and removes the change directory. |

The change template:

```markdown
# <Title: the change in a few words>

## Why

<The problem, and who has it.>

## What changes

<The new behaviour, rule by rule: every case it touches, and what stays as it is. The constraints that apply.>

## Worked example

<One or more concrete scenarios, step by step, with real values: what the user does, what the product does, what it shows and stores. Before and after, where behaviour changes.>

## Out of scope

<What this change doesn't do.>
```

### next

Prints only what can be done now, in the order of the change's [steps](../../method/changes/). Items that aren't [ready](../../method/changes/) are left out.

- `impact`: while the change has no documents and nothing under `implementation`, the impact step is due: the file the impact agent reads, `change.md`.
- `triage`: the ready `pending` documents as one batch, each with the rules that reached it, and the files the triage agent reads with them: `change.md` and every `updated` document that can reach a document in the batch, as a diff since the baseline.
- `write`: the ready `affected` documents, by node: one entry per node with its ready `affected` documents, one writer each.
- `plan`: once every document is settled, the nodes under `implementation` that aren't `done` and that no plan holds, and the directory the planner writes the plans in.
- `implement`: once every document is settled and every node to implement is planned, the ready plans, each with its nodes, one implementer each.

A document is ready when no other unsettled document can reach it through propagation, a dependency on a section counting as reaching. Down the tree, only the documents of its parent count, not those of higher ancestors. Two unsettled documents that can reach each other don't wait for each other.

**Plans.** Each `plans/<id>.md` is a plan; its id is the file name without `.md`. Its YAML frontmatter has `nodes`, a non-empty list of nodes, and optionally `after`, a list of plan ids. A plan is done when all its nodes are `done`. It is ready when it isn't done, every plan in its `after` is done, and every node its nodes link to is `done`, not under `implementation`, or in the plan itself. When a plan is wrong, `next` lists the problem under `plan errors` and nothing under `implement`, until the plan is fixed:

- the frontmatter is missing or isn't valid YAML, or `nodes` is empty;
- a node in `nodes` isn't under `implementation`;
- a node is in more than one plan;
- `after` names a plan that doesn't exist;
- plans wait for each other in a cycle, through `after` or through links between their nodes.

### set

| State | For | Set by | Allowed from |
|---|---|---|---|
| `updated` | document | a writer, or the user, also to take in an edit made outside a change | any state, or not yet in the change |
| `affected` | document | triage, or impact for a starting document; needs `--reason` | `pending`, `affected`, or not yet in the change |
| `no-change` | document | triage, or the writer when it finds nothing to change; needs `--reason` | `pending`, `affected` |
| `done` | node | the implementer of its plan, once the code is updated and verified | a node under `implementation` |

A document is named by its path, with or without `.md`, and must exist in the tree. `pending` can't be set: only propagation sets it. A document set to `affected` that wasn't in the change is a starting document: it is added with `change.md` as its `via`.

Setting a document to `updated` applies the [propagation rules](../../method/changes/) one step: each document it reaches directly is added as `pending` with the rule that reached it (`derives from <id>.md`, `child of <node>`, `links to <node>`, or with the document or section a dependency names: `derives from api.md#errors`, `links to <node>/rules.md#refund-window`). A dependency on a section reaches only when the section changed since the baseline: its text in the document differs from its text in `git show <baseline>:<path>`, or it exists in only one of them. A document already in the change gets the rule added to its `via`; if it was settled, it goes back to `pending` and its reason is cleared. If the document's node has code paths, the node is added under `implementation` as `pending`, or set back to `pending` if it was `done`. Propagation continues as writers set the reached documents to `updated` in turn.

### close

Fails while any document is `pending` or `affected` or any node isn't `done`. Then runs `validate`; if it finds errors, prints them to stderr and fails. Otherwise it records the change's checks in `.uspec/checks.yaml` (see [drift](../../method/drift/)), creating the file if it is missing: every document of the change, all settled by then, as checked against the current content of its upstream units, and every node under `implementation`, all `done` by then, as verified against its current spec and code. Records of items the change didn't reach are kept as they are. Then it removes the change directory, plans included.

## Output

`new`:

```
$ uspec change new refund-window
Created .uspec/changes/refund-window/
  change.md     template
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
plans:
  payments   pending  system/services/payments
```

An empty section prints `none`. A plan line gives its state and nodes, and `after <ids>` when it has any.

`next`:

```
$ uspec change next refund-window
impact:     none
triage:
  read:
    .uspec/changes/refund-window/change.md
    docs/product/support/refunds/rules.md   diff since 4f2c9e1
  batch:
    docs/system/services/payments/api.md    links to product/support/refunds
write:      none
plan:       none
implement:  none
```

```
$ uspec change next refund-window
impact:     none
triage:     none
write:      none
plan:
  in: .uspec/changes/refund-window/plans/
  nodes:
    system/services/payments
    experience/ops-console/refunds
implement:  none
```

```
$ uspec change next refund-window
impact:     none
triage:     none
write:      none
plan:       none
implement:
  payments   .uspec/changes/refund-window/plans/payments.md
    system/services/payments
```

While the impact step is due, `impact:` is followed by `read:` and the path of `change.md`. Plan errors, when there are any, follow as `plan errors:` with one line each.

`set` prints the item and its state (`docs/system/services/payments/api.md: no-change`, `system/services/payments: done`). For `updated` it prints what propagated: `+` for a document new to the change, `~` for one already in it.

```
$ uspec change set refund-window product/support/refunds/rules.md updated
propagated from docs/product/support/refunds/rules.md:
  + docs/system/services/payments/api.md            links to product/support/refunds
  ~ docs/experience/ops-console/refunds/states.md   links to product/support/refunds/rules.md#refund-window (already in the change)
```

With nothing reached it prints `propagated from <path>: nothing`.

`close` prints `validate: ok`, the checks it recorded, and `removed .uspec/changes/<name>/`:

```
$ uspec change close refund-window
validate: ok
recorded .uspec/checks.yaml: 5 documents checked, 2 nodes verified
removed .uspec/changes/refund-window/
```

With `--json`:

| Subcommand | Object |
|---|---|
| `new` | `change`, `path`, `baseline` |
| `list` | `changes`: each with `change`, `baseline`, `created`, `counts` (`pending`, `affected`, `updated`, `no_change`, `implementation_pending`, `implementation_done`) |
| `status` | `change`, `baseline`, `documents` (`document`, `path`, `state`, `reason`, `via`), `implementation` (`node`, `state`), `plans` (`plan`, `path`, `nodes`, `after`, `state`: `pending` or `done`) |
| `next` | `change`, `baseline`, `impact` (`null` when not due, else `read`: `path`), `triage` (`null` when empty, else `read`: `path`, plus `document` and `diff_since` for diffs; `batch`: `document`, `path`, `via`), `write` (`node`, `documents`: `document`, `path`), `plan` (`null` when nothing is left to plan, else `dir` and `nodes`), `plan_errors` (`plan`, `null` for an error about several plans, and `message`), `implement` (`plan`, `path`, `nodes`) |
| `set` | `change`, `document` or `node`, `state`; for `updated` also `propagated` (`document`, `path`, `via`, `already_in_change`) and `implementation` (the node added, or `null`) |
| `close` | `change`, `closed: true`, `checked` (`document`, `path`), `verified` (`node`) |

```json
{
  "change": "refund-window",
  "baseline": "4f2c9e1...",
  "impact": null,
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
  "plan": null,
  "plan_errors": [],
  "implement": []
}
```

## Errors

- `new`: the name isn't kebab-case; the change already exists; the project has no git commit to use as the baseline.
- Any subcommand naming a change: no open change by that name (the message lists the open ones); `status.yaml` is invalid or has an unknown state.
- `set`: an unknown state; `pending`; `affected` or `no-change` without `--reason`; `affected` on a settled document, or `no-change` on a document that isn't `pending` or `affected`; a document that doesn't exist; `done` on a node that isn't under `implementation`.
- `close`: the change isn't finished (the message gives the counts of pending, affected and nodes to implement); `validate` finds errors.

Plan errors aren't command errors: `next` and `status` report them as output.
