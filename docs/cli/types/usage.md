# uspec types

```
uspec types
```

## Behaviour

Prints the project's [node types](../../method/node-types/) with their documents, as loaded from `.uspec/node-types/`, so a tool can offer the types a node may have, the nodes it may link to and what each document holds without reading the type files itself. It changes nothing and doesn't check the types; `validate` reports their problems.

- Types come in directory order. A type whose `node-type.yaml` can't be read is left out.
- Documents come in the order the type's `documents` lists them, with their template's fields and its defaults (`required` and `exposed` true, `extra` false). A document without a template is listed with those defaults and no template.

## Output

One block per type: its id, name and `code` if it describes code; its description; the types it allows as children and as upstream; then one line per document with its flags (`optional`, `internal`, `extra`, `derives from <ids>`).

```
$ uspec types
service  Service  code
  One deployable backend service.
  children:         none
  derives from:     feature, domain-model, architecture
  documents:
    api.md          extra
    logic.md        internal, derives from api
    storage.md      optional, internal, derives from logic
```

With `--json`, a `types` array in the same order. Each type has `type` (its id), `name`, `description`, `path` (its `node-type.yaml`, project-relative), `code`, `children`, `derives_from`, `instructions` (`null` if none) and `documents`. Each document has `document` (its id), `template` (the template's project-relative path, `null` if missing), `description`, `required`, `derives_from`, `exposed` and `extra`:

```json
{
  "types": [
    {
      "type": "service",
      "name": "Service",
      "description": "One deployable backend service.",
      "path": ".uspec/node-types/service/node-type.yaml",
      "code": true,
      "children": [],
      "derives_from": ["feature", "domain-model", "architecture"],
      "instructions": "A Service is one deployable backend service, ...",
      "documents": [
        {
          "document": "logic",
          "template": ".uspec/node-types/service/logic.md",
          "description": "Business rules and invariants inside the service. ...",
          "required": true,
          "derives_from": ["api"],
          "exposed": false,
          "extra": false
        }
      ]
    }
  ]
}
```

## Errors

Only the errors shared by all commands (see [CLI](../#errors-and-exit-codes)): no project, or a missing spec root. Problems in the node types don't stop it.
