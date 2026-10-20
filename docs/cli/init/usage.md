# uspec init

```
uspec init [--preset <preset>]
```

## Behaviour

Creates a uspec project in the current directory: `.uspec/` with its node types, and the root node in `docs/`. Unlike other commands, it doesn't look for a project in parent directories.

1. Checks that neither `.uspec/` nor `docs/node.yaml` exists.
2. Puts the node types in `.uspec/node-types/`:
   - With `--preset`, copies the preset's node types. A preset is a local directory or `github:<owner>/<repo>[/<path>][@<ref>]`, cloned with git (shallow, at `<ref>` if given) into a temporary directory that is removed afterwards. The node types are taken from the first of `.uspec/node-types/`, `node-types/` or the preset directory itself that contains a type directory (one with a `node-type.yaml`). Files and directories starting with `.` are not copied.
   - Without it, writes one type, `basic`: a Basic node has an `overview` document and may have `basic` children.
3. Writes `.uspec/config.yaml` with `spec_root: docs`, creates `.uspec/changes/` and writes an empty `.uspec/checks.yaml` (no item recorded as checked yet; `uspec drift accept` records them).
4. Loads the node types. They must be valid (see [node types](../../method/node-types/)).
5. Picks the root type: the type no other type lists as a child. If several qualify and one of them is `root`, it is `root`.
6. Creates the root node: `docs/node.yaml` with `type: <root type>`, and one `docs/<document-id>.md` per document of the root type, each a copy of its template's body. An existing `docs/` directory is reused.

If any step fails, `.uspec/` is removed, so the command can be run again.

## Output

```
Created .uspec/ with 3 node types
Created the root node (root):
  docs/node.yaml
  docs/overview.md
```

With `--json`:

```json
{
  "types": ["root", "domain", "feature"],
  "root_type": "root",
  "created": ["docs/node.yaml", "docs/overview.md"]
}
```

`types` lists the ids of all node types, `created` the files of the root node.

## Errors

- `.uspec/ already exists`
- `docs/node.yaml already exists`
- `a GitHub preset is github:<owner>/<repo>[/<path>][@<ref>]`: the preset has no owner or repo.
- `failed to run git`: git couldn't be started.
- `couldn't download preset from <url>`: the clone failed (unknown repository or ref, no network).
- `no node types found in preset <preset>`: none of the candidate directories holds a node type, or the path doesn't exist.
- `the node types have errors:` followed by one `<path>: <message>` line per problem.
- `the preset has no root type: every type is some other type's child`
- `the preset has several possible root types: <ids>`: more than one type is no type's child, and none of them is `root`.
