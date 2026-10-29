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

## Recovering an interrupted response

An unfinished response can coexist with a failed verdict from an earlier review. Resume must
continue the newer request in the existing worktree, even when the saved review reason is still
`qa_rejected`. A completed rejected review has nothing unfinished to resume.

The runner records each revision request, its original feedback and attachment references before
assessment begins. Recovery uses that request and work completed since it began; an older successful
validation or failed verdict cannot satisfy the new request. A completed new review settles the
request even when genuine findings remain. Stopping or failing before completion retains it.

Older interrupted records can recover a human-work response only when a persisted owner decision
establishes the request after the prior validation and before the interrupted assessment. Recovery
uses the host's saved decision and evidence, preserving their scope; it does not create approval or
claim that a deferred study ran. When the request cannot be reconstructed, recovery must explain
that the feedback needs to be supplied again, rather than silently returning the previous verdict.

## New reviews

### Originating decisions

Generated decision work retains the exact recorded words, decision time and source
task/project in a host-added description block and separate `sourceDecision`
metadata. This is evidence context, not the child's own decision or a task-wide
override. The source decision is saved before generated work is queued.

Launch resolves originating decisions against the same project's canonical task
records, including legacy parent pointers and split lineage. The resulting source
context reaches triage, execution, validation, advice and fresh diff review through
the shared human-decision prompt; it also changes the review checkpoint fingerprint.
Suggestions alone are not decisions. Missing, stale or conflicting source data is
explicitly unverified and cannot be treated as proof that no approval exists.
Apply only the recorded scope and time; do not invent a separate review-session
date, named reviewer or owner “no requested changes” statement.

This prevents missing source evidence from being replaced by a history of pending
requests. Existing receipts remain preserved; display grouping is not semantic
reconciliation, and these changes do not silently approve or waive their contents.

### Task scope

Task review checks the current ticket's acceptance criteria and explicit applicable pre-merge
requirements. Reviewers must identify the task/spec/instruction that makes a missing requirement
applicable, rather than treating every pending project gate as a blocker on every ticket. A separate
project playtest can remain pending in the summary while a report-correction task passes; the
playtest's own ticket still requires actual participant evidence. Ordinary human review or merge
permission remains a delivery step and is not itself an implementation defect. Applicable project
instructions and explicit pre-merge gates still apply.

Validation can reject a mistaken or out-of-scope reviewer finding with an explanation, without
claiming the external requirement was fixed, approved or waived. This is prompt guidance, not an
automatic reclassification of saved findings or proof that a model will apply scope correctly.
Existing task receipts and failed verdicts are preserved until the normal review/decision flow
updates them. Full-spec review still checks the entire requested spec.

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
## Finding the work to review

Human-only reviews appear above the work summary as **What needs your input**. Each response card
starts with a short requested action and any explicit screenshot/image paths found in the original
notes. Related notes can therefore read as one request, such as **Review 3 updated screenshots**,
instead of requiring the reviewer to interpret repeated technical paragraphs. These deterministic
display hints do not establish approval, waive requirements, or replace the spec. Original wording,
locations, receipt identities and history remain under the review-note disclosure.
Topic mentions alone never instruct the reviewer to run a study or approve art: generic legacy
findings use neutral guidance. Baseline-specific decision copy requires an explicit outstanding
approval statement; negated or waived approval wording falls back to the original requirement.

The scoped response form uses concise Reviewer, Status, Your decision and Evidence labels.
Supporting files follow the response cards. **Task-wide approval options** is a separate secondary
disclosure so a response to one request is not confused with an override of all human gates.

**Files to review** resolves the report and its local Markdown links in this task's worktree,
falling back to the project checkout only when there is no task worktree. **Open** uses the
system's default viewer and **Show in file manager** reveals that exact artifact. Missing files
remain labeled missing. Image counts describe files in the linked folder, not completed generation,
visual acceptance or provenance verification. The generated-image location is checked when the
report links source art. Report limitations are quoted separately. Lists are cached until a new
review run or an explicit **Refresh files**.

Related reworded notes from the same source can share a response form when their current receipts
match. Grouping uses conservative text/topic matching for display, not semantic equivalence or gate
resolution. Every original finding and its history remains stored. Saving a grouped response updates
the selected records atomically under the same expected-revision check; different existing answers
remain separate. Continuing still requires every tracked receipt and current blocker to be covered.
The human override remains a separate, explicit owner decision.

Grouping also covers repeated CI and repository-policy requests, not only visual or participant
work. Receipt UUIDs are ignored for display similarity because they are audit references rather
than new requirements. Related notes can match another member of a group as the wording evolves;
different answers or source files stay separate. An explicit missing hosted-CI demonstration gets
a short execution outline: an authorized temporary PR with a failing test, recorded run evidence,
then removal of the failure and a passing run. This is automatable verification work, not a claim
that a person's code approval supplies the missing hosted evidence. Repository check enforcement
is shown separately and remains subject to the task's actual conditional policy.
For requests outside the visual/participant topics, an explicit reference to another receipt's
identity is also required for grouping; similar approval boilerplate alone is insufficient.
