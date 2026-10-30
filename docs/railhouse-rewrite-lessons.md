# Workbench operational lessons for the Railhouse rewrite

Recorded 2026-10-28. Keep this handoff alongside the implementation so operational safeguards do
not disappear when the orchestration architecture changes. The canonical independent behavior and
qualification checklist lives in Railhouse's
[operational safeguards](https://github.com/ianderse/railhouse/blob/main/docs/operational-safeguards.md).
Railhouse must implement independently: do not copy, port, import, or mechanically translate
Workbench source, tests, configuration, assets, or persistence formats. This document describes
Workbench evidence and decisions; it does not establish Railhouse runtime support.

## Pricing and usage

The usage ledger already identifies models and token categories. Cost should be a real per-model
calculation using input, output, cached input, and cache creation rates, rather than applying one
Sonnet rate to every model. Preserve provider-reported cost and calculated cost separately.
Configured local-model comparison rates take precedence. When a local model has no price entry,
the owner's requested savings comparison uses a labeled Sonnet fallback. This is avoided cloud
value, not measured electricity/hardware cost or an actual cloud charge.

Unknown/missing data needs a coverage state. A partial or unavailable total is not zero. Validate
persisted summaries and IPC results at runtime: an older cached object missing cost fields caused
`formatCostUsd(undefined)` to crash the usage page despite its static type. A cache schema version
alone does not protect against malformed or mixed-version payloads.

## Approval loops

A recorded human decision must reach every phase and independent reviewer with its scope,
requirement/gate, revision, actor, and outcome intact. Otherwise a reviewer can repeatedly return
already approved work to Human Review under different wording. Submitted artifacts are not human
acceptance. Rejections, waivers, deferrals, and approvals must remain distinct; scoped approval
cannot bypass unrelated failures or genuine defects. Keep acceptance authoritative outside model
messages and memory.

## Why long tasks were slow

Investigation found both model request overhead and legitimate long commands. One sampled task
had roughly 881 logs and 334 assistant requests, with a median request duration near 51 seconds
and about 5.5 hours summed request wall time; ordinary tools accounted for roughly 19 minutes.
These are one-run diagnostic observations, not general benchmarks. Request wall time includes
queue/prefill/decode/internal retries, excludes separate foreground tools/advisor execution, and
parallel durations can overlap. It is not compute time.

The sampled LAN oMLX endpoint allowed six generating requests while another six waited; decode
was roughly 14–22 tokens/second. Saved Workbench limits allowed eight tasks with four subagents
apiece. Multiplying local task slots can overload a remote endpoint without host memory pressure.
Inspect the serving process and actual queue. A local `~/.omlx` file was not the LAN server's
effective configuration. No live capacity settings were changed by this investigation.

Contexts around 90–100k tokens and repeated compacted history remained material. Restarting the
application loads code but does not shrink a resumed native session. Inspect per-reply input,
cache reads/writes, and compaction separately from Workbench prompt bytes. A provider retry burst
of about 225 seconds was real but did not explain eight hours of work. A separate native render
ran for about 55.8 minutes and produced 2,160 PNGs: elapsed time alone is not a safe stall signal.
A suspected planning-only routing bug was not established; do not preserve it as a fact.

## Throughput changes and their boundaries

### Phase effort and edit scope (2026-10-29)

A subsequent review of larger Anomaly and Railhouse tickets found initial planning took about
3–8 minutes, while repeated full-file generation, context overhead, and integration repair
accounted for substantial later work. Independent review found real correctness defects and
remains required. Reasoning-token shares and elapsed durations are not wasted-time measurements.
See Railhouse's [dated evidence and independent follow-through](https://github.com/ianderse/railhouse/blob/main/docs/research/2026-10-29-execution-efficiency.md).

Workbench now selects effort by phase when triage is automatic. Architectural planning, design,
and spec review retain their depth; large implementation (including continued work during sync),
review revisions, merge repair, and validation that must review or repair major findings cap
automatic effort at high. Smaller implementation, check execution after a clean independent
review, and ordinary sync cap it at medium. Low effort is not raised for those execution phases.
Explicit task effort pins and fixed/fallback settings are preserved. Fresh independent diff review retains its own
high-effort policy. Missing or failed independent review never selects the lighter check-only policy.

Task prompts prefer targeted edits over regenerating large existing files and recover completed
work from the saved plan/diff after interruption or compaction. Initial breakdowns and spec-gap
follow-ups identify shared foundations as real prerequisites before parallel consumers, with
justified ownership boundaries. This is planning guidance, not exclusive file locking or a
change to queue capacity; existing queued tickets are not rewritten. Required checks, merge-loss
checks, recovery safeguards, and human decisions remain authoritative.

The phase policy is enforced in the runner; edit/decomposition guidance still depends on model
adherence. Source checks do not establish faster live delivery. Load the new build for later runs
without interrupting active tasks, then compare useful completions and review defects alongside
latency, retries, and output volume.

Validation: strict TypeScript, all 306 test files (3,778 passed, one skipped), and the production
build passed. Regression checks cover effective phase arguments on both transports, pins/fixed
settings, unavailable or actionable independent reviews, and continued implementation during sync.
No provider productivity gain or existing-worker activation is claimed.

### Existing batching and recovery controls

The approved implementation order is batching → advisor checkpoints → preserved fresh context →
progress recovery. Keep these as separate mechanisms with explicit settings and durable evidence.

- **Batch independent work.** Supply a bounded phase-start Git/change/check brief. Encourage
  independent reads/searches/checks in one turn; keep dependent mutations sequential. Failed Git
  reads are unavailable observations, never a clean-repository claim. Suggested checks are not
  reported as executed tests.
- **Schedule task advice explicitly.** Task advisor choices are Continuous, Phase boundaries
  (default), and Off. Normal interactive advisor behavior retains its own configuration. Boundary
  advice after planning supplements the existing fresh independent validation judge; it requires
  an authorized configured model and respects provider holds. Journal pending/completed/failed
  attempts, fingerprint full inputs/model/effort/decisions/repository content, and validate cached
  reports. Failed or malformed advice is not a passing checkpoint. Failed inherited configuration
  refresh cannot retain positive permission to spend.
- **Continue with fresh context.** The default boundary is before validation; a manual action is
  available for resumable paused/failed unfinished tasks. Keep the same worktree, branch, dirty
  files, original transcripts, reviews, costs, and decisions. Use an immutable bounded handoff
  and durable session epochs; establish the actual replacement session ID before sending its
  prompt. Preserve attachment delivery across transports. If safe automatic preservation is
  unavailable, retain the original session with a warning. An explicit fresh-context request
  must fail clearly rather than silently resume old context. This is separate from Start over.
- **Detect unchanged completed work.** Evaluate repository/check/finding evidence only at safe
  completed phase boundaries. Ignore active commands, pending async work, provider failures,
  holds, and log/token volume. Persist evaluation/recovery identity. Bound escalation to one
  preserved fresh-context recovery and one eligible authorized configured fallback, then a clear
  stalled outcome. Respect exact model pins and cooldowns. This is not a live mid-command timer.

These defaults take effect in new or resumed runs after the main process loads the new build.
Existing processes can retain old prompts, task configuration, and model metadata. Source, tests, commit/push,
build, process restart, and observed live behavior are separate claims. Do not stop user-owned
work merely to force activation or to demonstrate recovery.

## Safeguards that must survive the rewrite

Keep Resume, fresh continuation, and Start over distinct. Before destructive cleanup, require an
externally preserved, verified, independently restorable receipt with actual restore proof. A
context handoff alone does not establish a backup guarantee. Preserve raw captures/transcripts
and write derived evidence separately. Missing native sessions must never become implicit reset.

Persist operation/session identity before external effects; reconcile lost acknowledgments,
crashes, and actual process/Git state before retry. Generation fencing cannot prove that an old
writer stopped. Duplicate browser/scheduler commands must share durable idempotency and ownership
rules. Keep recovery limits, costs, human decisions, and completed phases across restart.

Do not invent fallback routes or turn a model name into permission to use paid inference. Pins,
configured fallbacks, capability checks, and credential/provider holds are separate facts. All
Workbench AI calls stay behind its CLI backend layer; Railhouse needs its own neutral adapter
contracts and real installed-backend qualification.

Measure completed useful tickets, request/queue/tool time, correctness, and cost together. Keep
nested provider capacity visible. Batch reads and bounded context address request overhead;
provider admission control is still a separate capacity concern, not a claimed result of these
four changes. No broad concurrency retuning was performed here.

## Other adapter and integration lessons

OMP's `--no-tools` flag disables built-ins but does not alone remove ambient MCP payloads. Small
text utilities need isolated instructions, no ambient context/rules/LSP, provider tool-schema
stripping, and an execution guard; normal coding workers retain the tools their task requires.
Verify the actual provider request rather than trusting the command label.

Native turn end is not necessarily job completion. OMP RPC can end a turn while an asynchronous
command remains pending; wait for settled state and retain ownership so the phase cannot finish
or rotate context early. Print-mode execution requires its own foreground-work constraint.

Model metadata used for routing can disagree with the endpoint's actual image capability. Verify
both, and remember existing workers may retain the old registry. Backend availability alone also
does not enable automatic merge: effective project autonomy, target/push policy, passed review,
actual Git state, and serialized integration all matter. Preserve uncertain merge/push outcomes
for reconciliation instead of rerunning them blindly.

## Progress entry points and document growth

Use root PROGRESS.md as a concise authored status/document map, with small standing instructions
and task-relevant authoritative links. The full engineering reference is preserved behind a link;
root CLAUDE.md no longer repeats it. Historical documents remain available on demand, not default
startup reading. Agents must still read every applicable requirement and run required checks.

Workbench supplies a separate deterministic live projection from recorded tasks and observed Git
state, capped at 4,800 UTF-8 bytes, without reading the documentation archive or making a model
call. The host refreshes it on task launch, relevant state changes, merge, and integration promotion.
This live projection writes only an ignored, managed state file. Separately, after each spec-review
ticket the host publishes a bounded latest-review block to canonical root PROGRESS.md on the reviewed
local base branch, with a documentation-only commit before review completion. Authored text outside
the block and unrelated work are preserved. [Review publication](review-progress.md) describes retry,
size and revision provenance. Keep refresh time out of otherwise unchanged advice-cache inputs. Do not clone raw logs,
full task descriptions, or entire histories just to build a short summary. Failure to persist does
not fail successful integration or withhold the bounded launch context. A failed canonical review
publication does keep that review unfinished; Resume retries the saved report without another model call.

Parallel workers and read-only reviewers do not maintain shared progress. The integration owner
replaces stale authored status rather than appending a diary. Board status, reported checks,
integration target/revision, pushed state, and explicit acceptance must stay distinct. Railhouse's
RH-002 and safeguards record the independent planned selection, provenance, refresh, and delivery
contract. Source/build validation alone does not establish reduced model context or productivity.

## Delivery and ongoing evidence

The corresponding implementation and focused tests live with the task runner, handoff/checkpoint/
progress helpers, agent backend transport, and project-scoped task IPC. Preserve failure tests
for malformed caches, crash windows, dirty/untracked content, repeated commands, inherited advice
disablement, and configured-route limits. Real Git/filesystem tests demonstrate those local
boundaries; injected RPC events do not certify a live provider's full recovery behavior.

A read-only installed OMP 18.13.2 probe used `--mode rpc --no-ui --no-title` with a disposable
session directory, disabled tools/extensions/skills/context/rules/LSP, and sent only `get_state`.
It returned a nonempty native session ID, `isStreaming: false`, and `hasPendingAsyncWork: false`;
no model prompt was submitted. This verifies that installed handshake boundary, not live provider
execution or complete crash recovery. The probe's owned process and temporary directory were cleaned up.

Railhouse's handoff maps each requirement to its existing owner slice and required real HTTP,
database, Git, native-process, and backend qualification evidence. Its foundation currently has
no execution runtime; the checklist must remain planned until independently implemented and
qualified. A merged ticket or passing test is not explicit spec acceptance.
