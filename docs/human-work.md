# Human work from a review blocker

A missing real approval, decision or participant observation is human work. An agent must not
invent it, and repeating AI repair rounds cannot supply it. These actions remain part of the
owning task's authoritative metadata, rather than creating a second task database.

## Existing failed reviews

After a full Workbench restart, open the task in **Human Review**. Each open blocker has
**Track as human action**. Use it for the actual human requirements, such as the committed-image
sign-off and the three-person usability study on task 126. Existing findings are never silently
reclassified by a keyword heuristic.

Each human action has:

- The preserved source finding and its file/line.
- A responsible person (a free-text owner, not an authenticated identity).
- **Open**, **In progress**, or **Evidence submitted** status.
- A response/decision or participant observations, plus references to the actual artifacts.
- Timestamps and revision history, including corrections and reopening.

The **Human work waiting** board inbox shows owners and progress and opens the parent task.
It consumes no agent execution slot. Newly tracked actions use the existing **Review Needed**
notification setting. Recording an owner does not send a message to that person.

Submission requires a named responsible person, response and evidence reference. It records what
that person entered; Workbench does not certify an approval or verify that a study occurred.
A rejection or missing study can be recorded honestly and remains an unresolved task requirement.

When all current blockers are tracked and their fields are complete, **Submit and continue** saves
open actions and unsaved edits as submitted, then sends the resulting saved revision through the
existing change-request flow. Already submitted, unchanged work shows **Continue with submitted
evidence**. Missing fields or untracked blockers are explained beside the button. The host builds the feedback,
not the renderer, and preserves the task session and work. The agent reads the references,
updates the report from actual evidence and reruns review. The existing AI verdict and final
approval do not change just because an action was submitted. Stale or incomplete handoffs fail
before launching an agent. Evidence references are text in this slice; a dedicated artifact
viewer/study workflow is not included.

## Owner override

**Override human approval for this task** records an explicit approver and decision/reason, then
**Apply override and continue** resumes the existing task. Its scope is task-wide: all human-only
acceptance gates on this task, including reworded demands for renewed sign-off. Existing submissions
and findings remain preserved. Applying another override keeps the earlier override in history.
The active override stays visible when the task returns for final review and is not inherited by
split or follow-up tasks.

The host builds the override prompt and passes the persisted decision to every coding/review phase.
Workbench enforces it in the review gate: findings explicitly classified `requiresHuman: true` are
recorded as overridden rather than fixed. They cannot independently make review fail again. Code
findings, failed checks, and a failed report with no identified overridden finding still block.
The raw AI validation report is retained, with the owner override attached separately to the gate
verdict and the excluded findings recorded per round. An override does not turn an unrun study into
completed research or assert that automated tests passed. Overrides also allow handoff when old
human action fields are incomplete, without fabricating submissions to fill them.

This changes main-process behavior and requires a full Workbench restart. Already-running task
sessions keep their original configuration; the override applies when the task is continued.

## New reviews

The review and validation schemas support an explicit `requiresHuman` flag. When only unfixed
human requirements remain and no check failed, Workbench ends the AI repair loop immediately
with the failed verdict preserved. Human actions are created when the task enters Human Review.
Mixed reviews continue to repair the agent-actionable findings while keeping human requirements
pending. Untagged legacy findings can still be tracked manually.

## Persistence and checks

Records live under `task_metadata.json` → `humanWork`, with a stream revision and per-action
history. Mutations share the project queue lock, reread disk metadata, preserve unrelated fields,
validate current findings and atomically publish. Expected revisions prevent competing windows
from overwriting one another. Duplicate creation of a tracked finding creates no second action.

Checks cover lifecycle/history, incomplete and stale submissions, project scope, concurrent edits,
actual IPC persistence, renderer controls and the board inbox, exact-revision evidence handoff,
and early exit from human-only AI review loops. Real human approval and participant observations
remain the user's acceptance boundary.
