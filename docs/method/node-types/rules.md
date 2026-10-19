# Node types

A node type says what a node of the [spec tree](../spec-tree/) is: which types its children may have, which types it may link to as upstream, which documents it holds and what each document should look like. The project defines its own types, so the method fixes no structure: how the tree is cut is decided by the types, once, before the tree grows.

## Rules

**Type definition format.** Each node type is a directory in `.uspec/node-types/`. The directory name is the type id (`node-types/service/` → `service`). It holds a `node-type.yaml` file and one template per document the type declares, named `<document-id>.md`.

```
.uspec/node-types/service/
├─ node-type.yaml   type definition
├─ api.md           template for api.md
├─ logic.md         template for logic.md
└─ storage.md       template for storage.md
```

**`node-type.yaml`.**

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Human-readable type name. |
| `description` | yes | One line saying what a node of this type describes. |
| `code` | no | `true` if nodes of this type describe code and so list code paths (see [spec tree](../spec-tree/)). Defaults to `false`. |
| `children` | no | Type ids allowed as children. Can include the type itself (e.g. Domain → Domain). Empty or missing means nodes of this type have no children. |
| `derives_from` | no | Type ids a node of this type may link to as upstream (see [links](../links/)). |
| `documents` | yes | Ids of the documents a node of this type holds. At least one. |
| `instructions` | no | Rules for every agent working on a node of this type, whatever document it writes. Nodes of the type are reviewed against them. |

**Document templates.** A template is a Markdown file. Its frontmatter tells the agent how to fill the document; its body is the document's starting content. A new document starts as a copy of the body, and text in angle brackets (`<Service>`) is guidance that is replaced when the document is written.

| Field | Required | Meaning |
|---|---|---|
| `description` | yes | What the document covers and how to fill it. It decides what goes in this document and what goes elsewhere. |
| `required` | no | Whether every node of the type must have this document. Defaults to `true`. |
| `derives_from` | no | Ids of other documents of the same type this one is built from, or `<id>#<anchor>` for one [section](../spec-tree/) of such a document. |
| `exposed` | no | Whether nodes that link to this node see this document. Defaults to `true`. |
| `extra` | no | `true` if the document may have extra files. Defaults to `false`. |

**Document dependencies.** Documents inside one node depend on each other: a service's `logic.md` implements what its `api.md` promises. A template's `derives_from` declares this once per type, so every node of the type has the same order (`api → logic → storage`). A dependency can narrow to a section a document of the type always has, from its template: `derives_from: [api#errors]` builds the document from the errors section of `api.md`, and a change elsewhere in `api.md` doesn't reach it. Document dependencies set:

- **Order.** A node's documents are written in dependency order.
- **Changes.** A change to a document reaches the documents that derive from it, or from a section of it that changed, never the other way by itself (see [changes](../changes/)).
- **Context.** An agent writing a document reads the documents and sections it derives from, not every document in the node (see [context](../context/)).

If a node doesn't have an optional document, dependencies on it are skipped.

**Exposed documents.** A link makes a node depend on part of another node, not all of it: a screen built against a service needs its API, not its logic or storage. `exposed: false` makes a document internal: nodes that link to its node don't read it, and a change to it doesn't reach them.

**Extra files.** A document whose template has `extra: true` may have files that aren't Markdown (an OpenAPI schema, a diagram) in a `<document-id>-extra/` folder next to it. Extra files are part of their document: whoever reads or writes the document can use them, they are exposed or internal with it, and a change to them is a change to the document. The `-extra` suffix is reserved, so no child node is named `<document-id>-extra`.

**Valid types.** A set of types is valid only if:

- every type directory has a `node-type.yaml`, and every listed document has a template;
- every type id in `children` and `derives_from` exists;
- types form no cycle through `children`, other than a type allowing itself (Domain → Feature → Domain is invalid), because detail would go back up;
- every document id in a template's `derives_from`, with or without a section, is declared by the type, and document dependencies within a type form no cycle.

A node is valid against its type only if its type exists, its children have allowed types, it has every required document, it has `-extra` folders only for documents that allow them, it lists code paths exactly when its type has `code: true`, every section its documents derive from exists in its documents, and it links only to nodes whose type is in its type's `derives_from`.

## Example

```yaml
# .uspec/node-types/service/node-type.yaml
name: Service
description: One deployable backend service.
code: true
derives_from: [feature, domain-model]
documents: [api, logic, storage]
instructions: |
  A Service is one deployable backend service, and the only owner of its
  code. Service-wide rules (idempotency, ledgers) live here once.
```

```markdown
<!-- .uspec/node-types/service/logic.md -->
---
description: |
  Business rules and invariants inside the service.
derives_from: [api]
exposed: false
---

# <Service> logic

## Rules
```

A screen that links to a payments service reads its `api.md` but not its internal `logic.md`; a change to `api.md` reaches `logic.md` in the same node and the linked screen.
