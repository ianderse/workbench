---
name: commit-in-correlated-groups
description: "Split a batch of changes into logically correlated groups and commit each group separately."
metadata:
  node_type: memory
  type: feedback
  modified: 2026-10-17T22:30:46.921Z
---

When committing a batch of changes, break them into correlated groups and commit each group separately, rather than one large commit.

**Why:** The user asked for this explicitly when committing a large feature batch, and wants each commit to hold one coherent change.

**How to apply:** Before committing, group modified files by the change they belong to, stage each group on its own, and commit groups one at a time with a clear message.
