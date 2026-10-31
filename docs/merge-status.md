# Task merge status

The board card and the top of task details show automatic merge activity separately from AI review:

- Queued for merge: waiting for the project's merge slot or a branch sync.
- Merging: bringing the target into the task and merging the task into that target.
- Resolving conflicts: the merge agent is working; the count is conflicted files, not conflict hunks.
- Verifying: checking the resolved merge, including preservation of the target's changes.
- Pushing: publishing the merged target branch.
- Merged: a durable merge receipt exists, with the target branch and commit. This remains visible on Done.
- Blocked: the merge attempt ended without success; task details show the recorded reason.
- Interrupted: saved activity belonged to a previous app session. Startup retries eligible completed tasks.

Progress uses `metadata.autoMergeProgress`; success and failure use the existing `autoMerge` and
`autoMergeBlocked` records. Each update invalidates the task cache and emits the existing task-list
change event, so open cards and task details update together. Completion clears progress atomically
with its receipt. Failed pushes remain visibly distinct from failed merges. A reverted merge is
identified explicitly. Startup marks unfinished activity interrupted before catch-up, and a new task
run clears the previous attempt's state. These indicators do not approve tasks or bypass review.

This requires the updated main process. Restart Workbench after current workers and merge agents
finish; reloading a window only updates the display code.

## Failed review is an automatic restart boundary

A completed failed AI review does not receive a new review budget because another task merged
into its base branch. Automatic resync leaves that task in its existing state, with its pending
resync request, branch, failed checks and review history intact. The resync executor does not
inspect or change the worktree, fast-forward it, enqueue it or launch another agent. Merge
notifications may still check ancestry to retain the pending request. This guard also covers startup
recovery scans and requests arriving as a run finishes.

Explicit **Start/Resume** or **Request changes** still begins deliberate work and applies the
preserved resync request through the existing run path. It does not waive a failed check, supply
a missing owner decision or approve the task. A new base commit alone is not that authorization.

Task 234 was held immediately using the existing user-stop sentinel, with its canonical task,
review, metadata and log files unchanged. The sentinel prevents old-process automatic restarts
before this build is activated and is cleared by the next explicit task start.

Validation: the regression advances the base branch 35 times, feeds merge requests, startup scans
and after-run hooks, then recreates the resync service. Both divergent and fast-forwardable task
branches retain their HEAD, worktree, failed report and owner receipts, with zero Git inspections,
agent starts or queue entries from the executor. Early terminal failures and unchanged passing/
incomplete behavior are also covered. Strict TypeScript, the full single-worker suite (310 files,
3,884 passed and one skipped), and the production build passed for this change.
