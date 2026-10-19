# Experiments

An **experiment** is code tried out directly, on a branch, with no change and no spec behind it. It is the one place where spec is written from code (see [method](../)): sometimes trying something is faster than specifying it first. An experiment is never merged as it is; it is either dropped, or kept by turning it into a spec change, after which the code follows the spec as usual.

## Rules

**Outside the spec.** An experiment edits code only, never the spec tree. While it lasts, its code is [drift](../drift/), which is correct: nothing in the spec backs it yet.

**Two endings.** When the experiment is over, it is either:

- **dropped:** the branch is deleted and the spec is untouched;
- **kept:** it becomes a [change](../changes/). An agent reads the code diff and writes `change.md` from it with the user: what the new behaviour is, with a worked example. From there it is an ordinary change: impact finds the starting documents, the edits propagate, candidates are triaged and written, and the tree is validated.

**Implement checks instead of writing.** In a kept experiment, the nodes under `implementation` already have their code. The plans say so, and each implementer verifies the existing code against the new spec and fixes what doesn't match, instead of writing it.

**No merge without a spec change.** Experiment code can't be merged until a change backs it, because it is drift until then.

**Closer review.** A spec written from code tends to describe what the code does, accidents included, rather than what was intended. The user reviews `change.md` and the documents of a kept experiment more closely than those of a change that started in the spec.

## Example

To see whether a 30-day refund window hurts fraud rates, a developer changes the constant in the `payments` service's code on a branch. The drift check flags the change. The numbers look good, so the experiment is kept: an agent reads the diff and writes `change.md` with the user, with the worked example of a refund requested on day 20. Impact finds `product/support/refunds/rules.md`, and the change runs as in [changes](../changes/#example). When `payments` is implemented, its code already says 30 days, so its implementer only verifies it; the screen, which the experiment never touched, is updated as usual.
