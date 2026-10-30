# Workbench progress

Observed 2026-10-30. This is the authored project entry point, not a completion ledger or approval.
Inspect current Git state and task records for later changes; historical evidence remains linked.

## Current implementation

Workbench OMP supports autonomous coding tasks, isolated worktrees, queue/dependency coordination,
review and integration, project memory, human decisions, and model-specific usage accounting through
CLI backends. Recent work adds batched start briefings, advisor scheduling, preserved fresh context,
bounded phase recovery, and related-spec human decisions across later tasks and independent reviews.
An already waived/deferred activity must be reconciled rather than requested again under a new scope
label. Newly added requirements and whole-spec acceptance remain separate.

Automatic triage now applies phase-specific effort; explicit effort pins and fixed/fallback settings
remain authoritative. Prompts prefer targeted edits and shared foundations before parallel consumers.
Agent-launched Vitest uses one worker by default, capped at two for explicit settings; direct Workbench
tests default to two. Keep broad suites sequential and use one worker on a busy host.

Each spec-review ticket now requires a host-published, documentation-only update to root PROGRESS.md
on its reviewed local base branch before completion. The audit stays read-only. One bounded latest-review
block records the inspected revision, agent-reported findings and check-observation status. Publication
failure preserves the report; Resume retries publication without another model review. Authored text
outside the block and unrelated checkout work are preserved. No automatic push or historical backfill.
See [review publication and retry](docs/review-progress.md).

Workbench separately refreshes a bounded live projection in ignored `.workbench/PROGRESS.md` at task
launch and state/integration changes. It supplies recorded task state and observed Git identity without
reading the documentation archive or calling a model. Board Done, reported checks, integration, push
and owner/spec acceptance remain distinct. Neither progress file can waive required checks.

## Validation and next boundaries

Review-publication validation passed 309 test files (3,856 tests, one skipped), followed by 207
focused tests for final receipt recovery and Git normalization, plus strict TypeScript and production
build. All tests used one Vitest worker. Fixtures do not establish live activation or provider productivity.
New or resumed runs use changes after the main process loads the build; active workers were not
interrupted to force activation. Existing workers may retain old settings and environment.

Native Windows qualification, full provider/crash-recovery qualification and provider-wide admission
including nested requests remain separate. An installed OMP handshake is not production execution
or recovery proof. Consult scoped human decisions and authoritative specs for acceptance boundaries.

## Relevant references

- [Standing rules and commands](CLAUDE.md)
- [Engineering architecture/reference](docs/workbench-reference.md)
- [Human work and related-spec decisions](docs/human-work.md#related-specification-decisions)
- [Review progress publication](docs/review-progress.md)
- [Test resource limits](docs/test-resource-limits.md)
- [Project memory](docs/project-memory.md) and [merge status](docs/merge-status.md)
- [Prompt measurements](docs/omp-prompt-sizes.md) and [provider holds](docs/omp-provider-cooldowns.md)
- [Independent Railhouse lessons](docs/railhouse-rewrite-lessons.md)
- [Fork/upstream decisions](docs/upstream-sync/DECISIONS.md)

## Ownership and freshness

The integration owner replaces stale authored status after inspected integration or material
qualification changes. Keep the whole file below 6 KiB and leave room for the host-managed review
block. Parallel workers/read-only reviewers must not edit shared progress; the host owns its review
block and ignored live projection. Preserve specs, immutable evidence and authoritative acceptance records.
