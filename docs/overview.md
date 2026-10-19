# uspec

uspec is a specification method for building products with AI agents, plus the tooling for it. A product is described as a **tree of spec nodes**. The spec is the **source of truth**: **narrowly focused agents** write each part of it, and code is generated from it, never the other way round. The method is in [method/](method/), the tools in [cli/](cli/), [skills/](skills/) and [vscode/](vscode/).

## The problem

- **Everything in one place.** The product lives in one file or one chat. It grows too big, details get lost, and every agent reads what it doesn't need.
- **No spec, only code.** Agents change code directly; the reasons stay in chat history and are gone after the session.
- **One agent does everything.** The same agent writes product docs, architecture, design, code and tests, and does each worse than a focused one would.
- **Hidden dependencies.** A screen depends on a service's API, the service on a user story, but nothing says so. A change in one place silently breaks another.

## Who it's for

Developers and small teams who build mainly with AI agents and want product intent, architecture and design versioned next to the code.

## Scope

The first release contains:

- **The method**: how a product is split into a spec tree, and how a change moves through it to the code.
- **A CLI** (similar in spirit to OpenSpec) that scaffolds, validates and navigates the spec and tracks changes.
- **Skills for Claude Code and Codex** that describe a change with the user, review the spec, and turn experiments into spec changes.
- **A VS Code extension** that shows the tree, its problems and its changes, and orchestrates a change: it runs the agents that find, triage and write the documents, plan the code and implement the plans.
- **Presets**: ready-made node types to start a project from, including a minimal one for small apps.

Out of scope for the first release:

- Onboarding an existing codebase (building the first tree from code). Its design isn't finished.
- Recording triage results after a change closes, to detect edits that were never propagated.

## Success criteria

- An agent can implement any node with code paths from its context alone, without clarifying questions.
- A change reaches every affected node and the code.
- Adding a domain or node type needs no change to uspec, only to the project's spec.
- Drift between spec and code is detected, not discovered by accident.
