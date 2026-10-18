# uspec — Product Overview

uspec is a specification method for building products with AI agents, plus the tooling for it. A product is described as a **tree of spec nodes**. The spec is the **source of truth**: **narrowly focused agents** write each part of it, and code is generated from it, never the other way round. The one exception is [onboarding an existing codebase](#onboarding-existing-codebases), where the first tree is built from code.

The first release is a set of **skills for Claude Code and Codex** plus a **CLI** (similar in spirit to OpenSpec) that scaffolds, validates and navigates the spec. It is for developers and small teams who build mainly with AI agents and want product intent, architecture and design versioned next to the code.

## The problem

- **Everything in one place.** The product lives in one file or one chat. It grows too big, details get lost, and every agent reads what it doesn't need.
- **No spec, only code.** Agents change code directly; the reasons stay in chat history and are gone after the session.
- **One agent does everything.** The same agent writes product docs, architecture, design, code and tests, and does each worse than a focused one would.
- **Hidden dependencies.** A screen depends on a service's API, the service on a user story, but nothing says so. A change in one place silently breaks another.

## Spec tree

A product is a **tree of nodes**, and every node has a **type**. The project defines the types and how they nest; uspec fixes no structure. For example, a food delivery product ([examples/example_product](../examples/example_product/), shortened) splits product by user problem, experience by app and system by service:

```
docs/                          type
├─ product/                    product
│  ├─ glossary/                glossary
│  └─ ordering/                product-area
│     ├─ cart/                 feature
│     └─ checkout/             feature
├─ experience/                 experience
│  ├─ design-system/           design-system
│  └─ customer-app/            surface
│     └─ cart-and-checkout/    screen
└─ system/                     system
   ├─ domain-model/            domain-model
   └─ services/                services
      ├─ customer-bff/         service
      ├─ orders/               service
      └─ payments/             service
```

The branches don't mirror each other: one feature can touch several services and appear on several screens. A small app could get by with far fewer types.

### Nodes and types

A node is a directory with a `node.yaml` file (type, links, code paths), its **documents**, and its children as subdirectories. A node can describe one thing from several angles: a service has `api.md`, `logic.md` and `storage.md`.

A **node type** says which types may be its children, which types it may link to, which documents its nodes have, and whether they describe code. A type may contain itself (an area split into smaller areas), but there are no other cycles: detail only goes down. For each document, the type has a **template**: its starting structure plus instructions for the agent that fills it. See [node-types.md](node-types.md).

### Links

A node often depends on nodes that aren't its parent. It records them as **links**, the list of nodes it is derived from (its **upstream**; the reverse is **downstream**):

| Node | Type | Derived from |
|---|---|---|
| `system/services/payments` | service | `product/ordering/checkout`, `product/support/refunds`, `product/partner/payouts`, `system/domain-model`, … |
| `experience/customer-app/cart-and-checkout` | screen | `product/ordering/cart`, `product/ordering/checkout`, `system/services/customer-bff`, `experience/design-system`, … |

Upstream nodes are the problem, the node is the solution: a service solves a set of features, and its API is the problem a screen solves. Links must not form cycles, and their direction is the project's choice. In the example, screens derive from services and never the reverse, so the backend doesn't depend on the frontend.

Two refinements, both declared in the node type:

- **Document dependencies.** Documents inside a node depend on each other: a service's `logic.md` is built from its `api.md`. This sets the order documents are written in and how a change moves inside the node.
- **Exposed documents.** A link usually needs only part of a node: a screen needs a service's `api.md`, not its `logic.md`. Documents are exposed by default; a type can mark some internal, and linked nodes neither see them nor get their changes.

### Context

An agent writing a document reads the node's ancestors, the exposed documents of its upstream nodes, and the documents in the same node that its document derives from. An agent implementing a node reads all of the node's documents plus the same ancestors and upstream documents.

Siblings, other branches and downstream nodes are not given unless linked. The agent can read more, but if it keeps needing something outside its context, a link is missing.

### Code paths

Only types marked `code: true` describe code (in the example: surfaces, screens, services, the design system); each of their nodes lists its code paths, other nodes list none. The link goes one way: the spec points to the code, the code doesn't point back. **Every node with code paths must be implementable**: its context is enough to write the code without asking questions. A review skill checks this.

## Agents

Each agent run has **one responsibility**: one document of one node (`user-story.md` for checkout, `api.md` for payments), or the code of one node. There are no separately defined agents: the document's template and the type's instructions tell the agent what to write. Narrow scope keeps context small, output predictable and responsibility clear.

## Workflow

1. **Change the spec first.** A change starts at the highest node it affects and moves down the tree and along links.
2. **Keep the spec consistent.** A node must not contradict its ancestors or upstream nodes; fix the node, or change the upstream first and bring the node in line.
3. **Then change the code** of the nodes that list it.
4. **Verify** the code against the spec it came from.

If code and spec disagree, the code is a bug, unless the spec is changed explicitly first. There is no proposal / apply / archive flow: changes are made directly in the tree.

> **TODO:** how a change moves through the tree in detail (document dependencies, exposed documents, stopping when nothing needs to change).

## Repository layout

```
.uspec/
├─ config.yaml     project configuration
└─ node-types/     one directory per type: node-type.yaml + a template per document
docs/              the spec tree (location set in config.yaml)
```

## Onboarding existing codebases

> **TODO:** how to build the first spec tree for a large existing codebase. This is a separate process from day-to-day work.

## Success criteria

- An agent can implement any node with code paths from its context alone, without clarifying questions.
- A change reaches every affected node and the code.
- Adding a domain or node type needs no change to uspec, only to the project's spec.
- Drift between spec and code is detected, not discovered by accident.
