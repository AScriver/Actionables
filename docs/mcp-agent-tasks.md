# Agent task MCP endpoint

Actionables can expose existing tasks to local agents at `http://127.0.0.1:4174/mcp`. The endpoint uses stateless Streamable HTTP with JSON responses and is disabled until a bearer token is configured.

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

Restart Actionables after setting the token. The normal API shutdown also closes the MCP endpoint; no separate MCP process is created.

Configure Codex globally in `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.actionables]
url = "http://127.0.0.1:4174/mcp"
bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"
enabled = true
required = false
```

Restart Codex so it reads both the global configuration and user environment.

## Agent workflow

The server instructions direct agents to use this sequence:

1. List `mine`.
2. When the user authorizes a new task, call `actionables.create_task` with one caller-generated idempotency UUID. For a top-level task, either provide the three existing scope IDs or provide the local Git `repositoryPath` with `ensureScope: true`. For one direct subtask, provide `parentId` without placement fields. Reuse the UUID only for an exact retry.
3. If no owned task matches, obtain the current feature or bug's top-level Actionable ID and list `available` with that `workItemId`.
4. Claim the exact listed version with the same `workItemId`.
5. Start from the compact task detail returned by claim; fetch again only when reconciling newer state.
6. Mutate with the latest version and secret claim token.
7. Record actual validation evidence before transitioning to Done.
8. Release a nonterminal claim when abandoning or handing off work.

A work item is one existing top-level Actionable representing the feature or bug plus its direct subtasks. Available discovery never falls back to unrelated pending Actionables. Create and organize the root and subtasks in the UI or with the authorized creation tool before assigning that `workItemId` to an agent session.

Task creation returns the created task detail, so an agent does not need to claim the task merely to verify creation. A child inherits its parent's project, repository, and worktree, and the one-level hierarchy rule prevents creating a grandchild. For a top-level task, existing scope IDs remain supported. When `repositoryPath` and `ensureScope: true` are supplied instead, the server verifies the local Git path, resolves its repository and worktree roots, reuses matching active scope records, and atomically creates any missing project, repository, or worktree with the task. The response reports which scope records were created. Creation does not claim the new task.

Automatic scope provisioning is explicit rather than silent: `repositoryPath` alone is rejected, and `ensureScope` cannot be combined with existing scope IDs or `parentId`. Repository and worktree identity is based on canonical local Git paths, not an agent-invented display name.

Claim tokens are secret capabilities. Do not put them in chat, code, files, logs, task text, or validation evidence.

After claim, the token identifies the stored agent claim. Get, update, transition, validation, and release calls do not repeat `agentId`; only explicit renewal accepts a new `leaseMinutes`. Successful mutations use the server's default renewal period.

Use `appendResearch`, `appendPlannedValidation`, and `addUserSources` when adding evidence or planned checks. The replacement fields remain available for intentional rewrites, but a call cannot replace and append the same collection at once. Exact duplicate added source references are ignored.

The endpoint exposes exactly these tools:

- `actionables.create_task`
- `actionables.list_tasks`
- `actionables.get_task`
- `actionables.claim_task`
- `actionables.renew_task_claim`
- `actionables.update_task`
- `actionables.transition_task`
- `actionables.record_task_validation`
- `actionables.release_task`

List results are limited to 100 tasks. Detailed results use a deterministic compact budget and report truncated fields plus omitted counts for relationship, source, file, and validation collections. Tool errors return the same machine-readable `code`, `retryable`, `nextAction`, field errors, and current version in both structured content and JSON text. The endpoint can create a top-level task or one direct subtask, but cannot otherwise change hierarchy or dependencies, expose resources or prompts, use experimental MCP Tasks, or support legacy HTTP+SSE.

Tool schemas describe every input field. Annotations mark reads as read-only, exact-retry-safe creation as idempotent, content replacement and lifecycle transition as potentially destructive, and claim release as a non-destructive coordination mutation.

## Security boundary

Every MCP request requires the configured bearer token. Host and Origin validation allow loopback only (`127.0.0.1`, `localhost`, or `::1`) to reduce DNS-rebinding risk. A missing Origin is accepted for non-browser MCP clients. Keep the API bound to `127.0.0.1`; exposing it on a network requires a separate reviewed authentication and transport design.
