---
name: keep-changes-local
description: "When asked to fix something (e.g. a failing CI), keep the changes local and do not push them."
metadata:
  node_type: memory
  type: feedback
  modified: 2026-10-17T22:30:46.921Z
---

When the user asks you to fix something, such as a failing CI on `develop`, keep the changes local: do not push them to the remote.

**Why:** The user gave this same instruction in several separate sessions, so it is a standing preference. Pushing without being asked publishes work the user wants to review first.

**How to apply:** Make the fix and verify it locally. Leave commits unpushed unless the user explicitly asks for a push.
