# uspec for VS Code

Works with [uspec](../docs/overview.md) projects: the spec tree with its types and links, its problems and drift, its open changes, and Claude Code or Codex agents that work through a change from the Changes view. It is a UI over the `uspec` CLI; what it does is specified in [docs/vscode/](../docs/vscode/overview.md).

## Requirements

- The `uspec` CLI on the `PATH` (`cargo install --path cli` in this repository), or its path in `uspec.cliPath`.
- Claude Code or Codex CLI, for agents and terminal sessions: `claude` on the `PATH`, the Claude Code extension, or its path in `uspec.claudePath`.
- `git`, which the CLI needs for changes and drift.

## What it adds

- **One explorer**: Changes, Node types, Specification. Changes starts collapsed; selecting a node opens its overview in the editor.
- **Review workflow**: Describe → Change plan → Triage & write → Split plans → Implementation plans → Implement → Complete. Start with **Open change.md** and **Process change.md**.
- **Markdown reviews**: review the change plan and triage proposal, choose files, add comments, then approve. Updated files are grouped by node; inline diffs start collapsed and **Open diff in VS Code** opens the native diff editor.
- **Independent plans**: approve the split into files such as `plans/cli.md` and `plans/vscode.md`, then run one planner per file. Review every generated plan before implementation; one implementer handles each ready plan.
- **Native terminals**: The selected agent runs in hidden VS Code terminals. Agent controls live beside their node or plan. Open the selected terminal in the editor, or continue its original session. Pending reviews and session ids survive extension reloads.
- **Problems, badges and editing help**: `uspec validate` errors on the right line, drift warnings, change states in the Explorer, completion and links in `node.yaml`, `node-type.yaml` and template frontmatter, and a line at the top of each spec document with its template and actions.

## Agents and permissions

Choose **uspec › Agents: Provider** in VS Code Settings: **Claude Code** (default) or **Codex**. Set `uspec.codexPath` if Codex is not on PATH. Codex models use `uspec.agents.codexModel` and `uspec.agents.codexTriageModel`; empty uses the CLI default. Install and sign in to the selected CLI first. Existing runs retain their provider when you change settings.

Every run is the agent's real interactive TUI (`claude` or `codex`) in a native terminal, hidden until you open it; its result comes from the agent's hooks, and after its first turn you can keep talking to it there. Read-only roles use the read-only sandbox; editing roles use workspace-write with their assigned scope in the prompt. Unlike Claude permission rules, this does not enforce individual file paths. Continue resumes the original Codex thread. Install Skills uses `.agents/skills/` for Codex.

Claude agent runs are `claude --permission-mode dontAsk` in the project root. They can't ask for permission, so anything outside their rules is denied: impact, triage and reviewers only read and run `git diff`, `git show` and `git log`; a writer may also edit its documents and their `-extra/` folders; a splitter only reads; a planner may write only its assigned plan file; an implementer may edit the code paths of its plan's nodes and gets `uspec.agents.implementerAllowedTools` on top (`Bash` by default, so it can run tests). Runs cost what Claude Code costs.

## Develop

```
npm install
npm run build          # dist/extension.js, and the skills copied from ../skills
npm test               # unit tests, then integration tests in VS Code with a fake Claude
USPEC_TEST_PROVIDER=codex npm run test:integration  # same workflow with a fake Codex
npm run test:live      # the spec side of a change with the real Claude Code (costs money)
npm run package        # uspec-0.1.0.vsix
```

`Run extension` in `.vscode/launch.json` opens this repository in an Extension Development Host.

For code that already exists from an experiment, explicitly select check mode in `change.md`:

```markdown
---
mode: check
---
# Change title
```

Without this field, agents use implementation mode. Mentions of experiments in prose do not select a mode. Plan approvals survive reloads; editing an approved plan requires approval again.
