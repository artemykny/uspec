# Links

A node often depends on nodes outside its own branch: a service is built from the features it serves, a screen from the API of the service it calls. A node is built from its parent without a link; anything else it depends on, a higher ancestor included, needs one. A **link** records such a dependency, from a node to a node it is derived from. The nodes a node links to are its **upstream**; the nodes that link to it are its **downstream**. Upstream nodes are the problem, the node is the solution: a service solves a set of features, and its API is the problem a screen solves. Links exist so that dependencies are explicit: a change reaches everything it affects and nothing else, and each agent reads what its node is built from.

## Rules

**Format.** A node lists its links in the `derives_from` field of its `node.yaml` (see [spec tree](../spec-tree/)), as paths relative to the spec root. A node with no links omits the field. A link names a node, or narrows to one document or one [section](../spec-tree/) of it:

| Link | Depends on |
|---|---|
| `product/support/refunds` | every exposed document of the node |
| `product/support/refunds/rules.md` | that document |
| `product/support/refunds/rules.md#refund-window` | that section of the document |

Whatever it narrows to, a link goes from the node to the target node: types, direction and cycles are checked between nodes. A node may have several links into the same node, one per document or section it needs.

**Valid links.**

- A link points to a node that exists in the tree.
- A link to a document names a document of the target node that its type declares as exposed (see [node types](../node-types/)) and that exists; a link to a section names a section that exists in that document.
- The target's type is one the node's type allows as upstream; a [node type](../node-types/) lists these in its own `derives_from`. A type that lists none allows no links.
- Links form no cycles, a node linking to itself included.

**Direction.** A link goes one way, from the node to its upstream. The upstream node doesn't know its downstream nodes. Which way links go between parts of the tree is the project's choice, set by the types' `derives_from`: in the example below, screens derive from services and never the reverse, so the backend doesn't depend on the frontend.

**What a link carries.** A link to a node makes the node depend only on the upstream node's exposed documents. Its internal documents (see [node types](../node-types/)) are not read by downstream nodes, and a change to them does not reach them. A link to a document or a section carries only that document or section: a change elsewhere in the upstream node, or elsewhere in the document, doesn't reach the node, and the node's agents read only what the link names. A node links as narrowly as what it is built from: a screen that shows one rule of a feature links to that rule's section, not to the whole feature.

## Example

Types allow the links, nodes make them:

| Type | May derive from |
|---|---|
| service | feature, domain-model |
| screen | feature, service, design-system |

| Node | Type | Derived from |
|---|---|---|
| `system/services/payments` | service | `product/ordering/checkout`, `product/support/refunds`, `system/domain-model` |
| `experience/customer-app/cart-and-checkout` | screen | `product/ordering/cart`, `product/ordering/checkout`, `system/services/payments` |
| `experience/ops-console/refunds` | screen | `product/support/refunds/rules.md#refund-window`, `system/services/payments` |

The screen reads the payments service's `api.md`, which is exposed, but not its internal `logic.md`. The ops console reads only the refund window section of the refunds rules: a change to how refunds are paid out doesn't reach it, a change to the window does. A link from `system/services/payments` to the screen would be invalid twice: a service may not derive from a screen, and it would close a cycle.
