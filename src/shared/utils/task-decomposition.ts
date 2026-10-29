/** Planning guidance, not an exclusive file reservation or a scheduling lock. */
export const TASK_DECOMPOSITION_GUIDANCE = `## Task boundaries and dependencies
- State each task's primary implementation files/modules and the existing interfaces it consumes. Name only ownership you can justify from the inspected code; label uncertain boundaries rather than inventing exclusive file claims.
- Before parallelizing, identify coupled edits to foundational contracts, schemas/migrations, dispatchers, and other shared integration modules. Put the common interface/change in one coherent prerequisite increment, then let consumers depend on its merged result. Do not ask independent tasks to redesign the same interface and reconcile it later.
- Keep unrelated modules parallel. Sharing a documentation file or merely mentioning the same path does not establish a code dependency. Use dependsOn only for actual prerequisites; do not serialize every large task.`;
