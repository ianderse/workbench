# OMP prompt sizes

Investigation snapshot: 2026-10-27, Workbench `ce89547`, installed OMP `18.13.2`.

## Finding

Large individual coding requests occur in the local AD task sessions. Retained task
history is the leading source in the examined example. Workbench's fixed task
instructions are not a 200k-token template. Planning, implementation, validation
and repairs deliberately resume one task session; OMP rebuilds its current system
prompt rather than storing another full copy of it at every phase.

The scan covered 133 top-level files matching
`anomaly-directorate/.workbench/tasks/*/omp-sessions/*.jsonl`: 18,074 assistant
records with usage, including failures and aborted replies. It excluded child and
advisor transcripts, archived previous runs, and standalone reviewer calls. These
are recorded replies, not all provider requests: auxiliary calls can be absent.
Some sessions were running during the scan, so the figures describe that snapshot.

For 12,897 oMLX Qwen reply records, provider-reported prompt tokens
(`input + cacheRead + cacheWrite`, excluding output) had median 112,173, p95
211,092 and maximum 238,192. There were 1,627 records at or above 190,000.
Cached tokens are included in these context sizes; this is not a measurement of
uncached prefill work or billing.

The maximum came from task
`117-add-operative-identity-earned-chemistry-and-honors`, transcript
`2026-10-27T11-07-02-279Z_01a17d0a-cd07-72ad-bef9-696b600a7732.jsonl`:

- Line 7: first request, 17,222 prompt tokens.
- Line 556: ordinary coding reply (`stopReason: toolUse`), input 1,731,
  cache read 236,461, output 345: 238,192 total prompt tokens.
- Line 559: first compaction on that parent chain, reporting 238,537 tokens before
  and 52,524 after. The before count includes the preceding reply's output.

The walked parent chain contained 554 entries including the maximum request's
reply, with no prior compaction. Stored pre-request message content was:

| Role | Messages | Characters |
| --- | ---: | ---: |
| User | 2 | 9,211 |
| Assistant | 168 | 721,922 |
| Tool result | 186 | 457,760 |
| Developer | 2 | 4,330 |

These are journal-content sizes, not a reconstruction of the serialized request.
Stored thinking, tool arguments, pruning, extensions and provider transforms can
change what is replayed. Read results contributed 273,263 UTF-8 bytes and grep
results 147,448. Individual examples include a 25,702-byte heading search (line
27), a 24,769-byte `operations/types.ts` read (line 37), and a 15,490-byte
`DESIGN_DECISIONS.md` heading search (line 226). This does not demonstrate that
the whole historical documentation archive was injected.

The original parallel-task list had 20 eligible task rows totaling 6,171 characters
before header/footer: 14 queued, three AI review, two in progress, one human
review; only three listed file changes. Its uncapped growth was a real issue,
but much smaller than accumulated history in this example. The raw changelog
was 1,042,452 bytes across 2,098 lines, making whole-file reread guidance costly.

## Bounds and diagnostics

- The parallel-task prompt now has a 6,000-character total budget, including its
  instructions and omission notice. Known overlaps and active tasks come first.
- `list_parallel_tasks` returns a bounded, paginated result with file/task filters;
  callers can look up an exact repo-relative file instead of retrieving all tasks.
- OMP task prompts use the tool when available and otherwise ask for scoped,
  bounded changelog searches. General task guidance asks for focused file ranges
  and concise command output.
- Main-process log entries prefixed `[OMP prompt]` record UTF-8 sizes, never prompt,
  tool-result, attachment or authorization bodies. Launch entries identify the
  phase/job, attempt, print/RPC transport, resume state, new instruction, appended
  instructions and named Workbench sections. JSON repair launches are separate.
- Reply entries preserve provider-reported input, output, cache-read and
  cache-write counts separately. Compaction boundary events are separate from
  coding replies. Existing usage-ledger totals remain cumulative across replies.

Launch diagnostics explicitly cover only Workbench's contribution. They do not
measure OMP's final system prompt, loaded tools, retained history, extension
transforms or auxiliary compaction/advisor requests that emit no assistant usage.
Component byte counts exclude inter-section separators; the aggregate append
size includes them. No character-to-token conversion is claimed.

## Compaction boundary

No compaction override was found in the inspected global or AD/task117 project
configuration. For the configured 262,144-token window, OMP 18.13.2's default
reserve is `max(floor(window * 0.15), 16384) = 39321`, giving a trigger of 222,823.
Speculative summarization starts around 194,970; recent-history retention defaults
to 20,000 tokens. Large coding contexts are therefore consistent with the defaults,
and their size alone does not identify a compaction-model request. See the
[versioned compaction documentation](https://github.com/can1357/oh-my-pi/blob/v18.13.2/docs/compaction.md)
and [threshold implementation](https://github.com/can1357/oh-my-pi/blob/v18.13.2/packages/agent/src/compaction/compaction.ts).

This change leaves compaction settings and existing sessions untouched. The next
experiment is a task-scoped lower working threshold, comparing completion quality,
repeated reads, elapsed time and cache-inclusive per-request size. A global setting
would also affect other OMP clients and utility calls; it is not a Workbench-only
control. Settings can be layered with a per-process CLI overlay, as described in
the [versioned settings documentation](https://github.com/can1357/oh-my-pi/blob/v18.13.2/docs/settings.md).
The bounds and logs do not yet establish reduced peak context or equal task quality
in a completed live implementation run.
