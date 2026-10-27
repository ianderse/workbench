# Project memory: first slice

Workbench owns capture, retention and review. OMP and Claude Code receive bounded background
context while coding. This uses a local JSON ledger, not Mnemopi, a vector store, or a second chatbot.
Task state, approvals and completion remain in the authoritative task records.

## Use it

Enable **Self-improve** in **Settings → Project → Knowledge**. New task completions trigger a
bounded extraction of at most two durable decisions, lessons, procedures or preferences. Empty
results are expected for routine work. Workbench supplies a compact task outcome, relevant committed
document excerpts and up to 30 current memories to one tool-free utility call. OMP uses its configured
`memory` model role (falling back through normal OMP defaults); Claude Code uses Haiku. The call has
no advisor, task mutation tools or transcript ingestion. Model-reported validation is labeled as such.

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
procedures and standing preferences remain proposals. A worker can also explicitly propose through
`propose_project_memory`; those proposals pass the same completion/merge gate.

Conflicts never silently replace an active record. Workbench detects same-title/category conflicts
and checks conflict IDs identified by extraction against current active records. This is bounded
assistance, not complete semantic contradiction detection. Disputed active records are marked in
future context packets. The board's persistent **Memory needs review** banner opens the inbox.
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
  attempts. Startup resumes unfinished journals, without ingesting the historical task backlog.
- Removed claims are tombstoned against automatic rediscovery of the same body, even under a
  different category or title. Saved extraction jobs also pass the current quality filter before publication. Removal
  stops future recall; it does not erase history, old context receipts or agent sessions.
- The main project's canonical memory directory is used across temporary worktrees. No global
  recall or cross-project sharing is added. Disabling Self-improve stops new capture/promotion and
  mutations; records stay viewable. Existing legacy Markdown notes remain separately preserved.
- Recall uses deterministic lexical relevance, not embeddings. Only active ledger entries and
  relevant, explicitly unverified indexed legacy notes qualify. Symlinked legacy notes are excluded.
  The entire context packet is capped at 4,500 UTF-8 bytes and eight memories: approximately 1,500
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
