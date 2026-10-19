# uspec skills for Claude Code

| Skill | What it does |
|---|---|
| [`uspec-spec`](uspec-spec/SKILL.md) | Starts a change: writes `change.md` and the structure with the user, then hands the change to the VS Code extension. Resolves blocked writers and gaps with the user. |
| [`uspec-review`](uspec-review/SKILL.md) | Checks that nodes are implementable and consistent with their upstream. |

The agents that work on a change are run by the uspec VS Code extension, which orchestrates the change; no skill starts them. Their prompts sit next to `uspec-spec`, so they are installed with it:

| Agent | Prompt | One run per |
|---|---|---|
| Impact | [impact-agent.md](uspec-spec/impact-agent.md) | change without documents: finds the starting documents |
| Triage | [triage-agent.md](uspec-spec/triage-agent.md) | batch of candidates |
| Writer | [writer-agent.md](uspec-spec/writer-agent.md) | node with documents to write |
| Planner | [planner-agent.md](uspec-spec/planner-agent.md) | change with nodes to plan |
| Implementer | [implementer-agent.md](uspec-spec/implementer-agent.md) | ready plan |

`uspec-review` runs its own subagent, the [reviewer](uspec-review/reviewer-agent.md), one per node.

The skills call the `uspec` CLI ([docs/cli/](../docs/cli/overview.md)), which must be on the `PATH`. Each skill is specified in [docs/skills/](../docs/skills/overview.md).

## Install

Copy the skill directories into the project's `.claude/skills/`, or into `~/.claude/skills/` to use them in every project, or run **Install Skills** in VS Code:

```
cp -r skills/uspec-* <project>/.claude/skills/
```
