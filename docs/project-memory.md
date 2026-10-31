# Project memory: first slice

Workbench owns capture, retention and review. OMP and Claude Code receive bounded background
context while coding. This uses a local JSON ledger, not Mnemopi, a vector store, or a second chatbot.
Task state, approvals and completion remain in the authoritative task records.

## Use it

Enable **Self-improve** in **Settings → Project → Knowledge**. New task completions trigger a
bounded extraction of at most one durable decision or lesson, or a real conflict with accepted
guidance. Empty results are expected for routine work. Workbench supplies a compact task outcome, relevant committed
document excerpts and up to 30 current memories to one tool-free utility call. OMP uses its configured
`memory` model role (falling back through normal OMP defaults); Claude Code uses Haiku. The call has
no advisor, task mutation tools or transcript ingestion. Model-reported validation is labeled as such.

OMP text utilities replace the ambient coding system prompt with the supplied utility instruction,
disable project context files, rules and LSP, and remove all tool schemas from provider requests.
This includes ambient MCP tools: OMP's `--no-tools` flag alone disables only built-in tools.
The JSON-format repair call uses the same isolation. MCP servers may still be discovered at CLI
startup, but their tools and instructions are excluded from these utility requests. Coding sessions
keep their normal context and tools. Serialized extraction input is capped at 24,000 UTF-8 bytes,
including JSON escaping; existing-memory context is dropped first when space is needed. This is a
byte bound, not a tokenizer measurement or a guarantee for every model's context window.

Capture asks what a future worker would do differently: a specific situation, action or constraint,
and project-specific reason. Task recaps and generic lessons about the importance of documentation
do not qualify. Capture asks for plain language and the consequence for future work, rather than
unexplained acronyms or implementation trivia. A conservative English text filter rejects obvious
recap/lesson boilerplate and descriptions without an instruction or constraint; automatically extracted
procedures also need at least two listed steps. This is not a semantic quality or validation guarantee.
Existing memories are supplied only for deduplication and contradiction
checks, not as evidence to extract again. Identical task claims share the original record across
tasks/citations/categories without upgrading its verification. Titles still distinguish explicit scopes.
Old automatic proposals identical to an active
record are marked obsolete during review reassessment, preserving their history and the active record.

A decision or lesson can become active automatically only when it passes the guidance filter and its entire body is an exact,
self-contained quote from an allowed documentation file at the task's captured commit, that commit
is an ancestor of the configured merge target, and the same quote still exists in the target. Failed
runs are never automatically promoted. **Source-backed** means this citation check passed; it does
not mean Workbench observed tests or verified runtime behavior. Unmerged or unverifiable claims,
procedures and standing preferences stay with the task's capture journal unless they conflict with
accepted guidance. Unmerged citations remain in the same journal for reassessment after merge,
without another extraction call. They do not create a review obligation. A worker can also explicitly propose through
`propose_project_memory`; those proposals pass the same completion/merge gate.
Ordinary worker-tool findings are written to task-scoped `records/task-notes/` receipts instead
of the project ledger. A useful exact documentation citation or a real active conflict can still
create an unverified ledger proposal; a citation is checked after merge, never trusted from the
worker alone. Stable task/request keys, cross-process locking and atomic receipts preserve routing
across retries and interrupted publication. These task notes are not recalled or review notices.

Conflicts never silently replace an active record. Workbench detects same-title/category conflicts
and checks conflict IDs identified by extraction against current active records. This is bounded
assistance, not complete semantic contradiction detection. Disputed active records are marked in
future context packets. The board's persistent **Memory decisions** banner includes only conflicts,
replacements of active guidance, and proposals whose source is **User instruction**. Ordinary task suggestions
remain available under collapsed **Optional suggestions** in management. Desktop review notices
use the same decision predicate as the banner.
Grouped desktop alerts use the existing **Review Needed** notification switch; clicking opens the
project's memory review. Optional phone delivery uses the existing notification configuration, without
a phone deep link. Source-backed automatic saves stay quiet. Notification attempts are recorded once
per entry revision; disabled/failed notifications do not remove items from the inbox.

In **Project memory → Manage memories**, review sources and both sides of a conflict. **Keep existing
memory** removes the proposal. **Use new memory** checks the displayed revisions and atomically marks
the conflicting records obsolete while accepting the new claim. **Use in future tasks** confirms an
uncertain proposal manually; it does not verify tests or approve the source task. Pending proposals
are not recalled. Recorded evidence is visible without opening the source preview. **Dismiss proposal**
removes an unwanted suggestion. **Correct** keeps history and requires review again. Manual capture and
explicit replacements remain available. Lists are cached and refreshed on committed memory changes
or explicit **Refresh**. Source previews show current files/tasks; recorded citations remain preserved.

## Storage and correctness

- Canonical storage is `.workbench/compeng/records/project-memory.json`, with project UUID,
  revision history, proposal idempotency keys and notification receipts. Foreign project UUIDs fail.
- Writers lock, reread and atomically publish a synced temporary file. Expected revisions reject
  stale edits. Independent worker processes share the same lock. Abandoned locks expire after 30
  seconds. Temporary files are never interpreted as records.
- Extraction journals live under `records/captures/`, keyed by task and run generation. Results are
  persisted before publication, making retries/restarts idempotent. Merge reassessment reuses the
  result without another model call. Stale runs are discarded; extraction is capped at three
  attempts. Context-limit errors are recorded as terminal failures instead of repeating the unchanged
  request. Startup resumes unfinished journals, without ingesting the historical task backlog. An
  extraction-policy version change allows previously exhausted jobs without saved results to retry
  with the repaired setup; completed results are preserved.
- Removed claims are tombstoned against automatic rediscovery of the same body, even under a
  different category or title. Saved extraction jobs also pass the current quality filter before publication. Removal
  stops future recall; it does not erase history, old context receipts or agent sessions.
- The main project's canonical memory directory is used across temporary worktrees. No global
  recall or cross-project sharing is added. Disabling Self-improve stops new capture/promotion and
  mutations; records stay viewable. Existing legacy Markdown notes remain separately preserved.
- Recall uses deterministic lexical relevance, not embeddings. Only active ledger entries and
  relevant, explicitly unverified indexed legacy notes qualify. Symlinked legacy notes are excluded.
  The entire context packet is capped at 3,000 UTF-8 bytes and four memories: approximately 1,000
  tokens by bytes/3, not a tokenizer measurement. Other instructions and Claude's native memory are
  outside this budget. Long records may be labeled excerpts.
- Exact prepared packets are saved under the task's `memory-context/` directory before launch.
  **Memory context** shows what Workbench supplied, including sources and disputes. It establishes
  preparation, not worker use or improved outcomes. Remembered claims never grant tool permissions.
- Coding phases expose only proposal capture through a temporary, task-bound token. Workers cannot
  approve, edit or delete accepted entries. Planning/spec review do not get this mutation tool.
  OMP capture tools over WSL NAT are unsupported; completion extraction still uses the task outcome.

A full app restart is required after installing these main/preload handlers. Reloading a renderer
alone cannot register them. A mixed-version renderer displays a restart notice.

## Validation and next boundary

Checks exercise independent-process writers, interrupted publication, bounded recall, project
isolation, exact Git citation/ancestry checks, pre-merge proposals and post-merge retention, failed and
stale runs, extraction retry limits, tombstones, durable notification deduplication, conflict resolution,
real HTTP worker capture, generated OMP extension, and both coding backends' prompt receipts.

Before adding richer retrieval or another backend, compare memory-enabled and memory-disabled
workers on fixed previous failures. Measure repeated mistakes, corrective turns and task outcomes.
Persistence and retrieval alone do not establish a productivity benefit.

For a bounded, read-only baseline, run:

```sh
node scripts/memory-diagnostics.ts /path/to/project 50
```

The report counts prepared context by distinct task, context bytes, task-local capture candidates,
and recorded phase/review outcomes. Validation and review verdicts remain explicitly model-reported.
A missing receipt is unknown, never a memory-disabled control. Even an empty receipt proves only
that no context was prepared for that phase. Outcomes are not linked causally to the supplied
memories, so the report keeps `benefitNotEstablished: true`; compare fixed failures with explicit
on/off runs and observed corrective turns before claiming fewer repeated mistakes.

For the authorized 2026-10-30 cleanup, Anomaly Directorate's 93 remaining task proposals were
archived and six accepted recaps/stale claims retired, leaving ten active entries and no pending
decisions at that observation. The original 94-item banner had already fallen to 93 with no conflict
by the time of cleanup. Byte-for-byte ledger/index backups and per-entry cleanup receipts live in
that project's `records/maintenance/`. Original Markdown notes remain untouched; their old index
was replaced by a pointer to the curated ledger so unreviewed historical notes no longer compete
with accepted guidance. Archiving is not acceptance, deletion, test verification, or permission.

The quieter-capture change passed strict TypeScript, the full single-worker suite (310 files,
3,881 passed and one skipped), and the production build. Focused tests cover actual HTTP tool
capture, concurrent/restarted retries, interrupted receipt publication, citation/merge gates,
conflict notifications, optional review UI, prompt bounds and diagnostic evidence labels. This
does not qualify productivity benefit or activation in an already running main process. The normal
full-app restart loads the new capture hooks; active workers were not interrupted for activation.
