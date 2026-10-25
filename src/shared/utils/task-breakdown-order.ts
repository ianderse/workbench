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
