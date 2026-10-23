---
name: keep-changes-local
description: "Keep changes local: do not commit or push them unless the user asks."
metadata:
  node_type: memory
  type: feedback
  modified: 2026-10-18T19:03:08.070Z
  originSessionId: c42d954d-2960-40e9-92c5-e7b1628eb297
---

Keep your changes local. Do not commit them, and do not push them, until the user tells you to.

**Why:** The user gave this instruction in several separate sessions, and again on 2026-10-18 after a turn's work was committed without being asked ("I didn't ask you to commit your changes, please undo the commit and keep them local until I tell you to commit them"). Committing or pushing unasked takes a decision the user wants to make themselves.

**How to apply:** Make the change and verify it locally, and leave it in the working tree. Commit only when the user asks, and then in correlated groups (see [[commit-in-correlated-groups]]); push only when the user asks for a push. "Commit the changes" covers that batch only, not the work that follows it.
