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

Setup and Settings report `Disabled` until a non-empty token is configured.
The URL is not usable until Actionables is restarted with that token, and it
only accepts loopback connections. Do not print, paste into task records, or
commit the token.

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

When updating to nested subtasks, install the updated workflow skill from that
Settings section. Recognized unmodified older revisions can be upgraded;
customized skills require manual review. The database migration upgrades only
the exact previous built-in relationship-auditor prompt, increments its settings
version, and preserves custom prompts and other settings. Existing custom Codex
start templates are also preserved. Review any custom instructions for obsolete
direct-child-only guidance; keep the original root as `workItemId` and the
immediate parent as `parentId`.

## Agent workflow

Codex supplies its technical thread ID in MCP request metadata. Actionables
derives claim ownership and creator provenance from that host metadata; agents
do not supply or invent an `agentId`.

The server instructions direct agents to use this sequence:

1. List `mine`.
2. When the user authorizes one new task, call `actionables.create_task` with one caller-generated idempotency UUID, a deliberate priority other than `Unset`, an effort estimate other than `Unknown`, and at least one meaningful tag. For 2–25 authorized tasks, call `actionables.bulk_create_tasks` with `mode: "preview"` first; correct every reported item failure, then submit the explicit items with `mode: "apply"`. Every item needs its own caller-stable idempotency UUID. Keep it for corrections to the same intended task; use a new UUID only for a different task. For a top-level task, either provide the three existing scope IDs or provide the local Git `repositoryPath` with `ensureScope: true`. For a subtask at any depth, provide the original top-level Actionable as workItemId and its intended immediate parent as parentId; the parent must belong to that work item. Omit placement fields. Reuse a UUID only for an exact retry.
3. If no owned task matches, obtain the current feature or bug's top-level Actionable ID and list `available` with that `workItemId`. A scoped response with `workItem.terminal: true` and empty `items` is a successful final-state read, not a discovery failure.
4. For a known Done or Dismissed task, inspect it with `get_task` using the top-level `workItemId` and do not claim it. Otherwise claim the exact listed active version with the same `workItemId`.
5. After every composed tool call, inspect `isError`. If it is true, stop before reading success fields or issuing dependent mutations and preserve the structured error. Treat `retryMode` as authoritative: repeat the exact call once only for `same_request`; correct arguments before a new call for `after_input_change`; satisfy the structured `recovery` and wait until any `recovery.retryAt` for `after_state_change`; and stop for `never`. Retain `correlationId` when diagnostics are needed. `retryable` and `nextAction` remain only for legacy compatibility. An awaited MCP tool error is a resolved result, not necessarily a thrown exception.
6. Start from the compact task detail returned by claim or terminal inspection. Before treating it as complete, inspect `task.truncation.reconciliationGuidance`. When guidance is present, reconcile every supported implementation-critical field it names with `actionables.get_task_detail`: use the compact task version and the same read authorization (`claimToken` for active claimed work or `workItemId` for terminal inspection) at offset 0, then pass `contentHash` with each `nextOffset` until null, concatenate `json` in order, and JSON-parse the complete value. If any page returns `VERSION_CONFLICT`, discard the partial value and restart from the current compact detail. If a terminal page returns `TERMINAL_READ_INVALIDATED`, discard partial pages and stop terminal inspection; continued access requires the normal authorized list and claim flow before reading the active task with `claimToken`. Do not move the task forward or edit files until every named supported field is reconciled. When guidance is absent, any reported loss is noncritical to scope and planned validation and the normal flow may continue.
7. If the owning thread loses the returned token, list `mine` and call `actionables.recover_task_claim` with the listed version.
8. For a newly claimed Inbox task, transition to `Researching` before investigation.
9. Before transitioning to `Ready` or advancing Ready to `In progress`, inspect the latest `readiness.requiredForReady` and `permittedTransitions`. Ready requires non-empty finding, description, Research, and planned validation. Supply each named missing field and do not make the transition until `requiredForReady` is empty and the target is permitted.
10. Keep a task `Researching` between turns only while additional investigation is genuinely required. Before pausing, record the findings so far, the remaining questions, and the next research step; a turn ending by itself does not require a status transition.
11. Split only when research confirms multiple independently implementable outcomes. For a task at any depth, keep that task as the coordination record and create the minimum child task set covering every implementation slice beneath it, using the original root as workItemId. Keep nested coordination tasks beneath their immediate parent while retaining the original root as workItemId. A single outcome remains one task.
12. Make every implementation task a narrow, complete, independently verifiable vertical slice. Do not split by technical layer, create adjacent cleanup, or duplicate scope.
13. Record the split rationale, dependency notes, and focused validation boundary in the current task and every created task. Leave created tasks unclaimed in Inbox. Unless a dedicated relationship tool is available, record dependencies only as task notes and do not claim that dependency relationships were created.
14. Before reporting research complete, move the task to `Ready` only when `readiness.requiredForReady` is empty and Ready appears in `permittedTransitions`. A split task at any depth remains the coordination record for its children and aggregate validation. The original top-level Actionable remains `workItemId`.
15. Transition from `Ready` to `In progress` before making implementation changes. Do not edit implementation files while the task is `Inbox`, `Researching`, or `Ready`.
16. Mutate with the latest version and secret claim token.
17. Before `Done`, populate Resolution with the completed changes and important implementation decisions, record actual validation, and then transition the task.
18. Never claim completion while an owned task remains `Researching`.
19. Use `actionables.handoff_task` when task content must be saved before release, and `actionables.release_task` only when no task content needs to change.
20. To clean up an active unclaimed task created by the same Codex thread, call `actionables.dismiss_task` with only its public ID and a required reason. Claimed work uses `actionables.transition_task`.

When implementation uncovers a need for more investigation, `In progress` can return directly to `Researching` with a meaningful reason. The transition is recorded in task activity; do not route through a semantically false Ready state.

A work item is one existing top-level Actionable representing the feature or bug plus all its descendants. Available discovery never falls back to unrelated pending Actionables. Create and organize the root and subtasks in the UI or with the authorized creation tool before assigning that `workItemId` to an agent session.

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
verify creation. For a subtask, `workItemId` identifies the original top-level
Actionable and `parentId` identifies its immediate parent at any depth beneath
that root. It inherits the parent's project, repository and worktree. Root
membership is checked again on creation retries and after moves or detachment.
Detailed records and generated Codex prompts report the actual `workItemId`.
For a
top-level task, existing scope IDs
remain supported. When `repositoryPath` and `ensureScope: true` are supplied
instead, the server verifies the local Git path, resolves its repository and
worktree roots, reuses matching active scope records, and atomically creates
any missing project, repository, or worktree with the task. The response
reports which scope records were created. Creation does not claim the new task.

`actionables.bulk_create_tasks` and `actionables.bulk_prepare_tasks` accept
only an explicit ordered list of 1–25 items: they never discover, select, or
modify unlisted work. Call each first with `mode: "preview"`; preview validates
and returns ordered per-item results without writing. Correct every reported
item failure before applying the list with `mode: "apply"`. Keep an item's UUID
when correcting the same intended task; use a new UUID only for a different
task. The whole request must satisfy the published input schema before per-item
validation begins; malformed items reject the request without applying siblings.
Application processes items in order, is non-atomic across the list, and is
atomic per item: an item failure does not roll back earlier successful items.
The compact result identifies every item as valid during preview or as created,
prepared, replayed, or failed during apply. Each item has its own caller-stable
UUID; an exact replay returns that item's prior result, while changing an
applied item using its UUID conflicts.

Bulk preparation is limited to explicit, unclaimed top-level or descendant tasks
created by the current Codex thread within the authorized `workItemId`. Use the
normal list, claim, and reconciliation workflow for pre-existing tasks. Each
bulk item supplies that `workItemId` and its current `version`; it neither
accepts nor returns a claim token. It can only take an Inbox task through
`Researching` and `Ready` after its supplied content satisfies readiness, then
releases it for normal available-work discovery. It cannot bypass scope,
hierarchy, version, or lifecycle checks, or prepare a task outside its
named work item. It cannot leave or expose a claim, or claim unlisted work. A
139-item intake therefore uses six chunks per phase.

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
validates that the target is the root or one descendant, rejects nonterminal
targets, and returns `terminal: true` and `archiveState` on compact terminal
detail. Archived tasks, work-item roots, and parent scopes are excluded unless
`includeArchived: true` is explicitly supplied on every terminal read. This
option is unavailable for claim-token reads.
An excluded archived terminal read returns `ARCHIVE_INCLUSION_REQUIRED` with
`retryMode: "after_input_change"`, `recovery.action: "modify_request"`, and an
`includeArchived` field error. If archived history is intended, retry that read
with `includeArchived: true`; otherwise keep the record excluded. This recovery
requires no restore or other state change. Active-work, claim, and mutation
archive failures retain their existing `ARCHIVED` recovery.
Terminal reads do not recreate or renew claims, change versions, or add activity.
Paged detail remains version- and content-hash-bound across a later reopen. A
reopen during paging returns `TERMINAL_READ_INVALIDATED`, not a retry instruction
that would reuse the now-invalid terminal scope.

### Find completed research

`actionables.search_completed_tasks` searches Done tasks across work items in
an explicit `projectId` or `repositoryId`. Supply a nonempty `q` (up to 200
characters); supplying both scope IDs restricts results to their intersection.
It uses the dashboard's case-insensitive keyword/phrase text matching over
titles, findings, descriptions, research, and Resolution. Dashboard text search
also now includes Resolution. Dismissed and active tasks are never history
search results.

The default `limit` is 25 (maximum 100). Each result includes `id`, `workItemId`,
title, scope, Done status, version, `archiveState`, `updatedAt`, and a bounded
`match` containing the matched field and an excerpt around the match.
`updatedAt` means last modification, not completion date. Results are ordered
by descending public task ID. Continue with `nextCursor` as `cursor`, keeping
the scope, query, and archive option unchanged, until `nextCursor` is null.
Each page reads current records; restart if changes during paging need to be
included. Search scans the selected completed history using ordinary text
matching; it has no relevance ranking or separate search index.

By default, directly archived tasks, tasks whose work-item root is archived,
and tasks under archived projects, repositories, or worktrees are excluded.
Use `includeArchived: true` on the search and every subsequent read to include
them. `archiveState` describes the selected task and its project/repository/
worktree inheritance; an archived work-item root may also require inclusion.
No restore or lifecycle mutation occurs.

Use each result's `id`, `workItemId` and `version` with
`actionables.get_task_history` to read research, Resolution and stored source
references together. The tool is exclusively an agent MCP capability; it adds
no dashboard behavior. It also accepts a known Done or Dismissed task's version
from `get_task`. It requires no claim token or thread metadata.

Each `items` entry identifies a `field` (`research`, `resolution`, `userSources`,
`files` or `sourceThread`) and zero-based `index`. Research indexes identify
notes, source/file indexes identify references, and scalar fields use index 0.
`kind: "value"` returns a complete native string or reference object. For
example, a small result includes these entries in one read:

```json
[
  { "field": "research", "index": 0, "kind": "value", "value": "Verified the shared reader." },
  { "field": "resolution", "index": 0, "kind": "value", "value": "Reused its terminal safeguards." },
  { "field": "userSources", "index": 0, "kind": "value", "value": { "type": "File", "locator": "apps/api/src/mcp.ts" } }
]
```

An oversized value becomes `kind: "text"` entries with exact plain `text`,
`offset` and `totalLength` in UTF-16 code units. Split references also identify
the `property` (such as `locator` or `path`). Chunks contain at most 1,000 code
units, prefer nearby word/line boundaries, and preserve surrogate pairs and
CRLF. They are independently readable; concatenate matching field/index/property
chunks only when a whole value is needed. No serialized JSON fragments need to
be assembled or parsed. Complete references contain their stored locator and
optional label, or file path with optional lines/symbol; sourceThread retains
the original stored thread reference. Removed user sources are excluded by the
existing detail reader. Raw imported JSON and lifecycle detail are not returned.

Pages contain at most 40 items and 8,000 characters of serialized `items`, plus
bounded metadata. `fieldCounts` reports note, source and file counts, including
empty collections; empty scalar values are explicit complete strings.
`offset` and `nextOffset` count **items**, not characters. `totalItems`,
`remainingItems` and `complete` make completeness explicit. Start at offset 0;
repeat with the returned `nextOffset`, same version, first `contentHash` and
same archive option until `nextOffset` is null. The hash covers the entire
focused snapshot, so an edit to any returned field/reference rejects mixed
history even when an external writer omitted a version bump. On
`VERSION_CONFLICT`, discard partial history and restart with a fresh version
from search or compact detail. A reopened task returns
`TERMINAL_READ_INVALIDATED` and ends terminal access. These reads preserve
statuses, claims, lease times, versions, archive state and activity.

The existing `get_task` and `get_task_detail` contracts remain unchanged for
lifecycle detail and exact individual fields, including their 8,000-character
JSON pages. The focused projection reuses the transactional terminal reader;
pagination bounds responses, not the size of the snapshot loaded on the server.

History search requires no work-item claim and grants no access to active
backlog discovery. Treat completed research and Resolution as historical
evidence and verify relevant claims against current code. A source change or
passing test does not establish support in the currently installed runtime.

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
active. At least one of `finding`, `addFiles`, `appendResearch`,
`appendPlannedValidation`, or `validation` is required. When no task content
needs to change, use `release_task`; it releases the claim without saving or
updating task content.

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

Handled tool errors return `code`, a redacted `detail`, `correlationId`,
`retryMode`, and structured `recovery`. `recovery.action` is one of
`retry_request`, `modify_request`, `resolve_state`, `reconcile_state`,
`migrate_database`, or `stop`; `recovery.guidance` explains that action, and
`recovery.retryAt` appears only when the server knows an authoritative time.
Use the four retry modes literally:

- `same_request`: the exact call may be repeated once.
- `after_input_change`: do not repeat the same call; correct its arguments and
  submit a new request.
- `after_state_change`: complete the named recovery, wait until `retryAt` when
  present, reconcile current task state, and only then retry.
- `never`: stop that operation.

The legacy `retryable` and `nextAction` fields remain for older clients.
`nextAction` mirrors `recovery.guidance`; `retryable` is only a coarse
compatibility signal and is false for both `after_input_change` and `never`.
New clients must use `retryMode` and `recovery`.

A returned `INTERNAL_ERROR` exposes no exception text. Its `correlationId`
links the redacted response to the full local server diagnostic. Repeat the
exact call only when its returned mode is `same_request`, and only once; a
`never` response requires state reconciliation and log inspection instead.
If the client throws or the HTTP/MCP service is unreachable before a structured
tool result arrives, no retry contract was delivered and mutation delivery is
uncertain. Re-list or fetch the scoped task before another mutation. Reuse the
same caller-stable idempotency UUID for an exact create or bulk retry; do not
invent a new key merely because the response was lost.

Input rejected by the MCP SDK before a tool handler runs remains text-only with
targeted field wording. It does not carry the handled-error envelope; clients
must correct the reported schema input instead of assuming a retry mode.

Before a tool that can mutate Actionables runs, the server verifies that the
active database has exactly the repository's completed migration set. Drift
returns `SCHEMA_MIGRATION_REQUIRED` with `after_state_change` and
`migrate_database`; no task mutation is attempted. Apply migrations to the same
configured database only when the reported history is missing migrations.
Incomplete or unexpected history requires preserving a backup and following the
documented operator recovery or using the matching application version. Retry
only after `/api/health` reports `schema: "current"`. Do not switch, reset,
delete, or hand-edit a populated database to make the check pass.

Detail responses expose the same descendant progress as the dashboard in the
historically named `directTaskProgress` field. Counts include every attached
descendant once, including archived tasks; `subtasks` still lists immediate
children. Done requires all descendants to be Done or Dismissed, even through a
terminal intermediate task, plus the task's own Resolution and qualifying
validation. Reopening or attaching unfinished nested work reopens affected Done
ancestors to Ready with audited history; refresh their versions before continuing.

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
- `actionables.bulk_create_tasks`
- `actionables.bulk_prepare_tasks`
- `actionables.list_tasks`
- `actionables.search_completed_tasks`
- `actionables.get_task_history`
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

Active list results are limited to 100 tasks, report `hasMore` when another match exists beyond the bound, and identify scoped work-item status even when empty. Completed history search is separately limited to 100 matches and uses `nextCursor`. Detailed results use a deterministic compact budget and report truncated fields plus omitted counts for relationship, source, file, and validation collections. When the exact lost content can affect task scope or planned validation, `truncation.reconciliationGuidance` explicitly stops forward lifecycle movement and implementation until the full record is reconciled; noncritical metadata and history loss leaves that guidance absent. `actionables.get_task_detail` exposes the named implementation-critical fields and Resolution as deterministic 8,000-character JSON pages bound to an exact task version. Its `contentHash` must accompany every continuation offset, so changes to related task values also reject mixed-snapshot paging with `VERSION_CONFLICT`. Callers concatenate the pages and parse the complete value; successful reads do not return a claim token, renew a claim, or change the task version. Handled tool errors return the same machine-readable `code`, `correlationId`, `retryMode`, structured `recovery`, field errors, current version, and legacy compatibility fields in both structured content and JSON text. The endpoint can create a top-level task or a subtask at any depth, but cannot otherwise change hierarchy or dependencies, expose resources or prompts, use experimental MCP Tasks, or support legacy HTTP+SSE.

Tool schemas describe every model-supplied input field. Thread identity is
host-derived request metadata and is intentionally absent from those schemas.
Mode-based bulk tools carry conservative mutation annotations even though their
`preview` mode writes nothing. Annotations otherwise mark reads as read-only,
exact-retry-safe creation and preparation as idempotent, content replacement and
lifecycle transitions (including dismissal) as potentially destructive, and
claim release as a non-destructive coordination mutation.

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
