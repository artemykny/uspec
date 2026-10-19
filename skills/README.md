# uspec skills for Claude Code

| Skill | What it does |
|---|---|
| [`uspec-spec`](uspec-spec/SKILL.md) | Starts a change, or continues the open one: triages candidates and writes affected documents. |
| [`uspec-implement`](uspec-implement/SKILL.md) | Writes and verifies the code of the change's nodes, then closes the change. |
| [`uspec-review`](uspec-review/SKILL.md) | Checks that nodes are implementable and consistent with their upstream. |

Each skill runs in the agent the user talks to and hands the work to subagents. The prompt of each subagent sits next to the skill:

| Subagent | Prompt | One run per |
|---|---|---|
| Triage | [triage-agent.md](uspec-spec/triage-agent.md) | batch of candidates |
| Writer | [writer-agent.md](uspec-spec/writer-agent.md) | node with documents to write |
| Implementer | [implementer-agent.md](uspec-implement/implementer-agent.md) | node |
| Reviewer | [reviewer-agent.md](uspec-review/reviewer-agent.md) | node |

The skills call the `uspec` CLI ([docs/cli/](../docs/cli/overview.md)), which must be on the `PATH`. Each skill is specified in [docs/skills/](../docs/skills/overview.md).

## Install

Copy the skill directories into the project's `.claude/skills/`, or into `~/.claude/skills/` to use them in every project:

```
cp -r skills/uspec-* <project>/.claude/skills/
```
