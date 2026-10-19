# CLI

The `uspec` command does everything that doesn't need judgement: it scaffolds the tree, validates it, works out where a change propagates, tracks the change's state and assembles the context an agent reads. [Skills](skills.md) do the writing and call the CLI for the rest. Concepts are defined in [product-overview.md](product-overview.md), formats in [node-types.md](node-types.md), the process in [workflow.md](workflow.md).

Every command that prints something takes `--json`, so skills can read its output.

| Command | What it does |
|---|---|
| [`init`](#init) | Creates `.uspec/`, the node types and the root node. |
| [`validate`](#validate) | Checks the tree's structure. |
| [`tree`](#tree) | Prints the tree with node types. |
| [`context`](#context) | Prints the instructions and files an agent reads to write a document or implement a node. |
| [`node`](#node) | Adds, moves and removes nodes. |
| [`change`](#change) | Opens a change, shows what's ready to triage, write or implement, records results, closes it. |
| [`drift`](#drift) | Finds code changed without a spec change. |

## init

```
uspec init [--preset <name>]
```

Creates `.uspec/config.yaml`, `.uspec/node-types/` and the root node in `docs/`.

- With `--preset`, the preset's node types are downloaded from GitHub and copied into `.uspec/node-types/`. The root node gets the documents of the preset's root type, each a copy of its template.
- Without it, init generates one basic node type and a root node of that type with a single document.

Init fails if `.uspec/` already exists.

## validate

```
uspec validate
```

Checks every rule in [node-types.md](node-types.md#validation) and lists each error with its path. Exits non-zero if there are any.

## tree

```
uspec tree [<node>]
```

Prints the tree, or the subtree under `<node>`, with each node's type and links.

## context

```
uspec context <node> --document <id> [--change <name>]
uspec context <node> --implement [--change <name>]
```

Prints what an agent needs to write a document or implement a node, following [Context](product-overview.md#context): the type's instructions as text under `# Instructions`, then the files to read under `# Files`, grouped by why they're read.

- `--document <id>`:
  - `document`: the document itself;
  - `ancestors`: the documents of the node's ancestors;
  - `upstream`: the exposed documents of the node's upstream nodes, and the node's own documents that `<id>` is built from (the template's [`derives_from`](node-types.md#document-dependencies));
  - `change`: with `--change`, its `change.md` and the diffs of updated documents upstream of this one, since the change's baseline;
  - `template`: the document's template.
- `--implement`: `ancestors` and `upstream` as above, `documents` (all of the node's documents, internal ones included), `change` (its `change.md`) and `code` (the node's code paths). The instructions are the type's only.

```
$ uspec context system/services/payments --document logic --change refund-window
# Instructions

Service type:
A Service is one deployable backend service, and the only owner of its
code. ...

# Files

document:
  system/services/payments/logic.md
ancestors:
  overview.md
  system/overview.md
  system/services/overview.md
upstream:
  product/support/refunds/user-story.md
  product/support/refunds/rules.md
  system/services/payments/api.md
change:
  .uspec/changes/refund-window/change.md
  product/support/refunds/rules.md         diff since 4f2c9e1
template:
  .uspec/node-types/service/logic.md
```

Skills give an agent exactly this output, so every agent's context is decided by the tree and not by the agent.

## node

```
uspec node new <path> --type <type> [--derives-from <node>...]
uspec node move <from> <to>
uspec node remove <path>
```

- `new` creates the directory, `node.yaml` and each document as a copy of its template. It fails if the type isn't allowed under the parent.
- `move` moves the directory and rewrites every link to it in other nodes' `node.yaml`.
- `remove` deletes the node and its subtree. It fails while other nodes link to it.

## change

```
uspec change new <name>
uspec change list
uspec change status <name>
uspec change next <name>
uspec change set <name> <document | node> <state> [--reason <text>]
uspec change close <name>
```

Manages the [change directory](workflow.md#changes) `.uspec/changes/<name>/`. Every command except `new` and `list` names the change it works on.

| Command | What it does |
|---|---|
| `new` | Creates the directory with an empty `change.md`, and `status.yaml` with the current commit as the baseline. |
| `list` | Lists open changes, oldest first. Changes are processed in this order. |
| `status` | Prints every item in `status.yaml` with its state and reason. |
| `next` | Prints the items that are ready, grouped by what to do with them. |
| `set` | Records an item's state and propagates. |
| `close` | Runs `validate` and removes the directory. Fails while any item is pending or affected. |

### next

`next` prints only what can be done now, in three groups. Items waiting for something upstream are left out.

- `triage`: a batch of ready candidates, each with the rule that reached it, and the files the triage agent reads with them: `change.md` and the diffs of the updated documents since the baseline.
- `write`: the `affected` documents that are ready, one writer each.
- `implement`: the ready nodes, one implementer each. A node is ready when the nodes it links to are done.

```
$ uspec change next refund-window
triage:
  read:
    .uspec/changes/refund-window/change.md
    product/support/refunds/rules.md       diff since 4f2c9e1
  batch:
    system/services/payments/api.md        links to refunds
    system/services/payments/logic.md      links to refunds
write:      none
implement:  none
```

### set

| State | For | Set by |
|---|---|---|
| `updated` | document | the writer, or the user for the documents edited at the start of the change |
| `affected` | document | triage; needs `--reason` |
| `no-change` | document | triage; needs `--reason` |
| `done` | node | the implementer, once the code is updated and verified |

`set` is where propagation happens. Setting a document to `updated` adds every document it reaches as a pending candidate, with the rule that reached it, following the [propagation rules](workflow.md#2-change-the-product). If the document's node has code paths, the node is added under `implementation`. `affected` and `no-change` add nothing; after `no-change` the change stops there.

## drift

```
uspec drift
```

> **TODO:** how code changed without a spec change is detected, e.g. comparing each node's code paths against the commit its spec last changed in.
