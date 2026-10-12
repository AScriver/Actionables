# Actionables friction review — October 12, 2026

The strongest remaining improvements are predictable claim renewal, smaller
context readbacks, and evidence storage that does not repeatedly hit hidden
aggregate limits. Tool discovery and parent acceptance also still require
avoidable coordination. These findings describe observed work and the current
implementation; they are not estimates of reasoning tokens saved.

## Review boundary and coverage

- Start, exclusive: `2026-09-23T00:04:15.004Z`, from the unchanged
  [September baseline](C:/Code/Actionables/docs/actionables-friction-baseline-2026-09-22.md).
- End, inclusive: `2026-10-12T16:56:54.000Z` — October 12, 9:56:54 AM Arizona.
- **Next incremental review starts strictly after this end timestamp.**
  Include new turns in older chats and archived chats. Preserve both reports.
- Searched local `sessions` and `archived_sessions`, resolving titles/archive
  state against the read-only Codex index and checking the app's active and
  archived chat listings. Filtered individual event timestamps.
- Screened **980 candidate rollout files**. Found named Actionables tool use
  in **105 distinct user chats: 104 archived and one active**, plus **14
  subagent chats**, all archived. Resumed file segments were joined by the
  session metadata's `id`; its `session_id` can identify a subagent's parent
  and must not be used to merge agents into that parent. Forked prehistory was
  excluded, and mirrored records/call IDs were deduplicated.
- Of the 105 user chats, 18 have an Actionables workspace and 87 have other
  workspaces. Those are workspace counts, not perfect workflow classifications;
  mixed chats can contain both product work and Actionables maintenance.
  Selected maintenance/evaluation evidence is identified below.
- The scan found 2,400 tool-call blocks containing named Actionables invocation
  expressions in user chats and 813 in subagent chats. A block may contain a
  loop, conditional, several calls, or an unexecuted branch. These are **not
  executed MCP request counts** and are not an error-rate denominator.
- [Evidence index and chat inventory](C:/Code/Actionables/docs/actionables-friction-review-2026-10-12.json)
  preserve counts, selected event locators, and the identified chats without
  copying claim credentials or full conversation bodies.

## Current implementation checked

Source HEAD: `086dda5` (`fix(sidebar): reveal project menus on hover`). Local
Apps reports release `20261006-133516` running; API health reports `ok`, database
`ok`, and schema `current`. Installed copies of `agent-tasks.ts`, `mcp.ts`, the
contracts, and the bundled workflow match this checkout by SHA-256.

Live MCP initialization advertises 23 tools, as does this chat. Its initialization
instructions contain 1,219 UTF-16 characters; tool descriptions total 13,177,
with a longest description of 1,036. The September figures were 1,067 / 12,097 / 981. These exclude schemas and client wrappers. This chat's 23 exposed tool
descriptions, including generated declarations/wrappers, total 97,714 characters;
that is a different measurement and is not a token count.

The current saved claim duration is 30 minutes, with a 10-minute warning window.
No task was claimed, edited, or created during this audit. No explicit
`workItemId` was supplied for tracking this new review.

## Prioritized improvements

### 1. Preserve a longer claim when ordinary writes renew it

**Priority: high. Classification: remaining contract gap, demonstrated in a long
workflow.**

In **“Resume research for task #591”** on October 3–5, the root chat received
**14 `CLAIM_EXPIRED` results**. Associated subagent chats received another 12;
these are concentrated in this large workflow, not 26 unrelated incidents.
After one failed renewal, the agent listed available tasks, inspected missing
IDs, reclaimed its tasks with `leaseMinutes: 120`, and rebuilt their complete
contexts. See the [failure and recovery](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-02T15-50-23-01a0fecf-c1a8-7a10-9c7a-6ba122594e97.jsonl:2379).

Current code gives an explicit duration to the initial claim, but
[`renewClaimAfterMutation`](C:/Code/Actionables/apps/api/src/agent-tasks.ts:687)
sets expiry to `now + saved default` after ordinary writes. It can therefore
shorten a previously requested 120-minute claim to 30 minutes. Omitted-duration
explicit renewal also uses the saved default. Common
[`update_task` receipts](C:/Code/Actionables/apps/api/src/mcp.ts:1933) omit the
resulting expiry even though they renew the claim. The existing tests exercise
saved defaults, but do not cover preserving a longer existing deadline through
an ordinary mutation.

**Smallest improvement:** automatic renewal must never move expiry backward;
return `leaseExpiresAt` consistently from every mutation that renews a claim.
Make the effective duration explicit so callers can schedule one renewal from
the returned deadline. Explicit user-requested duration changes can retain
their current semantics.

**Thinking removed:** guessing lease lifetime after updates, discovering expiry
through a failed save/read, and repeating list → inspect → claim → context.
Keep finite leases, ownership checks, and state reconciliation after actual
expiry. The logs do not prove that shortening caused every recorded expiry.

**Acceptance:** claim for 120 minutes with a 30-minute default, update after five
minutes, and verify expiry has not moved earlier and is present in the receipt.
Exercise the long-work resume sequence without weakening claim ownership.

### 2. Read back changed fields without rereading the whole task

**Priority: high. Classification: recurring gap after baseline #559.**

In **“Research Actionable #961”**, October 6, the agent fetched the full task
context, changed its design notes, and then fetched **five context pages** to
verify that one update. The readback included the full task with 29 file
references, 14 research entries, and 13 sources. It wrote custom code to gather
pages, retain the hash, reconstruct field arrays, and compare submitted values.
The exact five-page sequence is visible in the
[readback result](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-06T11-49-17-01a1128c-7014-7a43-95cb-602ff68d5240.jsonl:489).

The same pattern appears in **“Research Actionable #591”** on October 2:
after appending evidence, the agent reread all context and computed a client-side
set difference against the preceding snapshot. In **“Research task #598”**, a
[combined context output was truncated](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-07T14-44-46-01a11853-7a99-7381-89c7-55279ecce829.jsonl:218).

The current [`getTaskContextSchema`](C:/Code/Actionables/apps/api/src/mcp.ts:263)
supports ID, claim, version, offset, and hash, but no field selection or change
cursor. Native chunks already solve the old JSON-fragment problem. They still
require callers to paginate the entire task for narrow readbacks. Mutation
receipts identify changed fields but do not supply their canonical values.
`get_task_detail` can already read one exact field, but uses serialized JSON
fragments; it is not the native-value, multi-field readback described here.

**Smallest improvement:** add bounded exact reads for the receipt's changed
fields, preserving version/hash checks. Return canonical changed values when
they fit; otherwise provide the specific continuation needed. Keep the initial
complete scope/validation read. Reuse the existing context format and the
history API's continuation conventions.

**Thinking removed:** repeatedly assembling unchanged files, relationships, and
old notes; hand-writing pagination and equality checks after one's own save.
This complements existing append operations, which already exist.

**Acceptance:** replay the #961 update/readback with unchanged fields absent
from the response, exact persisted values verified, bounded output, and stale
versions still rejected. Measure executed requests and returned characters.

### 3. Make evidence capacity visible and preserve overflow losslessly

**Priority: high. Classification: new scaling friction.**

Across **“Research Actionable #591”** and **“Resume research for task #591”**,
October 2–5, there were **eight observed aggregate-limit rejections: seven for
50 source references and one for 200 research entries**. The first occurred
while using the preferred `appendResearch` / `addUserSources` fields, not while
unnecessarily replacing the entire task.

At the first failure, the record already had 43 sources. Appending ten sources
failed; the agent revised the request to seven and retried. Later, appending a
small module-strategy note plus one source failed again. Evidence:
[initial rejection and revised write](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-02T12-29-57-01a0fe18-4047-7012-843b-1d40a64b1a3a.jsonl:282),
[module-strategy rejection](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-02T15-50-23-01a0fecf-c1a8-7a10-9c7a-6ba122594e97.jsonl:1837),
[research-cap rejection](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-02T15-50-23-01a0fecf-c1a8-7a10-9c7a-6ba122594e97.jsonl:41230).

The [50/200 limits](C:/Code/Actionables/packages/contracts/src/index.ts:1150)
remain. [`updateClaimedAgentTaskResult`](C:/Code/Actionables/apps/api/src/agent-tasks.ts:2473)
deduplicates additions, then validates the combined stored record against those
limits. Errors currently report the exceeded field without current count,
remaining capacity, or an evidence-preserving recovery route.

**Smallest improvement:** distinguish bounded request/page sizes from the
amount of durable historical evidence a coordinator may retain. Expose current
counts and capacity before a write and in any rejection. Provide a lossless
overflow path using paginated history or linked evidence; keep an explicit
current summary separate from retained evidence. Do not silently drop old
sources or automatically replace research with a lossy summary.

**Thinking removed:** counting and pruning references, rewriting old notes to
fit, deciding which evidence to omit, and repeatedly retrying valid incremental
updates. Merely raising the limits would postpone this failure mode.

**Acceptance:** append source 51 and research entry 201 to a representative
coordinator without losing earlier evidence; either persist through the bounded
history path or return an actionable preflight result before a partial write.

### 4. Test and streamline actual tool discovery, beyond shorter prose

**Priority: medium. Classification: agent/integration adoption issue related to
baseline #557, not evidence of missing server tools.**

In **“Research task #598”**, October 7, initial setup broadly printed matching
Actionables definitions alongside instructions/memory. The combined output was
reported as **41,949 tokens and truncated**. The next call rediscovered the
names and the three tools needed to start. See
[setup output and retry](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-07T14-44-46-01a11853-7a99-7381-89c7-55279ecce829.jsonl:18).
The same chat contains five discovery-marked truncated outputs; those mixed
outputs are not all attributable solely to tool definitions. Comparable broad
discovery appears in #591 and #961 chats.

The installed workflow already says to discover names first and load only
needed schemas. That instruction was available in the failing setup. This is
primarily poor adoption, amplified by large generated tool declarations and
output types. Reducing server description prose again would not address the
whole cost. Both the October 7 chat's name list and today's inventory contain
all 23 tools; the old 15-tool cache gap is not the explanation for this example.

**Smallest improvement:** add an executable, narrow discovery example to the
integration and extend the existing actual-agent evaluation to normal
claim/context/update/complete work. Retrieve only the needed input contract;
avoid printing whole generated return types for every tool. Verify that the
agent follows the smaller path rather than adding another long instruction.

**Thinking removed:** recovering from truncated setup, repeated schema lookup,
and distinguishing actionable inputs from duplicated protocol/type scaffolding.

**Acceptance:** a fresh and a resumed agent can inspect, claim, update and
complete a small isolated task without a broad catalog dump or truncated
discovery. Compare executed setup calls and uncached input with the current path.

### 5. Make the parent acceptance step an explicit next action

**Priority: medium. Classification: recurring workflow visibility gap after
baseline #561/#562; the acceptance requirement itself is correct.**

In **“Research Actionable #617”**, September 27, the user reported that remaining
children appeared blocked by their parent. Inspection showed #618–#620 were
Done, but coordinator #613 remained Ready; #614–#616 correctly depended on it.
The agent then gathered #613's completion evidence and ran its aggregate check.
This is **Actionables maintenance/evaluation evidence**:
[user report and reconciliation](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-09-27T10-40-29-01a0e3f4-3a32-7ba2-b090-0f165c6423cd.jsonl:338).

An ordinary-work example occurred today in **“Complete Actionable 964”**:
the user explicitly asked to close #964 if its work was finished. All four
children were already Done, and the parent still needed its aggregate review
and completion record. The agent reviewed unchanged source and existing
evidence, then closed it. See
[the request and review](C:/Users/AustinScriver/.codex/archived_sessions/rollout-2026-10-12T09-48-23-01a13103-ed3b-77e0-97f8-8db50a9870e2.jsonl:13).

The dashboard already displays descendant progress, and `get_completion_view`
already consolidates evidence. The
[sequential prompt](C:/Code/Actionables/packages/contracts/src/codex-prompts.ts:175)
deliberately ends by reporting the parent ready for aggregate validation.
There is no need to build those existing capabilities again or auto-close
parents when children finish.

**Smallest improvement:** surface “children finished — parent acceptance
pending” as an explicit next action, including the parent's remaining checks
and downstream tasks waiting on it. Provide a direct parent-validation prompt
using the existing completion view. When authorized scope already includes
finishing the parent, continue into that phase; otherwise offer the bounded
next action without broadening authorization.

**Thinking removed:** interpreting why a finished child set still blocks work,
finding the correct coordinator, and writing another prompt to initiate its
already-recorded acceptance review.

**Acceptance:** finishing the final child exposes the exact parent acceptance
step and affected dependents while keeping the parent open until its own
requirements pass. Include a case like #591 where unfinished research remains
despite all currently known implementation children being Done.

## Previously observed friction already addressed

- **Unblocking required a dashboard detour:** #647's October 2 continuation
  reopened the task through the dashboard. Native audited unblocking shipped
  afterward in `bc284aa`; do not propose it again. Its unfinished browser check
  was a real acceptance boundary, not removable overhead.
- **“Choose an eligible task” looked like delegated selection:** the user
  clarified this in **“Add agent task unblocking”** on October 2. Explicit
  delegated selection shipped in `eaf8d1e` and is in the current prompt source.
- **Wrong branch/worktree placement:** **“Fix Actionable worktree assignment”**
  identified #611 under CurrentSprint despite creation on `ascriver/workflow`.
  `e95db0e` addresses branch-specific placement; it is already in this release.
- **Manual plugin port/startup knowledge:** **“Retrieve Actionable 1001 review”**
  prompted automatic local review-plugin startup, shipped in `d011510`.
- **Completed-history continuation/query friction:** September changes added
  executable continuation calls, explicit multi-term search, and focused history
  guidance (`eb1f33e`, `57c32b7`, `9a28601`). Completed-history search already
  exists; broader claims about the newest verified answer remain separate from
  simple chronological retrieval.

## Interpretation and limits

Start with claim renewal, then context readback and evidence capacity. These
remove repeated work from the demonstrated long-running workflow. Follow with
discovery evaluation and parent-acceptance visibility. This is a priority order,
not a claim that these improvements block one another.

Preserve legitimate safeguards: version conflicts, claim ownership, research
before implementation, dependency checks, actual parent acceptance, and explicit
live-operation authority. A stale review snapshot or an incorrect task ID is
not by itself a product defect. Agent-specific overreading and poor discovery
are classified separately from server behavior.

The evidence is local Codex history, including archived and resumed chats, not
unavailable remote-host or cloud conversation bodies. Dynamic tool lookups and
REST calls were screened as candidates; the inventory counts explicitly named
invocations and may undercount those other paths. Regex flags for transport
errors or truncation were only triage signals; documentation can contain those
words, so unverified flags are not reported as failures. The #591 run is an
outlier and dominates the expiry/cap observations.

This audit checked source, deployed metadata/contracts, saved settings, and
representative historical call/result sequences. It did not mutate production
tasks to reproduce failures, run the application test suite, or perform a fresh
browser usability study. No improvement has been implemented or benchmarked by
this review, and no precise thinking/time savings are claimed.
