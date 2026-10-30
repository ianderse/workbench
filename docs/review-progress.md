# Canonical progress after spec reviews

Every spec-review ticket (`metadata.specReview`) must publish its finished structured report into
root `PROGRESS.md` before emitting `QA_PASSED`. This applies to complete, gap-bearing and unverified
reports. The reviewer stays read-only; the host performs publication without another model call.
Ordinary implementation validation and independent code-review rounds do not each publish a block.

The host replaces one latest-review block between `<!--wb:review-->` and `<!--/wb:review-->`.
It records the ticket/round, review completion time, actual worktree revision inspected, agent-reported
result, whether checks were observed, and remaining gaps/sections. Detailed evidence stays in the
ticket report. Legacy reports without a captured revision say unknown; the publication tip is never
substituted for the inspected revision. A review result is not owner/spec acceptance or a passed
code-integration gate.

Publication starts from the reviewed local base branch's current tip in an isolated temporary
worktree. It commits only `PROGRESS.md`, then advances that branch with the existing safe Git
helpers. It does not push. Publications to one project/branch are serialized; a moving branch gets
bounded retries. Unrelated staged, dirty and untracked work stays intact. Conflicting local progress
edits, malformed markers, symlinks, unavailable branches or Git failures leave the review unfinished
with its report preserved. Resume retries publication rather than repeating the audit.

Authored bytes outside the managed block remain unchanged. The entire file is capped at 6 KiB:
the host uses a compact review record when necessary and fails clearly if even that cannot fit.
The integration owner must then compact the authored snapshot and resume publication. Keep the
root file concise and link detailed status instead of growing a chronological ledger.

A durable receipt records the publication commit, branch and report digest before review completion.
It must match the exact saved audit and its commit must remain reachable from the local target;
restored state or a branch reset cannot establish delivery from a stale receipt alone.
Commit trailers allow recovery if the branch advanced before the receipt was saved. Retrying an
older published report must not replace a newer review's block. Request changes runs a fresh audit
and clears its old publication receipt. Existing historical reviews are not automatically backfilled.

Focused real-Git tests cover documentation-only commits, dirty checkout preservation, branch movement,
serialization, duplicate/lost-ack retries, compact output and failure paths. Runner tests cover both
CLI backends and publication-before-completion. Source checks do not establish activation in an
already-running main process; new or resumed reviews use this behavior after the host loads the build.
