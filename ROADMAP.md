# Roadmap

uspec is at the design stage: the method is written down, and first versions of the CLI, the skills and the VS Code extension exist. The first release is a CLI plus skills for Claude Code and Codex, and a VS Code extension ([docs/overview.md](docs/overview.md)).

## Done

- [x] Product overview and the method's concepts: spec tree, node types, links, context, changes, agents, experiments, drift ([docs/method/](docs/method/overview.md))
- [x] Node type and node format, validation rules ([node-types](docs/method/node-types/rules.md))
- [x] Workflow: two modes, stateful changes, propagation and triage, experiments ([changes](docs/method/changes/rules.md))
- [x] Example product spec tree ([examples/example_product](examples/example_product/))

## 1. Finish the design

- [ ] Onboarding an existing codebase: how the first tree is built from code
- [ ] Format of `change.md` and `status.yaml`, and how propagation fills `status.yaml`
- [x] CLI command surface, first draft ([docs/cli/](docs/cli/overview.md))
- [x] Skills list, first draft ([docs/skills/](docs/skills/overview.md))
- [ ] Drift check: how code changed without a spec change is detected
- [ ] Presets: where they are published on GitHub and how `uspec init` names one

## 2. CLI

Implemented in Rust in [cli/](cli/).

- [x] `uspec init`: empty project (one basic node type, a root node with one document) and from a preset
- [x] `uspec validate`: every rule in [node-types](docs/method/node-types/rules.md)
- [x] `uspec change`: open a change, compute propagation into `status.yaml`, show what is ready, close
- [x] Drift check (a heuristic on commit times, see [drift](docs/cli/drift/usage.md))

## 3. Skills

First drafts for Claude Code in [skills/](skills/).

- [x] Change spec: propose structure, write documents from templates, triage propagated changes
- [x] Implement: write and verify the code of a node from its context
- [x] Review: check that nodes with code paths are implementable and don't contradict upstream
- [x] Experiment to spec: turn a code diff into a spec change

## 4. Presets

- [ ] First preset from the example product's node types
- [ ] A minimal preset for small apps

## 5. VS Code extension

Implemented in TypeScript in [vscode/](vscode/), specified in [docs/vscode/](docs/vscode/overview.md).

- [x] `uspec types`: the node types as JSON, for editors and skills ([cli/types](docs/cli/types/usage.md))
- [x] Spec Tree, Node, Changes and Node Types views; problems from `validate`, drift, badges, editing help
- [x] Agents on a change from the Changes view: triage, writers and implementers with Claude Code, recorded through the CLI, with approval of writer updates
- [ ] Graph views of the types, the links and a change's propagation
- [ ] Publish to the Marketplace

## Later

- [ ] Record triage results after a change closes, to detect edits that were never propagated (e.g. a lock file of document hashes)
- [ ] Onboarding skill, once its design is done
