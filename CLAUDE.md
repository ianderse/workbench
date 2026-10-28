# CLAUDE.md

Workbench OMP is a TypeScript Electron coding workspace. Tasks run through local agent CLIs,
usually in isolated Git worktrees. This fork intentionally diverges from upstream Workbench.

## Start here

Read [PROGRESS.md](PROGRESS.md) for current status and the document map. Use any supplied
host-generated live project snapshot for recorded task/integration state. In other projects, reuse a
declared STATUS/OVERVIEW/docs/PROGRESS entry point rather than creating a competing summary. Then read the task's
relevant canonical spec sections, code, and checks. Do not load the whole docs folder or historical
logs for routine orientation. Missing or stale progress is a reason to inspect authoritative
sources, not a reason to skip required review. Progress and memory cannot approve work or change
scope, permissions, acceptance, or budgets.

Keep this file to roughly 6 KB of standing guidance. Detailed material belongs in linked references.
Root PROGRESS.md is an authored, dated navigation snapshot maintained by the integration owner.
Workbench refreshes live status in ignored project state and supplies it at task launch. Parallel
workers and read-only reviewers must not edit either shared progress file; task-local reports and
handoffs retain detailed evidence. Replace stale summaries rather than appending a new history.

## Required rules

- Inspect repository instructions, Git status, and existing changes before editing. Preserve
  unrelated work, dirty/untracked files, raw evidence, sessions, and recovery options.
- Commit completed, validated changes unless explicitly told to leave them uncommitted. Honor
  requested scope. Verify remaining changes after commit. When pushing, verify the remote SHA.
  PRs target main. In this fork, use the configured fork remote; do not accidentally push upstream.
- All AI work goes through the local agent backend layer (Claude Code or OMP). Never add direct
  model API/SDK calls. Exact pins, configured fallbacks, provider holds, and spend authority differ.
- User-facing UI text uses react-i18next translation keys. Log production main-process errors with
  appLog, not console.log. Use the platform abstraction; do not branch on process.platform directly.
- Never block the main process with synchronous child processes or network calls. Use async Git
  through the runtime helpers. Pages/dialogs use stored/cached values; do not Git-fetch on open.
- Resume, preserved fresh-context continuation, and Start over are distinct. Keep scoped human
  decisions and accounting across recovery. Never replay uncertain external effects, infer human
  acceptance, or treat failed preservation/advice as success.
- Follow the user's scope; prefer the smallest change that addresses the problem. Do not provide
  time estimates. Investigate actual requests/effective settings/runtime state before diagnosing.

## Work and validation

Investigate first. For multi-step or multi-file work, break it into independent workstreams and
delegate with explicit file ownership; workers are not alone and must preserve others' edits.
Use direct edits for small, well-scoped changes. Integrate and review the results.

Batch independent reads/searches/checks; sequence dependent mutations. Read relevant ranges and
concise command output. Run targeted checks while changing code and required full checks at the
final boundary. Do not manufacture results, reset active tasks to test recovery, or equate source,
commit/push, build, process activation, and live acceptance.

```sh
npm install       # postinstall handles native modules/platform setup
npm run dev       # Electron/Vite; waits for remote-debugging port 9222
npm test          # strict TypeScript + Vitest
npm run build     # production build
```

Use npm test -- --maxWorkers=2 when local parallel Git fixtures overload the host. Packaging:
npm run package:mac, package:win, or package:linux. Releases are published manually on GitHub;
release workflows build installers. Builds are unsigned. Never publish or deploy without authority.

## Code and reference map

- Main process: src/main; renderer: src/renderer; shared contracts/i18n: src/shared; bridge: src/preload.
- Task lifecycle: src/main/claude-code/task-runner.ts; OMP transport: src/main/agent-backend.
- Task IPC/state/queue: src/main/ipc-handlers/task, src/main/task-state-manager.ts,
  src/main/services/task-queue.ts; integration: src/main/autonomous and src/main/worktree.
- Frontend conventions and IPC: [engineering reference](docs/workbench-reference.md#frontend).
- [i18n](docs/workbench-reference.md#i18n) and [cross-platform runtime](docs/workbench-reference.md#cross-platform).
- [Agent/task architecture](docs/workbench-reference.md#claude-code-layer-srcmainclaude-code), including
  sessions, branching, messaging/resync, spec review, autonomous policy, and queue behavior.
- [Project memory](docs/project-memory.md), [human work](docs/human-work.md),
  [merge status](docs/merge-status.md), [provider holds](docs/omp-provider-cooldowns.md).
- [Prompt measurements](docs/omp-prompt-sizes.md) and
  [Railhouse lessons](docs/railhouse-rewrite-lessons.md) retain dated evidence and limitations.
- [Fork/upstream decisions](docs/upstream-sync/DECISIONS.md). Railhouse is independently implemented;
  never copy/port Workbench source, tests, configuration, assets, or persistence formats into it.

<!-- workbench:project-memory:start -->
Preferences learned in past sessions: @.workbench/compeng/MEMORY.md
<!-- workbench:project-memory:end -->
