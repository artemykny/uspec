# VS Code extension

The extension shows a uspec project in VS Code: the [spec tree](../method/spec-tree/rules.md) with its types and links, its problems, its open [changes](../method/changes/rules.md) and what is ready in them. From the Changes view it runs Claude Code [agents](../method/agents/rules.md) on a change, one per item, with the prompts the [skills](../skills/overview.md) define, and records their results. It is a UI over the [CLI](../cli/overview.md): every rule comes from `uspec … --json`, and it never writes `status.yaml` or a `node.yaml` the CLI manages except through a CLI command.

## Projects and the CLI

**Projects.** Every directory in the workspace that holds `.uspec/` is a project, nested ones included; a file belongs to the nearest project above it, as for the CLI. The views show one root per project when there are several.

**Calling the CLI.** The extension runs `uspec --json <command>` in the project root and reads the JSON. A command that fails (`{"error": …}`, exit code 1) shows its message; `validate` and `drift` exit with 1 when they find something, which is output, not a failure. Commands that change files (`node`, `change new | set | close`, `init`) run one at a time per project, so two `change set` calls never write `status.yaml` at once.

**What is loaded.** On start and after any file in `.uspec/` or the spec root changes (debounced), the extension loads `tree`, `types`, `change list` and, for each open change, `change status` and `change next`, then runs `validate` and `drift`. The views update from it, so they follow a skill or an agent live as it works through a change.

**No CLI.** When `uspec` can't be started, the extension says so once and points to the `uspec.cliPath` setting.

## Views

The extension adds a uspec container to the activity bar with four views.

**Spec Tree.** Nodes, not folders: each node with its name, its type and a mark when it has code paths; under it its documents in its type's order, a missing required document marked, the `-extra/` folder of a document under the document, then its child nodes. The tooltip gives the type's description, the links and the code paths. A node with validation errors is marked. The view follows the active editor. Node actions:

- **New child node**: pick one of the types the parent's type allows as children, enter a name, pick links from the nodes whose types the new type may derive from, and enter code paths if the type has `code: true`; runs `uspec node new` and opens the new node's first document.
- **Move/Rename**: enter the new path; runs `uspec node move` and reports the links it rewrote.
- **Remove**: asks first; runs `uspec node remove` and shows the links that block it.
- **Open node.yaml**, **Reveal code paths**, **Search in code paths**, **Copy path**, **Show context**, **Review with Claude**.

**Go to Node** is a quick pick over every node and document of every project.

**Node.** Follows the active file: a spec document, a node's `node.yaml`, or a code file under a node's code paths (the node with the longest matching code path). It shows the node's type and, for a document, its template: description, required or optional, exposed or internal, what it derives from. Then the node's upstream (its links), its downstream (the nodes that link to it, worked out from `uspec tree`), its code paths, its state in the active change, its drift, and its context: what `uspec context` lists for writing the current document and, for a node with code paths, for implementing it, with the active change. Context files open on click; a file marked `diff since <commit>` opens as a diff. **Copy context** copies the CLI's text output, or that output followed by every listed file's content and every diff, to paste into any agent.

**Changes.** Open changes, oldest first, with their counts. The oldest is the active change, since changes are processed one at a time; another can be made active. Under each change:

- **Agents**: the agent runs of this session for the change, with their state, duration and cost.
- **Next**: what `uspec change next` lists: the triage batch with the rules that reached each candidate, the documents to write, the nodes to implement. When nothing is listed and nothing is left, the change can be closed.
- **Documents**, grouped by state, each with its reason or the rules that reached it.
- **Implementation**: the nodes with their state.
- `change.md` and `status.yaml`.

Change actions: **New change** (asks for a kebab-case name, runs `uspec change new` and opens `change.md`), **Close** (runs `uspec change close` and shows what blocks it), **Review diffs** (every updated document's diff since the baseline in one view), and the agent actions below. Document actions: **Diff since baseline**, **Record as updated** (shows what it propagated to), **Mark affected** and **Mark no-change** (ask for the reason), **Run writer**. Node actions: **Mark done**, **Run implementer**. Every state change runs `uspec change set`.

**Node Types.** Each type with its description, documents (required or optional, internal, extra, derives from), allowed children and allowed links, from `uspec types`. Types and documents open their `node-type.yaml` and templates.

**Status bar.** The active change and what is left (`refund-window · 2 to triage · 1 to write`), and the node of the active file.

**Badges.** In the Spec Tree and the Explorer, documents of the active change carry their state (`P` pending, `A` affected, `U` updated, `✓` no-change), nodes under implementation `I` until done, and drifting nodes and their code paths `D`. Unwritten documents (empty, or still the template's body) are dimmed.

## Editing

**Problems.** `validate` errors go to the Problems panel. An error about a file goes on that file; an error about a node goes on its `node.yaml`, or on its parent's when it has none. The squiggle goes on the line the error names when it can be found: the `type:` line for an unknown or disallowed type, the link for a broken or disallowed link, the `code:` line for code paths, the type id in `node-type.yaml`, the line a YAML error gives. A cycle of links puts one error on each link of the cycle. Drift adds a warning on the node's `node.yaml`. Lines of a document that are still template guidance (a line of the template's body with `<…>` text) are flagged as information.

**`node.yaml`.** Completion for the keys; for `type`, the types the parent's type allows; for `derives_from`, the nodes whose types this node's type may derive from; for `code`, paths in the project. Hover on the type, a link or a code path describes it; Ctrl+click opens a link's `node.yaml` or reveals a code path.

**`node-type.yaml` and templates.** Completion for the keys, for type ids in `children` and `derives_from`, for document ids in `documents` and in a template's `derives_from`, and for the booleans; type ids and document ids link to their files.

**Spec documents.** A line at the top gives the template's description, with **Show context**, **Open template**, and during the active change the document's state with **Diff since baseline**, **Record as updated** and, for an affected document, **Run writer**.

## Agents

Agents are Claude Code runs started by the extension: `claude -p` with `--output-format stream-json`, in the project root, with the prompt on stdin. Each run does one job of the active change, as in [agents](../method/agents/rules.md); the extension plays the main agent's part of recording results, and the user approves through the views.

**Roles.**

| Role | One run per | Prompt | Input after the prompt |
|---|---|---|---|
| Triage | the triage batch of `change next` | `uspec-spec/triage-agent.md` | the batch as `change next` prints it: `read` and `batch` |
| Writer | document under `write` | `uspec-spec/writer-agent.md` | `uspec context <node> --document <id> --change <name>` |
| Implementer | node under `implement` | `uspec-implement/implementer-agent.md` | `Mode: implement`, or `Mode: check` when `change.md` says the change comes from an experiment, then `uspec context <node> --implement --change <name>` |
| Reviewer | node | `uspec-review/reviewer-agent.md` | the node's `uspec context` output, as `uspec-review` gives it |

A prompt is read from the project's `.claude/skills/`, then `~/.claude/skills/`, then the copy of [skills/](../../skills/) bundled with the extension.

**Permissions.** A run can't ask for permission: anything it isn't allowed is denied. MCP servers are not loaded. Its system prompt says so, and names what it may edit, so it doesn't spend turns on commands that would be denied (a loop or a `git -C` doesn't match the rules).

| Role | Tools | Allowed |
|---|---|---|
| Triage, reviewer | Read, Glob, Grep, Bash | reading, `git diff`, `git show`, `git log` |
| Writer | and Edit, Write | and editing its document and its `-extra/` folder |
| Implementer | Read, Glob, Grep, Bash, Edit, Write | reading, git, editing under its node's code paths, and the tools in `uspec.agents.implementerAllowedTools` (Bash by default, to run tests) |

**Results.** The run's final message is read as the prompt's output format; code fences and emphasis are ignored.

- Triage: each line `<document> | affected | <reason>` or `<document> | no-change | <reason>` for a document of the batch is recorded with `change set`. Candidates without a decision stay pending and go to the next triage run; the notes are shown.
- Writer: `updated` is recorded as `updated` once approved (see below), and anything the writer adds after its result is kept as notes; `no change` is recorded as `no-change` with its reason; `blocked` records nothing and is shown to the user with what needs to change upstream. A writer that says `updated` without changing the document, or `no change` after changing it, records nothing.
- Implementer: `done` is recorded as `done`; `gap` and `failed` record nothing and are shown.
- Reviewer: records nothing; its findings are shown.

Anything else is a failed run, which records nothing.

**Approval.** Before a writer runs, the document is saved. An `updated` result that is user-visible (or every one, or none, per `uspec.agents.approveWrites`) waits for the user: **Show diff** compares the document with what it was, **Approve** records `updated`, **Reject** puts the saved content back and leaves the document `affected`. Once nothing of the change waits for the user, approving offers to run its agents again.

**Running a change.** **Run agents** on a change repeats rounds until nothing is ready or something needs the user: each round runs `change next`, starts the triage run and a writer per document to write, or, when both are empty, an implementer per node to implement, at most `uspec.agents.maxParallel` at once, and waits for them. It stops when a run waits for approval, is blocked, finds a gap or fails, or when a triage run records nothing. Running agents on a change that isn't the oldest open one asks first, since changes are processed oldest first. Single items run from their own actions, and an item `change next` doesn't list as ready asks first; an item already running isn't started twice. **Stop** ends the change's runs.

**Logs.** Every run has a log, live while it runs: the prompt's input, the agent's messages and tool calls, denied permissions, the result, its cost and session id. **Open in Claude Code** resumes the run's session in a terminal.

**Interactive sessions.** Work that needs a conversation with the user runs in a terminal with Claude Code: **Start change in Claude Code** asks what should change and runs `/uspec-spec` with it; **Continue in Claude Code** and **Implement in Claude Code** run `/uspec-spec` and `/uspec-implement` on a change. These need the skills installed; **Install Skills** copies the bundled skills into the project's `.claude/skills/`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `uspec.cliPath` | `uspec` | The uspec CLI. |
| `uspec.claudePath` | empty | Claude Code. Empty: `claude` on the `PATH`, then the binary bundled with the Claude Code extension. |
| `uspec.agents.model` | empty | Model for agent runs; empty uses Claude Code's default. |
| `uspec.agents.maxParallel` | 4 | Agent runs at once per change. |
| `uspec.agents.approveWrites` | `user-visible` | Which writer updates wait for approval: `user-visible`, `always` or `never`. |
| `uspec.agents.implementerAllowedTools` | `["Bash"]` | Permission rules implementers get on top of editing their code paths. |
| `uspec.validateOnChange` | true | Run `validate` after every change to the tree. |
| `uspec.drift.enabled` | true | Run `drift` with every refresh. |
| `uspec.specTree.followActiveEditor` | true | Reveal the active file in the Spec Tree. |
| `uspec.templateHints` | true | Flag template guidance left in documents. |

## Implementation

TypeScript in [vscode/](../../vscode/), bundled with esbuild into `dist/extension.js`. `npm run build` also copies [skills/](../../skills/) into `vscode/skills/`, the bundled prompts. `npm test` runs the unit tests (parsing, paths, problem locations) with mocha, then two integration suites in a VS Code instance with the CLI built from [cli/](../../cli/): `flow` against a copy of [examples/example_product](../../examples/example_product/), with a fake `claude` that answers in each role's format, from the first update to close; and `multi` against a copy of this repository, whose tree has the example product nested in it. `npm run test:live` runs the spec side of a change with the real Claude Code, which costs money. `npm run package` builds a `.vsix`.

| File | What it does |
|---|---|
| `src/extension.ts` | Activation: creates the model, views, providers and commands |
| `src/core/cli.ts` | Runs the CLI and parses its JSON; the per-project lock |
| `src/core/model.ts` | The CLI's JSON shapes |
| `src/core/paths.ts` | Projects, nodes and documents for a file; code-path matching |
| `src/core/issues.ts` | Where a `validate` error goes: file and line |
| `src/core/yaml.ts` | Which key and list the cursor is in, in `node.yaml`, `node-type.yaml` and frontmatter |
| `src/core/templates.ts` | Template bodies, unwritten documents, leftover guidance |
| `src/core/agents.ts` | Agent prompts, tools and permission rules per role, the headless system prompt, result parsing |
| `src/core/claude.ts` | Starts `claude -p` and reads its stream |
| `src/projects.ts` | Finds projects, loads them, refreshes on file changes |
| `src/views/*.ts` | Spec Tree, Node, Changes and Node Types views |
| `src/decorations.ts`, `src/diagnostics.ts`, `src/editing.ts`, `src/codelens.ts`, `src/statusbar.ts` | Badges, problems, completion and links, document lenses, status bar |
| `src/commands.ts` | Node, change and context commands |
| `src/agents.ts` | Agent runs of a change: starting, recording, approval, logs |
| `src/terminal.ts` | Claude Code sessions in a terminal; installing the skills |
| `src/content.ts` | Read-only documents: a file at the baseline, context output, run logs |
