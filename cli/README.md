# uspec CLI

The `uspec` command, in Rust. What each command does is specified in [docs/cli/](../docs/cli/overview.md), one node per command.

## Build and install

```
cargo build --release        # target/release/uspec
cargo install --path .       # puts uspec on the PATH
```

Needs `git` on the `PATH`: changes record a baseline commit, and `drift` and GitHub presets use git.

## Test

```
cargo test
```

The tests run the binary against a copy of [examples/example_product](../examples/example_product/), including a full change from the first edit to close.

## Layout

| File | What it does |
|---|---|
| `src/main.rs` | Command line, `validate`, `tree` and `types` |
| `src/project.rs` | Finds the project, reads `.uspec/config.yaml`, converts paths |
| `src/types.rs` | Loads node types and templates |
| `src/tree.rs` | Loads the spec tree |
| `src/validate.rs` | The rules in [node-types](../docs/method/node-types/rules.md) |
| `src/graph.rs` | Propagation: which documents an update reaches |
| `src/change.rs` | `change` commands and `status.yaml` |
| `src/context.rs` | `context` |
| `src/node.rs` | `node new`, `move`, `remove` |
| `src/init.rs` | `init` and presets |
| `src/drift.rs` | `drift` |
| `src/git.rs` | Calls to git |
