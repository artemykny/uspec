# Skills

The user works with uspec through skills for Claude Code for the parts that need a conversation: describing a change, agreeing on structure, resolving what an agent couldn't, reviewing the spec. They call the [CLI](../cli/overview.md) for everything mechanical. Running a change's agents, one per item, is not a skill's job: the [VS Code extension](../vscode/overview.md) orchestrates them, and the skills send the user there.

## Skills

| Skill | What it does |
|---|---|
| [`uspec-spec`](uspec-spec/behaviour.md) | Starts a change: writes `change.md` and the structure with the user, then hands the change to VS Code. Resolves blocked writers and gaps with the user. |
| [`uspec-review`](uspec-review/behaviour.md) | Checks that nodes are implementable and consistent with their upstream. |

## Agent prompts

The prompts of the agents that work on a change sit next to `uspec-spec`, the skill that starts the change, and are installed with it. The extension runs them ([agents](../method/agents/rules.md)); no skill does.

| Agent | Prompt | One run per | Reads |
|---|---|---|---|
| Impact | `impact-agent.md` | change without documents | `change.md` and `uspec tree` |
| Triage | `triage-agent.md` | batch of candidates from `uspec change next` | `change.md`, the diffs and the candidates |
| Writer | `writer-agent.md` | node with documents to write | the output of `uspec context <node> --document <id>...`, one `--document` per document |
| Splitter | `splitter-agent.md` | settled change | change and implementation contexts, returns the Markdown split for approval |
| Planner | `planner-agent.md` | one approved plan | `change.md` and the output of `uspec context <node> --implement` for each node to plan |
| Implementer | `implementer-agent.md` | ready plan | the plan and the output of `uspec context <node> --implement` for each of its nodes |

`uspec-review` keeps its own subagent, the **reviewer** (`reviewer-agent.md`, one run per node in scope, reading the node's `uspec context` output), since a review doesn't change the spec and needs no orchestration.

## Shared rules

- **The CLI decides.** What is open and ready comes from `uspec change list` and `uspec change next`, and what an agent reads from `uspec context`. Skills don't pick files or order themselves.
- **Name the change.** Every CLI call names the change. A skill says which change it works on ("Using change: refund-window"), and asks when more than one is open and the user hasn't said.
- **No orchestration.** A skill starts no agent that works on a change: no impact, triage, writer, planner or implementer. When that work is next, it tells the user to continue in VS Code.
- **Stop and resume.** The state lives in the change directory, so a skill can stop at any point and be run again in a new session.

## Install

The skills call the `uspec` CLI, which must be on the `PATH`. Copy the skill directories into the project's `.claude/skills/`, or into `~/.claude/skills/` to use them in every project, or run **Install Skills** in VS Code:

```
cp -r skills/uspec-* <project>/.claude/skills/
```
