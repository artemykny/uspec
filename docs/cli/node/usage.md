# uspec node

```
uspec node new <path> --type <type> [--derives-from <node>...] [--code <path>...]
uspec node move <from> <to>
uspec node remove <path>
```

## Behaviour

`node` changes the [spec tree](../../method/spec-tree/) so that it stays valid: each subcommand checks the tree rules and [links](../../method/links/) it would affect before it touches a file. It works on the tree as it is on disk and doesn't track changes.

**`new`** creates a node at `<path>`, of type `<type>`:

1. Checks the place: no node exists at `<path>`, the type exists, the parent node exists and its type lists `<type>` among its children. The name may not start with `.` and may not be `<document>-extra` for a document of the parent's type, since that directory holds the parent's extra files. The root can't be created this way; `init` creates it.
2. Checks each `--derives-from` node: it exists and its type is in the new type's `derives_from`. A new node can't close a cycle, since nothing links to it yet.
3. Checks code paths: a type with `code: true` needs at least one `--code`; any other type takes none. Code paths are stored as given and not checked against the repository.
4. Creates the directory and `node.yaml` with `type`, `derives_from` and `code` (empty fields left out), and each of the type's documents as a copy of its template body, without the frontmatter. Optional documents are created too; a document whose template is missing is skipped.

**`move`** moves the node at `<from>`, with its subtree, to `<to>`:

1. Checks that `<from>` exists and isn't the root, that `<to>` doesn't exist and isn't inside `<from>`, and that the node's type may sit under the new parent, with the same name rules as `new`.
2. Moves the directory.
3. Rewrites every link in the tree that points to the moved node or a node in its subtree, nodes inside the subtree included. The moved node's own links are kept as they are.

**`remove`** deletes the node at `<path>` and its subtree. The root can't be removed. It refuses while a node outside the subtree links to the node or to any node in its subtree; links within the subtree don't block it.

## Output

`new` lists the node and the files it created:

```
$ uspec node new system/services/refunds --type service --derives-from product/support/refunds --code services/refunds/
Created docs/system/services/refunds
  docs/system/services/refunds/node.yaml
  docs/system/services/refunds/api.md
  docs/system/services/refunds/logic.md
  docs/system/services/refunds/storage.md
```

`move` prints the move and, if any, the nodes whose links it rewrote, at their paths after the move:

```
$ uspec node move system/services/payments system/billing/payments
Moved docs/system/services/payments → docs/system/billing/payments
Rewrote links in:
  experience/customer-app/cart-and-checkout
```

`remove` prints the node and how many nodes it removed, itself included:

```
$ uspec node remove system/services/refunds
Removed docs/system/services/refunds (1 nodes)
```

With `--json`, node paths are spec-relative and files project-relative:

```json
{ "node": "system/services/refunds", "type": "service", "created": ["docs/system/services/refunds/node.yaml", "..."] }
{ "from": "system/services/payments", "to": "system/billing/payments", "links_rewritten": ["experience/customer-app/cart-and-checkout"] }
{ "removed": ["system/services/refunds"] }
```

## Errors

Every check above that fails stops the command before it changes anything, with one of these messages:

| Subcommand | Message |
|---|---|
| `new` | `<path> already exists` |
| `new` | ``unknown type `<type>`; types: <ids>`` |
| `new`, `move` | `the root node already exists` (the target is the root) |
| `new`, `move` | `parent <path> doesn't exist` |
| `new`, `move` | ``parent <path> has unknown type `<type>` `` |
| `new`, `move` | ``type `<type>` isn't allowed under <parent> (`<parent type>`); allowed: <types or none>`` |
| `new`, `move` | `` `<name>` is reserved for the extra files of <document>.md `` |
| `new`, `move` | ``invalid node name `<name>` `` |
| `new` | `can't link to <node>: it doesn't exist` |
| `new` | ``can't link to <node>: type `<type>` isn't in `<type>`'s derives_from`` |
| `new` | ``type `<type>` has code: true; give its code paths with --code`` |
| `new` | ``type `<type>` doesn't have code: true, so the node can't list code paths`` |
| `move` | `the root node can't be moved` |
| `move`, `remove` | `no node at <path>` |
| `move` | `<to> already exists` |
| `move` | `can't move <from> into itself` |
| `remove` | `the root node can't be removed` |
| `remove` | `can't remove <path> while other nodes link to it:`, followed by one line `<node> links to <target>` per link |
