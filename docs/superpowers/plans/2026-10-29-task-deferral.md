# Task Deferral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users and agents manually defer and resume a task without changing its lifecycle status.

**Architecture:** Store a nullable `deferredAt` timestamp on the existing task. Reuse domain transactions for dashboard and MCP operations, preserving optimistic concurrency, ownership, content, and dependency rules.

**Tech Stack:** TypeScript, React, Fastify, Zod, Prisma/SQLite, Vitest, Playwright.

**Spec:** Actionable 1036 description, approved in this chat on October 29, 2026.

## Global Constraints

- Manual resume only; no scheduler or new dependency.
- Deferral applies to the selected task only, without propagating to descendants.
- Preserve status, readiness, research, validation, relationships, and history.
- Agent deferral releases its own valid claim atomically; resume leaves work unclaimed.
- Tests use explicit isolated TEMP databases. Browser tests use the shared launcher.
- Commit the verified change on `AScriver` and deploy through the existing Local Apps workflow, as subsequently authorized by the user. Do not push without separate authorization.

## Review Focus

- A stale version or conflicting live claim must not alter deferral or release ownership.
- Deferred blocked work must retain its blocker and cannot bypass dependencies after resumption.
- Deferred Inbox tasks must not be triaged automatically or started through Codex prompts.
- Deferring a parent must not silently change its children or satisfy its dependents.
- Fresh migrations and portable round trips must preserve old records and deferral metadata.

### Task 1: Manual deferral across dashboard and MCP

**Files:**
- Modify `prisma/schema.prisma`; create an additive migration under `prisma/migrations/`.
- Modify `packages/contracts/src/index.ts` and `codex-prompts.ts` for metadata, filters, operations, receipts, and prompt guards.
- Modify `apps/api/src/repository.ts`, `app.ts`, `agent-tasks.ts`, `mcp.ts`, `inbox-triager.ts`, and `portable-format.ts` at existing task boundaries.
- Modify `src/api.ts` and `src/App.tsx` for inspector actions, deferred visibility, and stale/error handling.
- Add focused API/MCP/browser tests; update existing typed fixtures where required.
- Update `docs/how-to.md`, `docs/mcp-agent-tasks.md`, and the canonical integration workflow for user and agent instructions.

**Interfaces:**
- Task summaries/details expose `deferredAt: string | null`.
- Dashboard query `deferred: active | deferred | all` defaults to `active`.
- Shared domain operation `setActionableDeferred(prisma, id, input, existingTransaction?)` accepts version, deferred boolean, and audit origin.
- Dashboard `POST /api/actionables/:id/defer` and `/resume` accept `{ version }`.
- MCP `actionables.defer_task` accepts `{ id, version, claimToken }`.
- MCP `actionables.resume_task` accepts `{ id, workItemId, version }`.
- MCP `list_tasks(view: deferred)` requires an explicit top-level `workItemId`.

- [x] Write focused failing API tests proving defer/find/resume, preserved lifecycle/content/dependencies, stale rejection, and deferred lifecycle guards. Run against a fresh explicit TEMP database; expect missing endpoints/behavior.
- [x] Add nullable persistence and contracts, then implement the shared operation, dashboard API/filtering, helper exclusion, and portable round trip. Run the focused API tests; expect passing behavior.
- [x] Write failing agent/MCP tests proving owned claim release, scoped deferred discovery/inspection, resume without claim, invalid tokens/versions/ownership, and claim rejection while deferred.
- [x] Implement agent operations and thin MCP adapters with the existing mutation/receipt patterns. Run focused agent/MCP suites; expect passing behavior.
- [x] Write a failing browser test for defer, reload, find via Deferred filter, and resume while retaining status/content. Add prompt guard assertions.
- [x] Implement dashboard controls and deferred indicators using existing UI patterns; update guidance. Run the focused browser test through the shared isolated launcher; expect passing behavior.
- [x] Run format, type checks, API/frontend suites, relevant browser suites, production build, and migration verification with isolated databases. Inspect every result and resolve regressions.
- [x] Obtain one independent read-only review, fix concrete defects with regression checks, record actual validation and Resolution, and complete Actionable 1036.

## Execution Notes

- Baseline: lifecycle and agent suites passed, 50 tests across two files.
- The approved Actionable is the design and coordination record; this plan records the implementation sequence.
- Final checks: format and type checks passed; 338 API, 29 frontend, and 21 browser tests passed; production builds and all 21 migrations passed, including seed idempotence.
- Full API verification used two workers and a 15-second test timeout after the initial concurrent run exposed contention in the historical workflow revision check. No application timeout was changed.
- Build emits a bundle-size warning for the dashboard JavaScript; no new dependency was added.
- Independent review corrections: retain `deferred=all` in URLs, preserve child handoffs from a deferred parent, reject imported deferral changes behind live claims at preview/commit, and reject terminal deferral, including after safe-field merging. Regression checks failed before fixes and passed afterward.
- Archived deferred snapshots remain valid because archiving preserves deferral; restore the task before resuming it.
- Expanded handoff tests exposed a grid-row regression. Grouping deferral and lifecycle controls into the existing workflow row restored claim, prompt, and release controls; all 21 browser regressions passed afterward.
- After source acceptance, the user authorized committing and deploying this implementation. Use the existing backed-up, migration-aware Local Apps deployment command and record its verified release identity in Actionable 1036.
