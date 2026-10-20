# VS Code extension

The extension shows a uspec project in VS Code: the [spec tree](../method/spec-tree/rules.md) with its types and links, its problems, its open [changes](../method/changes/rules.md) and what is ready in them. It is the orchestrator of a change ([agents](../method/agents/rules.md)): from the Changes view it runs the selected CLI agent on the change, one run per item in the session its configuration names, with the prompts that come with the [skills](../skills/overview.md), records their results, and stops when the user is needed. Skills don't orchestrate; they send the user here. It is a UI over the [CLI](../cli/overview.md): every rule comes from `uspec … --json`, and it never writes `status.yaml` or a `node.yaml` the CLI manages except through a CLI command.

## Projects and the CLI

**Projects.** Every directory in the workspace that holds `.uspec/` is a project, nested ones included; a file belongs to the nearest project above it, as for the CLI. The views show one root per project when there are several.

**Calling the CLI.** The extension runs `uspec --json <command>` in the project root and reads the JSON. A command that fails (`{"error": …}`, exit code 1) shows its message; `validate` and `drift` exit with 1 when they find something, which is output, not a failure. Commands that change files (`node`, `change new | set | close`, `init`) run one at a time per project, so two `change set` calls never write `status.yaml` at once.

**What is loaded.** On start and after any file in `.uspec/` or the spec root changes (debounced), the extension loads `tree`, `types`, `change list` and, for each open change, `change status` and `change next`, then runs `validate` and `drift`. The views update from it, so they follow a skill or an agent live as it works through a change.

**No CLI.** When `uspec` can't be started, the extension says so once and points to the `uspec.cliPath` setting.

## Views

The extension adds a uspec container to the activity bar with one explorer and exactly three root branches, in order: **Changes**, **Node types**, **Specification**. Changes is collapsed by default. Project groups appear inside these branches in multi-project workspaces.

**Specification and node type appearance.** Both branches use compact native tree rows with consistent indentation and aligned icons. Specification nodes use a node icon, documents a file icon, and extra folders a folder icon; node types use a distinct type icon. Names are the primary text, with node type ids and document flags in muted secondary text. Code paths have a code icon, and validation and drift marks use the theme's error and warning colors alongside their existing symbols. Row actions appear on hover or keyboard focus and remain available through the context menu. Long labels truncate with the full name and path in the tooltip. Selection, hover, focus, typography and backgrounds follow the active VS Code theme, including light, dark and high contrast themes; state is never conveyed by color alone.

**Spec Tree.** Nodes, not folders: each node with its name, its type and a mark when it has code paths; under it its documents in its type's order, a missing required document marked, the `-extra/` folder of a document under the document, then its child nodes. The tooltip gives the type's description, the links as written (with the document and section they narrow to) and the code paths. A node with validation errors is marked. The view follows the active editor. Node actions:

- **New child node**: pick one of the types the parent's type allows as children, enter a name, pick links from the nodes whose types the new type may derive from, and enter code paths if the type has `code: true`; runs `uspec node new` and opens the new node's first document.
- **Move/Rename**: enter the new path; runs `uspec node move` and reports the links it rewrote.
- **Remove**: asks first; runs `uspec node remove` and shows the links that block it.
- **Open node.yaml**, **Reveal code paths**, **Search in code paths**, **Copy path**, **Show context**, **Review with Agent**.

**Go to Node** is a quick pick over every node and document of every project.

**Node overview.** One editor tab, reused, that describes one node. It opens beside the current editor when a node or document is selected in the Specification branch or in Go to Node, and then follows the active file: a spec document, a node's `node.yaml`, or a code file under a node's code paths (the node with the longest matching code path). A file that belongs to no node leaves the overview on its last node. The open document, if any, is the **current document**.

From top to bottom it shows:

- **Header**: the node's name, its project-relative path in muted text, and its type's name as a label, with the type id on hover. A node with validation errors shows their count, which opens the Problems panel.
- **About**: the type's description; then, with a current document, the document's name, its template's description and its flags as `uspec types` words them: `required` or `optional`, `exposed` or `internal`, `extra`, and `derives from <ids>`.
- **Upstream**: the node's links in `node.yaml` order, each as the linked node's name with the document or section it narrows to; a click opens that section at its heading, that document, or the linked node's overview.
- **Downstream**: the nodes that link to this one, worked out from `uspec tree`, each with what its link narrows to; a click opens its overview.
- **Code paths**: each path; a click reveals it in the Explorer. A type without `code: true` says **No code**.
- **Active change**: the active change's name, then each of the node's documents in it with its state (`pending`, `affected`, `updated` or `no-change`) and its reason, or the rules that reached it, and the node's implementation state (`pending` or `done`). A node the change hasn't reached says **Not in this change**; without an open change, **No active change**.
- **Drift**: the reason `uspec drift` gives for the node.
- **Context**: what `uspec context` lists with the active change, grouped as the CLI groups it (instructions first, then the files under their group names). For a node with code paths, a **Write** / **Implement** switch beside the heading chooses between the context of writing the current document and that of implementing the node; without a current document only **Implement** is offered, and a node with neither says so. A file opens on click, a section at its heading; a file marked `diff since <commit>` opens as a diff. **Copy context**, beside the heading, copies the CLI's text output, or that output followed by every listed file's content and every diff, to paste into any agent.

Every section has a heading and says **None** when empty. File rows show the file's name first and its path as secondary text; long paths truncate with the full path on hover. States and flags are short text labels, never color alone, with their meaning on hover. Sections are separated by subtle theme-colored dividers with even spacing, in one column; on a narrow editor paths and labels wrap and section actions move below their heading. The overview uses the editor's background, font and theme colors in light, dark and high contrast themes, and every action is reachable by keyboard with a visible focus indicator.

**Changes.** Open changes, oldest first, with their counts. The oldest is the active change, since changes are processed one at a time; another can be made active. Under each change:

- **Next**: what `uspec change next` lists, in the order of the change's steps: **Find starting documents** while the impact step is due; the triage batch with the rules that reached each candidate; the documents to write grouped by node; **Plan** with the nodes to plan; the plans ready to implement, each with its nodes; and the plan errors. When nothing is listed and nothing is left, the change can be closed.
- **Documents**, grouped by state, each with its reason or the rules that reached it.
- **Plans**: each plan with its state, its nodes and what it comes after; a plan opens its file.
- **Implementation**: the nodes with their state.
- `change.md` and `status.yaml`.

Change actions: **New change** (asks for a kebab-case name, runs `uspec change new` and opens `change.md` to fill in from the template; or **Start Change with Agent** to write it with `uspec-spec`), **Show state** (opens the change state window below), **Close** (runs `uspec change close` and shows what blocks it), **Review diffs** (every updated document's diff since the baseline in one view), and the agent actions below. Document actions: **Diff since baseline**, **Record as updated** (shows what it propagated to), **Mark affected** and **Mark no-change** (ask for the reason), **Add to change** on a document not in it (marks it `affected` as a starting document, asking for the reason), **Run writer** (runs the writer of the document's node, with that document and the node's other documents under `write`). Node actions: **Mark done**. Plan actions: **Run implementer**, **Open plan**. Every state change runs `uspec change set`.

**Change state.** A compact editor view follows the [review workflow](#review-workflow). It uses VS Code theme tokens, native tree items and ordinary VS Code button styles, including light and high contrast themes. No separate terminal inventory or explanatory cards. Use a single scrolling step bar, compact file rows with filenames and muted paths, and native section-header colors. Primary actions advance or approve work; document and terminal actions are secondary. Do not repeat agent status in a plan row. Keep plan metadata and actions aligned in two compact rows, use short status labels with detailed hover text, show added/removed line counts on file reviews, and reveal optional comment inputs on demand. On narrow editors, keep the current step visible within the scrolling bar. Split proposals render as readable plan rows, with the Markdown source available through Open.

1. **Describe**: **Open change.md**, **Process change.md**. No agent button here. Processing first asks how the change goes on: a quick pick of the session modes (see sessions under [agents](#agents)), each with its sessions per role, the change's current mode first; the chosen mode becomes the change's, and processing immediately enters Change plan. Escape leaves the change in Describe.
2. **Change plan**: the impact agent produces `change-plan.md`, a Markdown review document. The file list is read from that document. **Approve**, **Go back**, **Continue with agent**; continuation resumes the same session.
3. **Triage & write**: review triage recommendations, select files to rewrite and optionally comment per file. No-change files are hidden. Writers run once per ready node, or once for the nodes of a round whose writers share a session; updated files are grouped by node with one agent status/control per node. Each file has an inline diff, **collapsed by default**, and **Open diff in VS Code**, which opens the native diff editor. No aggregate write review document.
4. **Split plans**: review `plan-split.md`, assigning nodes and dependencies to separate paths such as `plans/cli.md` and `plans/vscode.md`. Approve before generation. With the splitter `off` (see [sessions](#agents)), the extension writes the split itself and records it as approved, so there is nothing to review.
5. **Implementation plans**: generate each approved plan with its own agent. Independent generation can run in parallel, regardless of implementation dependencies. Review/approve each plan separately; there is no global implementation plan.
6. **Implement**: per-plan progress, dependencies and **Open agent window**. All current plans must be approved before any implementation starts.
7. **Complete**: close once the CLI says all work is settled.

The window's footer, on every step, has **Sessions: <mode>**, which shows the change's session mode with its sessions per role on hover and changes it with the same quick pick, and **New context** while the change's mode names sessions, one of them has a session id and no agent of the change is running (see sessions). Completed steps can be revisited without undoing recorded changes. Agent status appears beside the node or plan it belongs to, with the run's session name, including running agents when a later step is viewed. A gap returns to spec work. Every mutation of method state still goes through the CLI.

**Node Types.** Each type with its description, documents (required or optional, internal, extra, derives from), allowed children and allowed links, from `uspec types`. Types and documents open their `node-type.yaml` and templates.

**Status bar.** The active change and what is next (`refund-window · find starting documents`, `refund-window · 2 to triage · 1 to write`, `refund-window · plan`, `refund-window · 2 plans to implement`), and the node of the active file. Clicking the active change opens its change state window.

**Badges.** In the Spec Tree and the Explorer, documents of the active change carry their state (`P` pending, `A` affected, `U` updated, `✓` no-change), nodes under implementation `I` until done, and drifting nodes and their code paths `D`. Unwritten documents (empty, or still the template's body) are dimmed.

## Editing

**Problems.** `validate` errors go to the Problems panel. An error about a file goes on that file; an error about a node goes on its `node.yaml`, or on its parent's when it has none. The squiggle goes on the line the error names when it can be found: the `type:` line for an unknown or disallowed type, the link for a broken or disallowed link, the `code:` line for code paths, the type id in `node-type.yaml`, the line a YAML error gives. A cycle of links puts one error on each link of the cycle. Drift adds a warning on the node's `node.yaml`. Lines of a document that are still template guidance (a line of the template's body with `<…>` text) are flagged as information.

**`node.yaml`.** Completion for the keys; for `type`, the types the parent's type allows; for `derives_from`, the nodes whose types this node's type may derive from, then, after a node and `/`, its exposed documents, and after a document and `#`, the anchors of its sections; for `code`, paths in the project. Hover on the type, a link or a code path describes it, a section link with the section's first lines; Ctrl+click opens a link's `node.yaml`, its document, or its document at the section's heading, or reveals a code path.

**`node-type.yaml` and templates.** Completion for the keys, for type ids in `children` and `derives_from`, for document ids in `documents` and in a template's `derives_from`, there followed after `#` by the anchors of the sections in that document's template, and for the booleans; type ids and document ids link to their files.

**Spec documents.** A line at the top gives the template's description, with **Show context**, **Open template**, and during the active change the document's state with **Diff since baseline**, **Record as updated** and, for an affected document, **Run writer**, which runs its node's writer as in the Changes view.

## Agents

Agents are Claude Code or Codex runs started in native VS Code terminals, hidden until requested. A run is the provider's own interactive TUI (`claude` or `codex`, never `claude -p` or `codex exec`) with the prompt as its first message, so its terminal shows the real agent session, not a log of headless output. The extension never reads the terminal: the agent's hooks (Claude Code's `SessionStart` and `Stop` hooks via `--settings`, Codex's `notify` program) append the session id and each turn's final message to a sidecar file, and the final message of the first turn is the run's result. A run fails when the agent exits or its terminal closes before that turn ends. After its first turn the session stays open in its terminal for the user, and opening a run reveals only its terminal in the editor. Once the agent has exited, Continue resumes its exact session with the original provider in that terminal; a new automated run in the same session asks before ending a still-open one (see sessions below). When a change closes, the sessions of its runs close with it, as do the sessions Continue with Agent opened for it. Input is never replaced by a webview chat. Each run does one job of the active change, as in [agents](../method/agents/rules.md); the extension is the orchestrator that starts them and records their results, and the user approves through the views.

**Roles.**

| Role | One run per | Prompt | Input after the prompt |
|---|---|---|---|
| Impact | the change, while `change next` lists `impact` | `uspec-spec/impact-agent.md` | `Change: <path of change.md>`, then the text output of `uspec tree` |
| Triage | the triage batch of `change next` | `uspec-spec/triage-agent.md` | the batch as `change next` prints it: `read` and `batch` |
| Writer | node under `write`, or the nodes of a round whose writers share a session | `uspec-spec/writer-agent.md` | `uspec context <node> --document <id>... --change <name>`, one `--document` per document listed for the node; for several nodes, each node's under `## <node>` |
| Splitter | settled change with unplanned nodes, unless the splitter is `off` | `uspec-spec/splitter-agent.md` | change, nodes, existing plans and implementation contexts; returns the Markdown split proposal |
| Planner | one approved split entry | `uspec-spec/planner-agent.md` | `Change:` and `Plans:` (the path of `change.md` and of the plans directory), `Nodes to plan:` one per line, `Existing plans:` one path per line or `none`, then for each node to plan `## <node>` and `uspec context <node> --implement --change <name>` |
| Implementer | plan under `implement` | `uspec-spec/implementer-agent.md` | `Mode: implement`, or `Mode: check` when `change.md` has `mode: check` in its YAML frontmatter, then `Plan: <path of the plan>`, then for each of its nodes `## <node>` and `uspec context <node> --implement --change <name>` |
| Reviewer | node | `uspec-review/reviewer-agent.md` | the node's `uspec context` output, as `uspec-review` gives it |

The provider is selected in `uspec.agents.provider` (Claude Code by default). Codex runs take the thread id and final agent message from its `agent-turn-complete` notification. Each run persists its provider; changing settings affects new runs, never the provider used to resume an existing session. Codex models have separate settings, so Claude aliases are never passed to Codex. Codex uses read-only sandboxing for impact, triage, splitter and review, and workspace-write for writer, planner and implementer, with approval prompts disabled. File scope is a prompt instruction for Codex, not the per-file permission enforcement available in Claude. Codex retains the user’s CLI configuration and authentication.

A prompt is read from the selected provider’s skill directory (`.claude/skills/` for Claude, `.agents/skills/` for Codex), then the corresponding directory in the user’s home, then the copy of [skills/](../../skills/) bundled with the extension.

**Sessions.** Every run is in a session, named per role by the session mode of its change (see [agents](../method/agents/rules.md)). A mode is a map from role to session name. The presets below are always there; `uspec.agents.sessions` is a map from mode name to mode that adds modes, and a preset's name in it replaces that preset. A change uses the mode chosen for it (Process change.md, **Sessions** in the change state window, or **Choose Agent Sessions…** on the change), kept with the change across reloads; until one is chosen, or while the chosen one no longer exists, it uses `uspec.agents.sessionMode`. A mode can be changed at any step: each job names its session from the mode when it starts. The roles that can be named are `impact`, `triage`, `writer`, `splitter`, `planner` and `implementer`; the reviewer always gets a new session, since it isn't part of a change. Jobs of one change whose names resolve to the same name share one session: the next job resumes it with its own prompt. A name not used yet in the change starts a new session, and a role without a name gets a new session for every job. The same name in two changes is two sessions; a change's sessions close when it closes.

| Preset | Mode | Meaning |
|---|---|---|
| `isolated` (default) | `{}` | Every job in a new session. |
| `simple` | `{ "impact": "explore", "triage": "explore", "writer": "explore", "splitter": "off", "planner": "explore", "implementer": "explore" }` | Everything in the explore session, one plan. |
| `complex` | `{ "impact": "explore", "triage": "spec", "writer": "spec", "splitter": "build", "planner": "plan-{plan} from build", "implementer": "plan-{plan}" }` | One session per stage, one per plan. |

A mode is the whole configuration: it isn't merged with a preset, and roles it leaves out get a new session per job. For example, `{ "fast": { "impact": "explore", "triage": "explore", "writer": "explore", "splitter": "off", "planner": "build", "implementer": "build" } }` adds `fast`, which writes the spec in the explore session and plans and implements in another.

- **Placeholders** make a name per item: `{round}` (triage, writer) is the triage/write round of the change, from 1; `{node}` (writer) the node it writes; `{plan}` (planner, implementer) the plan id. Round 1 writes the starting documents; every triage run starts the next round, and writers belong to the round of the last triage run before them. Round numbers persist with the change across reloads.
- **`explore`** is the user's interactive `uspec-spec` session of the change, the main agent (the explore stage in settings and views). Start Change with Agent and Continue with Agent capture its session id through the agent's hooks, as runs do, and keep it with the change across reloads. If the change has no explore session yet (`change.md` was written by hand or outside VS Code), the first job named `explore` starts a new session, which becomes the change's explore session.
- **`"splitter": "off"`** runs no splitter: the extension writes `plan-split.md` itself with one entry, `plans/<change>.md`, owning every unplanned node, and records it as approved without asking. If unplanned nodes appear later (after a gap), the next entry is `plans/<change>-2.md`, after the existing plans, and so on. `uspec.agents.approvePlans` still applies.
- **Forks.** `"<name> from <session>"`: the first time `<name>` is used, its session starts as a fork of `<session>`, a plain name used by an earlier stage, or `explore`: it has that session's history, and the two go on separately. Claude Code forks with `--resume <id> --fork-session`. A provider that can't fork starts a new session, and the run log says so.
- **New context** (in the change state window, or **Start New Agent Context** on the change) is for a session whose context has grown too large: the change forgets its sessions, so the next job of each name starts a new session, which the jobs after it continue, as on a first use. A fork whose source was forgotten starts a new session. The `explore` name too starts a new session, which becomes the change's explore session. The mode and the round stay, and earlier runs keep their own session ids, so Continue with agent still resumes them. It isn't offered while agents of the change run.

The settings are checked when the extension loads and when they change. In a mode, an unknown role, a role map that isn't a map, a placeholder not allowed for the role, `from` naming a session no earlier stage uses, `off` on a role other than `splitter`, or a planner forking from the splitter's session while the splitter is `off` shows a warning that names the setting, the mode and what is wrong (`uspec.agents.sessions: fast: {plan} can't be used by triage. Its jobs run in new sessions until this is fixed.`), and every job of a change using that mode runs in a new session until it is fixed; the other modes are unaffected. A `uspec.agents.sessions` that isn't a map leaves only the presets, and a `uspec.agents.sessionMode` that names no mode makes `isolated` the default, each with a warning.

**Shared sessions.**

- **One job at a time per session.** Jobs that resolve to the same session wait for each other, in the order the run loop starts them. Jobs in different sessions run in parallel, at most `uspec.agents.maxParallel` per change.
- **Writers sharing a session in a round are one job.** Its input has each node's `uspec context` under `## <node>`, it may edit every one of those documents, and its result has one block per document. Approval, rejection and recording stay per document. Names with `{node}` keep one job per node.
- **Resuming.** A job in an existing session starts the provider with `--resume <id>` (Codex: `resume <id>`), its own prompt and input, and its own role's permissions: tools, allowed rules, edit scope and Codex sandbox, never those of an earlier job in the session. It runs in the terminal of the session's last job. If that terminal still runs the agent (the user is talking to it, or it is the explore session), the extension asks first: **End and Continue** ends it and starts the job; **Cancel** leaves the job not started and stops the run loop.
- **Re-read note.** A job in a session that already did a job is told in its system prompt that files may have changed since its earlier jobs (the user edited or rejected them, other runs wrote them), to re-read anything before relying on it, and that only this job's input, permissions and result format apply.
- **Model.** A job runs on its role's model, except in a session more than one role uses: there every job runs on `uspec.agents.model` (Codex: `uspec.agents.codexModel`), so the session doesn't switch models. `uspec.agents.triageModel` applies only to a session only triage uses.
- **Provider.** A session keeps the provider it started with, even after `uspec.agents.provider` changes.
- **Revisions** (Continue with Agent on a proposal, revising a writer's document) resume the session that produced them.

**Claude permissions.** A run runs in `auto` permission mode (approve for me): its allowed rules run without asking, and Claude Code's classifier approves or blocks anything else instead of asking the user. It has only the tools in the table. MCP servers are not loaded. Its system prompt says so, and names what it may edit, so it stays within its scope and doesn't spend turns on commands that may be blocked (a loop or a `git -C` doesn't match the rules).

| Role | Tools | Allowed |
|---|---|---|
| Impact, triage, reviewer | Read, Glob, Grep, Bash | reading, `git diff`, `git show`, `git log` |
| Writer | and Edit, Write | and editing its documents and their `-extra/` folders |
| Splitter | Read, Glob, Grep, Bash | reading and git diffs; the extension saves its Markdown proposal |
| Planner | and Edit, Write | and writing only its assigned plan file |
| Implementer | Read, Glob, Grep, Bash, Edit, Write | reading, git, editing under the code paths of its plan's nodes, and the tools in `uspec.agents.implementerAllowedTools` (Bash by default, to run tests) |

**Results.** The run's final message is read as the prompt's output format; code fences and emphasis are ignored.

- Impact: saves `change-plan.md` in the documented Markdown format. Every named document is validated against the tree; the UI reads its file list from that document. Approval records selected entries as affected.
- Triage: saves a Markdown proposal with one decision per candidate. Approval records the reviewed decisions through `change set`. Missing, duplicate or unknown candidates prevent approval. No-change entries are hidden in the UI, retained in the proposal.
- Splitter: saves `plan-split.md`, validates node coverage and dependencies, then waits for approval before any planner starts. With the splitter `off`, the extension writes `plan-split.md` itself and records it as approved.
- Writer: one result per document, in the order given, each handled on its own. `updated` is recorded as `updated` once approved (see below), and anything the writer adds after its results is kept as notes; `no change` is recorded as `no-change` with its reason; `blocked` records nothing and is shown to the user with what needs to change upstream. A result that says `updated` without the document changing, or `no change` after it changed, records nothing, and so does a document left without a result.
- Planner: `planned` reloads the change: its plans come from `change next`, which reports plan errors. With `uspec.agents.approvePlans`, the run waits for the user to read the plans: **Approve** lets implementation start. `failed` records nothing and is shown.
- Implementer: `done` records each of the plan's nodes as `done`; `gap` and `failed` record nothing and are shown.
- Reviewer: records nothing; its findings are shown.

Anything else is a failed run, which records nothing.

**Approval.** The starting documents and, with `uspec.agents.approvePlans`, the plans wait for the user as above. Before a writer runs, its documents are saved. An `updated` result that is user-visible (or every one, or none, per `uspec.agents.approveWrites`) waits for the user: **Show diff** compares the document with what it was, **Approve** records `updated`, **Reject** puts the saved content back and leaves the document `affected`. Once nothing of the change waits for the user, approving offers to run its agents again.

**Running a change.** **Run agents** on a change repeats rounds until nothing is ready or something needs the user: each round runs `change next` and starts what it lists, in the order of the change's steps: the impact run; else the triage run and a writer per node with documents to write (one for the nodes whose writers share a session); else a splitter awaiting approval, or with the splitter `off` the extension's own split, then one planner per approved split entry; else an implementer per ready plan; at most `uspec.agents.maxParallel` at once, jobs of one session one after another, and waits for them. It stops when a run waits for approval, is blocked, finds a gap or fails, when a triage run records nothing, or when `change next` reports plan errors. Before the impact run, it asks first when `change.md` is still the template. Running agents on a change that isn't the oldest open one asks first, since changes are processed oldest first. Single items run from their own actions, and an item `change next` doesn't list as ready asks first; an item already running isn't started twice. **Stop** ends the change's runs.

**Logs.** Every run has a log, live while it runs: the prompt's input, the agent's messages and tool calls, denied permissions, the result, its cost and session id, and its session name with whether the session was new, resumed or forked (and from which), as in `session: explore (resumed)`. **Open agent window** reveals the run’s native terminal; **Continue with agent** resumes that exact session. Session identities and pending reviews survive extension reloads.

**Interactive sessions.** Start Change with Agent and Continue with Agent open the selected CLI in a native terminal in the editor and ask it to use the `uspec-spec` skill; its session id is kept as the change's explore session. Install Skills copies the bundled `uspec-spec` and `uspec-review` skills into `.claude/skills/` for Claude or `.agents/skills/` for Codex. Continuing a recorded run always uses its original provider and exact session id (`claude --resume` or `codex resume`), including after a settings change or extension reload.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `uspec.cliPath` | `uspec` | The uspec CLI. |
| `uspec.agents.provider` | `claude` | Agent for new runs and interactive sessions: `claude` or `codex`. |
| `uspec.codexPath` | empty | Codex executable; empty finds `codex` on PATH. |
| `uspec.agents.codexModel` | empty | Codex model; empty uses its CLI default. |
| `uspec.agents.codexTriageModel` | empty | Codex triage model; empty uses its CLI default. |
| `uspec.claudePath` | empty | Claude Code. Empty: `claude` on the `PATH`, then the binary bundled with the Claude Code extension. |
| `uspec.agents.model` | empty | Model for impact, writer, planner, implementer and reviewer runs, and for every run in a session more than one role uses; empty uses Claude Code's default. |
| `uspec.agents.triageModel` | `sonnet` | Model for triage runs in a session only triage uses. |
| `uspec.agents.sessions` | `{}` | Session modes on top of `isolated`, `simple` and `complex`: a map from mode name to a map from role to session name (see sessions under Agents). |
| `uspec.agents.sessionMode` | `isolated` | The session mode of a change until one is chosen for it. |
| `uspec.agents.maxParallel` | 4 | Agent runs at once per change. |
| `uspec.agents.approveWrites` | `user-visible` | Which writer updates wait for approval: `user-visible`, `always` or `never`. |
| `uspec.agents.approvePlans` | true | Wait for the user to read the plans before implementing them. |
| `uspec.agents.implementerAllowedTools` | `["Bash"]` | Permission rules implementers get on top of editing their code paths. |
| `uspec.validateOnChange` | true | Run `validate` after every change to the tree. |
| `uspec.drift.enabled` | true | Run `drift` with every refresh. |
| `uspec.specTree.followActiveEditor` | true | Reveal the active file in the Spec Tree. |
| `uspec.templateHints` | true | Flag template guidance left in documents. |

## Implementation

TypeScript in [vscode/](../../vscode/), bundled with esbuild into `dist/extension.js`. `npm run build` also copies [skills/](../../skills/) into `vscode/skills/`, the bundled prompts. `npm test` runs the unit tests (parsing, paths, problem locations) with mocha, then two integration suites in a VS Code instance with the CLI built from [cli/](../../cli/): `flow` against a copy of [examples/example_product](../../examples/example_product/), with a fake `claude` that answers in each role's format, from the impact run to close; and `multi` against a copy of this repository, whose tree has the example product nested in it. `npm run test:live` runs the spec side of a change with the real Claude Code, which costs money. `npm run package` builds a `.vsix`.

| File | What it does |
|---|---|
| `src/extension.ts` | Activation: creates the model, views, providers and commands |
| `src/core/cli.ts` | Runs the CLI and parses its JSON; the per-project lock |
| `src/core/model.ts` | The CLI's JSON shapes |
| `src/core/paths.ts` | Projects, nodes and documents for a file; code-path matching |
| `src/core/issues.ts` | Where a `validate` error goes: file and line |
| `src/core/yaml.ts` | Which key and list the cursor is in, in `node.yaml`, `node-type.yaml` and frontmatter |
| `src/core/templates.ts` | Template bodies, unwritten documents, leftover guidance |
| `src/core/agents.ts` | Agent prompts, inputs, tools and permission rules per role, the system prompt a run gets, result parsing |
| `src/core/links.ts` | Links and sections: parsing a link, a document's headings and anchors |
| `src/core/claude.ts` | Starts `claude -p` and reads its stream (unused by runs); the result shape of a run |
| `src/agentTerminal.ts` | Runs an agent's TUI in a terminal and reads its hooks' sidecar |
| `src/projects.ts` | Finds projects, loads them, refreshes on file changes |
| `src/views/*.ts` | Spec Tree, Node, Changes and Node Types views, and the change state window |
| `src/decorations.ts`, `src/diagnostics.ts`, `src/editing.ts`, `src/codelens.ts`, `src/statusbar.ts` | Badges, problems, completion and links, document lenses, status bar |
| `src/commands.ts` | Node, change and context commands |
| `src/agents.ts` | Agent runs of a change: starting, recording, approval, logs |
| `src/terminal.ts` | Selected agent sessions in a terminal; installing the skills |
| `src/content.ts` | Read-only documents: a file at the baseline, context output, run logs |

Plan approvals persist across extension reloads and apply only to the reviewed contents and change baseline. A modified or unapproved plan must be reviewed before implementation.

## Review workflow

The editor workflow has seven steps: Describe, Change plan, Triage & write,
Split plans, Implementation plans, Implement, Complete. The CLI owns method
state; the extension owns review artifacts and session identities.

### Markdown proposals

`change-plan.md`, triage proposals and `plan-split.md` live in the change
directory. They are editable Markdown, never a JSON review UI. Each proposal
starts with a title and explanation, then entries in this format:

```markdown
# Change plan

Explain the intended changes and their reasons here.

## Files

### docs/service/api.md
- Decision: affected
- Reason: The public contract changes.
- Comment:

## Plans

### plans/cli.md
- Nodes: cli
- After:
- Reason: CLI work can be implemented independently.
```

Files use document keys from the spec tree; decisions are `affected` or
`no-change`. Split entries use simple plan ids in `plans/<id>.md`; every
unplanned node belongs to exactly one entry, dependency ids must exist and
must not form cycles. Invalid or incomplete proposals cannot be approved.
The UI rereads the document before approval; it does not approve a stale
in-memory list. User selections/comments are saved into the proposal and
provided to the corresponding writer. No-change files remain in the proposal
for audit but are hidden from the review list.

### Review and navigation

Approve records the reviewed decisions. Go back revisits the prior step;
it never restores files or silently deletes approved work. Continue with
agent resumes the session that produced that proposal, node edits or plan.
Session ids and outstanding review snapshots are retained across reloads.
Approval of a plan applies only to its exact contents and change baseline.

Writer review groups changed files by node. One agent control/status sits on
the node header. Each changed file has a collapsed inline diff, an optional
comment and a native diff-editor action comparing the saved pre-write content
with the current file. The diff displays deletions/additions using theme
tokens. Explicit rejection may restore the saved content; going back cannot.
Files recorded no-change are omitted. There is no `write-review.md`.

### Terminals

Automated agent runs start in ordinary hidden terminals; a run that resumes
a shared session runs in the terminal of that session's last job. Open agent
window reveals the selected terminal in the editor. While running, it shows
that run; after completion, continuation uses `--resume` with its saved session
id. No custom terminal input or webview chat is used. Closing a terminal stops
its running job and must not record success. Terminal controls and queued,
running, review, error and done states belong to their workflow items.
