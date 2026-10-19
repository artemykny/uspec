# uspec validate

```
uspec validate [--json]
```

## Behaviour

Checks the node types and the spec tree against the rules in [node types](../../method/node-types/) (valid types, a node valid against its type) and [links](../../method/links/) (valid links), and lists every error it finds. It changes nothing.

The checks run in this order, and errors are listed in it:

1. **Loading the types.** The `.uspec/node-types/` directory is missing; a type directory has no `node-type.yaml`, or it isn't valid YAML; `name` or `description` is missing; `documents` is empty; a listed document has no template; a template's frontmatter isn't valid YAML or has no `description`. A type whose `node-type.yaml` can't be read is left out of the checks below. Hidden directories are skipped.
2. **Types.** Every type id in `children` and `derives_from` exists; every document id in a template's `derives_from` is declared by the type; document dependencies within a type form no cycle; types form no cycle through `children` (a type listing itself is allowed).
3. **Nodes**, in tree order. A node directory has a `node.yaml`, it's valid YAML, it has a `type` and the type exists; if any of these fails, the node's other checks are skipped. Then: each child's type is allowed; every required document exists; there are no other files than `node.yaml` and the type's documents; `-extra` folders exist only for documents that allow them; code paths are listed exactly when the type has `code: true`; every link points to an existing node whose type is in the node's type's `derives_from`.
4. **Links.** Links form no cycle.

A child whose type is missing or unknown is reported on the child itself, not as a disallowed child of its parent; the same goes for a link to a node of unknown type. A directory named `<id>-extra` for a document the type doesn't declare is a child node, so it's reported as one without `node.yaml`. Files and directories starting with `.` are ignored. A cycle is reported once, as the first one found.

Code paths aren't checked against the repository; that is [drift](../drift/)'s job.

## Output

With no errors, it prints the number of node types and nodes:

```
$ uspec validate
ok: 7 node types, 22 nodes
```

Otherwise, one line per error, with the project-relative path of the file or directory it's about, then the count:

```
$ uspec validate
error: .uspec/node-types/screen/node-type.yaml: `derives_from` references unknown type `services`
error: docs/system/services/payments: missing required document storage.md
error: docs/system/services/payments: links to product/ordering/cart of type `feature`, which isn't in `service`'s derives_from
error: docs/: links form a cycle: product/ordering → system/services/payments → product/ordering
4 errors
```

With `--json`:

```json
{
  "errors": [
    {
      "message": "missing required document storage.md",
      "path": "docs/system/services/payments"
    }
  ],
  "valid": false
}
```

`valid` is `true` and `errors` empty when there are none.

## Errors

- Exits with 1 when it finds any error. The findings are output, on stdout, not a command error.
- Fails as every command does when there is no project or the spec root is missing (see [CLI conventions](../)). Problems in the node types don't stop it: they are what it reports.
