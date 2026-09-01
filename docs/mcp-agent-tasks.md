# Agent task MCP endpoint

Actionables can expose existing tasks to local agents through a loopback MCP
endpoint. The default is `http://127.0.0.1:4174/mcp`; a valid custom
`API_PORT` changes the effective endpoint. The endpoint uses stateless
Streamable HTTP with JSON responses and is disabled until a bearer token is
configured.

## Enable it

Generate a token and save it in the current Windows user's environment:

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
[Environment]::SetEnvironmentVariable("ACTIONABLES_MCP_TOKEN", $token, "User")
$env:ACTIONABLES_MCP_TOKEN = $token
Remove-Variable token,bytes
```

Restart Actionables after setting the token. The normal API shutdown also
closes the MCP endpoint; no separate MCP process is created. First-run setup and
**Settings → Actionables agent integration** show the effective API origin, MCP
endpoint, and whether the route is enabled. They never display the token.

Configure Codex globally in `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.actionables]
# Use the effective endpoint reported by Actionables.
url = "http://127.0.0.1:4174/mcp"
bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"
enabled = true
required = false
```

Restart Codex so it reads both the global configuration and user environment.
If a saved API port later becomes unavailable, Actionables selects and persists
a new endpoint. Startup narrowly replaces the old URL only when the Actionables
entry still matches the previously managed configuration, preserves unrelated
`config.toml` bytes, and tells you to restart Codex. Matching configuration is
byte-idempotent. Malformed, ambiguous, or user-managed Actionables entries are
not overwritten; follow startup's manual-review guidance to set the reported
replacement endpoint and then restart Codex. If `API_PORT` is explicitly
customized outside this startup flow, use the effective endpoint reported by
Actionables and review the Codex entry before restarting.

The Codex instructions and Actionables workflow skill are separate, optional
files. First-run setup and **Settings → Actionables agent integration** can
install either or both with explicit consent. See
[Windows setup](windows-setup.md#optional-codex-instructions-and-workflow-skill)
for their target paths and conflict-safe behavior.

## Agent workflow

Codex supplies its technical thread ID in MCP request metadata. Actionables
derives claim ownership and creator provenance from that host metadata; agents
do not supply or invent an `agentId`.

The server instructions direct agents to use this sequence:

1. List `mine`.
2. When the user authorizes a new task, call `actionables.create_task` with one caller-generated idempotency UUID, a deliberate priority other than `Unset`, an effort estimate other than `Unknown`, and at least one meaningful tag. For a top-level task, either provide the three existing scope IDs or provide the local Git `repositoryPath` with `ensureScope: true`. For one direct task or sibling, provide the authorized top-level Actionable as both `workItemId` and `parentId`, without placement fields; never use a direct task as the parent. Reuse the UUID only for an exact retry.
3. If no owned task matches, obtain the current feature or bug's top-level Actionable ID and list `available` with that `workItemId`. A scoped response with `workItem.terminal: true` and empty `items` is a successful final-state read, not a discovery failure.
4. For a known Done or Dismissed task, inspect it with `get_task` using the top-level `workItemId` and do not claim it. Otherwise claim the exact listed active version with the same `workItemId`.
5. After every composed tool call, inspect `isError`. If it is true, stop before reading success fields or issuing dependent mutations, preserve the structured error, and follow its recovery guidance. An awaited MCP tool error is a resolved result, not necessarily a thrown exception.
6. Start from the compact task detail returned by claim or terminal inspection. Before treating it as complete, inspect `task.truncation.reconciliationGuidance`. When guidance is present, reconcile every supported implementation-critical field it names with `actionables.get_task_detail`: use the compact task version and the same read authorization (`claimToken` for active claimed work or `workItemId` for terminal inspection) at offset 0, then pass `contentHash` with each `nextOffset` until null, concatenate `json` in order, and JSON-parse the complete value. If any page returns `VERSION_CONFLICT`, discard the partial value and restart from the current compact detail. If a terminal page returns `TERMINAL_READ_INVALIDATED`, discard partial pages and stop terminal inspection; continued access requires the normal authorized list and claim flow before reading the active task with `claimToken`. Do not move the task forward or edit files until every named supported field is reconciled. When guidance is absent, any reported loss is noncritical to scope and planned validation and the normal flow may continue.
7. If the owning thread loses the returned token, list `mine` and call `actionables.recover_task_claim` with the listed version.
8. For a newly claimed Inbox task, transition to `Researching` before investigation.
9. Before transitioning to `Ready` or advancing Ready to `In progress`, inspect the latest `readiness.requiredForReady` and `permittedTransitions`. Ready requires non-empty finding, description, Research, and planned validation. Supply each named missing field and do not make the transition until `requiredForReady` is empty and the target is permitted.
10. Keep a task `Researching` between turns only while additional investigation is genuinely required. Before pausing, record the findings so far, the remaining questions, and the next research step; a turn ending by itself does not require a status transition.
11. Split only when research confirms multiple independently implementable outcomes. For a top-level task, keep the root as the coordination record and create the minimum direct task set covering every implementation slice. For an existing direct task, narrow it to one slice and create only the remaining slices as siblings under the same root. A single outcome remains one task.
12. Make every implementation task a narrow, complete, independently verifiable vertical slice. Do not split by technical layer, create adjacent cleanup, duplicate scope, or create grandchildren.
13. Record the split rationale, dependency notes, and focused validation boundary in the current task and every created task. Leave created tasks unclaimed in Inbox. Unless a dedicated relationship tool is available, record dependencies only as task notes and do not claim that dependency relationships were created.
14. Before reporting research complete, move the task to `Ready` only when `readiness.requiredForReady` is empty and Ready appears in `permittedTransitions`. A split root remains the coordination record; later work coordinates its direct tasks and aggregate validation instead of duplicating their implementation scope.
15. Transition from `Ready` to `In progress` before making implementation changes. Do not edit implementation files while the task is `Inbox`, `Researching`, or `Ready`.
16. Mutate with the latest version and secret claim token.
17. Before `Done`, populate Resolution with the completed changes and important implementation decisions, record actual validation, and then transition the task.
18. Never claim completion while an owned task remains `Researching`.
19. Release a nonterminal claim when abandoning or handing off work.
20. To clean up an active unclaimed task created by the same Codex thread, call `actionables.dismiss_task` with only its public ID and a required reason. Claimed work uses `actionables.transition_task`.

When implementation uncovers a need for more investigation, `In progress` can return directly to `Researching` with a meaningful reason. The transition is recorded in task activity; do not route through a semantically false Ready state.

A work item is one existing top-level Actionable representing the feature or bug plus its direct subtasks. Available discovery never falls back to unrelated pending Actionables. Create and organize the root and subtasks in the UI or with the authorized creation tool before assigning that `workItemId` to an agent session.

Available discovery returns only active, unarchived, nonterminal tasks that are
not manually blocked, have no unresolved dependency, and have no unexpired
claim. Blocking and claim eligibility are filtered before the result limit is
applied, so blocked tasks cannot hide safe work. Every scoped list also returns
`workItem` with the root ID, status, and derived `terminal` flag. Done and
Dismissed roots are valid read scopes; `mine` and `available` remain active-work
views and return empty `items` for a terminal root. Every list response includes
`hasMore`; callers must not treat `items` as exhaustive when it is true.

Task creation returns the created task detail and records the calling Codex
thread as its creator, so an agent does not need to claim the task merely to
verify creation. A direct task or sibling can be created only when `workItemId`
and `parentId` identify the same active, top-level Actionable; it inherits that
root's project, repository, and worktree. Grandchildren are rejected. For a
top-level task, existing scope IDs
remain supported. When `repositoryPath` and `ensureScope: true` are supplied
instead, the server verifies the local Git path, resolves its repository and
worktree roots, reuses matching active scope records, and atomically creates
any missing project, repository, or worktree with the task. The response
reports which scope records were created. Creation does not claim the new task.

`actionables.dismiss_task` resolves the current version internally and reuses
the same lifecycle, reason, optimistic-concurrency, status-history, and activity
rules as other transitions. It fails closed when Codex thread metadata is
missing, the task lacks creator-thread provenance, another thread created it,
the item is archived or terminal, or it has an active claim. An expired claim
is reconciled atomically before dismissal.

Automatic scope provisioning is explicit rather than silent: `repositoryPath` alone is rejected, and `ensureScope` cannot be combined with existing scope IDs or `parentId`. Repository and worktree identity is based on canonical local Git paths, not an agent-invented display name.

Claim tokens are secret capabilities. Do not put them in chat, code, files, logs, task text, or validation evidence.

A successful `actionables.claim_task` call returns `{ task, claim }`. Read the
latest version from `task.version` and the secret token from
`claim.claimToken` for later claimed-task calls.

If that response credential is lost, `actionables.list_tasks` with
`view: "mine"` still returns the owning thread's task and current version.
`actionables.recover_task_claim` accepts that public task ID and version plus
an optional 5–120 minute lease, derives the caller from Codex thread metadata,
and succeeds only when that thread owns the unexpired claim. It atomically
replaces the stored token hash, renews the lease, increments the task version,
and returns `{ task, claim }` with a fresh token. The previous token becomes
invalid immediately; `claimedAt` is preserved while `renewedAt` and
`leaseExpiresAt` reflect recovery.

Concurrent recovery calls using the same listed version have one winner. The
winner returns the only usable credential; later calls receive
`VERSION_CONFLICT`. If the winning response is also lost, list `mine` again
and recover using the newer version. An expired claim cannot be recovered and
must follow the normal available-list and claim flow. Repeating `claim_task`
from the owning thread returns `OWN_CLAIM_ACTIVE` with `currentVersion` and
machine-readable guidance to `recover_task_claim`; other threads cannot use
the recovery operation.

After claim, the token identifies the stored agent claim. Active get and detail
reads, plus update, transition, validation, and release calls, do not repeat
`agentId`; only explicit renewal accepts a new `leaseMinutes`. Successful
mutations use the server's default renewal period.

`actionables.get_task` and `actionables.get_task_detail` accept exactly one read
authorization. Active work uses its valid `claimToken`. Read-only inspection of
a Done or Dismissed task uses the explicit top-level `workItemId`; the server
validates that the target is the root or one direct task, rejects archived and
nonterminal targets, and returns `terminal: true` on compact terminal detail.
Terminal reads do not recreate or renew claims, change versions, or add activity.
Paged detail remains version- and content-hash-bound across a later reopen. A
reopen during paging returns `TERMINAL_READ_INVALIDATED`, not a retry instruction
that would reuse the now-invalid terminal scope.

Terminal inspection never reopens work. Continued work requires explicit user
authorization and the existing dashboard transition from Done or Dismissed to
Ready, including its required audited reason, before the normal list and claim
flow resumes. A separately authorized new follow-up is a new Actionable; do not
claim a relationship unless one was actually recorded.

Use `appendResearch`, `appendPlannedValidation`, and `addUserSources` when adding evidence or planned checks. The replacement fields remain available for intentional rewrites, but a call cannot replace and append the same collection at once. Exact duplicate appended research notes and added source references are ignored.

Use `actionables.handoff_task` when another agent or session must continue
claimed work. It atomically replaces the finding, adds exact-deduplicated file
references and research notes, appends planned checks, optionally records one
actual validation result through the normal validation rules, and releases the
claim. Every supplied handoff write and the release share one transaction: if
any write fails, none of the handoff content persists and the claim remains
active. The existing `release_task` remains the release-only operation.

Routine mutations (`renew_task_claim`, `update_task`, `transition_task`,
`dismiss_task`, `record_task_validation`, `handoff_task`, and `release_task`)
return one lean authoritative receipt with `id`, latest `version`, current
`status`, `changedFields`, `claimReleased`, `reconciliationFields`, `readiness`,
`permittedTransitions`, and `counts`. Counts identify the field plus persisted
and duplicate-ignored additions. Renewal also reports `claimLease`; validation
reports the created record ID and whether it qualifies for completion. When a
result remains `Researching`, `lifecycleGuidance` names any persisted Ready
prerequisites that remain. Only fetch implementation-critical fields named by
`reconciliationFields`; a status-only transition therefore does not invalidate
unchanged research or sources. Create, claim, recovery, and explicit reads keep
their compact detail responses.

Successful calls expose their authoritative result in `structuredContent`.
`content.text` is a fixed short compatibility notice and intentionally does not
duplicate task detail or secret claim credentials. Error text retains the
machine-readable error payload.

The enforced implementation path is `Inbox → Researching → Ready → In progress`.
`Inbox → Ready` is rejected. Active work can become `Ready` only with non-empty
finding, description, Research, and planned validation fields. The server
returns those missing prerequisites in fixed order, omits Ready from
`permittedTransitions` until they are satisfied, and reports all remaining
fields together if a caller still forces the transition. `In progress` is
reachable only from `Ready`, and a Ready task whose prerequisites were later
cleared cannot advance until they are restored. In-progress work can return
directly to `Researching` with a meaningful audited reason when implementation
uncovers more investigation.
Every transition to `Done` also requires non-empty Resolution content in
addition to the existing qualifying-validation or completion-override policy.
`Dismissed` remains an intentional terminal escape hatch.

This lifecycle authority governs Actionables mutations; it cannot prevent an
agent or another process from editing files outside the MCP. A hard filesystem
write gate requires orchestration support and is outside this endpoint.

The endpoint exposes exactly these tools:

- `actionables.create_task`
- `actionables.list_tasks`
- `actionables.get_task`
- `actionables.get_task_detail`
- `actionables.claim_task`
- `actionables.recover_task_claim`
- `actionables.renew_task_claim`
- `actionables.update_task`
- `actionables.transition_task`
- `actionables.dismiss_task`
- `actionables.record_task_validation`
- `actionables.handoff_task`
- `actionables.release_task`

List results are limited to 100 active tasks, report `hasMore` when another match exists beyond the bound, and identify scoped work-item status even when empty. Detailed results use a deterministic compact budget and report truncated fields plus omitted counts for relationship, source, file, and validation collections. When the exact lost content can affect task scope or planned validation, `truncation.reconciliationGuidance` explicitly stops forward lifecycle movement and implementation until the full record is reconciled; noncritical metadata and history loss leaves that guidance absent. `actionables.get_task_detail` exposes only the named implementation-critical fields as deterministic 8,000-character JSON pages bound to an exact task version. Its `contentHash` must accompany every continuation offset, so changes to related task values also reject mixed-snapshot paging with `VERSION_CONFLICT`. Callers concatenate the pages and parse the complete value; successful reads do not return a claim token, renew a claim, or change the task version. Tool errors distinguish terminal, archived, and not-found recovery and return the same machine-readable `code`, `retryable`, `nextAction`, field errors, and current version in both structured content and JSON text. The endpoint can create a top-level task or one direct subtask, but cannot otherwise change hierarchy or dependencies, expose resources or prompts, use experimental MCP Tasks, or support legacy HTTP+SSE.

Tool schemas describe every model-supplied input field. Thread identity is
host-derived request metadata and is intentionally absent from those schemas.
Annotations mark reads as read-only, exact-retry-safe creation as idempotent,
content replacement and lifecycle transitions (including dismissal) as
potentially destructive, and claim release as a non-destructive coordination
mutation.

## Security boundary

Every MCP request requires the configured bearer token. Host and Origin validation allow loopback only (`127.0.0.1`, `localhost`, or `::1`) to reduce DNS-rebinding risk. A missing Origin is accepted for non-browser MCP clients. Keep the API bound to `127.0.0.1`; exposing it on a network requires a separate reviewed authentication and transport design.

The Codex thread ID is coordination provenance, not a replacement for the MCP
bearer token or a claimed task's secret capability. A non-Codex client may omit
thread metadata, and a client already holding the shared bearer token could
forge it. Creator-thread dismissal therefore remains limited to active,
unclaimed items. Claimed mutations require the claim token except for the
narrow recovery operation, which combines the shared bearer token with matching
thread provenance to rotate a credential. This protects normal Codex threads
from one another under the documented local single-user coordination model; it
does not provide cryptographic same-thread authentication against a client that
already holds the bearer token and forges the owner's thread metadata.
