# uspec for VS Code

Works with [uspec](../docs/overview.md) projects: the spec tree with its types and links, its problems and drift, its open changes, and Claude Code agents that work through a change from the Changes view. It is a UI over the `uspec` CLI; what it does is specified in [docs/vscode/](../docs/vscode/overview.md).

## Requirements

- The `uspec` CLI on the `PATH` (`cargo install --path cli` in this repository), or its path in `uspec.cliPath`.
- Claude Code, for agents and terminal sessions: `claude` on the `PATH`, the Claude Code extension, or its path in `uspec.claudePath`.
- `git`, which the CLI needs for changes and drift.

## What it adds

- **Spec Tree**: nodes with their types, documents and children; new, move and remove nodes through `uspec node`; Go to Node.
- **Node**: the node of the active file, its template, upstream and downstream nodes, code paths, drift, and the context an agent reads, which can be copied.
- **Changes**: open changes with what is ready to triage, write and implement, every document's state, and the agent runs. Record states, diff documents against the baseline, review all diffs, close the change.
- **Agents**: **Run Agents** on a change runs triage, writer and implementer agents with Claude Code, one per item, with the prompts from the uspec skills, and records their results with `uspec change set`. Writer updates can wait for your approval (`uspec.agents.approveWrites`). Every run has a live log and can be resumed in a terminal.
- **Claude Code sessions**: start a change with `/uspec-spec`, or continue or implement one, in a terminal.
- **Problems, badges and editing help**: `uspec validate` errors on the right line, drift warnings, change states in the Explorer, completion and links in `node.yaml`, `node-type.yaml` and template frontmatter, and a line at the top of each spec document with its template and actions.

## Agents and permissions

Agent runs are `claude -p` in the project root. They can't ask for permission, so anything outside their rules is denied: triage and reviewers only read and run `git diff`, `git show` and `git log`; a writer may also edit its document and its `-extra/` folder; an implementer may edit its node's code paths and gets `uspec.agents.implementerAllowedTools` on top (`Bash` by default, so it can run tests). Runs cost what Claude Code costs; each run's cost is shown next to it.

## Develop

```
npm install
npm run build          # dist/extension.js, and the skills copied from ../skills
npm test               # unit tests, then integration tests in VS Code with a fake claude
npm run test:live      # the spec side of a change with the real Claude Code (costs money)
npm run package        # uspec-0.1.0.vsix
```

`Run extension` in `.vscode/launch.json` opens this repository in an Extension Development Host.
