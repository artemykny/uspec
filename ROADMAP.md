# Roadmap

uspec is at the design stage: the method is written down, no tooling exists yet. The first release is a CLI plus skills for Claude Code and Codex ([product-overview.md](docs/product-overview.md)).

## Done

- [x] Product overview: spec tree, nodes, types, links, context, code paths ([product-overview.md](docs/product-overview.md))
- [x] Node type and node format, validation rules ([node-types.md](docs/node-types.md))
- [x] Workflow: two modes, stateful changes, propagation and triage, experiments ([workflow.md](docs/workflow.md))
- [x] Example product spec tree ([examples/example_product](examples/example_product/))

## 1. Finish the design

- [ ] Onboarding an existing codebase: how the first tree is built from code ([workflow.md](docs/workflow.md#4-onboard-an-existing-codebase))
- [ ] Format of `change.md` and `status.yaml`, and how propagation fills `status.yaml`
- [x] CLI command surface, first draft ([cli.md](docs/cli.md))
- [x] Skills list, first draft ([skills.md](docs/skills.md))
- [ ] Drift check: how code changed without a spec change is detected
- [ ] Presets: where they are published on GitHub and how `uspec init` names one

## 2. CLI

- [ ] `uspec init`: empty project (one basic node type, a root node with one document) and from a preset
- [ ] `uspec validate`: every rule in [node-types.md](docs/node-types.md#validation)
- [ ] `uspec change`: open a change, compute propagation into `status.yaml`, show what is ready, close
- [ ] Drift check

## 3. Skills

- [ ] Change spec: propose structure, write documents from templates, triage propagated changes
- [ ] Implement: write and verify the code of a node from its context
- [ ] Review: check that nodes with code paths are implementable and don't contradict upstream
- [ ] Experiment to spec: turn a code diff into a spec change

## 4. Presets

- [ ] First preset from the example product's node types
- [ ] A minimal preset for small apps

## Later

- [ ] Record triage results after a change closes, to detect edits that were never propagated (e.g. a lock file of document hashes)
- [ ] Onboarding skill, once its design is done
