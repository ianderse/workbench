/** Tasks ordered so every task comes after the ones it depends on (stable for independent tasks) */
export function sortByDependencies<T extends { key: string; dependsOn: string[] }>(tasks: T[]): T[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out: T[] = [];
  const done = new Set<string>();
  const visit = (task: T, stack: Set<string>): void => {
    if (done.has(task.key) || stack.has(task.key)) return;
    stack.add(task.key);
    for (const dep of task.dependsOn) {
      const depTask = byKey.get(dep);
      if (depTask) visit(depTask, stack);
    }
    stack.delete(task.key);
    done.add(task.key);
    out.push(task);
  };
  for (const task of tasks) visit(task, new Set());
  return out;
}

/**
 * Drop the dependency edges that close a cycle: edges are added one by one in task order and an
 * edge from a task that already (transitively) waits for the dependent is skipped.
 */
export function breakDependencyCycles<T extends { key: string; dependsOn: string[] }>(tasks: T[]): void {
  const accepted = new Map<string, string[]>(tasks.map((t) => [t.key, []]));
  const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return (accepted.get(from) ?? []).some((next) => reaches(next, target, visited));
  };
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (reaches(dep, task.key)) continue;
      accepted.get(task.key)!.push(dep);
    }
    task.dependsOn = accepted.get(task.key)!;
  }
}
