# Skills

The user works with uspec through skills for Claude Code. Skills do the work that needs judgement: talking to the user, proposing structure, writing documents and code. They call the [CLI](../cli/overview.md) for everything mechanical: what to read, where a change goes, what is left to do.

## Skills

| Skill | What it does |
|---|---|
| [`uspec-spec`](uspec-spec/behaviour.md) | Starts a change, or continues the open one: triages candidates and writes affected documents. |
| [`uspec-implement`](uspec-implement/behaviour.md) | Writes and verifies the code of the change's nodes, then closes the change. |
| [`uspec-review`](uspec-review/behaviour.md) | Checks that nodes are implementable and consistent with their upstream. |

## Main agent and subagents

A skill is run by the agent the user talks to, the **main agent**. It talks to the user, writes `change.md` and makes the starting edits with them, runs the CLI and records results with `uspec change set`. The rest of the work goes to fresh subagents ([agents](../method/agents/rules.md)):

| Subagent | Skill | One run per | Reads |
|---|---|---|---|
| Triage | `uspec-spec` | batch of candidates from `uspec change next` | `change.md`, the diffs and the candidates |
| Writer | `uspec-spec` | node with documents to write | the output of `uspec context <node> --document <id>...`, one `--document` per document |
| Implementer | `uspec-implement` | node to implement | the output of `uspec context <node> --implement` |
| Reviewer | `uspec-review` | node in scope | the node's `uspec context` output |

Each subagent's prompt is a file next to its skill (`triage-agent.md`, `writer-agent.md`, `implementer-agent.md`, `reviewer-agent.md`). The main agent starts a subagent with that prompt followed by the CLI output it reads. A subagent returns a result; only the main agent records it. Subagents for different nodes run in parallel. Triage runs on Sonnet, since it only judges; the other subagents run on the main agent's model.

## Shared rules

- **The CLI decides.** What to do next comes from `uspec change next`, and what an agent reads from `uspec context`. Skills don't pick files or order themselves.
- **Name the change.** Every CLI call names the change. A skill says which change it works on ("Using change: refund-window"), and asks when more than one is open and the user hasn't said.
- **One subagent per item.** The documents of one node, or the code of one node.
- **Stop and resume.** The state lives in the change directory, so a skill can stop at any point and be run again in a new session. It picks up from `uspec change next`.

## Install

The skills call the `uspec` CLI, which must be on the `PATH`. Copy the skill directories into the project's `.claude/skills/`, or into `~/.claude/skills/` to use them in every project:

```
cp -r skills/uspec-* <project>/.claude/skills/
```
