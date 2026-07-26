# MCP agent task management

## Outcome

When the local Actionables API is explicitly configured for MCP, it exposes a standards-compliant Streamable HTTP endpoint at `/mcp`. Agents can discover available Actionables, claim one or more with an expiring lease, inspect and update only tasks covered by their valid claim tokens, perform existing lifecycle transitions and validation recording, renew or release claims, and receive bounded structured results with actionable conflict errors. The existing browser and REST behavior remains unchanged.

## Execution

- Mode: Supervised
- Task execution: Inline

## Global constraints

- This plan authorizes a local agent-coordination adapter, not accounts, human assignees, team roles, hosted access, or a general multi-user authorization system.
- “Task” means an existing Actionable, including a top-level actionable or subtask. Task creation, dependency editing, hierarchy editing, archive operations, scope administration, and bulk mutation are outside this outcome.
- Ownership is a transient lease stored separately from the Actionable. A client-supplied agent ID is descriptive; an opaque server-generated claim token is the mutation credential. Store only a cryptographic hash of that token.
- Claims expire and may be reclaimed. A successful claimed mutation renews the lease; an explicit renewal tool supports long-running work. A terminal transition releases the claim atomically.
- Reuse the current lifecycle, readiness, completion-validation, relationship, archive, activity, and optimistic-concurrency rules. MCP handlers must call transaction-safe domain functions rather than duplicate rules or call the REST API over HTTP.
- Use normal MCP tools. Do not use the experimental MCP Tasks utility, which models asynchronous protocol execution rather than Actionables domain records.
- Use the current MCP Streamable HTTP transport and official TypeScript SDK packages, pinned in the lockfile. Do not add legacy HTTP+SSE compatibility.
- The MCP endpoint is disabled unless an explicit local bearer token is configured. Bind locally by default, compare credentials safely, validate Host and Origin at the custom Fastify boundary, and document the risk of enabling a non-loopback host.
- Return structured output conforming to declared output schemas plus compact text fallback. Bound list sizes and text fields so tool results cannot dump the entire database or unbounded Markdown into agent context.
- Preserve the uncommitted repository-tracking work already present in this working tree; implementation must not overwrite, reformat, or commit it unless separately authorized.
- Claims are operational coordination state and are excluded from portable import/export. Claim/release/expiry activity remains durable history and may be exported.
- No commits, pushes, releases, or deployment changes are authorized by this planning request.

## Research

### Research scope and provenance

- Instructions and source-of-truth artifacts: user request in this task; repository `AGENTS.md`; `C:\Users\AustinScriver\.codex\skills\research-plan-implement\SKILL.md`; completed product plan `.agents/plans/COMPLETE.2026-07-24-personal-actionables-dashboard.md`.
- Commands and searches: `rg --files .agents`; repository-wide searches for `mcp`, agent ownership, task mutations, activity, and status transitions; targeted inspection of API routes, domain services, contracts, schema, server startup, packages, and tests; `git status --short`.
- Scope inspected and files read fully: `apps/api/src/server.ts`, `apps/api/package.json`, `apps/api/tsconfig.json`, root `package.json`, `packages/contracts/package.json`, and the living-plan template. Relevant sections were traced in `prisma/schema.prisma`, `packages/contracts/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/repository.ts`, and the completed MVP plan.
- Tests, configuration, documentation, history, memory, or external sources: existing Vitest API suites and Playwright configuration; official MCP 2025-11-25 [Streamable HTTP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), and official [TypeScript SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md).
- Meaningful not-found evidence: no MCP package, MCP route, agent identity, claim, ownership, or assignment model exists in the current repository or lockfile.

### Confirmed facts

- The application is explicitly local and single-user (`README.md:3`), and the API binds to `127.0.0.1` unless `API_HOST` overrides it (`apps/api/src/server.ts:16-18`).
- Actionables already have a numeric public ID, stable record ID, version, lifecycle status, validation records, activity history, archive state, and relationships (`prisma/schema.prisma:57-112`).
- REST updates, lifecycle transitions, and validation recording are separate routes (`apps/api/src/app.ts:407-480`, `apps/api/src/app.ts:596-625`) backed by transactional domain functions with optimistic version checks (`apps/api/src/repository.ts:1595-1885`).
- Existing contracts restrict REST status-transition and validation origins to `user`; an MCP adapter must set an internal agent origin without broadening browser-controlled inputs (`packages/contracts/src/index.ts`, status and validation request schemas).
- The completed product plan deferred both a live Codex adapter and authentication/multi-user ownership, and requires adapters not to persist around domain validation (`.agents/plans/COMPLETE.2026-07-24-personal-actionables-dashboard.md:860-874`, `:974`, `:1228-1230`).
- MCP Streamable HTTP uses one endpoint for POST and GET; GET may return 405 when no server stream is offered. The protocol requires Origin validation, recommends localhost binding and authentication, and replaced legacy HTTP+SSE.
- MCP tools support input and output schemas, structured results, bounded names, read/mutation annotations, and tool execution errors intended to help models self-correct.
- The official TypeScript SDK supports a synchronous JSON-response Streamable HTTP mode, which fits these short database operations and avoids introducing resumable MCP session state.
- The working tree contains uncommitted repository-tracking changes unrelated to this plan.

### Reasoned conclusions

- A separate `AgentTaskClaim` table is narrower and safer than adding assignee fields to Actionable: it makes expiry and token rotation explicit, permits one active claim per Actionable, avoids presenting transient coordination as product ownership, and can be excluded from portable backups without changing the portable document version.
- Claim verification and the underlying Actionable mutation must share one Prisma transaction. Checking a claim in an MCP handler and then calling the existing top-level transaction wrapper would create a time-of-check/time-of-use race; transaction-client core functions should be extracted and reused by both REST and MCP wrappers.
- Stateless JSON-response Streamable HTTP is sufficient because every proposed tool completes synchronously. MCP’s experimental Tasks utility would add unstable semantics without solving a product requirement.
- A shared endpoint bearer token protects the local MCP surface; per-task claim tokens enforce “own task” semantics between agents. Neither mechanism is a user-account system.
- Claim, release, and observed-expiry activity should use new activity types and agent-prefixed origins so the user can explain agent actions from the existing timeline. Lease heartbeats should not create activity noise.
- Existing full-update DTOs are inappropriate as MCP tool inputs. The adapter needs narrow partial-update schemas and separate transition/validation tools so agents cannot mutate scope, archive state, relationships, server-managed evidence, IDs, versions, or ownership fields.

### Assumptions and evidence gaps

- Agent clients can retain the opaque claim token returned by `actionables.claim_task` and send it on later tool calls.
- A default 30-minute lease, configurable only within a bounded 5-120 minute range, is sufficient for initial use. Successful mutations and explicit renewal extend it.
- Agents may hold multiple concurrent task claims; no evidence supports a one-task-per-agent limit.
- Available tasks are active, nonterminal Actionables whose claim is absent or expired. Claiming does not silently change workflow status; the agent calls the transition tool explicitly.
- SDK-to-Fastify raw response integration must be proven with the pinned SDK version during T-003; official examples primarily show Express/Hono adapters.

### Approved decisions

- The user requested an MCP endpoint that lets agents manage and update their own tasks.
- Low-risk local design assumption: use expiring token-backed claims rather than adding human assignees or accounts.

### Decision gates

- None. Hosted or multi-user deployment, OAuth, human assignment UI, and durable non-expiring ownership would be separate product decisions.

## Task ledger

Statuses: Pending, Blocked, Ready, Active, Complete. Only dependency-eligible leaves may be Ready or Active.

| ID | Parent | Outcome | Depends on | Status |
| --- | --- | --- | --- | --- |
| T-001 | None | Agents can list, claim, renew, and release Actionables through transaction-safe expiring ownership primitives | None | Complete |
| T-002 | None | A valid claim can update task content, lifecycle status, and validation while every invalid or stale mutation is rejected atomically | T-001 | Complete |
| T-003 | None | A configured `/mcp` Streamable HTTP endpoint exposes the complete bounded tool set and passes real-client interoperability and security checks | T-002 | Complete |

## Task details

### T-001 — Expiring agent claims

- Authority: User request for agents to manage their own tasks; Outcome and Global constraints in this plan.
- Done when: A checked-in migration adds one optional claim per Actionable with agent ID, claim-token hash, lease expiry, and timestamps; domain operations atomically list available/mine, claim by expected Actionable version, renew with a valid token, release with a valid token, and reclaim an expired claim; claim/release/observed-expiry activity is recorded without heartbeat noise; claim state is absent from portable export/import.
- Touches: `prisma/schema.prisma`, a new Prisma migration, shared agent-task schemas/types in `packages/contracts/src/index.ts`, a focused `apps/api/src/agent-tasks.ts` domain module, activity mapping in `apps/api/src/repository.ts`, portable-format exclusions/documentation, and focused Vitest tests.
- Verify: Migration deploys from an empty database; tests cover claim races, wrong agent/token, token hashing, expiry/reclaim, renewal bounds, archived/terminal rejection, multiple claims per agent, release, activity, and portable export omission; `pnpm run typecheck` and focused Vitest tests pass.
- Boundaries: Do not add REST routes, UI assignment controls, task creation, or mutate workflow status when claiming.

### T-002 — Claimed task mutations

- Authority: User request for agents to update their own tasks; T-001 claim boundary and the existing Actionable lifecycle/validation rules.
- Done when: Transaction-client core variants of current update, transition, and validation operations are reusable without changing REST behavior; claimed wrappers verify agent ID, token hash, nonexpired lease, and expected version in the same transaction as the mutation; successful mutations renew the lease; terminal transitions delete the claim atomically; MCP-specific partial-update contracts permit only title, priority, effort, evidence state, finding, description, research, planned validation, tags, and user-added sources; origins and activity identify the agent without accepting caller-controlled origin.
- Touches: `packages/contracts/src/index.ts`, `apps/api/src/repository.ts`, `apps/api/src/agent-tasks.ts`, existing API/domain tests, and new agent-task tests.
- Verify: Focused tests prove REST response and lifecycle parity, partial updates preserve omitted/server-managed fields, claim checks cannot race the mutation, stale versions return the current version, invalid lifecycle and completion attempts retain existing machine codes, validation evidence remains required, successful mutation renews the lease, and Done/Dismissed releases it; all API tests pass.
- Boundaries: Do not expose scope moves, relationship mutation, archive/restore, imported evidence replacement, dependency waivers, completion-policy bypasses, or generic arbitrary patches.

### T-003 — MCP endpoint and tools

- Authority: User request for an MCP endpoint; T-001 and T-002 domain outcomes; MCP 2025-11-25 Streamable HTTP and tool specifications.
- Done when: Pinned official MCP server/node SDK packages are installed; Fastify serves stateless JSON-response Streamable HTTP at `/mcp` with POST handling and spec-compliant GET/DELETE behavior; endpoint access requires configured bearer authentication and validates Host/Origin; the tools `actionables.list_tasks`, `actionables.get_task`, `actionables.claim_task`, `actionables.renew_task_claim`, `actionables.update_task`, `actionables.transition_task`, `actionables.record_task_validation`, and `actionables.release_task` expose strict input/output schemas, compact structured/text results, accurate read/mutation annotations, and self-correcting tool errors; startup/shutdown and configuration are documented.
- Touches: `apps/api/package.json`, `pnpm-lock.yaml`, a new `apps/api/src/mcp.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, MCP integration tests using the official client transport against an ephemeral real listener, `README.md`, `docs/windows-setup.md`, and a focused `docs/mcp-agent-tasks.md`.
- Verify: An official MCP client initializes against a real ephemeral Fastify listener, lists the exact tools, and completes list → claim → get → update → transition/validation → release; tests reject missing/wrong bearer tokens, unexpected Origin/Host, malformed tool inputs, wrong/expired claim tokens, stale versions, and oversized list requests; GET/DELETE behavior matches the chosen stateless transport; existing REST/E2E tests remain green; `pnpm run format:check`, `pnpm run typecheck`, `pnpm test`, focused MCP integration tests, `pnpm run build`, and `pnpm run verify:migrations` pass.
- Boundaries: Do not expose legacy SSE endpoints, experimental MCP Tasks, prompts/resources, OAuth, network-wide binding defaults, agent task creation, or browser UI changes.

## Deferred discoveries

- UI indicators and manual user controls for active/expired agent claims.
- Agent-created Actionables and agent-managed hierarchy/dependencies.
- OAuth, per-agent credentials, hosted/multi-user authorization, audit administration, and token provisioning UI.
- Notifications or resources that push task changes to agents.
- Legacy HTTP+SSE compatibility and MCP experimental Tasks support.

## Scope audit log

- 2026-07-25 — Narrow support: token-backed expiring claims, transaction-client domain cores, bearer/Origin/Host checks, bounded output, and focused operations documentation are necessary to make “own tasks” correct and safely expose a local MCP mutation endpoint. Human assignment, hosted identity, UI, and broader task administration remain Deferred.

## Validation log

- T-001: 2026-07-25 — `pnpm run typecheck` passed; focused agent-task Vitest coverage passed (8/8); full API coverage passed (49/49 across 6 files); `pnpm run format:check` and `git diff --check` passed; `pnpm run verify:migrations` applied all 8 migrations to an empty SQLite database, confirmed the schema was current on a second deploy, seeded 32 records idempotently, and loaded `better-sqlite3`.
- T-002: 2026-07-25 — transaction-aware variants of the existing REST mutations preserve one rule path; `pnpm run typecheck` and `pnpm run format:check` passed; focused agent-task coverage passed (11/11) for partial preservation, sources/planned validation, claim/version races, wrong and expired credentials, lifecycle/validation error parity, agent origins, lease renewal, and Done/Dismissed release; the official full API run passed 52/52 across 6 files. One earlier parallel run hit the existing 10-second `app.test.ts` setup limit; that suite passed 15/15 alone and the unchanged official command then passed completely.
- T-003: 2026-07-25 — pinned stable `@modelcontextprotocol/sdk` 1.29.0 and added a stateless JSON `/mcp` route enabled only by `ACTIONABLES_MCP_TOKEN`; focused official-client coverage passed (4/4) for the exact eight tools, all eight operations, strict/bounded inputs and outputs, self-correcting claim/version errors, bearer/Host/Origin rejection, stateless GET/DELETE, and disabled-by-default routing; `pnpm run format:check`, `pnpm run typecheck`, full API coverage (56/56 across 7 files), `pnpm run build`, `pnpm run verify:migrations`, and non-accessibility Playwright E2E (17/17) passed. A second official client connected to the scheduled real instance and listed all eight tools; Codex parsed the global streamable-HTTP configuration; the Windows supervisor restarted with one listener on each port and healthy API status.
- Final reconciliation: 2026-07-25 — the first complete release run exposed the previously observed 10-second Vitest fixture-hook ceiling under load; a product-neutral `vitest.config.ts` raised only hook setup timeout to 30 seconds. The subsequent unmodified `pnpm run verify:release` command passed formatting, type checking, all 56 API tests, 17 browser E2E tests, 3 accessibility tests, production build, clean migration/seed/native-SQLite proof, and living-plan validation.

## Final reconciliation

- Run the repository’s complete release gate after all ledger tasks are Complete.
- Confirm an independently configured MCP client can perform the documented workflow against a migrated local database.
- Confirm the browser’s existing create/edit/lifecycle/import/export behavior remains unchanged and no claim credential is exported.
- Review the final diff against this plan, keep Deferred work out of scope, record deployment/configuration notes, then rename this plan with the `COMPLETE.` prefix.
