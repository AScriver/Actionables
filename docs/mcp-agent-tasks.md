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
2. When the user authorizes a new task, call `actionables.create_task` with one caller-generated idempotency UUID. For a top-level task, either provide the three existing scope IDs or provide the local Git `repositoryPath` with `ensureScope: true`. For one direct subtask, provide the authorized top-level Actionable as both `workItemId` and `parentId`, without placement fields. Reuse the UUID only for an exact retry.
3. If no owned task matches, obtain the current feature or bug's top-level Actionable ID and list `available` with that `workItemId`.
4. Claim the exact listed version with the same `workItemId`.
5. Start from the compact task detail returned by claim; fetch again only when reconciling newer state.
6. If the owning thread loses the returned token, list `mine` and call `actionables.recover_task_claim` with the listed version.
7. For a newly claimed Inbox task, transition to `Researching` before investigation.
8. Record at least one non-empty Research note, preferably with `appendResearch`, before transitioning from `Researching` to `Ready`.
9. Keep a task `Researching` between turns only while additional investigation is genuinely required. Before pausing, record the findings so far, the remaining questions, and the next research step; a turn ending by itself does not require a status transition.
10. Before reporting research complete, move the task to `Ready` when the findings and validation plan are sufficient.
11. Transition from `Ready` to `In progress` before making implementation changes. Do not edit implementation files while the task is `Inbox`, `Researching`, or `Ready`.
12. Mutate with the latest version and secret claim token.
13. If research is the entire requested outcome, advance the task through the permitted lifecycle, record actual validation, and move it to `Done`.
14. Never claim completion while an owned task remains `Researching`.
15. Release a nonterminal claim when abandoning or handing off work.
16. To clean up an active unclaimed task created by the same Codex thread, call `actionables.dismiss_task` with only its public ID and a required reason. Claimed work uses `actionables.transition_task`.

A work item is one existing top-level Actionable representing the feature or bug plus its direct subtasks. Available discovery never falls back to unrelated pending Actionables. Create and organize the root and subtasks in the UI or with the authorized creation tool before assigning that `workItemId` to an agent session.

Available discovery returns only active, unarchived, nonterminal tasks that are
not manually blocked, have no unresolved dependency, and have no unexpired
claim. Blocking and claim eligibility are filtered before the result limit is
applied, so blocked tasks cannot hide safe work.

Task creation returns the created task detail and records the calling Codex
thread as its creator, so an agent does not need to claim the task merely to
verify creation. A child can be created only when `workItemId` and `parentId`
identify the same active, top-level Actionable; it inherits that parent's
project, repository, and worktree. For a top-level task, existing scope IDs
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

After claim, the token identifies the stored agent claim. Get, update,
transition, validation, and release calls do not repeat `agentId`; only
explicit renewal accepts a new `leaseMinutes`. Successful mutations use the
server's default renewal period.

Use `appendResearch`, `appendPlannedValidation`, and `addUserSources` when adding evidence or planned checks. The replacement fields remain available for intentional rewrites, but a call cannot replace and append the same collection at once. Exact duplicate appended research notes and added source references are ignored.

Use `actionables.handoff_task` when another agent or session must continue
claimed work. It atomically replaces the finding, adds exact-deduplicated file
references and research notes, appends planned checks, optionally records one
actual validation result through the normal validation rules, and releases the
claim. Every supplied handoff write and the release share one transaction: if
any write fails, none of the handoff content persists and the claim remains
active. The existing `release_task` remains the release-only operation.

An `actionables.update_task` call with `appendResearch` returns only the
authoritative research mutation receipt: `id`, latest `version`, current
`status`, `appended`, and `duplicatesIgnored`. When at least one note was
persisted and the resulting status remains `Researching`, the receipt also
includes `lifecycleGuidance`: keep the task `Researching` and record remaining
questions and the next research step while investigation remains; otherwise
transition it to `Ready` before reporting research complete. A turn ending
alone does not force that transition. Updates without `appendResearch` retain
the compact task response.

The enforced implementation path is `Inbox → Researching → Ready → In progress`.
`Inbox → Ready` is rejected, active work cannot become `Ready` without a
non-empty Research note, and `In progress` is reachable only from `Ready`.
Rejections include machine-readable recovery guidance such as
`appendResearch`. `Dismissed` remains an intentional terminal escape hatch.

This lifecycle authority governs Actionables mutations; it cannot prevent an
agent or another process from editing files outside the MCP. A hard filesystem
write gate requires orchestration support and is outside this endpoint.

The endpoint exposes exactly these tools:

- `actionables.create_task`
- `actionables.list_tasks`
- `actionables.get_task`
- `actionables.claim_task`
- `actionables.recover_task_claim`
- `actionables.renew_task_claim`
- `actionables.update_task`
- `actionables.transition_task`
- `actionables.dismiss_task`
- `actionables.record_task_validation`
- `actionables.handoff_task`
- `actionables.release_task`

List results are limited to 100 tasks. Detailed results use a deterministic compact budget and report truncated fields plus omitted counts for relationship, source, file, and validation collections. Tool errors return the same machine-readable `code`, `retryable`, `nextAction`, field errors, and current version in both structured content and JSON text. The endpoint can create a top-level task or one direct subtask, but cannot otherwise change hierarchy or dependencies, expose resources or prompts, use experimental MCP Tasks, or support legacy HTTP+SSE.

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
