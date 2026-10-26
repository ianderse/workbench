# Standing upstream-sync decisions

Every upstream sync applies these. Each was decided by the owner after a sync was reviewed; the dated
reports next to this file hold the full reasoning. When a new sync needs a decision, the report lists
it under "Decisions needed"; once the owner decides, it is added here and every later sync follows it.

## Keep out (never take from upstream)

- **Version automation (2026-10-26).** Upstream versions the app from git history: `.husky/post-commit`
  amends every commit's `package.json` version, `.github/scripts/sync-version.cjs` computes it, and
  `.github/workflows/version.yml` rewrites `main`'s merge commit after each merged PR. This fork keeps
  `package.json` at the plain base version and takes release versions from tags. Do not bring in the
  hook, the script, the workflow, a `prepare: husky` script or the `husky` devDependency. If upstream
  changes them, drop the change and note it in the report.
- **The rename.** Product name Workbench OMP, app id `com.workbench.omp`, package name `workbench-omp`,
  updater and publish target `ianderse/workbench-omp`, README intro and changelog.

## How overlapping features are resolved

- **Merge helper (2026-10-25, decision 1).** `mergeTargetIntoBranch` is the single implementation for
  bringing a target into a task branch: PR merge, local merge, resync without a session and autonomous
  auto-merge all use it. Autonomous mode keeps its temporary-worktree `--no-ff` merge and `advanceBranch`.
- **Resync on auto-merge (decision 2).** An auto-merge emits the `auto-merged` hook and runs the same
  merge sync as Done; auto-merged tasks are never resynced themselves.
- **Validation skip rule (decision 3).** The AI review loop runs when the report is missing or any coding
  step is newer than the last validation (upstream's rule combined with our loop).
- **Usage ledger (decision 4).** Every result of a multi-turn run is booked.
- **Agent window system prompt (decision 5).** Claude windows take upstream's combined Graphify and
  self-improve flag; OMP windows keep their own prompt.
- **Task messaging (decision 6).** The settings switch shows for OMP too; OMP gets messaging through a
  per-run extension and live delivery through `omp --mode rpc`.
- **Backend pin through merge help (decision 7).** The task's resolved backend is passed through
  `mergeTargetIntoBranch` to `runClaudeText`.
- **Merge the base branch once, before validation (decision 8, fork-only).** Running tasks are told about
  merges but not asked to merge; the runner merges once before each validation (`mergeBaseDuring`,
  default `validate`). OMP tool pseudo paths are filtered from changelogs. Keep this when upstream
  changes resync or notices.
- **Agent window Session menu (2026-10-26).** Upstream's Session menu lists Claude Code transcripts. It
  stays hidden in OMP windows (`TerminalHeader`, `agentBackend.kind === 'omp'`); Claude windows get it.
  New Claude-transcript-based agent window features follow the same rule: hide or gate them for OMP
  unless they go through the agent backend layer.
