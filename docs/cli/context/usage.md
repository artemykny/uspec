# uspec context

```
uspec context <node> --document <id> [--document <id>...] [--change <name>]
uspec context <node> --implement [--change <name>]
```

## Behaviour

Prints the [context](../../method/context/) of one job: writing documents `<id>` of `<node>`, or implementing `<node>`. `--document` can be given more than once; the output is then one context for writing all the given documents together. It prints the type's instructions, then the files to read, grouped by why they're read. Skills give an agent exactly this output.

With `--document <id>`, the groups are, in order:

- `document`: the documents being written, in the order given;
- `ancestors`: the documents of every ancestor, the root first;
- `upstream`: the exposed documents of each linked node, then the node's own documents that any written document's template names in `derives_from`, except the ones being written. A document without a template counts as exposed. A link to a node that doesn't exist is skipped (`validate` reports it);
- `change`: with `--change`, see below;
- `template`: `.uspec/node-types/<type>/<id>.md` for each written document, in the same order.

With `--implement`: `ancestors` and `upstream` as above (without `derives_from` documents), `documents` (all of the node's documents, internal ones included), `change`, and `code` (the node's code paths).

A document's `-extra/` folder is listed right after it, in every group.

With `--change <name>`, the `change` group holds the change's `change.md`, then every document the change has recorded as `updated` that is already listed in the groups above (the documents being written excepted), marked `diff since <baseline>`. The agent reads it with `git diff <baseline> -- <path>`.

## Output

Text:

```
$ uspec context system/services/payments --document logic --change refund-window
# Instructions

Service type:
A Service is one deployable backend service, and the only owner of its
code. ...

# Files

document:
  docs/system/services/payments/logic.md
ancestors:
  docs/overview.md
  docs/system/overview.md
  docs/system/services/overview.md
upstream:
  docs/product/support/refunds/user-story.md
  docs/product/support/refunds/rules.md
  docs/system/services/payments/api.md
  docs/system/services/payments/api-extra/
change:
  .uspec/changes/refund-window/change.md
  docs/product/support/refunds/rules.md   diff since 4f2c9e1
template:
  .uspec/node-types/service/logic.md
```

A type without instructions prints `<Type> type: no instructions.` Empty groups are left out.

JSON (`--json`), for the same call:

```json
{
  "node": "system/services/payments",
  "type": "service",
  "documents": ["logic"],
  "instructions": { "type": "Service", "text": "A Service is one deployable backend service, ..." },
  "files": {
    "document": [{ "path": "docs/system/services/payments/logic.md", "note": null }],
    "ancestors": [...],
    "upstream": [...],
    "change": [
      { "path": ".uspec/changes/refund-window/change.md", "note": null },
      { "path": "docs/product/support/refunds/rules.md", "note": "diff since 4f2c9e1" }
    ],
    "template": [{ "path": ".uspec/node-types/service/logic.md", "note": null }]
  },
  "baseline": "4f2c9e1..."
}
```

`documents` lists the ids being written, in the order given, and is `[]` with `--implement`; `instructions.text` is `null` for a type without instructions; `baseline` is the change's full baseline commit, or `null` without `--change`. Every group of the mode is present, empty ones as `[]`; `change` only with `--change`.

## Errors

- ``no node at <node>``
- ``<node> has no type``, or ``<node> has unknown type `<type>` ``
- ``type `<type>` has no document `<id>`; its documents are <ids>``
- ``<node> has no code paths: its type `<type>` doesn't have code: true`` (with `--implement`)
- ``no open change `<name>`; open changes: <names>``, or ``...; no changes are open``
- ``give either --document <id> or --implement``, when neither is given. Giving both is a usage error (exit code 2).
