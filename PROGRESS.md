# Workbench progress

Observed 2026-10-29. This is the authored project entry point, not a completion ledger or approval.
Baseline: 5527b9c (throughput/recovery delivery). Inspect current Git state for later changes.

## Current implementation

Workbench OMP supports autonomous coding tasks, isolated worktrees, queue/dependency coordination,
review and integration, project memory, human decisions, and model-specific usage accounting through
CLI backends. The baseline adds batched task-start briefings, task advisor scheduling, preserved
fresh context, and bounded phase-boundary progress recovery. These are source/build capabilities;
existing workers can retain old configuration and live recovery qualification remains separate.

Validation recorded at that baseline: 302 test files, 3,681 passed and one skipped, strict typecheck
and production build passed. Installed OMP 18.13.2 returned a native session ID in a get_state-only
RPC probe without a model prompt. That does not certify full provider execution or crash recovery.

## Current documentation/context work

Use a small status entry point and task-relevant references instead of repeatedly scanning all docs.
Standing guidance is in CLAUDE.md; detailed guidance was preserved in docs/workbench-reference.md.
Workbench generates a bounded live PROGRESS.md inside the project's ignored tool-state directory
(.workbench/PROGRESS.md by default), refreshes it after task state/integration changes and at task launch, and supplies
it to task/triage prompts. This avoids runtime writes to tracked root progress files, which would
dirty integration checkouts. Failure to persist the projection does not fail a merge or task.

Validation during this context change: 304 test files, 3,707 passed and one skipped; final focused
context/host checks, strict typecheck, and production build passed. The Windows archive-flush
regression found in baseline CI was corrected in f85a0e5 with writable-handle/failure tests.
That CI run also had older Windows path-fixture and Git-timeout failures; native Windows
qualification of the combined update remains pending. No provider productivity gain is claimed.

The live snapshot labels current checkout identity, recorded task status, agent-reported checks,
and recorded autonomous integration targets separately. Board Done, passing checks, merge, push,
and explicit spec acceptance are distinct. Omitted rows remain available in task records. The
snapshot never reads the documentation archive or makes an AI call. It does not prove live activation.

Related-spec human decisions now reach later task phases and independent reviews across batches,
including absolute/relative references to the same project-contained spec. Source requirements,
exact decisions and dated requests stay evidence context; task-wide overrides are not inherited.
Reviews reconcile an already waived/deferred activity instead of requesting it again under a
new scope label. Newly added requirements and whole-spec acceptance remain separate. See
[human-work provenance and scope](docs/human-work.md#related-specification-decisions).
Validation: 307 test files passed (3,792 tests, one skipped), strict TypeScript and build passed.
New runs use this change after the main process loads the build; active workers were not interrupted.

## Execution efficiency

Automatic triage now feeds phase-specific effort instead of carrying the hardest task effort
through every step. Planning/design/spec review and fresh independent review retain depth;
routine execution/check/sync phases have lower caps, while large implementation and corrective
work retain up to high effort. Validation only uses the lower cap after a clean independent review.
Explicit task effort pins and fixed/fallback settings are preserved.
Task prompts prefer targeted edits and preserve completed work after compaction. Initial
breakdowns and spec-gap follow-ups plan shared foundations before parallel consumers; this is
guidance, not file locking or rescheduling of existing tickets. See the
[dated behavior and qualification boundary](docs/railhouse-rewrite-lessons.md#phase-effort-and-edit-scope-2026-10-29).
Live latency and first-pass quality still need observation after the main process loads the build.
The combined validation above also covers this phase policy; live productivity remains unqualified.

## Working boundaries and next checks

- Verify current code and the task's mandatory specs/checks; stale progress cannot waive them.
- Use task records and scoped human decisions for active work, blockers, approvals, and acceptance.
- Observe the new behavior in new/resumed runs after the main process loads the current build;
  don't interrupt user-owned work to force activation.
- Provider-wide admission including nested requests remains separate capacity work.
- Keep historical evidence intact. Resolve duplicate/superseded docs through an explicit canonical
  map and reviewed archival changes; this change does not delete or silently rename project specs.

## Relevant references

- [Standing rules and commands](CLAUDE.md)
- [Engineering architecture/reference](docs/workbench-reference.md)
- [Human work and decisions](docs/human-work.md)
- [Project memory](docs/project-memory.md)
- [Merge status](docs/merge-status.md)
- [Prompt measurements and context limits](docs/omp-prompt-sizes.md)
- [Provider holds](docs/omp-provider-cooldowns.md)
- [Independent Railhouse lessons](docs/railhouse-rewrite-lessons.md)
- [Fork/upstream decisions](docs/upstream-sync/DECISIONS.md)

## Ownership and freshness

The integration owner updates this authored snapshot after inspected integration or a material
change to qualification. Keep it to one or two pages (roughly 6 KB); replace stale status, link
full evidence, and never append an endless chronological log. Parallel workers/read-only reviews
must not edit it. Workbench owns its ignored live projection. Neither file replaces authoritative
specs, task state, immutable evidence, human decisions, or acceptance records.
