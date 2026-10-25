# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Product Overview

Workbench OMP (a renamed, intentionally diverged fork of Workbench; upstream is merged in daily, see `docs/upstream-sync/`) is a TypeScript Electron desktop app where users describe a goal and the **Claude Code CLI** does the work
autonomously. Every task runs in its own git worktree so the main branch stays safe.

**Core workflow:** User creates a task (description, images, connectors, git options) → a short Claude Code **triage**
run picks model, effort and whether to plan → Claude Code **plans** (plan mode, optional) → **implements** in the task's
worktree (same session, permission checks off) → **validates** (project checks + fresh-context review + commit) → user
reviews, requests changes (same session continues) or merges.

**Main features:**

- **Autonomous Tasks** — Each task is delegated to Claude Code (`claude -p`) in its worktree; Claude Code decides
  when to use subagents, skills, MCP tools and its task list
- **Kanban Board** — Visual task management from planning through completion
- **Agent Terminals** — Parallel AI-powered terminals (12 by default, up to 24) with task context injection
- **Insights** — Chat for exploring a codebase (runs through Claude Code; can't change files) that can also manage
  the project's tasks: Workbench's task tools (`src/main/insights/task-tools.ts`, served over local MCP HTTP by
  `task-tools-server.ts` with a token per chat turn) create, edit, start, stop, retry, move, review, PR, merge, archive
  and delete tasks through the same IPC handlers as the UI (`ipc-handlers/ipc-registry.ts`); ideas the user didn't ask
  for stay task suggestions (`__TASK_SUGGESTION__`)
- **Pull Requests** — Create a GitHub pull request from a task's worktree and merge it (via the `gh` CLI). A task with
  an open PR stays in Human Review (PR Created); Merge PR (`src/main/ai/runners/github/pr-merger.ts`) pulls the target
  branch into the task branch, lets the merge agent (`src/main/ai/runners/merge-agent.ts`, Claude Code) resolve
  conflicts, checks that no line the target added was lost, pushes and merges the PR, then moves the task to Done
- **Connectors** — MCP servers added to a task's Claude Code session (`--mcp-config`: Context7, Electron, Puppeteer,
  user-added servers) with app-wide defaults in Settings and per-task choices in the task dialog
- **Graphify memory graph** — Optional [Graphify](https://github.com/Graphify-Labs/graphify) knowledge graph of a
  project's code, built into `.workbench/knowledge` and offered to agents
- **Isolated Workspaces** — Git worktree isolation for every build; AI-powered semantic merge
- **Authentication** — Claude subscription accounts (each a `CLAUDE_CONFIG_DIR`) or API profiles with any
  Anthropic-compatible endpoint
- **Multi-Account Swapping** — When one Claude account hits a rate limit, switch to an available one automatically
- **Cross-Platform** — Windows, macOS, and Linux with auto-updates

## Critical Rules

**AI work goes through the agent backend layer** — All AI work (tasks, triage, Insights, titles, PR text, commit messages,
merge conflict help) runs through a local coding-agent CLI: Claude Code by default (`src/main/claude-code/`, `ClaudeTaskRun`
for tasks, `runClaudeText()` for one-shot calls) or OMP when Settings > Agents selects it (`src/main/agent-backend/`).
Never call the Anthropic API or an AI SDK directly for these.

**i18n required** — All user-facing text uses `react-i18next` translation keys (see [i18n](#i18n)).

**Platform abstraction** — Never use `process.platform` directly. Import from `src/main/platform/` (see
[Cross-Platform](#cross-platform)).

**No console.log in production code** — `console.log` output is invisible in bundled Electron apps. Log errors in the
main process with `appLog` (`src/main/app-logger.ts`, written to the logs folder); reserve `console.log` for development
only.

**No time estimates** — Provide priority-based ordering instead of duration predictions.

**PR target** — Always target the `main` branch for PRs; it is the only long-lived branch.

**Never block the main process** — IPC handlers reachable from the UI must not run synchronous child processes
(`execFileSync`/`execSync`) or network calls; use async `execFile` (promisified). A sync `git fetch` used to freeze the
whole app every time a dialog opened.

**Don't re-fetch on open** — Pages and dialogs show stored values (Zustand stores, settings, or
`src/renderer/lib/refresh-cache.ts` for results of slow checks) and only fetch when the user presses a refresh
button, or once when nothing was fetched before. Shared hook: `useProjectBranches()` (it lists local refs
again in the background, never `git fetch`, so branches made outside the app show up).

## Work Approach: Orchestrator-First

You are an orchestrator. Your primary role is to understand what needs to be done, break it into workstreams, and
delegate execution to agent teams. This keeps your context window focused on coordination and decision-making rather
than filling up with implementation details.

<orchestrator_pattern>
When given a task, follow this pattern:

1. **Investigate first** — Read the actual code before forming any hypothesis. Use targeted searches (Glob, Grep, Read)
   for simple lookups. For broader exploration, spawn an Explore agent.

2. **Plan the approach** — Identify what needs to change, which files are involved, and whether work can be
   parallelized. For multi-step tasks, create a task list to track workstreams.

3. **Delegate execution** — Spawn agent teams to do the implementation work. Each agent gets a clear, self-contained
   assignment with all the context it needs: relevant file paths, the specific change to make, and acceptance criteria.
   Run independent workstreams in parallel.

4. **Verify and integrate** — Review agent outputs, run tests, and ensure changes work together. Fix integration issues
   or spawn follow-up agents as needed.
</orchestrator_pattern>

**When to delegate vs. do directly:**

- Delegate: multi-file changes, research across the codebase, independent parallel workstreams, tasks that would consume
  significant context
- Do directly: single-file edits, simple bug fixes, quick lookups, tasks where you already have the context

**Giving agents good assignments** — Each agent works with a fresh context. Include: the specific goal, relevant file
paths, code patterns to follow, and what "done" looks like.

**Minimal changes only** — Prefer the simplest approach (e.g., prompt-only changes, single guard clause) before
suggesting multi-component solutions. If the user asks for X, implement X — don't bundle additional fixes they didn't
request.

**Default to action** — When the user's intent implies making changes, implement them rather than only suggesting. If
something is unclear, read the relevant code to fill in the gaps rather than asking. Only ask when genuine ambiguity
remains about what the user wants.

## Commands

```bash
npm install            # Install dependencies (postinstall rebuilds native modules; on Linux it also fixes chrome-sandbox)
npm run dev            # Development mode with HMR and remote debugging on port 9222 (Electron MCP); waits for the port to be free first
npm test               # Type check (strict) + all tests (Vitest)
```

### Packaging

| Command                 | Output                                           |
|-------------------------|--------------------------------------------------|
| `npm run package:mac`   | macOS `.dmg` + `.zip`                            |
| `npm run package:win`   | Windows `.exe` (NSIS installer)                  |
| `npm run package:linux` | Linux `.deb`                                     |

Packages are written to `dist/`.

### Releases

Releases are created by hand on GitHub, never by a workflow. Publishing a release runs `release.yml`; publishing a
pre-release runs `beta-release.yml`. Each one builds the four platforms in a matrix (`npm ci`, `npm run build`,
`npm run package:*`), takes the version from the release tag (`package.json` keeps the plain base version, and the beta
workflow adds `-beta` when the tag has no pre-release suffix) and uploads the installers and update manifests to that
release with `gh release upload`.

Builds are unsigned and not notarized: the repo holds no signing secrets. The release repository is public, so
auto-update reads releases unauthenticated and the build needs no token.

## Project Structure

```
workbench/
├── src/
│   ├── main/                # Electron main process
│   │   ├── claude-code/     # Claude Code CLI integration (task runner, triage, one-shot calls, inventory)
│   │   ├── ai/              # Remaining helpers: runners (PR, commit, merge help), merge/, project/
│   │   ├── worktree/        # Task worktree creation
│   │   ├── insights/        # Insights chat through Claude Code
│   │   ├── agent/           # AgentManager: starts/stops Claude Code task runs, relays events
│   │   ├── claude-profile/  # Multi-profile credentials, token refresh, usage
│   │   ├── terminal/        # PTY daemon, lifecycle, CLI integration
│   │   ├── platform/        # Cross-platform abstraction
│   │   ├── ipc-handlers/    # IPC handler modules by domain
│   │   └── services/        # App services (session recovery, rate-limit resume)
│   ├── preload/             # Preload scripts (electronAPI bridge)
│   ├── renderer/            # React UI (components, stores, contexts, hooks, styles)
│   └── shared/              # Shared types, i18n, constants, utils
├── resources/               # App and tray icons, macOS entitlements
└── .github/                 # Workflows and the postinstall script
```

## Claude Code Layer (`src/main/claude-code/`)

- **Task runner** (`task-runner.ts`, `ClaudeTaskRun`) — runs one task in its worktree:
  - `triage` (`triage.ts`): read-only `claude -p --json-schema` run → `TaskTriage` (model `haiku|sonnet|opus|fable`,
    effort `low…max`, needsPlan, scope, title, verification commands). Rules follow Claude Code's model-config and
    best-practices docs; Settings > Claude Code can fix model/effort or force planning on/off.
  - `plan`: `--permission-mode plan` + structured plan (headless plan mode has no `ExitPlanMode`), saved to `plan.md`.
  - `implement`: resumes the same session (`--resume`) with `--dangerously-skip-permissions` (worktree isolation;
    without a worktree it uses `--permission-mode auto`) and the triage model/effort.
  - `validate`: same session runs checks, reviews the diff with fresh eyes (`/code-review` or a subagent), commits,
    returns a structured `ValidationReport`. `revise` mode applies "request changes" feedback, then validates again.
    AI review loop (`aiReviewRounds`, default 3, `shared/utils/ai-review-loop.ts`): a report with status `failed`, an open
    blocker/major finding or a failing check sends the task back (`revise` in the same session, In Progress), then it is
    reviewed again; rounds and the verdict go to `ClaudeRunInfo.reviewRounds/reviewVerdict` and a failed verdict shows as a
    panel in Human Review.
  - State in `<specDir>/claude_run.json` (`ClaudeRunInfo`: session id, triage, plan, phases with cost, `system/init`
    info, subagents, validation) so stopped / rate-limited runs continue; logs in `task_logs.json`. Claude Code's
    task list (TaskCreate/TaskUpdate, enabled with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`) is mirrored as the task's subtasks.
- **UI work** (`ui-design.ts`, `shared/utils/ui-work.ts`) — triage's `uiWork` (schema field, missing = false) or the
  ticket's `metadata.uiWork` (true/false forces, set in the task dialog) makes a task UI work (`resolveUiWork`). It forces
  planning on (`applyUiWorkPlanning`), and the plan step runs on the **design model** with a "Design spec" requirement
  (layout, components, states, responsive, accessibility, copy, design system fit) saved in `plan.md`. Design model = Opus
  on Claude Code; on OMP the `design` role, falling back to `plan` (omp fails with "Model not found" for an undefined
  role, so `ompRoleSelector` only passes roles the config defines; the design role also beats the size mapping) and to
  the Large size when neither exists. Project setting `uiImplementer` (`design` default | `default`, in
  `.workbench/settings.json`) decides whether implement, revise and validate also use it. Validation and the OMP fresh-context
  review check the result against the design spec. A per-task `agentOverride` pin wins; Spec review is unaffected.
- **One-shot calls** (`run-text.ts`, `runClaudeText`) — `claude -p --output-format json --no-session-persistence`, tools
  off unless asked, optional `--json-schema`.
- **Process + env** (`process.ts`, `env.ts`) — async spawn, stream-json parsing (`stream-types.ts`), best available
  Claude profile (rate-limit aware) or the active API profile.
- **Inventory** (`inventory.ts`) — subagents, skills, commands, hooks, MCP servers, CLAUDE.md and settings files that
  Claude Code loads for a project (Settings > Claude Code).
- **AgentManager** (`src/main/agent/agent-manager.ts`) — creates the worktree, builds the run config (attachments,
  connectors, Graphify, settings) and relays run events (`log`, `execution-progress`, `task-event`, `run-info`,
  `subtasks`, `run-finished`) to the IPC layer and the XState task machine.

Claude Code docs: https://code.claude.com/docs/en/ (CLI reference, headless mode, sub-agents, model config,
permission modes, worktrees, hooks, skills).

### Agent backend (OMP)

`AppSettings.agentBackend` (`src/shared/types/agent-backend.ts`, read in the main process with `isOmpBackend()` from
`src/main/agent-backend/settings.ts`) picks Claude Code (default) or OMP (`omp`, local models from
`~/.omp/agent/models.yml`). OMP maps triage's model tiers (haiku/sonnet/opus/fable) to OMP models and efforts to thinking
levels. With OMP no Claude account is required (`checkClaudeCodeAuth` passes), the usage indicator and auth-failure modal are
hidden, and agent windows launch `omp` (`buildOmpLaunchCommand` in `terminal/cli-integration-handler.ts`). OMP detection
(`omp --version`, `omp models --json`, cached in the renderer refresh cache) is `ipc-handlers/agent-backend-handlers.ts`;
the settings UI is `settings/AgentBackendSettings.tsx`.

A task can pin its own backend, model and effort (`TaskMetadata.agentOverride`, the Model control in the task dialogs, `task-form/TaskAgentPicker.tsx`). `resolveEffectiveAgent()` (`shared/utils/agent-override.ts`) turns it and the app backend into the task's backend; the runner (`TaskRunConfig.backend`), the auth check and one-shot calls (`runClaudeText({ backend })`) use that instead of the global backend, and triage's model/effort are replaced by the pin (`applyAgentOverrideToTriage`).

### Resume and Start over

A stopped (Human Review, reason `stopped`) or failed (Error) task whose run has an unfinished step shows **Resume**
(`canResumeTask()`, `shared/utils/task-resume.ts`): it is `TASK_START`, which keeps the worktree and continues the saved
session at the first unfinished step. **Start over** (`TASK_RETRY`, confirmation dialog) discards the worktree and branch,
but first saves the work (commits, uncommitted and untracked files, minus generated folders) on a
`workbench/backup/<spec-id>-<yyyyMMdd-HHmmss>` branch (`utils/task-work-backup.ts`, used by `discardTaskWorktree()`); when
that fails nothing is discarded. OMP session transcripts are copied into `previous_runs/<n>/`.

### Base branch and "New branch"

A task's worktree branch (`workbench/<spec-id>`) is cut from `metadata.baseBranch`, and merges go back into it. The new task
dialog can create that base branch: choosing "New branch..." in the Base branch picker (`task-form/TaskGitOptions.tsx`)
stores `baseBranch = <name>` plus `newBaseBranchFrom = <start branch>` (`task-form/base-branch-metadata.ts`; names are
validated by `shared/utils/git-ref-name.ts`). `AgentManager.buildRunConfig` calls `ensureNewBaseBranch()`
(`main/utils/new-base-branch.ts`, async `git()`) right before the worktree is created: a no-op when the branch exists
(several tasks may share one), else `git branch --no-track <name> <from>`, pushed when the task's push-new-branches is on;
a failure fails the start (appLog plus the task's recoverable error). The dialogs also set `metadata.baseBranchChosen`
when the picked branch is not the project's default (a new branch always); autonomous mode reads it, see "Autonomous mode".

### Task Directory

Each task's `.workbench/tasks/XXX-name/` contains `task_metadata.json`, `implementation_plan.json` (status and
mirrored task list), `claude_run.json`, `task_logs.json`, `plan.md` (when planned) and `attachments/`.

### Task Changelog (parallel tasks)

Task hooks (`src/main/task-hooks.ts`, `taskHooks.on('state' | 'files-edited', ...)`) run on every state a task
enters (state machine transitions and manual moves) and on the files its Claude Code session edits (Edit, Write,
MultiEdit, NotebookEdit tool calls). `src/main/task-changelog-writer.ts` turns them into the project's
`.workbench/changelog.jsonl` (one JSON entry per line; state entries carry every file the task's branch changes).
At every phase, `buildParallelTasksPrompt()` (`src/main/task-changelog.ts`) adds a "Parallel tasks" section to the
task's system prompt: the other tasks with unmerged changes and the files they touch, so Claude Code can stay clear of
them and avoid merge conflicts.

### Task messaging and resync (upstream)

Parallel tasks message each other through Workbench (`src/main/task-messaging/`: broker, inbox, notices, tools served over
local MCP; Settings > Agents > Task messaging) and, when a task is merged, every other task on that base branch that lacks
the merge goes back to In Progress to take it in (`src/main/task-resync/`, `ClaudeTaskRun` phase `resync`, request in
`resync_request.json`). Messaging reaches OMP tasks too: the tools come from a per-run extension file (`task-messaging/omp-extension.ts`, `omp -e`) and live messages are steered into the running step through `omp --mode rpc` (`agent-backend/omp-rpc.ts`, setting `omp.liveMessages`; `-p` fallback keeps messages in the inbox for the next step);
resync runs on either backend. "Started" notices go to running tasks only and carry `TaskMessage.about`, so they are dropped once that task is no longer running and are not queued twice while an unread one waits. See `docs/upstream-sync/2026-10-25.md` for how it was merged with this fork's features.

### Stale tickets (briefing and queue grooming)

Tickets are written before the code exists, so later ones go stale as earlier tasks merge. Two things counter that:

- **Briefing** — when a task starts (`mode: 'start'`, also a retry), `buildTaskBriefing()` (`src/main/task-briefing.ts`)
  adds a "Since this ticket was written" section to its system prompt (`TaskRunConfig.briefingPrompt`): the tasks merged
  after the ticket was created, each with title, run summary, files touched (changelog) and open follow-ups, the ticket's
  own dependencies first, capped at about 6k characters. No model call.
- **Queue grooming** — every merge path (`markTaskDone` for local merges and merged PRs, the full worktree merge in
  `worktree-handlers.ts`) emits the `merged` task hook, and `ipc-handlers/queue-grooming-handlers.ts` calls
  `groomQueueAfterMerge(projectId, taskId, { autoApplyStructural: false })` (`src/main/queue-grooming.ts`). One background,
  read-only `runClaudeText` call (OMP role `plan`) compares the merged task with the tickets in Planning and the Queue.
  Notes are applied at once (appended to the description and kept in `metadata.contextNotes`, shown on the card and undoable
  in the task dialog; running tasks that depend on the merged one get the note as a Workbench message instead, when task messaging is on). Obsolete, duplicate and new-task answers become proposals in `.workbench/queue-proposals.json`,
  shown in the "Queue updates" panel on the board (`QueueUpdatesPanel`); with `autoApplyStructural` they apply at once and
  leave an undo entry. The project setting `groomQueueAfterMerge` (default on) turns it off. The answer is validated by
  `normalizeGroomingResult()` (`shared/utils/queue-grooming.ts`).

### Follow-up tickets

When a task enters Human Review as `completed` / `auto_merged`, the `state` task hook in
`ipc-handlers/queue-grooming-handlers.ts` calls `createFollowUpTickets()` (`src/main/follow-up-tickets.ts`), in the main
process, not when the panel opens. The review summary (`claude_run.json` `reviewSummary`) is written in the background
right after the run ends, so it takes the stored one, joins the run's generation (`trackReviewSummary`, same key) or writes
it, and the panel reuses it. One read-only `runClaudeText` call (OMP role `plan`) gets the task, its `needsAttention` items
and the open tickets (Planning, Queue, In progress; a pending split proposal's pieces count as handed off) and answers
`none | covered | queue | planning` per item; `normalizeFollowUpResult()` (`shared/utils/follow-up-tickets.ts`) validates it
(max 4 tickets, unknown `coveredBy` dropped, title and description required). Tickets get `metadata.followUpFrom`
(`{ taskId, item, needsDecision? }`) and `dependsOnTaskIds = [source]`; `queue` goes to the end of the Queue, `planning` to
Planning with a "Why this needs a decision" paragraph; `covered` adds a `kind: 'followUp'` context note. A ticket with
`followUpFrom` can only create `planning` tickets (recursion guard); Spec review tickets are skipped; `metadata.followUpsStartedAt`
is written before the model call (blocks repeats for 15 min) and `followUpsCreatedAt` after the tickets exist, so each task is handled once but a restart mid-call is retried; a startup catch-up (20 s after start, `catchUpFollowUpTickets`) handles finished Human Review tasks from the last 7 days that missed the `state` hook. The created tickets are kept in
`metadata.followUpTickets` for the line in the Human Review panel. Project setting `followUpTickets` (default on). Queued follow-up and decision tickets are added to the `dependsOnTaskIds` of every unstarted Planning/Queue ticket that depends on their source task (and on the decision ticket) so a dependent like a report waits for them (`addDependencyToDependents()`, `shared/utils/dependents-wait.ts`; needs-decision tickets never block, a new Spec review ticket also waits for the open follow-ups of its batch).

A `needsDecision` ticket (also stores `followUpFrom.why`) shows a "Your decision" panel (`task-detail/TaskDecisionPanel.tsx`) in the
task dialog instead of Start. `decideTicket()` (`src/main/decision-tickets.ts`, IPC `QUEUE_DECIDE_TICKET`, pure rules in
`shared/utils/decision-tickets.ts`) handles three answers: *Make tickets* makes one read-only `runClaudeText` call (OMP role `plan`) that
returns 0..4 `{ title, description, queue }` tickets plus a `decisionRecord`; they are created like follow-ups (`followUpFrom: { item: 'decision' }`,
no `needsDecision`, the decision ticket's own `dependsOnTaskIds`, queued ones at the end of the Queue; the recursion guard only
applies to review-derived follow-ups, so the explicit queue choice stands), then the decision ticket gets a "## Decision" block,
`metadata.decision = { text, at, outcome: 'tickets' | 'deferred' | 'rejected', ticketIds }` and moves to Done (backlog accepts
`MARK_DONE`; it never ran, so there is no worktree or merge dialog). *Not now* saves the note (outcome `deferred`, stays in Planning and
can be decided again); *Reject* archives. Any model failure, or an answer with no tickets, changes nothing. A `planning` follow-up also carries `followUpFrom.suggestion` (the model's recommended decision, written as the person would type it); older tickets get one through the panel's "Suggest a decision" button (`suggestDecision()`, IPC `QUEUE_SUGGEST_DECISION`, never on open), the panel prefills the textarea with it, and an empty answer on *Make tickets* uses it (`resolveDecisionText()`; the person's own text and a deferred ticket's saved text always win).

### Task splitting (per project)

The project setting `selfSplit` (`off | propose | auto`; unset = auto while autonomous mode is on, else propose,
`resolveSelfSplit()` in `shared/utils/task-split.ts`) lets the agent move part of a ticket's scope into 1 to 4 new
tickets. Two sources: the plan step's optional structured `split` (`keepScope` + `newTickets`; the plan then covers only
`keepScope`) and a `## Deferred` bullet list at the end of the implement answer (`parseDeferredSection()`, one follow-up
ticket). A ticket made by a split (`metadata.splitFrom`) or that split before (`metadata.splitInto`) never gets the
option (`canTaskSplit()`; the runner's `splitMode` is unset and the schema/prompts omit it). `applyTaskSplit()`
(`main/task-split.ts`) rewrites the description (original kept in a collapsed block, a `kind: 'split'` context note says
what moved where), creates the pieces at the top of the Queue chained after the task, and rewires queued/planning
dependents onto the last piece; undo (Queue updates panel) works while no piece started. `auto` applies at once;
`propose` at the plan step stores a `split` proposal, emits `SPLIT_PROPOSED` and the task pauses in Human Review
(`split_proposed`, `pendingSplit` in `claude_run.json`). Apply or Dismiss in the panel (or Resume) continues it: applied
keeps the saved plan for the reduced scope, dismissed plans the whole ticket again. A deferred-work proposal does not pause.

### Spec review loop (per project)

Tickets made by Break into tasks carry `metadata.specBatch = { id, source, round }` and are recorded as a batch in
`.workbench/spec-batches.json` (`src/main/spec-batches.ts`; `source` = the `docs/...md` paths in the prompt, else the batch
keeps a copy of the prompt). When every ticket of a batch is in Human Review as `completed` / `auto_merged`, Done or
archived (failed, stopped or errored tickets keep it waiting), the `state` / `merged` task hooks
(`ipc-handlers/spec-review-handlers.ts`) create and queue one **Spec review** ticket (`metadata.specReview`, depends on the
batch's tickets, so it starts once they are merged). Project setting `specReview` (default on) turns it off.
The review ticket runs as `ClaudeTaskRun.runSpecReview()`: a single `spec_review` step (no triage, plan, implement, validate or
commit; OMP `plan` role, Opus on Claude) with a `SpecReviewReport` schema (`shared/utils/spec-review.ts`). It is read-only: the
edit tools are removed (`--disallowedTools`, OMP gets read/grep/glob/bash), the prompt forbids changes, and afterwards the
worktree is reset if a commit or change turned up. It ends in Human Review (`completed`); autonomous auto-merge skips it and
Done cleans its worktree without asking. `applySpecReview()` then drops gaps without spec section and evidence, creates the
rest as next-round tickets (`round + 1`, queued, with their dependencies) while `round < maxReviewRounds` (default 2), else
the batch is `gaps_open`; no gaps means `complete`. `SpecReviewPanel` shows the report on the review card.

### Autonomous mode (per project)

Project settings `autonomous`, `autonomousTarget` (`integration` default | `main`), `autonomousBranch` (default
`workbench/auto`) and `autonomousPush` (default on), kept in `.workbench/settings.json`. Rules are pure in
`shared/utils/autonomous.ts`; git work is `main/autonomous/autonomous-git.ts` (merges and reverts run in a temporary
detached worktree, then the branch is moved by `merge --ff-only` where it is checked out, else `update-ref`); the glue is
`main/autonomous/autonomous-service.ts` and `ipc-handlers/autonomous-handlers.ts`.

- New tasks branch from the target (the integration branch is created from the base branch when first needed; local
  branches are preferred). A task that enters Human Review as `completed` with `reviewVerdict.status === 'passed'` (no
  verdict, a failed one or a stopped task never merge) is merged with one `--no-ff` commit after the target is pulled
  into the task branch (merge agent resolves conflicts; otherwise `metadata.autoMergeBlocked`, task stays in Human
  Review). The commit goes to `metadata.autoMerge = { sha, branch, at }`, the target is pushed, the machine enters
  `auto_merged` (Human Review, reason `auto_merged`), the queue runs and grooming applies structural changes.
- A task with an explicit base branch (`getExplicitBaseBranch()`: autonomous on, worktree, `metadata.baseBranchChosen`, and
  a branch that is neither the project default nor the integration branch) ignores the target: it is cut from that branch
  (`AgentManager.buildRunConfig`, a new branch is created first) and auto-merged into it (`runAutoMerge`: pulled into the
  task branch, `--no-ff`, pushed when `autonomousPush`, `autoMerge.branch` = that branch). Tasks without the flag (older
  ones, "Project default") follow the target as before. Resync (`takesInMerge`) matches such a task by its base branch only;
  split pieces, "Fix:" tasks and other follow-ups inherit `baseBranch`/`baseBranchChosen`. The "Merge into main" banner is
  only about the integration branch and does not include feature branches.
- The queue gate counts a dependency auto-merged into the dependent's target as satisfied (`isDependencySatisfied`). The
  target is the dependent's explicit branch, else the shared target; a dependency merged into a feature branch
  (`baseBranchChosen`) does not release dependents that follow the shared target, and a dependency merged into main does
  not release dependents on a feature branch (they wait for Done).
- Done from `auto_merged` only cleans up the worktree. Request changes creates a `Fix: <title>` task at the top of the
  Queue (the old worktree is behind the target). Revert (`git revert -m 1`) and "Merge into main" (board banner) also use
  temporary worktrees. Undo of automatic queue changes is in the Queue updates panel.

### Queue priority between projects

Project setting `priority` (`high | normal | low`, default normal, in `.workbench/settings.json`, Settings > Project > Tasks).
All projects share one local model server, so `blockingHigherPriorityProject()` (`shared/utils/project-priority.ts`, pure)
returns the first project with strictly higher priority that has runnable work: a task running (`isRunningStatus`:
`in_progress` or `ai_review`, `shared/utils/running-tasks.ts`, also what the parallel task limit counts in the queue,
`isAtParallelLimit` and the renderer's `isQueueAtCapacity`) or a queued task that could start (not archived, not on a
rate-limit hold, dependencies satisfied by `getUnmetDependencyIds`). Only automatic starts are gated: `TaskQueue.promote`
(every queue pass: status changes, autonomous runs, startup) and `resumeHeldTask` (rate-limit resume); a manual Start
(`TASK_START`), a resumed in-progress task and resync starts are not, and running tasks are never paused. The queue reports
holds (`onHoldChange`, IPC `TASK_QUEUE_HOLD`, plus `TASK_QUEUE_HOLDS_GET` once at start) into `queue-hold-store.ts`; cards
show "Waiting for <project>". A `state` task hook calls `taskQueue.requestLowerPriority()`, which re-runs held projects' queues after 2 s.

### Notifications (desktop and phone)

`main/notification-service.ts` shows Electron `Notification`s (English strings built in the main process, not i18n; text,
click routes and timing are pure in `shared/utils/notification-events.ts`) and pushes the same events to a phone through
Home Assistant (`main/phone-notifier.ts`, pure payload/routing in `shared/utils/phone-notify.ts`). Events come from task
hooks in `main/attention-notifier.ts` (started by `notification-handlers.ts`): `auto-merged` and `merged` (task merged, once
per task), `decision-needed` (emitted by `createFollowUpTickets`, batched per project over 2 s), `needs-attention`
(blocked auto-merge, failed startup resume) plus the `state` hook for tasks in `error` and the "all work done"
`QueueEmptyTracker` (queue / in_progress / ai_review empty for 5 s after being active in this session). Desktop switches:
`NotificationSettings` (`onTaskComplete`, `onTaskFailed`, `onReviewNeeded`, `onDecisionNeeded`, `onQueueEmpty`; needs
attention and errors use `onTaskFailed`); phone switches: `AppSettings.phoneNotifications.events`. The two channels are
independent, and the same kind for the same task is shown once per 30 s. A click sends `NOTIFICATION_OPEN` to the
renderer (`App.tsx` opens the task or the board). The Home Assistant token is stored with `safeStorage` in
`userData/phone-notify-token.bin` (`phone-token-store.ts`), never in settings.json, never logged, never sent to the
renderer. In `npm run dev` the app is "Electron" to macOS: allow it in System Settings > Notifications > Electron.

### MCP Connectors

Settings > Connectors (`settings.mcpConnectors`, `McpConnectorSettings`) holds the defaults: Context7, Electron and
Puppeteer, plus custom servers, which must pass a connection test before they can be switched on. New tasks copy the
enabled ids into `TaskMetadata.mcpConnectors` and can change them in the task dialog. When a task runs,
`buildMcpConfig()` (`src/main/claude-code/mcp-config.ts`) turns that task's ids into `--mcp-config` for its Claude Code
session, on top of the user's own Claude Code MCP configuration. Helpers live in `src/shared/utils/mcp-connectors.ts`.

### Graphify Memory Graph

`src/main/graphify.ts` detects the `graphify` CLI (PyPI package `graphifyy`; status, version and install on
Settings > Updates) and builds a project's graph with `graphify extract <project> --code-only --out
.workbench/knowledge` (Settings > Project > Knowledge index), writing `graphify-out/graph.json`, `GRAPH_REPORT.md` and an
`index.json` summary. The project's "Use Graphify" switch (Project page) is on while `.workbench/knowledge` exists
(`isGraphifyEnabled()`); switching it on builds the graph (the switch is disabled while a build from the app runs,
`memory-graph-store.ts`), switching it off stops a running build and removes the folder, which hides the Graph item. While it is on,
task runs and the Claude page (Insights) get `GRAPHIFY_OUT`, the graphify CLI on `PATH` and a prompt section about
graphify's search commands (Insights limits Bash to those commands). Installing Graphify also adds its `/graphify` skill to Claude Code (`graphify install` for
`~/.claude` and each Claude profile's config dir, after an install or update), and agent windows
get `GRAPHIFY_OUT` and an `--append-system-prompt` hint pointing `/graphify` at `.workbench/knowledge`.

### Electron MCP (testing the app from a task)

Run `npm run dev` and switch on Electron in Settings > Connectors (or in the task's connectors). Claude Code can
then drive the running app over the Chrome DevTools Protocol with `get_electron_window_info`, `take_screenshot`,
`send_command_to_electron`, and `read_electron_logs`.

## Frontend

**Stack:** Electron 40, React 19, TypeScript (strict), Claude Code CLI, Zustand 5, Tailwind CSS v4, Radix UI,
xterm.js 6, electron-vite 5 (Vite 7), Vitest 4 + React Testing Library + jsdom, Motion.

**Path aliases:** `@/*` → `src/renderer/*`, `@shared/*` → `src/shared/*`, `@preload/*` → `src/preload/*`.

**State (Zustand)** — Renderer stores live in `src/renderer/stores/` (`project-store.ts`, `task-store.ts`,
`terminal-store.ts`, `settings-store.ts`, `insights-store.ts`, `context-store.ts`, `kanban-settings-store.ts`,
`terminal-font-settings-store.ts`). Main-process stores: `src/main/project-store.ts`,
`src/main/terminal-session-store.ts`.

**Styling** — Tailwind CSS v4 via `@tailwindcss/postcss`; `clsx` + `tailwind-merge` through `cn()`; variants with
`class-variance-authority`. One color theme (**Default**, `src/shared/constants/themes.ts`) with light/dark variants
via CSS custom properties in `src/renderer/styles/globals.css`. Elements with a `hover:` (or focus/highlight) style get
the pointer cursor automatically from a base rule.

**Fonts** — Bundled in `src/renderer/assets/fonts/`: Anthropic Sans (UI), Dank Mono (terminals and agent windows,
loaded with the FontFace API before xterm measures), Anthropic Serif (sidebar "Workbench" title only) and Inter
(optional interface font). Settings > General > Appearance picks the interface and command line fonts.

**Settings UI (claude.ai style)** — The dialog (`settings/AppSettings.tsx`) has one menu: General, Accounts, Agents,
Project, Connectors, Developer, Updates (Project is the selected project's page: Project, Knowledge, Tasks, Branches).
The project's `useClaudeMd`, `maxBudgetUsd` (budget per task) and `claudeProfileId` (its Claude account;
unset = the account in use) are kept in the project's own `.workbench/settings.json` (`src/main/project-store.ts`). Build pages from `SettingsSection` +
`SettingsRows`/`SettingsRow`; controls are switches, `SegmentedControl`, borderless selects, or dropdown menus with
`SETTINGS_MENU_TRIGGER_CLASS` (no collapsible rows). UI copy conventions: sentence case, no em dashes, no trailing
period in setting descriptions, and no green check / red x status icons (state the status in text).

**IPC** — Handlers in `src/main/ipc-handlers/` (by domain), safe APIs exposed in `src/preload/`, renderer calls
`window.electronAPI.*`.

**Agent management** (`src/main/agent/`) — `agent-manager.ts` (starts, stops and restarts Claude Code task runs and
relays their events), `agent-state.ts` (profile/session assignment for account swapping).

**Claude profiles** (`src/main/claude-profile/`) — `credential-utils.ts` (OS keychain), `token-refresh.ts` (OAuth
refresh), `usage-monitor.ts` (usage and rate limits), `profile-scorer.ts` (profile selection). On every start,
`claude-code-detection.ts` finds Claude Code's own setups (`~/.claude`, `CLAUDE_CONFIG_DIR`, `~/.claude-*`: subscription
sign-in, cloud provider, API key or gateway, from managed settings, the dir's `settings.json` and the environment) and
lists them as accounts (`ClaudeProfile.detected`): usable and renamable, never removed. Claude Code's default `~/.claude`
runs without `CLAUDE_CONFIG_DIR`, keeps its sign-in in `~/.claude.json` and its plain keychain entry
(`config-dir-paths.ts`).

**Terminals** (`src/main/terminal/`) — `pty-daemon.ts` / `pty-manager.ts` (PTY processes), `terminal-lifecycle.ts`,
`cli-integration-handler.ts`. Renderer uses xterm.js 6 with WebGL, fit, web-links, and serialize addons.

## i18n

English is the only supported language. Translation files: `src/shared/i18n/locales/en/*.json`.

**Namespaces:** `common`, `navigation`, `settings`, `dialogs`, `tasks`, `taskReview`, `terminal`, `errors`,
`welcome`.

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation(['navigation', 'common']);

<span>{t('navigation:items.kanban')}</span>          // CORRECT
<span>Kanban</span>                                   // WRONG
<span>{t('errors:task.parseError', { error })}</span> // With interpolation
```

## Cross-Platform

Supports Windows, macOS, and Linux; CI runs tests on all three. Use `src/main/platform/`:

| Function                                  | Purpose                           |
|-------------------------------------------|-----------------------------------|
| `isWindows()` / `isMacOS()` / `isLinux()` | OS detection                      |
| `getPathDelimiter()`                      | `;` (Win) or `:` (Unix)           |
| `findExecutable(name)`                    | Cross-platform executable lookup  |
| `requiresShell(command)`                  | `.cmd/.bat` shell detection (Win) |
| `joinPaths(...parts)`                     | Platform-correct path joining     |

### Shell runtime (Windows: PWSH or WSL)

On Windows, Settings > General > Shell (`AppSettings.windowsShell`, `'pwsh'` by default, applied after a restart)
chooses where Workbench runs everything: natively with PowerShell agent windows (`pwsh.exe`, falling back to
Windows PowerShell 5.1), or inside WSL (the default distro). `src/main/platform/shell-runtime.ts`
(`initShellRuntime()` at startup, `whenShellRuntimeReady()`, `isWslRuntime()`, `getWslInfo()`,
`toRuntimePath()` / `toHostPath()`) holds the active runtime; `wsl-detect.ts` checks availability and probes the
distro once (user, home, login shell and PATH, mount root, networking, interop, tool paths). When WSL can't
start, the session runs natively and the Settings row says why. These modules are not re-exported from `platform/index.ts`.

- **Start tools through `runTool` / `spawnTool` / `killRuntimeProcess`** (`platform/runtime-exec.ts`) and git
  through `git()` (`utils/git-exec.ts`), never `execFile(getToolPath(...))` or a literal `'git'` spawn (an
  architecture test fails on those). In WSL mode they run `wsl.exe -d <distro> --cd <dir> --exec ...`, translate
  whole-argument Windows paths, and pass changed env vars through `WSLENV` (never PATH); in pwsh mode they behave
  as a plain spawn. `getToolPath()` and `getToolInfoAsync()` describe tools (Linux paths in WSL mode), they don't
  run them.
- **Stored paths stay Windows paths** (projects, worktrees, profile config dirs, the WSL Claude home as
  `\\wsl.localhost\<distro>\home\<user>`); translate only at process boundaries (args, cwd, env, prompt text,
  git output such as `worktree list --porcelain`).
- **Claude home:** use `getClaudeHome()` / `expandClaudeHome()` / `joinClaudeHome()` / `claudeProjectSlug()`
  (`platform/claude-home.ts`), not `os.homedir()`. WSL accounts live in the Linux home with file-only credentials
  and their own profile store (`claude-profiles.wsl.json`).
- **Agent windows** know their `shellKind` (`'cmd' | 'powershell' | 'posix'`); command builders in
  `terminal/cli-integration-handler.ts` and `shared/utils/shell-escape.ts` choose syntax from it, not from
  `isWindows()`. WSL windows type bash syntax (wrapped in `bash -c` when the login shell is fish).
- **WSL2 NAT networking** can't reach the app's `127.0.0.1`: Insights task tools go through a stdio bridge
  (`insights/task-tools-bridge.cjs`) run as a Windows process through interop, and the Live agent hook command has
  a WSL branch. Watchers poll `\\wsl.localhost` paths (`fs.watch` fails there).
- **Worktrees** use relative links only when both runtimes' git is 2.48 or newer; on a runtime switch,
  `worktree/runtime-switch.ts` repairs every project's worktrees in the background.

## Known Gotchas

**Electron path resolution** — Paths often differ between dev and packaged builds (`app.isPackaged`,
`process.resourcesPath`). In dev, `__dirname` is `out/main`; in production, bundled assets live under
`process.resourcesPath`. Verify both contexts.

<!-- workbench:project-memory:start -->
Preferences learned in past sessions: @.workbench/compeng/MEMORY.md
<!-- workbench:project-memory:end -->
