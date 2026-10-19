# CLI

The `uspec` command does everything that doesn't need judgement: it scaffolds the tree, validates it, works out where a change propagates, tracks the change's state and assembles the context an agent reads. [Skills](../skills/) do the writing and call the CLI for the rest. Concepts are defined in [method/](../method/).

## Commands

| Command | What it does |
|---|---|
| [`init`](init/) | Creates `.uspec/`, the node types and the root node. |
| [`validate`](validate/) | Checks the tree's structure. |
| [`tree`](tree/) | Prints the tree with node types. |
| [`types`](types/) | Prints the node types with their documents. |
| [`context`](context/) | Prints the instructions and files an agent reads to write a document or implement a node. |
| [`node`](node/) | Adds, moves and removes nodes. |
| [`change`](change/) | Opens a change, shows what's ready to triage, write or implement, records results, closes it. |
| [`drift`](drift/) | Finds code changed without a spec change. |

## Conventions

### Project

A project looks like this:

```
.uspec/
├─ config.yaml     configuration (optional)
├─ node-types/     one directory per type: node-type.yaml + a template per document
└─ changes/        open changes, committed with the work
docs/              the spec tree
```

Commands run from anywhere inside the project: the project root is the nearest directory, from the current one upwards, that has `.uspec/`. If there is none, the command fails and suggests `uspec init`. `init` is the exception: it creates the project in the current directory.

Every other command loads the node types and the spec tree first. Problems in the node types don't stop a command; `validate` reports them. A missing spec root does.

### Configuration

`.uspec/config.yaml` is optional:

```yaml
spec_root: docs   # the spec tree's directory, relative to the project root (default: docs)
```

`spec_root: .` puts the tree in the project root itself.

### Paths

Paths in the output are relative to the project root (`docs/system/services/payments/api.md`), so an agent can open them as they are. `status.yaml` and node links use paths relative to the spec root (`system/services/payments/api.md`). Arguments that name a node or document accept either form, with or without a leading `./` or trailing `/`. The root node is `.` (the spec root's name, `docs`, also works).

### Output

Text output is for people. `--json` is accepted by every command and prints one pretty-printed JSON object instead, so skills can read it. In JSON, a document is given both as `document` (spec-relative) and `path` (project-relative).

### Errors and exit codes

A command that fails prints `error: <message>` to stderr, or `{"error": "<message>"}` to stdout with `--json`, and exits with 1. `validate` and `drift` also exit with 1 when they find errors or drift; their findings are output, not an error. Invalid arguments are rejected with a usage message and exit code 2. Otherwise the exit code is 0.

### Git

The CLI needs `git` on the `PATH` and calls it as a subprocess. Changes record the current commit as their baseline, so they need a repository with at least one commit; `context` and `change next` point to diffs since that commit; `drift` compares commit history; GitHub presets are cloned with git.

## Implementation

Rust 2021, in [cli/](../../cli/), built with Cargo: `cargo build --release` (or `cargo install --path .` to put `uspec` on the `PATH`). Dependencies: `clap` for the command line, `serde`, `serde_yaml` and `serde_json` for files and output, `indexmap` to keep the tree and types in order, `anyhow` for errors.

`cargo test` runs the binary against a copy of [examples/example_product](../../examples/example_product/), including a full change from the first edit to close.

The files shared by all commands:

| File | What it does |
|---|---|
| `src/main.rs` | The command line, output and error handling; dispatches to the commands |
| `src/project.rs` | Finds the project, reads `.uspec/config.yaml`, converts paths |
| `src/types.rs` | Loads node types and templates, collecting their problems for `validate` |
| `src/tree.rs` | Loads the spec tree and answers questions about it (ancestors, descendants, links) |
| `src/git.rs` | Calls to git |

Each command's own code is listed in its node.
