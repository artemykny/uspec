# uspec drift

```
uspec drift
uspec drift accept [<document | node>...]
```

## Behaviour

Applies the [drift rules](../../method/drift/) to every item in the tree, against the records in `.uspec/checks.yaml`. The items are the documents of every node, and every node whose type has `code: true` and that has code paths.

Each hash is 16 hexadecimal digits over exact content, whitespace included. A document unit's hash is of the file; a section unit's hash is of the section's text only. A hash of a set of files covers each file's path and content, so adding, removing or renaming a file changes it:

- a node's **spec** is its `node.yaml`, its documents and their `-extra/` folders;
- a node's **code** is the files under its code paths that git tracks or that are untracked but not ignored, as they are in the working tree, so uncommitted changes count.

A document's **upstream units** are the units whose update reaches it directly under the [propagation rules](../../method/changes/): a document of its node it derives from, or a section of it; every document of its parent; every exposed document of a node it links to; a document or section it links to. A unit is named by its spec-relative path, with `#<section>` for a section.

### drift

1. Reads `.uspec/checks.yaml`. A missing file means no records: every item drifts as `never checked`.
2. Collects what open changes skip, from every change in `.uspec/changes/`, whatever their state: the documents listed in its `documents`, in any state, and the nodes under its `implementation`. A change that can't be read is ignored.
3. Checks each document not skipped. Without a record, it drifts with `never checked`. Otherwise each upstream unit that differs from the record is a reason:
   - its hash differs: `<unit> changed since it was last checked`;
   - it reaches the document but has no record (such as a new exposed document of a linked node): `<unit> added since it was last checked`;
   - it is in the record but no longer reaches the document, or its section is gone: `<unit> removed since it was last checked`.

   A record against a document of a higher ancestor, above the parent, is ignored: it isn't reported, and `accept` or a change's close drops it with the rest of the record.
4. Checks each node with code paths not skipped. Without a record, it drifts with `never checked`. Otherwise:
   - its code hash differs from the record: `code changed since it was last verified`;
   - its spec hash differs from the record: `spec changed since its code was last verified`.

   Both can apply at once; both are reported. Code reverted to the verified content no longer drifts.

### accept

Records the given items as checked, as they are now, and writes `.uspec/checks.yaml`, creating it if it is missing:

- a document, as checked against the current content of its current upstream units: its record is replaced, so units that no longer reach it are dropped;
- a node with code paths, as verified against its current spec and code.

Arguments name a document or a node, in any of the [path forms](../#paths). With no arguments, every item in the tree is recorded; this is how a project starts recording. Items in open changes are recorded like any other. Records of items not given are kept as they are. If any argument is invalid, nothing is recorded.

Accepting needs no change and doesn't touch the spec. The file is written as the [drift rules](../../method/drift/) describe: one line per document–unit pair and per node, sorted by path.

## Output

`drift` prints one line per reason, `<item>: <reason>`, items in tree order: a node's code drift, then its spec drift, then its documents in its type's order, each document's units in path order. Items are named by their spec-relative path:

```
$ uspec drift
cli/drift: code changed since it was last verified
cli/drift: spec changed since its code was last verified
vscode/overview.md: cli/drift/usage.md changed since it was last checked
```

Without drift:

```
No drift: everything matches what it was last checked against.
```

With `--json`, the reasons as a list, empty without drift. Each entry has `kind` (`dependency` for a document, `code` or `spec` for a node), `node` (for a document, its node), `document` and `path` (dependency drift only, else `null`), `unit` (dependency drift only, else `null`; also `null` for a document that was never checked) and `reason`. A node that was never checked has kind `code`.

```json
{
  "drift": [
    {
      "kind": "code",
      "node": "cli/drift",
      "document": null,
      "path": null,
      "unit": null,
      "reason": "code changed since it was last verified"
    },
    {
      "kind": "dependency",
      "node": "vscode",
      "document": "vscode/overview.md",
      "path": "docs/vscode/overview.md",
      "unit": "cli/drift/usage.md",
      "reason": "cli/drift/usage.md changed since it was last checked"
    }
  ]
}
```

`drift` exits with 1 when anything drifts (after printing the output), with 0 otherwise.

`accept` prints one line per item it recorded, in the same order: `verified: <node>` for a node, `checked: <document>` for a document.

```
$ uspec drift accept cli/drift/usage.md cli/drift
verified: cli/drift
checked: cli/drift/usage.md
```

With `--json`, `accept` prints `checked` (`document`, `path`) and `verified` (`node`).

## Errors

The errors shared by all commands (see [CLI](../#errors-and-exit-codes)): no project, or a missing spec root. Also:

- `.uspec/checks.yaml` exists but isn't valid.
- `accept`: an argument is neither a document nor a node with code paths.

A missing `.uspec/checks.yaml` isn't an error. Git failures don't fail the command: when git can't list the files under a node's code paths, its code counts as having no files.
