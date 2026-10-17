# uspec — Product Overview

## What uspec is

uspec is a specification method for building products with AI agents, plus the tooling that supports it.
The idea is to describe a product as a **tree of specs at different levels of abstraction**, keep that spec as the **source of truth**, and have **narrowly focused agents** write and maintain each part of it. Code is generated from the spec, never the other way round. The one exception is [onboarding an existing codebase](#onboarding-large-codebases), where the first spec tree is built from code; after that, the spec leads.

The first release is a set of **skills for Claude Code and Codex** plus a **CLI** (similar in spirit to OpenSpec) that scaffolds, validates and navigates the spec.

## The problem

Common problems when building a product with AI agents:

- **Everything in one place.** The whole product is described in one file or one chat. It gets too big, details get lost, and each agent reads a lot it doesn't need.
- **No spec, only code.** Agents change code directly. Why something was built a certain way is only in chat history, and it's gone after the session.
- **One agent does everything.** The same agent writes product docs, architecture, design, code and tests. The results are worse than when each task is done separately.
- **Wrong level of detail.** A spec is either too vague to implement without guessing, or so detailed that it's hard to see the overall picture.

## Core ideas

### 1. Spec tree with levels of abstraction

A product is not described in one file. It is described as a **tree of nodes**, where each node refines its parent.

Every node has a **type**, and each type has its own level of abstraction. The project defines its node types and **which types may be children of which**. An example with three types:

| Node type | Answers | Documents it might contain |
|---|---|---|
| Product | What is the product and how is it built, at a glance? | Product overview, high-level architecture |
| Domain | How does this domain work? | Domain description, tech details, design overview of pages |
| Feature | What exactly do we build? | API specs, database schema, detailed logic, concrete component designs |

With these allowed parent → child links:

```
╭────────────────────╮
│  Product           │◀─╮
│  overview          ├──╯  Product → Product
╰─────────┬──────────╯
          │
          │  Product → Domain
          ▼
╭────────────────────╮
│  Domain            │◀─╮
│  how it works      ├──╯  Domain → Domain
╰─────────┬──────────╯
          │
          │  Domain → Feature
          ▼
╭────────────────────╮
│  Feature           │
│  implementable     │     leaf
╰────────────────────╯
```

So a Product node can be split into smaller Product nodes, a Domain node can be split into smaller Domain nodes, but a Domain node can never have a Product child, and a Product node can never have a Feature child directly. Detail only goes down, never up, and never skips a level.

A node is **one entity in the tree, not one file**. A Domain node for "checkout" can hold several documents — the domain description, the tech details and the page design overview — that all describe the same thing from different angles.

The types above are **only an example**. uspec does not fix the number of types, their names, or the documents they contain:

- A project can have 2 node types, 7, or any other number, with its own rules for allowed children.
- **Branches can have different depths.** A simple area (e.g. "settings") may need a single Domain node with a few Features under it, while a large domain (e.g. "billing") may need several Domain nodes in a row.
- **Every leaf must be implementable** — detailed enough that an agent can write the code without asking questions. A leaf that isn't implementable is incomplete and must be refined further. A review skill checks this.

An agent working on one node reads that node and its ancestors for context. It may also read nodes from other branches when it needs them (e.g. a checkout Feature reading the billing API). It does not need the whole tree.

### 2. Narrow-focus agents

Each agent has **one responsibility**. For example:

- a product agent writes and maintains product descriptions,
- an architecture agent writes architecture,
- a design agent writes page and component designs,
- a test agent writes test specs and tests,
- an implementation agent turns leaf specs into code.

These roles are **only examples**. A real project defines its own roles; they can look completely different (a compliance reviewer, a data-model owner, a copywriter, ...).

Narrow scope keeps context small, makes output predictable and makes responsibility clear.

### 3. Spec-driven code generation

The spec is the **source of truth**. The workflow is always:

1. **Change the spec first.** A change starts at the highest node it affects and moves down the tree.
2. **Keep the tree consistent.** Children must not contradict their parents. If a child contradicts its parent, either fix the child, or update the parent first and then bring the child in line.
3. **Then change the code.** Code is generated or updated from implementable (leaf) specs.
4. **Verify.** Code is checked against the spec it came from.

If code and spec disagree, the spec is right and the code is a bug — or the spec has to be changed explicitly first.

## Key concepts

| Concept | Meaning |
|---|---|
| **Spec tree** | The full set of spec nodes for a product, organised as a tree of refinements. |
| **Node** | One entity in the tree (a product, a domain, a feature, ...). It has a type and a parent (except the root), and contains one or more documents. |
| **Node type** | A level of abstraction defined by the project. It sets which documents a node contains and which types its children may have. |
| **Document** | One file inside a node that describes it from one angle (domain logic, tech details, design, ...). |
| **Leaf** | A node with no children. Every leaf must be implementable: detailed enough to write code from without questions. |
| **Role (agent)** | A narrowly focused agent with a single responsibility. |
| **Change** | An edit to the spec tree that moves top-down and then drives code changes. |
| **Code path** | The path to the code a node describes, written in that node's spec. |

## Who it is for

- Developers and small teams building products mainly with AI coding agents.
- People who want AI output to stay consistent across many sessions and agents.
- Teams that want product intent, architecture and design written down and versioned next to the code.

## First release scope

- Skills for Claude Code and Codex
- CLI

## Repository layout

uspec keeps its configuration in a `.uspec` directory at the root of the repository:

```
.uspec/
├─ config.yaml     project configuration
├─ roles/          role (agent) definitions
└─ node-types/     node type definitions: their documents and allowed children
```

The spec tree lives in `docs/` by default. The location can be changed in `config.yaml`.

Each spec node is a directory, and its documents are files inside it. A node's spec says which code paths it describes, so code can be found from the spec.

## Changes

> **TODO:** describe how a change to the spec is made and how it moves to code.

There is no proposal / apply / archive flow. A change is made directly in the spec tree, and the code follows (see [Spec-driven code generation](#3-spec-driven-code-generation)).

## Onboarding large codebases

> **TODO:** describe how to create a spec tree for a large codebase that already exists.

This is a separate process from day-to-day work with the spec.

## Success criteria

- An agent can implement a leaf node using only the spec tree, without asking clarifying questions.
- A change to a node is carried down through all affected descendants, to the leaves and the code.
- Adding a new domain, node type or role needs no change to uspec itself — only to the project's spec.
- Spec and code stay in sync over time: drift is detected, not discovered by accident.
