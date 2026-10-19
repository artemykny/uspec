# Context

An agent's **context** is the set of files and instructions it is given to do one job: write documents of one node, or implement one node. It is decided by the tree, its [node types](../node-types/) and its [links](../links/), not by the agent, so two agents doing the same job read the same things. It holds what the job is built from and nothing more, which keeps context small and makes a missing dependency visible.

## Rules

**Writing documents.** The context of an agent writing one or more documents of a node is:

- **Instructions**: the `instructions` of the node's type.
- **Documents**: the documents it writes.
- **Ancestors**: the documents of every ancestor of the node, from the root down.
- **Upstream**: what the node's links name (see [links](../links/)): the exposed documents of a linked node, or the one document or [section](../spec-tree/) a link narrows to; and the documents of the same node, or sections of them, that any of these documents derives from (see [node types](../node-types/)).
- **Templates**: each written document's template. Its `description` says what the document covers; its body is the structure the document follows.
- **Change**: during a [change](../changes/), the change's description and the diffs, since the change's baseline, of the documents in the context above that the change updated.

**Implementing a node.** The context of an agent implementing a node is:

- **Instructions**, **ancestors** and **upstream** as for writing documents;
- **Documents**: all of the node's documents, internal ones included;
- **Code**: the node's code paths;
- **Change**: during a change, its description and the diffs of the updated documents among the files above.

Only a node with code paths can be implemented. An implementer works on a [plan](../changes/), which can span several nodes: its context is the plan, then the context above of each of the plan's nodes.

**Sections.** A section in the context is read on its own: the agent relies on that section, not on the rest of its document.

**Extra files.** A document's extra files are part of its context wherever the document is.

**What is left out.** Siblings, other branches, downstream nodes, the internal documents of upstream nodes, and the parts of an upstream node or document a link doesn't name are not in the context. A node gets something outside its branch only by linking to it.

**Missing links.** The agent can read more than its context, but if it keeps needing something outside it, a link is missing: the fix is to add the link, not to widen the context. A node with code paths must be implementable from its context alone (see [spec tree](../spec-tree/)).

## Example

An agent writes `logic.md` of `system/services/payments` during the change `refund-window`, which updated the refunds rules. `logic.md` derives from `api.md`, and the service links to `product/support/refunds`. Its context is:

| Part | Files |
|---|---|
| instructions | the Service type's `instructions` |
| document | `system/services/payments/logic.md` |
| ancestors | `overview.md`, `system/overview.md`, `system/services/overview.md` |
| upstream | `product/support/refunds/user-story.md`, `product/support/refunds/rules.md`, `system/services/payments/api.md` and its extra files |
| template | the Service type's `logic.md` template |
| change | `refund-window`'s description, and the diff of `product/support/refunds/rules.md` |

It doesn't get `storage.md` of the same node, the screens that call the service, or any other service.
