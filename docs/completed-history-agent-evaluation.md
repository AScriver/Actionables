# Completed-history agent evaluation

This opt-in evaluation asks actual Codex agents to retrieve synthetic completed
Actionables through the application's MCP handlers. It measures evidence
retrieval and recovery, separately from the deterministic MCP integration tests.
It does not test deployment or change production behavior.

## Reproduce

Use the repository's installed dependencies and existing Codex login. No API
key, service, plugin, or credential setup is performed by the evaluation.

```powershell
corepack pnpm exec tsx apps/api/tests/completed-history.eval.ts --check
# Read-only replay; requires the 12 original local raw-event directories.
corepack pnpm exec tsx apps/api/tests/completed-history.eval.ts --check-baseline

# Deterministic proxy smoke, without starting a model (requires a new isolated DB).
$proxyDirectory = Join-Path $env:TEMP ('actionables-proxy-check-' + [guid]::NewGuid())
$env:DATABASE_URL = 'file:' + (Join-Path $proxyDirectory 'history.db').Replace('\', '/')
corepack pnpm exec tsx apps/api/tests/completed-history.eval.ts --check-proxy

$evaluationDirectory = Join-Path $env:TEMP ('actionables-history-eval-' + [guid]::NewGuid())
$env:DATABASE_URL = 'file:' + (Join-Path $evaluationDirectory 'history.db').Replace('\', '/')
corepack pnpm exec tsx apps/api/tests/completed-history.eval.ts --run
# Compare canonical full versus history-only guidance (default: history).
# Use a new isolated database for each run; keep questions/model/effort fixed.
$comparisonDirectory = Join-Path $env:TEMP ('actionables-history-full-' + [guid]::NewGuid())
$env:DATABASE_URL = 'file:' + (Join-Path $comparisonDirectory 'history.db').Replace('\', '/')
corepack pnpm exec tsx apps/api/tests/completed-history.eval.ts --run --guidance full
# Add --telemetry to --run to capture local OTLP logs in the new run directory.
```

`--check` runs the evidence scorer, protocol fingerprints, disposable local
configuration provenance, usage edge cases, history overlap and loopback telemetry receiver checks without
starting a database or model. `--run` requires an explicit absolute
`DATABASE_URL`, refuses the default live database and every existing database,
and creates only synthetic fixtures. A new directory is required for each run.
`--case ordinary` selects one case for diagnosing the harness; it is not the
full evaluation. The normal test suite does not run this file or spend tokens.

`--guidance full|history` changes only the selected canonical MCP resource in
the agent prompt, with the explicit `history_evaluation` server name. Both
variants retain the same catalog, retrieval handlers, questions and scorer.
`metadata.json` records the selected resource; protocol fingerprints show what
was actually read. Compare repeated variants in interleaved order using fresh
sessions and databases. Fresh sessions do not imply cold caches, and resource
bytes are not model token counts.

`--batch-history` adds an optional retrieval instruction while leaving the
question unchanged. It collects history descriptors across sequential search
pages, then requests independent records together where native batching is
supported. Per-record pagination and recovery stay sequential; every result's
error, identity, version and hash still apply. Omit the flag for the unchanged
control and use the same catalog, guidance, model and effort for both variants.

Each case's `historyConcurrency` reports peak distinct task IDs with overlapping
native history calls and the number of independent overlapping starts. It pairs
CLI start/completion events; malformed, duplicate, unpaired or incomplete streams
produce unknown counters. Same-record overlap is not independent batching. These
are tool-overlap observations, not exact model-request counts. Observed telemetry
completion counts also retain the auxiliary/prewarm and delivery limitations
described below.

`--variant full|restricted` selects the evaluation environment (default: full).
The restricted variant advertises only the four tools already permitted by the
proxy and passes `skills.include_instructions=false` for that Codex process.
It preserves every retained tool object, including output schemas, and calls the
same validated server handlers. The full-catalog control remains necessary:
filtering removes opportunities for unsafe discovery, so restricted runs do not
establish equivalent production safety coverage.

The [official configuration schema](https://learn.chatgpt.com/docs/config-schema.json)
defines the optional skills-instruction switch. A separate local
`codex debug prompt-input` probe verified that it removes the automatic skills
block while preserving all other prompt content (excluding generated message
IDs/timestamps and skill bookkeeping). This probe is not an exec request capture.
Both variants retain AGENTS instructions, managed policy, execution rules,
credential handling and the existing CODEX_HOME; no global files are edited.
The runner records requested overrides separately from observed configuration.

The runner reuses `buildCodexAssistantArguments` from
`apps/api/src/assistant-runner.ts`, including ephemeral execution,
`--ignore-user-config`, the requested read-only sandbox and structured output.
It adds JSONL event capture and a per-process MCP endpoint. It uses the existing
runner model (`gpt-5.6-terra`) unless `ACTIONABLES_ASSISTANT_MODEL` is explicitly
set. Reasoning is explicitly `medium`, matching the historical runtime observation;
`ACTIONABLES_EVAL_REASONING_EFFORT` can select another supported effort for a
separately identified run. This does not change production runner defaults.
`ACTIONABLES_CODEX_PATH` selects an installed executable.
`ACTIONABLES_EVAL_CREDENTIAL_STORE` selects an existing credential store
(`auto` by default); no credential is copied or written by the harness.

The source API starts on an ephemeral loopback port through `buildApp`, without
the production entry point's user-configuration reconciliation. A second
loopback endpoint logs and forwards native MCP requests. By default it exposes
the real tool catalog, blocks mutation/active-discovery calls, and allows only completed
search, history, known-task reads and explicit inspection. Agents receive
repository scope and research questions, not expected answers. No browser is
used. The live Actionables tracker is not an evaluation target.

## Cases and scoring

The entry point contains the fixed questions, synthetic records and expected
evidence. Each case runs in a fresh agent session.

| Case              | Required evidence or behavior                                                       |
| ----------------- | ----------------------------------------------------------------------------------- |
| Ordinary          | Cedar lease check, source and current-verification caveat                           |
| Different wording | Same Cedar evidence from a paraphrased question                                     |
| Multiple terms    | Invoice and idempotency evidence across fields; exclude the layout-only distractor  |
| Archives          | Directly archived record and child beneath an archived root; no restore             |
| Oversized         | Complete Marigold history, including the final retry cap after long background text |
| No matches        | Exhausted completed search; exclude matching active work                            |
| Stale version     | Reject continuation after a fixture version change; return only revised evidence    |
| Reopened          | Reject continuation after fixture reopening and discard the partial conclusion      |
| Archive recovery  | Correct an explicitly supplied old call's archive option without restoring anything |
| Search pagination | Exhaust one-result pages and return all three Orchard decisions                     |

The harness changes the isolated stale/reopened fixture immediately after its
first successful history page. Every agent call must preserve the full stored
task, claim, version, archive, activity, status-history, source, validation,
hierarchy, dependency and scope snapshot. Fault cases must end in exactly the
documented post-injection state. An expired sentinel claim detects unintended
claim cleanup. These fixture injections are not agent mutations.

Passing requires exact expected task IDs, all decisive facts and source
references, grounded evidence quotes, complete latest-version history, the
expected recovery error where applicable, and an explicit historical-evidence
caveat. Empty positive answers and unsupported facts fail. No-match answers
require an actual exhausted search. Repeating the same failed request or
continuing invalidated terminal history fails. Expected error responses are
part of recovery coverage, not product failures.

The scorer follows calls in order. Each accepted history starts at offset zero,
keeps its task/root/version/hash and archive option, and follows contiguous
offsets through a consistent final page. Returned counts and continuation
descriptors must agree. Only the retained chain supplies evidence. A version
conflict discards prior pages, requires fresh task metadata, and restarts at
zero, including when a reference changed the hash without changing the version.
The reopened case stops retrieval immediately after invalidation. Archive
recovery must correct the supplied first call before its successful history read.

Search continuations preserve scope, query, limit and archive inclusion. The
Orchard case must exhaust one-result pages and discover every expected ID;
no-match evidence must come from an empty, exhausted search started without a
cursor. A final page alone cannot establish coverage. Independent exploratory
searches, interleaved task reads and omitted documented defaults remain valid.
`paginationErrors` explains broken chains; `exhaustedSearch` checks the Orchard
case. The no-model scorer checks exercise valid traces and corrupted histories,
searches and recovery sequences.

The strengthened scorer was replayed against the 12 original raw traces: the
original run remains **8/10**, and each revised-question targeted rerun remains
**1/1**. This is an oracle replay, not a new agent run or a cost comparison.
Future comparisons must hold revised questions, fixtures, model and explicit
reasoning effort constant, repeat variants in interleaved order, and use fresh
sessions; fresh sessions do not establish cold caches.

The score also reports tool-call counts, exact descriptor executions, repeated
successful calls, observed errors, elapsed time and CLI token usage. Descriptor
comparison ignores transport metadata. It does not infer an unobserved
reasoning process or equate every extra search with a mistake. Known blocked
attempts to read the installed workflow skill are reported separately from MCP
retrieval failures; executed shell/file/web actions or other tool errors fail.

## History-only guidance comparison, September 27

Four sequential batches used full/history/full/history guidance, ten fresh
sessions each, with identical revised questions, fixture source, executable,
`gpt-5.6-terra` and explicit `medium` effort. Prompts differed only in the
selected resource URI. All **40/40** cases passed the strengthened scorer,
including archive inclusion, version reconciliation, reopened-history rejection
and complete search/history pagination. No forbidden skill-file reads,
non-MCP actions or unexpected tool errors occurred. Fixture state, observed
model/effort and local provenance checks passed; source and questions matched.

The canonical history-only text is **6,300 UTF-8 bytes**, versus **28,323** for
the current full workflow, a **77.8% reduction**. Serialized resource contents
are 6,407 versus 28,572 bytes per read. The full catalog remained identical.

| Batch | Guidance | Input tokens | Cached subset | Uncached input | Output | Elapsed ms | MCP tool calls |
| ----- | -------- | -----------: | ------------: | -------------: | -----: | ---------: | -------------: |
| 1     | Full     |    2,250,127 |     1,976,064 |        274,063 |  9,662 |    337,247 |             37 |
| 2     | History  |    1,843,887 |     1,597,952 |        245,935 |  8,596 |    300,651 |             36 |
| 3     | Full     |    2,206,946 |     1,971,200 |        235,746 |  9,318 |    317,746 |             36 |
| 4     | History  |    1,913,938 |     1,726,208 |        187,730 |  9,275 |    317,317 |             38 |

Combined input was 15.7% lower with history guidance; uncached input was 14.9%
lower. These are observations from two repetitions per variant, not guaranteed
savings or a causal estimate of resource size alone. Caches were not cold, call
counts varied, and batch 2's archive-recovery case executed its prescribed first
call without reading the resource. The other 39 sessions read exactly the
selected resource, confirmed by payload fingerprints. Full model context and
exact model-request attribution remain unavailable as described below.

Raw runs are retained locally under
`%TEMP%/actionables-614-guidance-4f89e262-8219-4302-bf60-45179d3a82f8/`, in
`comparison-1-full`, `comparison-2-history`, `comparison-3-full` and
`comparison-4-history`. An interrupted preliminary `1-full` run is excluded: one
agent guessed the wrong MCP server alias despite correct evidence retrieval.
Both comparison prompts explicitly named `history_evaluation` to fix that
ambiguity. The original **8/10 plus two targeted passes** and its stored report
remain unchanged and separate from these observations.

## Restricted-environment comparison, September 27

Four further batches used full/restricted/full/restricted environments, each
with the same ten revised questions, history-only guidance, source, executable,
`gpt-5.6-terra` and explicit `medium` effort. All **40/40** cases passed with no
forbidden skill reads, non-MCP actions or unexpected tool errors. Separate
full/restricted proxy smoke tests verified the exact advertised subset and
unchanged retained tool objects, including every output schema.

| Advertised component       | Full control | Restricted |
| -------------------------- | -----------: | ---------: |
| Tool count                 |           23 |          4 |
| Tool array, bytes          |      167,262 |     41,537 |
| Input-schema array, bytes  |       31,397 |      4,213 |
| Output-schema array, bytes |      117,159 |     33,059 |

The restricted catalog is 75.2% smaller. These overlapping transport components
must not be summed, and model-presented schemas remain unavailable.

| Batch | Environment | Input tokens | Cached subset | Uncached input | Output | Elapsed ms | MCP tool calls |
| ----- | ----------- | -----------: | ------------: | -------------: | -----: | ---------: | -------------: |
| 1     | Full        |    1,950,453 |     1,730,816 |        219,637 |  9,230 |    319,331 |             37 |
| 2     | Restricted  |    1,374,749 |     1,192,704 |        182,045 |  7,754 |    281,471 |             34 |
| 3     | Full        |    2,068,814 |     1,861,376 |        207,438 | 10,071 |    342,586 |             42 |
| 4     | Restricted  |    1,456,596 |     1,305,088 |        151,508 |  8,143 |    292,457 |             35 |

Combined reported input was 29.6% lower and uncached input 21.9% lower in the
restricted variant. Both catalog exposure and optional skills instructions
changed together; their individual contributions cannot be separated. Caches
were not cold, tool counts varied, and batch 3's archive-recovery case skipped
the guidance resource. The other 39 sessions read exactly the selected resource.
This is experimental retrieval evidence, not equivalent production safety
coverage or a guaranteed performance improvement.

Independent assertions verified identical prompts, questions and source;
arguments differing only in the skills override and generated paths/endpoints;
unchanged shared local provenance, credential/sandbox requests and fixture state
apart from deliberate faults; observed model/effort; catalog fingerprints; and
token arithmetic. Full model input remains unobserved. The original baseline
and the preceding guidance comparison are unchanged and separate.

Raw evidence is retained under
`%TEMP%/actionables-615-catalog-9426e8a7-18ba-4353-88b8-589fae76966a/`, in
`proxy-full`, `proxy-restricted`, `comparison-1-full`,
`comparison-2-restricted`, `comparison-3-full` and `comparison-4-restricted`.

## Independent-history batching comparison, September 27

Four sequential control/batch/control/batch runs kept the full catalog,
history-only guidance, revised questions, source, model and explicit medium
effort fixed. The batching prompt added 502 UTF-8 bytes. All **40/40** cases
passed, including complete pagination, archive recovery, stale-version restart
and terminal invalidation. No forbidden skill reads, non-MCP actions or
unexpected tool errors occurred. The observer produced complete overlap
measurements for every case; exact model-request counts remain unknown.

Both controls read the three Orchard histories sequentially; both batching runs
read them concurrently after the dependent search pages completed. That case
used 9/6/6/6 MCP calls and recorded 12/8/12/10 telemetry completions in run order.
The two required archive-recovery calls remained intact in all four runs.
Oversized history retained all three sequential pages; stale and reopened reads
retained their required error/recovery behavior. Both variants already batched
the two archived records, so this comparison establishes no batching improvement
for that case.

| Variant   | Input tokens | Cached input | Uncached input | Output tokens | MCP calls | Observed completions | Elapsed seconds |
| --------- | -----------: | -----------: | -------------: | ------------: | --------: | -------------------: | --------------: |
| Control 1 |    1,775,082 |    1,570,304 |        204,778 |         9,219 |        36 |                   81 |         301.308 |
| Batch 1   |    1,594,151 |    1,388,544 |        205,607 |         8,260 |        32 |                   78 |         294.495 |
| Control 2 |    1,942,531 |    1,722,112 |        220,419 |         8,640 |        36 |                   83 |         311.477 |
| Batch 2   |    1,622,384 |    1,450,496 |        171,888 |         9,198 |        33 |                   76 |         315.190 |

The combined batching runs used fewer input tokens and observed completions,
but the first pair's uncached input increased and the second pair took longer.
Native overlap demonstrates the supported batching behavior; these small runs
do not establish a general latency improvement, exact reduction in model rounds
or monetary savings. Completion logs can include auxiliary/prewarm responses,
caches were not controlled, and exploratory call choices still varied. The
batching instruction remains opt-in; questions, production guidance and retrieval
handlers are unchanged by this experiment.

The artifact audit verified identical source, questions, normalized command
arguments, catalog and resource fingerprints, observed model/effort and local
configuration provenance. Each run preserved its database except for the two
declared fixture injections. Across runs, all 31 semantic fixture rows matched;
fresh databases generated different timestamps and source/relationship row IDs,
so their whole-database hashes are not expected to match. The original 8/10 plus
two targeted passes remain separate and their evidence file is unchanged.

Raw evidence is retained under
`C:\Users\AUSTIN~1\AppData\Local\Temp\actionables-616-batching-191b1548-d046-4105-944d-2ef305dba557`,
in `comparison-1-control`, `comparison-2-batch`, `comparison-3-control` and
`comparison-4-batch`. Deterministic observer/scorer checks, the isolated proxy
smoke, TypeScript, formatting and whitespace checks passed. No dependency,
production runtime setting or deployment changed.

## Artifacts and interpretation

The database directory retains `cases.json`, `metadata.json`, `results.json`
and per-case prompts, CLI arguments, answers, raw JSONL events, stderr and MCP
call/result logs. Metadata records source HEAD and SHA-256 hashes, generated
contract JavaScript, Node/Codex versions, model, scope, health and actual
endpoint addresses. The source identity is checked after every case. Tokens
are reported only when the CLI supplies usage; cached input is a subset of
input, not an additional amount.

Each case also writes `protocol.jsonl`: one record per proxied request,
including initialization, notifications, catalog/resource reads and tool calls.
Records identify the case, request epoch, method, numeric RPC ID (string IDs are
fingerprinted), HTTP status, error flag and fixture-state check. Body fingerprints
measure exact request bytes and the UTF-8 response body sent by the proxy, excluding
HTTP headers/framing. Components ending in `Json` measure `JSON.stringify(value)`;
`initializationInstructionsText` measures unquoted UTF-8 text. Components overlap
their envelopes, so their sizes must not be added to body totals. Empty responses
and errors remain observable. This artifact stores only sizes/hashes, never raw
bodies, arguments, headers or bearer tokens. Hashes are not token counts.

`advertisedToolsJson`, `advertisedInputSchemasJson` and
`advertisedOutputSchemasJson` measure the server's MCP
catalog transport. The proxy cannot establish which schemas Codex presents to
the model; that attribution remains unavailable. `--check-proxy` uses the same
proxy and isolated fixture setup, recomputes fingerprints from the actual
exchanges, checks empty notifications/errors, runs the ordinary evidence scorer,
blocks a mutation and verifies unchanged fixture state. Its `proxy-check.json`
records the result; it is not an actual-agent evaluation or a new baseline.

Each actual-agent case writes `configuration.json`. Requested values include
the executable/version, exact arguments, model, explicit reasoning effort,
working directory, credential-store selector, MCP endpoint and proxy allowlist.
The bearer token itself is not recorded there. Input identities cover the prompt,
output schema, selected questions, fixture source/state and source manifest.
The fixture-state hash includes generated values and is an integrity check within
the run, not a stable identity across newly seeded databases.

Before/after local provenance records sizes and hashes of candidate instructions,
configuration/policy files and discovered `SKILL.md` files, with explicit missing
or unreadable states. It does not persist their contents or establish that they
were loaded. Symlink targets and plugin/cloud skill selection are unresolved;
the exact loaded instruction chain, managed/cloud policy, merged configuration,
builtin tools and model-presented schemas remain unavailable through this runner.
`--ignore-user-config` bypasses the main user config, not every instruction or
policy source. The inventory labels that config accordingly.

Observed configuration retains every distinct supported `x-codex-turn-metadata`
observation separately from requested values. For example, requested `read-only`
and observed `sandbox: none` must both remain visible. Observed tool calls and
protocol methods prove activity, not the complete set of loaded or model-visible
inputs. A missing observation is reported as unavailable; it is never filled
from a requested default. Local provenance changes are reported explicitly.

`accounting` reconciles paired CLI `turn.started`/`turn.completed` records into
input, cached input, uncached input and output totals. Cached input is part of
input; uncached input is their difference. Optional reasoning is part of output.
Missing, invalid, ambiguous duplicate or incomplete turns produce unavailable
totals with reasons. Equal counters from two separately paired turns are not
deduplicated. Raw `usage` and `events.jsonl` remain available for inspection.
`--check-baseline` compares each original raw usage array with the recorded
report, and prints the ten-case run and two targeted reruns separately.

With `--run --telemetry`, each process uses a dedicated ephemeral loopback
OTLP/HTTP JSON receiver. `otel.jsonl` retains receipt times and raw request-body
text, without HTTP headers. Raw prompt, trace and metrics export are disabled
with process arguments; the receiver also rejects the known bearer value,
prompt text and any unredacted `prompt` attribute. Raw logs can contain local
account metadata and synthetic tool output; the result summary retains only
measurement fields. No global settings or persistent collector are changed.
The receiver captures until process exit, drains for at most two seconds and
reports rejection, missing batches or abnormal termination as incomplete capture.

The 0.155.0 parser reports token-bearing response-completion observations,
their observed peak input, transport attempts and event counts. Timing-only
completion events are not usage. It accepts the runtime's string and numeric
counter encodings and string/boolean success flags. The legacy telemetry field
`tool_token_count` means reported total tokens, not tokens attributable to tools.
Duplicates, invalid subsets and overflowing sums prevent misleading totals.
Unknown event kinds remain in the raw evidence and event counts.

CLI completed items, MCP tool calls, HTTP/WebSocket observations and model
requests are distinct. Completion logs lack a reliable request join key and
complete-delivery marker, so exact model-request count, complete peak input,
overall retries and compactions remain `null` with reasons. HTTP attempt numbers
are zero-based observations; retry traces and compaction metrics are outside this
log collector. `observedTotalsMatchCli` and `observedMinusCli` expose differences
without substituting telemetry totals for CLI turn totals.

An isolated September 27 ordinary-case probe passed with unchanged fixture state:
11 batches contained nine token-bearing completions, totaling 269,075 input,
211,200 cached and 1,154 output tokens. CLI turn usage was 258,113 input,
211,200 cached and 1,154 output. The extra 10,962-input/zero-output observation
coincided with startup prewarm. The versioned runtime sends prewarm through the
same telemetry path but consumes it separately from turn accounting. This is a
supported explanation, not a proven join: no row is discarded based on position,
zero output or a matching difference. This probe is separate from the historical
evaluation and establishes no cost or retrieval improvement.

`durationMs` retains the historical spawn-through-result-processing boundary.
New fields separately report spawn-to-child-close, receiver drain and result
processing time. The probe measured 35,871 ms, 1 ms and 30 ms respectively
(35,902 ms overall). Exporter shutdown is included in process time; hashing,
logging and parsing add instrumentation work. These timings do not isolate that
overhead or support comparisons with uninstrumented runs.

This is a small, guided evaluation with synthetic evidence and one run per
question. Exact-quote scoring measures retrieval fidelity, not general prose
quality. It is not a statistical reliability estimate, a model comparison or
proof of a usability improvement. Global instructions, installed skills and
managed settings can remain despite `--ignore-user-config`; inspect the
recorded agent metadata and stderr when reproducing a result. Stored source
locators are synthetic and do not establish current code or deployment facts.

Official runner references: [JSONL events and usage](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable),
[HTTP MCP configuration](https://learn.chatgpt.com/docs/mcp),
and [credential stores](https://learn.chatgpt.com/docs/auth#credential-storage).
Configuration provenance follows the documented
[instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[skill locations](https://learn.chatgpt.com/docs/build-skills),
[configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic)
and [managed settings](https://learn.chatgpt.com/docs/enterprise/managed-configuration).
Usage attribution follows the documented
[telemetry exporter](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry)
and the versioned runtime's
[event fields](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/otel/src/events/session_telemetry.rs),
[prewarm path](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/core/src/client.rs),
[retry traces](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/codex-client/src/retry.rs)
and [compaction metrics](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/core/src/tasks/mod.rs).

## Recorded run

On September 25, 2026, the fixed ten-case run produced **8/10 strict passes**.
After reviewing the two failures, only their question wording changed; both
targeted reruns passed. Preserve those as separate observations, not a pooled
10/10 result under one unchanged prompt.

[The recorded evidence](completed-history-agent-evaluation-results.json)
contains both versions of the questions, expected evidence, actual answers,
call arguments, errors, continuation metadata, state hashes and usage. Full
tool-response text and raw CLI events remain in the recorded local artifact
directories. The report and compact evidence are repository files.

| Initial case      | Strict result                 | MCP calls | Input tokens | Cached input | Output tokens |
| ----------------- | ----------------------------- | --------: | -----------: | -----------: | ------------: |
| Ordinary          | Pass                          |         2 |      179,027 |      141,056 |           943 |
| Different wording | Pass                          |         3 |      152,240 |      120,576 |           976 |
| Multiple terms    | Pass                          |         2 |      123,531 |      103,168 |           812 |
| Archives          | Pass                          |         3 |      232,401 |      200,704 |         1,277 |
| Oversized         | Pass                          |         4 |      310,185 |      275,200 |         1,244 |
| No matches        | Pass                          |         2 |      210,993 |      172,544 |         1,008 |
| Stale version     | Pass                          |         5 |      189,527 |      171,008 |         1,231 |
| Reopened          | Diagnostic placement mismatch |         3 |      254,938 |      222,976 |         1,151 |
| Archive recovery  | Additional valid record       |         4 |      145,138 |      115,456 |           948 |
| Search pagination | Pass                          |         6 |      368,988 |      337,152 |         1,131 |

The initial run made 34 MCP tool calls, including 19 exact descriptor
executions, in 393.346 seconds of measured case time. CLI usage totaled
2,166,968 input tokens (1,859,840 cached) and 10,721 output tokens; the CLI also
reported 4,614 reasoning tokens. These are emitted usage counters, not cost
estimates or isolated estimates of the retrieval text's size.

The reopened agent correctly stopped on `TERMINAL_READ_INVALIDATED`, discarded
partial history and supplied no historical conclusion. It quoted the returned
diagnostic in `evidence`, where the oracle expected an empty array. Clarifying
that diagnostics belong in `limitations` passed in a fresh run: 3 calls,
178,369 input tokens (153,856 cached), 942 output tokens, 37.105 seconds.

The archive-recovery agent correctly handled `ARCHIVE_INCLUSION_REQUIRED` by
retrying with `includeArchived: true`. It then searched for Juniper and returned
a second valid record. The original phrase "Archived Juniper history is
explicitly in scope" and the general instruction to include all matching IDs
made that scope ambiguous. Restricting the question explicitly to task 104
passed in a fresh run: 2 calls, 99,216 input tokens (69,888 cached), 682 output
tokens, 26.925 seconds. This wording change addresses the extra calls observed
in this case; it is not a production-tool change.

All 12 measured runs preserved state, apart from the recorded harness version
change/reopening. There were no mutation attempts, repeated failed requests,
duplicate successful calls, reads after terminal invalidation, executed
shell/file/web actions or calls to another MCP server. The agent used the
explicit `terms` selector for invoice/idempotency, retained root ID 105 for
archived child 106, read all three long-history pages, and recovered from the
stale version by searching again and reading version 2 from offset zero.
Manual review confirmed the answers' extra file/thread references were returned
by the relevant history calls; the automated source score checks the required
golden source references.

The measured runtime was Node 22.19.0, Codex CLI 0.155.0 and
`gpt-5.6-terra`; observed request metadata reported medium reasoning. Commands
used Corepack's repository-pinned pnpm 11.9.0. Product source remained at
`57c32b7957b9fdda0ac821260759bfa31d0b7cfd`. The initial harness SHA-256 was
`890ff05265153b36b7648f298a5d664a9c51c1e44e8956bb36ec52d5e66224e8`;
the two-question revision was
`e07ce10162826413378ad9ee36960ae79897d42c661f388833151479c7de0a2a`.
Per-run manifests retain the other source hashes. No deployment is established.

The initial set had three blocked attempts to read the installed workflow
skill; the revised reopened case had one. These were denied before execution.
The MCP workflow resource was available, and runs continued successfully.
All sessions also encountered an existing malformed local agent-role warning.
These are recorded environment effects; neither was changed for this task.
Although the CLI requested `read-only`, its metadata also reported
`sandbox: none`; isolation claims here rest on the dedicated database,
read-only MCP proxy, observed calls and state checks, not an assumed OS sandbox.

Preflight failures are separate from the measured set: the runner-style
`--ignore-user-config` command required explicitly selecting the existing
`auto` credential store to avoid a 401, and an in-memory HTTP forwarding attempt
was replaced with actual sockets after an SDK `socket.destroySoon` failure.
A smoke run also exposed scorer handling of quote labels and transport
metadata, corrected before the fixed run. None establishes a production
retrieval defect.

Validation: the eight focused MCP history tests passed in an isolated
database; scorer assertions, the API test-project TypeScript check, formatting
and whitespace checks passed. The final report and recorded evidence were
reviewed against the answers and calls. The long-history fixture uses repeated
background text to exercise pagination; this does not establish performance
on arbitrary multi-topic research. Broader reliability and other models remain
unmeasured.
