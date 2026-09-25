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

$evaluationDirectory = Join-Path $env:TEMP ('actionables-history-eval-' + [guid]::NewGuid())
$env:DATABASE_URL = 'file:' + (Join-Path $evaluationDirectory 'history.db').Replace('\', '/')
corepack pnpm exec tsx apps/api/tests/completed-history.eval.ts --run
```

`--check` runs the evidence scorer's positive and negative checks without
starting a database or model. `--run` requires an explicit absolute
`DATABASE_URL`, refuses the default live database and every existing database,
and creates only synthetic fixtures. A new directory is required for each run.
`--case ordinary` selects one case for diagnosing the harness; it is not the
full evaluation. The normal test suite does not run this file or spend tokens.

The runner reuses `buildCodexAssistantArguments` from
`apps/api/src/assistant-runner.ts`, including ephemeral execution,
`--ignore-user-config`, the requested read-only sandbox and structured output.
It adds JSONL event capture and a per-process MCP endpoint. It uses the existing
runner model (`gpt-5.6-terra`) unless `ACTIONABLES_ASSISTANT_MODEL` is explicitly
set. `ACTIONABLES_CODEX_PATH` selects an installed executable.
`ACTIONABLES_EVAL_CREDENTIAL_STORE` selects an existing credential store
(`auto` by default); no credential is copied or written by the harness.

The source API starts on an ephemeral loopback port through `buildApp`, without
the production entry point's user-configuration reconciliation. A second
loopback endpoint logs and forwards native MCP requests. It exposes the real
tool catalog, blocks mutation/active-discovery calls, and allows only completed
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

The score also reports tool-call counts, exact descriptor executions, repeated
successful calls, observed errors, elapsed time and CLI token usage. Descriptor
comparison ignores transport metadata. It does not infer an unobserved
reasoning process or equate every extra search with a mistake. Known blocked
attempts to read the installed workflow skill are reported separately from MCP
retrieval failures; executed shell/file/web actions or other tool errors fail.

## Artifacts and interpretation

The database directory retains `cases.json`, `metadata.json`, `results.json`
and per-case prompts, CLI arguments, answers, raw JSONL events, stderr and MCP
call/result logs. Metadata records source HEAD and SHA-256 hashes, generated
contract JavaScript, Node/Codex versions, model, scope, health and actual
endpoint addresses. The source identity is checked after every case. Tokens
are reported only when the CLI supplies usage; cached input is a subset of
input, not an additional amount.

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
