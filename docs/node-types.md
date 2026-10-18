# Node types

A node type is defined by the project (see [Spec tree](product-overview.md#spec-tree)). It sets which types a node's children and upstream nodes may have, which documents the node contains, and what each document should look like. This document specifies how node types and nodes are defined.

## Node type definition format

Each node type is a directory in `.uspec/node-types/`. The directory name is the type id (`node-types/service/` → `service`). It holds a `node-type.yaml` file and one template per document the type declares.

```
.uspec/node-types/service/
├─ node-type.yaml   type definition
├─ api.md           template for api.md
├─ logic.md         template for logic.md
└─ storage.md       template for storage.md
```

### `node-type.yaml`

```yaml
name: Service
description: One deployable backend service.
code: true
derives_from: [feature, domain-model]
documents:
  - api
  - logic
  - storage
instructions: |
  A Service is one deployable backend service, and the only owner of its
  code. Service-wide rules (idempotency, ledgers) live here once...
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Human-readable type name. |
| `description` | yes | One line saying what a node of this type describes. |
| `code` | no | `true` if nodes of this type describe code: each must list its code paths. Defaults to `false`: nodes list no code. |
| `children` | no | Type ids allowed as children. Can include the type itself (e.g. Domain → Domain). Empty or missing means nodes of this type have no children. |
| `derives_from` | no | Type ids a node of this type may link to as upstream. |
| `documents` | yes | Ids of the documents a node of this type contains. At least one. Each id has a template file `<id>.md` in the type's directory. |
| `instructions` | no | Rules for every agent working on a node of this type, whatever document it writes. The review skill checks nodes against them. |

### Document templates

Each template is a Markdown file named after the document id. Its frontmatter tells the agent how to fill the document; its body is the starting content of the document.

```markdown
---
description: |
  Business rules and invariants inside the service. Service-wide rules
  (idempotency, ledgers) live here once, not in every feature.
derives_from: [api]
---

# <Service> logic

## Responsibilities

## Rules

## Idempotency and retries
```

| Field | Required | Meaning |
|---|---|---|
| `description` | yes | What the document covers and how to fill it. Given to the agent that writes it; agents and the review skill use it to decide what goes where. |
| `required` | no | Whether every node of this type must have this document. Defaults to `true`. |
| `derives_from` | no | Ids of other documents of the same type that this document is built from (see [Document dependencies](#document-dependencies)). |
| `exposed` | no | Whether nodes that link to this node see this document. Defaults to `true`; `false` makes it internal (see [Exposed documents](#exposed-documents)). |
| `extra` | no | `true` if the document may have extra files (schemas, diagrams, examples) in a `<document-id>-extra/` folder. Defaults to `false` (see [Extra files](#extra-files)). |

When a document is created in a node, it starts as a copy of the template body. Text in angle brackets (`<Service>`) is guidance for the agent and is replaced.

### Document dependencies

Documents inside one node depend on each other: a service's `logic.md` implements what its `api.md` promises. A template declares this with `derives_from`, using document ids of the same type. It is declared once per type, so every node of that type has the same order.

```
api → logic → storage
```

Document dependencies set:

- **Order.** Documents of a node are written in dependency order: `api.md` before `logic.md`.
- **Changes.** A change to a document reaches the documents that derive from it. A change never travels the other way by itself: if `logic.md` needs a different API, `api.md` is changed explicitly first.
- **Context.** An agent writing a document reads the documents it derives from, not every document in the node (see [Context](product-overview.md#context)).

If a node doesn't have an optional document, dependencies on it are skipped.

### Exposed documents

A link makes a node depend on another node, but usually only on part of it. A screen built against a service needs its API, not its internal logic or storage.

Documents are exposed by default: nodes that link to the node see them. `exposed: false` makes a document internal:

- a node that derives from a service doesn't read the service's internal documents (e.g. `logic.md`, `storage.md`);
- a change to an internal document does not reach linked nodes.

### Extra files

Some documents need files that aren't Markdown: an OpenAPI schema next to `api.md`, a diagram next to `design.md`. A template allows this with `extra: true`. The files then go in a folder named after the document with the `-extra` suffix, next to the document:

```
docs/system/services/payments/
├─ api.md
└─ api-extra/
   └─ openapi.yaml
```

Extra files are part of their document: an agent that reads or writes the document can use them, they are exposed or internal with it, and a change to them is a change to the document. The `-extra` suffix is reserved, so a child node can't be named `<document-id>-extra`.

## Node format

A node is a directory with a `node.yaml` file, the documents its type declares (each as `<document-id>.md`), the `-extra` folders of documents that allow them, and its children as subdirectories. Nothing else goes in a node directory.

```
docs/system/services/payments/
├─ node.yaml      type, links, code paths
├─ api.md
├─ logic.md
├─ storage.md
└─ api-extra/     extra files of api.md
   └─ openapi.yaml
```

`node.yaml` holds the node's metadata, not its content; the content lives in the documents. Each document is written by an agent following its template.

```yaml
type: service
derives_from:
  - product/ordering/checkout
  - system/domain-model
code:
  - services/payments/
```

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | The node's type id. |
| `derives_from` | no | Upstream nodes, as paths relative to the spec root. |
| `code` | if the type has `code: true` | Code paths this node describes, relative to the repository root. Not allowed if the type doesn't have `code: true`. |

**Root and leaves.** A node of any type can be the root of the tree. `children` limits which children a node may have, not whether it has any: a node with no children is fine.

**Code.** Only nodes whose type has `code: true` list code, and each of them must. The link goes one way: from the spec to the code. Code has no references back to the spec.

## Validation

`uspec validate` fails when:

- a type directory has no `node-type.yaml`, or a listed document has no template;
- `children` or `derives_from` references a type that doesn't exist;
- types form a cycle through `children` other than a type pointing to itself (e.g. Domain → Feature → Domain), because detail would go back up;
- a template's `derives_from` references a document the type doesn't declare, or document dependencies within a type form a cycle;
- a node's type is unknown, or it has a child of a type its type doesn't allow;
- a node has no `node.yaml`, or is missing a required document;
- a node directory has a file that isn't `node.yaml` or a declared document, or an `-extra` folder for a document that doesn't allow extra files;
- a node lists code paths but its type doesn't have `code: true`, or its type has `code: true` and it lists none;
- a node links to a node that doesn't exist, or to a node whose type is not in its type's `derives_from`;
- links between nodes form a cycle.
