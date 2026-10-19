# uspec tree

```
uspec tree [<node>]
```

## Behaviour

Prints the [spec tree](../../method/spec-tree/), or the subtree under `<node>`, with each node's type, code paths and links. Without `<node>` it starts at the root.

- Nodes come in depth-first order, the starting node first, and children sorted by directory name.
- Every directory in the tree is a node, except the `-extra` folders of declared documents and directories whose name starts with `.`. A directory without `node.yaml`, or whose `node.yaml` can't be read, is still listed, with no type.
- The tree is printed as it is, without checking it: an unknown type or a broken link is shown as written. `validate` reports such problems.

## Output

One line per node, indented by two spaces per level below the starting node: the node's name with a trailing `/`, its type (`?` if it has none) and, if it has any, its code paths after `code:`. Each link follows on its own line, marked `→`, as written in `node.yaml`: a path relative to the spec root, with the document and section it narrows to. The starting node is shown by its path (the root by the spec root's name), the others by their directory name.

```
$ uspec tree system
system/  system
  services/  services
    payments/  service  code: services/payments/
      → product/ordering/checkout
      → system/domain-model
```

With `--json`, a `nodes` array in the same order. Each node has `node` (its path relative to the spec root, `.` for the root), `type` (`null` if none), `depth` (levels below the starting node, which is 0), `documents` (the ids of the documents present, in the type's order), `derives_from` (the links as written) and `code`:

```json
{
  "nodes": [
    {
      "code": ["services/payments/"],
      "depth": 0,
      "derives_from": ["product/ordering/checkout", "system/domain-model"],
      "documents": ["api", "logic", "storage"],
      "node": "system/services/payments",
      "type": "service"
    }
  ]
}
```

## Errors

- `no node at <node>`: `<node>` isn't a node of the tree.
- The failures every command shares, such as no project or a missing spec root (see [CLI](../#conventions)).
