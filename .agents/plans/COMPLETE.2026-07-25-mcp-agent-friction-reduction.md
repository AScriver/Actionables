# MCP agent friction reduction

## Outcome

Agents working on a specific feature or bug can discover and claim only the open Actionables in that explicitly identified work session, then manage a claimed task with fewer calls, smaller bounded results, additive updates, self-correcting errors, and self-describing MCP schemas. Arbitrary pending work is never returned as a fallback.

## Execution

- Mode: Continuous
- Task execution: Inline

## Global constraints

- A work session is an existing top-level Actionable plus its direct subtasks. Reuse the current one-level hierarchy; do not add a parallel project, session, epic, tag-convention, or database grouping model.
- `available` discovery and claiming require the caller to identify the work-session root. `mine` may remain global because it exposes only claims already owned by that agent, and may accept the same root filter.
- Do not add a combined queue that appends unrelated available work, and do not infer feature/bug scope from repository, worktree, title, free-text search, or agent ID.
- Preserve claim-token secrecy, bearer/Host/Origin protection, optimistic concurrency, lifecycle/validation rules, browser and REST behavior, and portable-data exclusions.
- Reuse the existing contracts, Prisma domain functions, official MCP SDK, Actionable hierarchy, and test infrastructure. Add no dependencies or speculative MCP resources, prompts, sessions, SSE, OAuth, experimental MCP Tasks, telemetry, or task-creation tools.
- Keep outputs compact and deterministic. Static field/collection caps with omitted counts are sufficient; do not introduce a generic serialization or pagination framework.
- Preserve all unrelated uncommitted work. Do not commit, push, publish, or deploy.

## Research

### Research scope and provenance

- Instructions and source-of-truth artifacts: user requests and clarification in this task; repository `AGENTS.md`; `C:\Users\AustinScriver\.agents\skills\actionables-workflow\SKILL.md`; `C:\Users\AustinScriver\.codex\skills\research-plan-implement\SKILL.md`; ponytail-lite skill; completed MCP plan `.agents/plans/COMPLETE.2026-07-25-mcp-agent-task-management.md`.
- Commands and searches: `git status --short`; `rg` for MCP list/claim/mutation schemas and hierarchy relationships; targeted PowerShell reads of contracts, Prisma schema, agent-task domain, MCP adapter, repository relationship/validation rules, tests, docs, global skill, and global `AGENTS.md`; live scheduled-task, port, log, and official MCP client checks.
- Scope inspected and files read fully: `prisma/schema.prisma`, `apps/api/src/mcp.ts`, `docs/mcp-agent-tasks.md`, global Actionables skill, global `AGENTS.md`, living-plan template, and package scripts; all relevant sections of `packages/contracts/src/index.ts`, `apps/api/src/agent-tasks.ts`, `apps/api/src/repository.ts`, and focused tests.
- Tests, configuration, documentation, history, memory, or external sources: existing 56-test API suite, official-client MCP integration tests, full release script, completed MCP design/validation record, scheduled supervisor script and runtime log.
- Meaningful not-found evidence: no feature/bug/session identifier exists apart from the current top-level/subtask hierarchy; no existing Actionable matches this Dashboard MCP-improvement work, so no task was claimed.

### Confirmed facts

- Current `actionables.list_tasks` accepts only `agentId`, `view`, and `limit`; `view: available` returns unrelated open tasks across every Actionables scope up to a 100-item cap (`packages/contracts/src/index.ts`, `apps/api/src/agent-tasks.ts`).
- Projects, repositories, and worktrees describe source-code location, not a feature or bug work session (`prisma/schema.prisma`).
- Actionables already support one top-level parent with direct subtasks, and detail responses expose parent, subtask, and dependency relationships (`prisma/schema.prisma`, `apps/api/src/repository.ts`).
- `claim_task` currently accepts any known open Actionable ID/version and does not prove membership in the discovery scope (`apps/api/src/agent-tasks.ts`, `apps/api/src/mcp.ts`).
- Claim returns only a summary, forcing an immediate `get_task`; later operations repeat `agentId`, and mutations repeat `leaseMinutes` even though the stored claim identifies the agent and successful mutations already renew it.
- Compact detail caps are per field/collection and can still produce a very large aggregate result; no omitted-count metadata explains truncation.
- Update replaces whole research, planned-validation, and user-source collections; errors are JSON text only; input properties lack field descriptions; several mutation annotations do not accurately communicate destructive replacement or terminal-transition behavior.
- The scheduled supervisor was marked Running while ports 4173/4174 were down. Restarting that existing scheduled task restored exactly one healthy web/API instance; the live MCP server then returned no owned matching task and 32 unrelated available tasks.

### Reasoned conclusions

- Reusing the root Actionable as the work-session key is the narrowest safe grouping: it is explicit, durable, visible in the existing UI, and already governs task hierarchy and parent completion.
- Scope safety must apply to claim as well as list. Limiting discovery alone would still let an agent claim an unrelated ID supplied from stale context.
- A global `mine` view is safe because valid ownership is already established; arbitrary global `available` discovery is not.
- Static compact caps and explicit omitted counts solve context pressure without pagination or a new output abstraction.
- The claim token is the post-claim capability. The server can derive agent provenance from the stored claim and apply its existing default renewal policy.
- Append fields belong in the existing `update_task` tool; a second additive-update tool would duplicate mutation semantics.

### Assumptions and evidence gaps

- The coordinator or user can provide the root Actionable ID for the current feature/bug session. Creating that root and its subtasks remains a user/UI or separate authorized workflow.
- The existing one-level hierarchy is sufficient for the current feature/bug work-session boundary.

### Approved decisions

- The user clarified that “project” means a specific feature or bug session and that returning arbitrary pending work may cause issues.
- The user asked to implement the identified friction reductions one at a time and previously selected ponytail-lite.

### Decision gates

- None.

## Task ledger

Statuses: Pending, Blocked, Ready, Active, Complete. Only dependency-eligible leaves may be Ready or Active.

| ID | Parent | Outcome | Depends on | Status |
| --- | --- | --- | --- | --- |
| T-001 | None | Agents can discover and claim only tasks in an explicitly identified feature/bug work session | None | Complete |
| T-002 | None | Every detailed task result has a small deterministic total ceiling and reports omitted content | T-001 | Complete |
| T-003 | None | Claim returns usable task detail and claim-token operations no longer repeat stored identity or mutation lease policy | T-002 | Complete |
| T-004 | None | Agents can append research, validation plans, and sources without replacing existing collections | T-003 | Complete |
| T-005 | None | Tool schemas and errors tell agents exactly how to call, recover, and assess side effects | T-004 | Complete |

## Task details

### T-001 — Scope-safe work-session discovery

- Authority: Outcome, Global constraints, and the user’s clarification that feature/bug tasks must be discoverable without arbitrary pending work.
- Done when: `list_tasks` defaults to owned claims; `available` requires a `workItemId` identifying a nonarchived top-level Actionable and returns only that root and its direct open subtasks; optional scoped `mine` uses the same boundary; summaries include enough hierarchy, finding/tag, and blocking context to select safely; `claim_task` requires the same root and rejects a target outside it.
- Touches: `packages/contracts/src/index.ts`, `apps/api/src/agent-tasks.ts`, `apps/api/src/mcp.ts`, focused agent-task/MCP tests, and work-session workflow documentation.
- Verify: Focused tests prove global available discovery is rejected, unrelated roots are excluded, the root and direct subtasks are discoverable, archived/terminal tasks stay excluded, scoped mine works, a cross-session claim fails, and a same-session claim succeeds; typecheck passes.
- Boundaries: Do not add project/repository/worktree/query filters or synthesize a mixed “work” queue.

### T-002 — Bounded compact detail

- Authority: Prior MCP review finding that independent caps can still overfill agent context; Global constraints.
- Done when: Compact detail uses fixed smaller text/collection caps with an aggregate result comfortably below roughly 30,000 characters for worst-case valid input, and returns explicit truncated-field and omitted-item counts for every bounded collection.
- Touches: `apps/api/src/mcp.ts` and focused MCP integration tests.
- Verify: A deliberately oversized task returns schema-valid detail below the target ceiling with correct omission/truncation metadata; ordinary detail remains intact; focused tests and typecheck pass.

### T-003 — Claim and credential ergonomics

- Authority: Prior MCP review findings that claim forces a follow-up fetch and post-claim calls repeat stored identity/lease data.
- Done when: `claim_task` returns the same compact task detail used by mutation tools plus claim credentials; get/renew/update/transition/validation/release authenticate with task ID and claim token without caller-supplied `agentId`; only claim and explicit renew accept `leaseMinutes`; mutation provenance derives from the stored claim and successful mutations use the server’s default renewal policy.
- Touches: shared contracts, `apps/api/src/agent-tasks.ts`, `apps/api/src/mcp.ts`, focused domain/MCP tests, and workflow documentation.
- Verify: The official client completes claim → update/validate/transition or release without an immediate get, repeated agent ID, or mutation lease argument; wrong tokens, expiry, concurrency, provenance, and renewal behavior remain covered; focused tests and typecheck pass.

### T-004 — Additive task updates

- Authority: Prior MCP review finding that whole-collection replacement creates avoidable overwrite risk.
- Done when: Existing `update_task` accepts `appendResearch`, `appendPlannedValidation`, and `addUserSources`; additions preserve current values, validate against existing collection limits, deduplicate exact user-source entries, report changed fields through existing activity, and reject ambiguous simultaneous replace-and-append input for the same collection.
- Touches: shared contracts, `apps/api/src/agent-tasks.ts`, focused agent-task/MCP tests, and workflow documentation.
- Verify: Focused tests prove additive preservation, limit enforcement, source deduplication, replace/append conflict rejection, and unchanged replacement behavior; typecheck passes.
- Boundaries: Do not add a new tool, remove explicit replacement fields, or add generalized patch operations.

### T-005 — Self-describing tools and recoverable errors

- Authority: Prior MCP review findings on text-only errors, missing property descriptions, and inaccurate annotations.
- Done when: Every MCP input property has concise `.describe()` metadata; tool failures provide the same machine-readable error in `structuredContent` and text with `retryable` and `nextAction`; annotations accurately distinguish read, claim/renew/validation, content replacement, terminal transition, and release side effects; server/global workflow instructions require an explicit work-session root and describe the streamlined claim/update flow.
- Touches: shared MCP-facing schemas, `apps/api/src/mcp.ts`, official-client integration tests, `docs/mcp-agent-tasks.md`, `README.md`, `C:\Users\AustinScriver\.agents\skills\actionables-workflow\SKILL.md`, and only directly affected setup guidance.
- Verify: Official-client schema inspection sees descriptions, representative errors expose structured recovery guidance, annotations match side effects, docs/skill match actual calls, focused tests pass, then the complete repository release gate and a live scheduled-instance client check pass.

## Deferred discoveries

- MCP task/session creation, hierarchy editing, or automatic generation of a work-session root.
- Multi-level epics, cross-root session membership, tags as grouping keys, or multiple roots per work session.
- Project/repository/worktree/full-text discovery, combined owned/available queues, pagination, resources, notifications, telemetry, OAuth, hosted access, SSE, or experimental MCP Tasks.

## Scope audit log

- 2026-07-25 — Decomposition: the user authorized the previously identified friction reductions one at a time; five sequential observable leaves isolate discovery safety, output size, credential flow, additive mutation, and tool self-description.
- 2026-07-25 — Narrow support: apply the explicit work-session boundary to `claim_task` as well as `list_tasks`; otherwise discovery can be bypassed by a stale or arbitrary task ID.
- 2026-07-25 — Decomposition revision: replaced proposed project/repository filters and mixed owned/available discovery with a top-level Actionable work-session root after the user clarified feature/bug intent and rejected arbitrary pending work.
- 2026-07-25 — Narrow support: reuse the existing native-Node production-launcher pattern for a focused E2E launcher that runs the same setup commands by module path and starts the API/Vite children without shell PATH lookup. The nested release → Playwright child on Windows intermittently loses PATH entries, while standalone browser/API suites pass. No dependency or app behavior changes.

## Validation log

- T-001: 2026-07-25 — Reused the existing top-level/direct-subtask hierarchy as `workItemId`; available listing now rejects a missing root, only returns that root and its direct open subtasks with selection context, defaults to owned claims, and claim verifies membership in the same root. Focused formatting and API typechecks passed; focused agent-domain and official-client MCP suites passed 16/16.
- T-002: 2026-07-25 — Replaced independent high caps with fixed compact caps, exact-length ellipsis handling, truncated-field markers, and omitted counts for every bounded collection. An official-client test populated maximum-size text plus 12-item content collections and 8-item relationship collections; the schema-valid structured result stayed below 30,000 characters with exact omission metadata. Formatting, API/test typechecks, and all 5 focused MCP tests passed.
- T-003: 2026-07-25 — Claim now returns compact task detail plus credentials in one official-client call. Post-claim get/update/transition/validation/release accept only the token (plus version for mutations); renew alone accepts a lease duration, and mutation provenance/default renewal derive from the stored claim. Formatting and API/test typechecks passed; focused domain and MCP coverage passed 17/17, including token rejection, expiry, provenance, renewal, concurrency, and terminal release.
- T-004: 2026-07-25 — Added append semantics to the existing update tool for research, planned validation, and user sources; exact added-source duplicates are ignored, replace/append conflicts are rejected, and combined values pass through existing collection limits. Focused domain and official-client MCP coverage passed 17/17, including preservation, conflict rejection, limit enforcement, deduplication, and the original replacement path.
- T-005: 2026-07-25 — Every top-level and nested MCP input property exposes a description; failures mirror machine-readable `code`, `retryable`, `nextAction`, field errors, and current version in structured/text results; annotations distinguish reads, destructive content/lifecycle mutations, and non-destructive release. The global skill validator passed. The unmodified `pnpm run verify:release` passed formatting, typechecks, 58 API tests, 17 browser tests, 3 accessibility tests, production build, all 8 migrations, idempotent seed, native SQLite, and plan validation. A native-Node E2E launcher removed nested Windows PATH dependence exposed by the release gate. The scheduled app was restored with one listener on each port; a live official client saw 8 tools, described list inputs, rejected unscoped available discovery, and returned only Actionable 1 for `workItemId: 1`.

## Final reconciliation

- Complete. All five sequential outcomes and the goal-level release/live checks passed.
- The scheduled Dashboard is Running with exactly one listener on ports 4173 and 4174.
- No existing Actionable matched this Dashboard MCP-improvement work, so Actionables task state was not mutated.
- Unrelated uncommitted work remains preserved; no commit, push, deployment, or release was performed.
