# Actionables friction follow up October 12 2026

Six remaining improvements would reduce avoidable coordination. Start with
schema-error recovery and explicitly authorized reopening: both have observed
agent workarounds, and neither requires relaxing ownership or acceptance rules.
The five improvements delivered under #969 are already implemented; this review
does not propose them again.

## Coverage and comparison

The unchanged [September baseline](actionables-friction-baseline-2026-09-22.md)
starts strictly after `2026-09-23T00:04:15.004Z`. This pass ends at the new review
request, `2026-10-12T19:17:46.702Z` inclusive, or 12:17:46 PM Arizona time.
The [earlier October review](actionables-friction-review-2026-10-12.md) ended at
`2026-10-12T16:56:54.000Z`. **The next incremental review starts strictly after
this pass's end timestamp.** Preserve both reports and the original baseline.

Screening active and archived local rollouts identified **106 user chats,
including 104 archived chats, plus 14 subagent chats** with named Actionables
tool use. The scan included later turns in older chats, joined resumed segments
by session metadata ID, excluded inherited fork history, and deduplicated call
IDs and mirrored records. The app's active listing and five archived listing
pages corroborated the local index; remote and cloud bodies are outside this
coverage.

There are 54 additional call blocks after the earlier review: 41 in
**“Find Actionables chat friction”** and 13 in **“Research Actionable #574”**.
No additional archived-chat invocation was found in that incremental interval.
Older archived incidents were screened again for gaps not covered by the prior
five findings. A composed block can contain loops or several calls, so these
are invocation-containing blocks, **not executed-request or error-rate totals**.
The [evidence manifest](actionables-friction-review-2026-10-12-follow-up.json)
contains the chat inventory and selected event locators without credentials or
conversation bodies.

Local Apps currently reports release `20261012-120840` running, and health reports
database `ok` and schema `current`. Its `mcp.ts` matches this checkout. The
[delivery record](actionables-friction-delivery-2026-10-12.md) identifies deployed
code `a119aee43c469bbb0f98ef69a60d13f967f6f606`; checkout HEAD is
`ce231f82a2e24c2972c2c166b1af03425a5a2b74`, which adds deployment documentation.
The release switched at about 19:10 UTC. Consequently, this window provides only
minutes of post-deployment observation and no ordinary post-deployment named
coordination calls. The findings below are remaining source gaps or adoption
issues, not measured regressions caused by that release.

## 1 Make malformed calls recover through the normal error contract

**Priority high. Repeated ordinary-work evidence, plus an isolated evaluation.**

Archived #591 work contains rejected calls with a string instead of an
`appendResearch` array, a lost claim credential, both read-authorization forms,
or an unsupported detail field. For example,
[September 30's update rejection](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-09-29T14-24-04-01a0ef0d-a854-7df0-a608-150d4b6efbfb.jsonl:5111)
and [October 4's read rejection](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-02T15-50-23-01a0fecf-c1a8-7a10-9c7a-6ba122594e97.jsonl:33485)
return raw MCP input-validation errors. Thirteen screened output blocks contain
actual schema rejections: nine in four user chats and four in subagent chats.
An additional matching block was merely quoting an old error in stored research
and was excluded. Some existing field messages already explain recovery well;
the argument mistakes themselves are agent errors.

The new [four-case coordination experiment](actionables-coordination-evaluation-2026-10-12.json)
adds a useful controlled example. Four malformed requests added `workItemId`
where it was not accepted, or supplied it instead of `id`. The evaluator recorded
them as `UNSTRUCTURED_ERROR`. All four cases eventually completed, but control
and narrow guidance each achieved only one of two strict passes. Narrow guidance
used 26 calls and 89,923 uncached input tokens versus control's 24 and 67,308.
This small experiment establishes no efficiency gain or causal ranking of the
guidance variants.

The installed SDK validates inputs before executing the handler. Consequently,
these errors bypass Actionables' [normal structured failure wrapper](../apps/api/src/mcp.ts:1546),
which supplies the domain error and recovery contract.

**Smallest improvement:** extend the existing bounded recovery contract to
input-validation failures, with exact invalid fields and a minimal corrected
call when the correction is unambiguous. Explain credential recovery without
echoing credentials. Keep strict schemas, scope checks and version checks.
Do not silently accept or discard a contradictory `workItemId`.

**Thinking removed:** identifying which error format arrived, rediscovering a
whole tool declaration, and guessing which arguments belong on this call.
Verify with the observed wrong-ID, extra-field and missing-credential cases;
each rejection should identify a safe next step before another mutation.

## 2 Reopen explicitly authorized terminal work through MCP

**Priority high. New ordinary-work evidence.**

In **“Research Actionable #574”**, the task was Done after isolated checks. At
18:45 UTC the user [requested additional local DEV acceptance](C:/Users/AustinScriver/.codex/sessions/2026/10/12/rollout-2026-10-12T09-53-23-01a13108-7f29-77e2-9f89-7cd5df775145.jsonl:583).
The agent inspected terminal history, opened Actionables in the browser,
selected the task, chose Ready, entered a reopening reason and confirmed it.
Only then could it [list, claim, reconcile and resume](C:/Users/AustinScriver/.codex/sessions/2026/10/12/rollout-2026-10-12T09-53-23-01a13108-7f29-77e2-9f89-7cd5df775145.jsonl:748)
through MCP.

That detour follows the current [workflow instruction](../resources/agent-integration/actionables-workflow/SKILL.md:166).
The dashboard already has an audited terminal-to-Ready transition with a required
reason, exact-version checks and [completed-ancestor reopening](../apps/api/src/repository.ts:2459).
Native unblocking, delivered earlier, handles a different lifecycle state.

**Smallest improvement:** expose this existing guarded reopen operation through
MCP for an explicitly named, authorized task and work item. Require its current
version and a meaningful reason, preserve the ancestor/dependency consequences,
and return the affected IDs and versions. Continue through normal claiming;
inspection alone must never reopen anything.

**Thinking removed:** switching to the dashboard solely to reproduce an
already-authorized state change, then translating its result back to MCP state.
Acceptance should replay this exact additional-DEV-check sequence without browser
navigation and reject stale, wrong-scope or unaudited reopening.

## 3 Reject new work in an archived scope before saving it

**Priority medium. Observed in isolated developer validation, not a user-data loss.**

The release browser run left a fixture worktree archived. Later tests created
Inbox records in it and could not find them in active lists. The
[diagnostic readback](C:/Users/AustinScriver/.codex/sessions/2026/09/22/rollout-2026-09-22T14-51-19-01a0cb1a-162d-7e41-9a8a-1dd75bf25ccc.jsonl:3641)
shows isolated fixture #93 with `directlyArchived: false` and inherited archive
state from its worktree. Six browser failures shared this setup problem. The
fixture now restores the worktree; that repair is already delivered.

A remaining API inconsistency made the mistake harder to diagnose:
[`POST /api/actionables`](../apps/api/src/app.ts:618) accepts ordinary creation
through [`validateScope`](../apps/api/src/repository.ts:524), which checks
existence and ownership but not archived state. The MCP creation path already
[rejects an archived resolved scope](../apps/api/src/agent-tasks.ts:1327).

**Smallest improvement:** apply equivalent archive checks at the ordinary
creation boundary, before allocating a task. Return the exact archived ancestor
and the restore-or-select-another-scope remedy. Preserve intentional historical
restore/import semantics and normal reading of archived tasks.

**Thinking removed:** tracing a successfully created but immediately hidden item
through scopes, archive inheritance and list filters. An isolated API check
should demonstrate rejection with no record created for each archived ancestor.

## 4 Expose the running build and contract identity

**Priority medium. Persistent client adoption issue, not missing server tools.**

The [September baseline](actionables-friction-baseline-2026-09-22.md) already
recorded stale definitions in an open chat. After today's release, the live server
advertised selected context fields and the new receipts, but this conversation's
advertised `get_task_context` declaration still lacked `fields`. The installed
workflow had updated successfully. Matching tool counts therefore did not prove
matching tool contracts.

The current [health response](../apps/api/src/app.ts:437) reports database/schema
health, and [MCP initialization](../apps/api/src/mcp.ts:1562) still identifies
server version `0.1.0`. Deployment verification required separate manager,
manifest, source/hash and tools-list comparisons to establish what was running.
Existing setup guidance handles endpoint changes, but these are same-endpoint
contract changes.

**Smallest improvement:** include a compact build identity and contract/workflow
fingerprints in the existing integration status and MCP metadata. Use the same
identity in deployment verification, with a clear refresh/reconnect instruction
when the advertised contract is older. Reuse the Local Apps release identity;
do not build a second updater.

**Thinking removed:** distinguishing old client definitions, old installed code
and current source manually. Test old/new contract identification at an unchanged
URL. Automatic invalidation of Codex's cached catalog depends on client support
and is not established by this audit.

## 5 Keep acceptance limitations visible in the completion view

**Priority medium. Completion-review usability; no false completion established.**

#973 completed its experiment with an Automated-test Partial result and a Passed
Review accepting the delivered experiment, including its negative efficiency
result. During #969's parent review, the completion view required four pages for
40 items. Its [structured validation entry for #973](C:/Users/AustinScriver/.codex/sessions/2026/09/22/rollout-2026-09-22T14-51-19-01a0cb1a-162d-7e41-9a8a-1dd75bf25ccc.jsonl:3773)
was the Passed Review. Its prose explicitly retained the Partial limitation;
the limitation was not lost, and this was a legitimate acceptance distinction.

However, [`completionView`](../apps/api/src/mcp.ts:1042) filters validation records
to `qualifiesForCompletion`. A reviewer must reconstruct relevant nonpassing
results from Resolution/Review prose or another detail read, and distinguish
“experiment delivered” from “every measured case passed.”

**Smallest improvement:** include a bounded view of recent Failed/Partial
validation alongside the qualifying acceptance record and any explicit
supersession. Preserve full paginated evidence. Do not automatically treat every
historical failure as an unresolved blocker or waive a current failure.

**Thinking removed:** cross-checking prose against omitted structured outcomes
to understand the actual acceptance boundary. A case with Partial automation
and a later Passed Review should expose both results without claiming the
automation passed or changing completion eligibility.

## 6 Make the browser test launcher honor one isolated run configuration

**Priority medium for development work. Repeatability and setup friction.**

This release required a manually started TEMP database/server pair and explicit
ports to obey the repository's isolation rules. An intermediate rerun against
reused data hit duplicate fixture titles; a fresh 15-case rerun passed. Those
are [recorded validation outcomes](actionables-friction-delivery-2026-10-12.md),
not application failures or proof of a fresh full-suite pass.

[`playwright.config.ts`](../playwright.config.ts:70) hardcodes the managed
server's database to `file:./data/actionables-e2e.db`, overriding the caller's
choice. [`start-e2e.mjs`](../scripts/start-e2e.mjs:5) resets a fixed repository
database path. Safe reuse is guarded, but the normal launcher does not offer
the same explicit disposable configuration used for the verified release run.

**Smallest improvement:** have the existing launcher honor and validate a single
explicit isolated database, dedicated ports and TEMP output configuration.
Fail before any reset if the target is the installed database, ambiguous or
already in use. Make fresh versus intentionally reused data explicit and verify
the reused server's identity. Keep the existing production-port protection.

**Thinking removed:** rebuilding launch commands, proving which database a reused
server actually serves, and diagnosing failures caused only by prior fixtures.
Check that the resolved target is honored, protected targets remain untouched,
and a fresh run cannot inherit a preceding run's fixture records.

## Boundaries and disposition

These are independent improvements; the priority order does not establish
blocking dependencies. No new Actionables were created or existing ones changed:
this review request supplied no new top-level work item, and #969 is completed.
No product implementation or runtime configuration changed during this pass.

The earlier lease, changed-context, retained-evidence and parent-acceptance
visibility fixes remain delivered. #574's pre-release full-context rereads are
another instance addressed by that existing context change. The evaluator's
approval configuration, scoring corrections and archive-fixture restoration
are also already fixed. Shell quoting/encoding errors, oversized mixed tool
output and browser-dialog handling are agent or environment issues; they are
not additional Actionables defects.

This pass verified source paths, historical call/results, the existing evaluator
record and live read-only runtime metadata. It did not mutate production records
to reproduce issues, rerun the application suites or measure human thinking time.
Expected savings mean fewer observed detours and recovery decisions, not a
claimed number of reasoning tokens or minutes saved.
