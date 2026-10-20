# Method

## Principles

- **Spec first.** The spec is the source of truth. Every change starts in the spec, described in `change.md`, and only then reaches the code.
- **Narrow agents.** Each agent run that writes has one responsibility: the documents of one node, or the code of one plan. Narrow scope keeps context small, output predictable and responsibility clear. Runs may share a session, so a later run keeps what earlier ones learned, but each still does only its own job.
- **Code follows the spec.** If code and spec disagree, the code is a bug, unless the spec is changed explicitly first. Code that is merged always matches the spec. There is one exception, where spec is written from code: an experiment, where code tried out directly is kept by turning it into a spec change.
- **The spec is consistent.** A node doesn't contradict its parent or its upstream nodes, so the tree is consistent from the root down by each node agreeing with its parent. When it does, the node is fixed, or the upstream is changed first and the node brought in line.
- **Dependencies are explicit.** A node states what it is built from, down to the section of a document, so a change reaches everything it affects and nothing else.

## How the concepts fit together

A product is a [spec tree](spec-tree/): a tree of nodes, each a directory of documents. Every node has a [node type](node-types/), which says what children it may have, what it may link to and which documents it holds. The project defines its own types; the method fixes no structure. A node is built from its parent; anything else it is derived from, a node, a document or a section of one, including a higher ancestor, it records as [links](links/).

The tree and its links decide each agent's [context](context/): what an [agent](agents/) reads to write one document or implement one node, and nothing more. If an agent keeps needing something outside it, a link is missing.

The life of a product:

1. **Set up.** The user chooses the node types, from a ready-made set or from scratch, and creates the root node. The types then belong to the project, and the user edits them. They decide how the whole tree is cut, so they are worth getting right first. From here the tree grows only through changes, and it contains only what is being built: planned work is described in the root's documents.
2. **Change.** All work is a [change](changes/), in one of two modes:
   - **Change spec.** The user first describes the change in `change.md`, with a worked example, together with an agent, and approves the structure. An agent then finds the documents the change starts at. From them the change moves down the tree and along links to every document that depends on it. The user reviews documents; agents write them.
   - **Implement.** An agent splits the implementation into plan files for approval, or the split is skipped and one plan covers every node; then one agent generates each plan; one agent per plan updates the code from the nodes' documents and context, and verifies it against them. Implement always comes after a spec change, never instead of one.

   An orchestrator, the [VS Code extension](../vscode/overview.md), runs the agents and records their results; the user steps in to approve and to resolve what an agent can't.
3. **Experiment.** Code tried out directly, outside a change, is kept only through an [experiment](experiments/): it is turned into a spec change, and the code then follows that change as usual.
4. **Keep spec and code in sync.** Three checks find what goes wrong, so it is detected, not discovered by accident:
   - **Structure:** the tree is valid against its [node types](node-types/) and [links](links/).
   - **Review:** every node with code paths is implementable from its [context](context/) alone, and no node contradicts its parent or upstream nodes.
   - **[Drift](drift/):** what changed since it was last checked: a document whose dependencies changed, a node whose spec changed since its code was last verified, and code that changed since then. What drifts is brought in line through a change, or accepted when it still holds; code that disagrees with its spec is a bug, or the spec is changed explicitly first.
