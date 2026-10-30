# Test resource limits

Agent-launched test commands share the computer with other tasks and dev servers. At the
Claude Code and OMP spawn boundaries, Workbench supplies Vitest worker environment limits:

- One worker by default. Explicit positive worker counts remain supported up to two;
  invalid or larger values are normalized to the bounded defaults/cap.
- `VITEST_MAX_WORKERS` covers the installed Vitest 4 behavior. `VITEST_MAX_THREADS`,
  `VITEST_MAX_FORKS` and the corresponding minimum variables cover the installed Vitest 2
  thread/fork pools. Minima cannot exceed their maxima. These values are inherited by
  nested tools and are explicitly forwarded into WSL.
- Workbench's own Vitest configuration defaults to two workers for direct repository checks.

Task instructions keep broad suites sequential and in the foreground, with the parent owning
the final full suite. Interrupted/timed-out test commands must settle their owned processes
before retry. They are not successful checks. The environment policy bounds each invocation;
it is not a global semaphore, orphan reaper, or guarantee that a command cannot unset its own
environment. Tests remain required; their scope and assertions are unchanged.

The incident on 2026-10-29 included ten orphaned workers and another 13-worker integration run
from Anomaly task 213, plus a separate unbounded checkout run. The excessive test processes
were terminated, and task 213 was paused through the normal application stop action with its
dirty worktree preserved. A separate two-worker checkout run was left running. No dev server
or unrelated agent was stopped. This operational cleanup is separate from the source fix.

The persistent policy applies when Workbench loads this build and launches new CLI processes;
already-running agents retain their original environment. Do not resume the paused task on
an old unbounded agent environment merely to demonstrate activation.

Local probes exercised installed Vitest 2.1.9 (Anomaly) and 4.1.0 (Workbench) with a synthetic
three-file suite, both configuration and CLI requesting 13 workers. The inherited default
limited each run to one active test worker and pool ID 1. Temporary probe files were removed.
This qualifies those installed native versions; live WSL behavior remains unverified.

Validation: the full Workbench suite passed with one worker (308 files, 3,806 tests passed,
one skipped), including CLI spawn inheritance and composed WSL forwarding regressions.
