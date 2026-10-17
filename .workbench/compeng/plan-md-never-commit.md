---
name: plan-md-never-commit
description: "PLAN.md at the repo root is a personal planning file the user deletes; never commit it."
metadata:
  node_type: memory
  type: feedback
  modified: 2026-10-17T22:30:46.921Z
---

Never commit `PLAN.md` at the repo root. It is a personal planning file that the user reviews and deletes on their own.

**Why:** The user deleted a `PLAN.md` commit made by mistake and asked for it to be undone and removed. Committing it again would repeat that mistake.

**How to apply:** When staging or committing, exclude `PLAN.md`. If it is already in a commit, ask before rewriting history, then undo the commit and delete the file as the user asked.
