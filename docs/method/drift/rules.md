# Drift

**Drift** is code that changed without a spec change. Code follows the spec (see [method](../)), so every change to a node's code should come from a [change](../changes/) that updated its spec first. Agents and people still edit code directly, and nothing stops them, so the spec silently stops describing what the code does. Drift is detected by comparing the history of a node's code with the history of its spec, so it is found at once, not by accident.

## Rules

**What is compared.** Only nodes with code paths are checked. A node's **code** is its code paths; its **spec** is its `node.yaml`, its documents and its extra files. For each, the last commit that touched it is taken.

**When a node drifts.** A node drifts when:

- the last commit that touched its code is later than the last commit that touched its spec, or
- its code has uncommitted changes while its spec has none.

Code and spec changed in the same commit don't drift.

**Open changes.** A node under `implementation` in an open change is skipped: its spec has changed and its code is expected to catch up (see [changes](../changes/)).

**Resolving drift.** Drifting code is a bug, unless the spec is changed explicitly first. Either:

- the code is brought back to what the spec says, or
- a change updates the node's spec to the intended behaviour, and the code then follows it as usual.

The spec is never edited only to match the code without a change.

**Merging.** Code that is merged matches the spec, so a node that drifts isn't merged until its drift is resolved.

## Example

A developer fixes a rounding bug directly in the code of `system/services/payments` and commits it. The last commit on its code is now later than the last commit on its spec, so `payments` drifts. The fix changes how refunds are rounded, which `logic.md` doesn't describe, so a change is opened: `logic.md` is updated with the rounding rule, `payments` is added under `implementation` and skipped while the change is open, and its code is verified against the new `logic.md`. Once the change closes, the spec's last commit is no earlier than the code's, and `payments` no longer drifts.
