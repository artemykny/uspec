# Method

## Principles

- **Spec first.** The spec is the source of truth. Every change starts in the spec, at the highest node it affects, and only then reaches the code.
- **Narrow agents.** Each agent run that writes has one responsibility: the documents of one node, or the code of one node. Narrow scope keeps context small, output predictable and responsibility clear.
- **Code follows the spec.** If code and spec disagree, the code is a bug, unless the spec is changed explicitly first. Code that is merged always matches the spec. There is one exception, where spec is written from code: an experiment, where code tried out directly is kept by turning it into a spec change.
- **The spec is consistent.** A node doesn't contradict its ancestors or its upstream nodes. When it does, the node is fixed, or the upstream is changed first and the node brought in line.
- **Dependencies are explicit.** A node states what it is built from, so a change reaches everything it affects and nothing else.

## How the concepts fit together

A product is a [spec tree](spec-tree/): a tree of nodes, each a directory of documents. Every node has a [node type](node-types/), which says what children it may have, what it may link to and which documents it holds. The project defines its own types; the method fixes no structure. A node records the nodes it is derived from, outside its own branch, as [links](links/).

The tree and its links decide each agent's [context](context/): what an [agent](agents/) reads to write one document or implement one node, and nothing more. If an agent keeps needing something outside it, a link is missing.

The life of a product:

1. **Set up.** The user chooses the node types, from a ready-made set or from scratch, and creates the root node. The types then belong to the project, and the user edits them. They decide how the whole tree is cut, so they are worth getting right first. From here the tree grows only through changes, and it contains only what is being built: planned work is described in the root's documents.
2. **Change.** All work is a [change](changes/), in one of two modes:
   - **Change spec.** The tree changes: nodes are added, moved or removed, and documents are written or updated. The change moves down the tree and along links to every document that depends on it. The user approves structure and reviews documents; agents write them.
   - **Implement.** Agents update the code of each node whose spec changed, from the node's documents and context, and verify it against them. Implement always comes after a spec change, never instead of one.
3. **Experiment.** Code tried out directly, outside a change, is kept only through an [experiment](experiments/): it is turned into a spec change, and the code then follows that change as usual.
4. **Keep spec and code in sync.** Three checks find what goes wrong, so it is detected, not discovered by accident:
   - **Structure:** the tree is valid against its [node types](node-types/) and [links](links/).
   - **Review:** every node with code paths is implementable from its [context](context/) alone, and no node contradicts its ancestors or upstream nodes.
   - **[Drift](drift/):** code that changed without a spec change. The code is a bug, or the spec is changed explicitly first.
