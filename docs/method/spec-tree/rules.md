# Spec tree

A product is described as a **tree of nodes**. Each node is a directory that describes one part of the product in its documents, and splits into more detailed parts as its children. The tree exists so that each part of the product is written down in one place, and each agent reads only the part it works on. Every node has a [node type](../node-types/), and the project defines the types and how they nest; the method fixes no structure, and a small app gets by with far fewer types than a large one. The branches don't have to mirror each other: one feature can touch several services and appear on several screens. A node is built from its parent; anything else it depends on, a higher ancestor included, is recorded as [links](../links/).

## Rules

**Node format.** A node is a directory holding:

- a `node.yaml` file with the node's metadata;
- the documents its type declares, each as `<document-id>.md`;
- the `-extra` folders of documents whose type allows extra files (see [node types](../node-types/));
- its children, as subdirectories.

Nothing else goes in a node directory. A child's path is its parent's path plus the directory name; nodes are named by their path relative to the spec root.

**Sections.** Documents are Markdown. A **section** is a heading and everything under it, up to the next heading of the same or a higher level, so its subsections are part of it. A section is named by its heading's anchor, as Markdown renderers link to it: the heading text in lowercase, without characters other than letters, digits, spaces, `-` and `_`, and with spaces turned into `-` (`## Refund window` → `refund-window`). Headings inside fenced code blocks don't count; when two headings of a document have the same anchor, the first is meant. A dependency can point to a section instead of the whole document (see [links](../links/) and [node types](../node-types/)), so a change elsewhere in the document doesn't reach what depends only on the section.

**`node.yaml`.** It holds the node's metadata, not its content; the content lives in the documents.

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
| `type` | yes | The node's type id. It must be a type the project defines. |
| `derives_from` | no | The node's upstream nodes, as paths relative to the spec root (see [links](../links/)). |
| `code` | if the type describes code | Code paths this node describes, relative to the repository root. |

**Root and leaves.** The spec root is a single node, and a node of any type can be the root. A node's type limits which types its children may have, not whether it has any: a node with no children is fine.

**Code paths.**

- Only nodes whose type describes code list code paths, and each of them lists at least one.
- The link goes one way, from the spec to the code. Code has no references back to the spec.
- Every node with code paths must be implementable: its [context](../context/) is enough to write its code without asking questions.

## Example

A food delivery product ([examples/example_product](../../../examples/example_product/), shortened) splits product by user problem, experience by app and system by service:

```
docs/                          type
├─ product/                    product
│  └─ ordering/                product-area
│     ├─ cart/                 feature
│     └─ checkout/             feature
├─ experience/                 experience
│  └─ customer-app/            surface
│     └─ cart-and-checkout/    screen
└─ system/                     system
   └─ services/                services
      └─ payments/             service
```

The `payments` node is a directory:

```
docs/system/services/payments/
├─ node.yaml      type, links, code paths
├─ api.md
├─ logic.md
├─ storage.md
└─ api-extra/     extra files of api.md
   └─ openapi.yaml
```

Its type describes code, so its `node.yaml` lists `services/payments/`; `product/ordering/checkout` is a feature, describes no code and lists none.
