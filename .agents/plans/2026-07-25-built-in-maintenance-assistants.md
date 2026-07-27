# Built-in maintenance assistants

## Outcome

Actionables provides three user-triggered, lower-tier-model workflows inside the app: task-note grooming with review before save, relationship auditing that produces non-mutating recommendations, and failed-test summarization that preserves the observed command output and never invents validation evidence.

## Execution

- Mode: Supervised
- Task execution: Inline

## Global constraints

- Scope is limited to the task note groomer, relationship auditor, and failed-test summarizer selected by the user.
- Model output is untrusted input: validate structured responses at the API boundary and require user review before any Actionable mutation.
- Relationship auditing is recommendation-only; it must not create, detach, waive, restore, or remove relationships.
- Failed-test summaries must distinguish observed output from model inference and must not create Passed validation evidence.
- Reuse the local single-user, loopback-only architecture and existing version-conflict behavior.
- Do not expose credentials, claim tokens, prompts containing secrets, or raw environment values to the browser or persisted activity.
- Do not add priority generation, automatic lifecycle transitions, or unattended background mutation.
- Preserve portable import/export behavior unless assistant artifacts become durable product records.
- Do not commit unless the user separately authorizes a commit.

## Research

### Research scope and provenance

- Instructions and source-of-truth artifacts: user-selected examples 1, 4, and 11; repository `AGENTS.md`; `README.md`; `docs/mcp-agent-tasks.md`; research-plan-implement skill.
- Commands and searches: repository file inventory; targeted `rg` searches for model, agent, relationship, validation, settings, and suggestion behavior; `codex exec --help`; environment-presence checks that did not reveal secret values; Git status.
- Scope inspected and files read fully: `prisma/schema.prisma`, `apps/api/src/server.ts`, `src/api.ts`, root `package.json`, `.gitignore`, MCP documentation, README. Relevant portions of `apps/api/src/app.ts`, `src/App.tsx`, contracts, relationship handling, and portable import suggestion handling were located.
- Tests, configuration, documentation, history, memory, or external sources: existing API and E2E test inventory; current Codex manual model/subagent guidance from the openai-docs skill; previous completed MCP plans; current clean branch `AScriver`.
- Meaningful not-found evidence: no existing model-provider integration, assistant-run persistence, assistant settings surface, or OpenAI API dependency was found. `OPENAI_API_KEY` is not set in the current process.

### Confirmed facts

- Actionables is a local, single-user Windows app whose API binds to loopback by default (`README.md`; `apps/api/src/server.ts`).
- The API currently accepts an optional MCP bearer token, but has no model invocation option or model credential (`apps/api/src/server.ts`; `apps/api/src/app.ts`).
- The local Codex CLI is installed and exposes non-interactive execution, explicit model selection, read-only sandboxing, ephemeral sessions, and JSON-schema-constrained final output (`codex exec --help`).
- The current process has `ACTIONABLES_MCP_TOKEN` set and no `OPENAI_API_KEY`; secret values were not read.
- Actionable edits already use shared Zod contracts, optimistic versions, API validation, activity history, and conflict responses (`packages/contracts/src/index.ts`; `apps/api/src/app.ts`; `apps/api/src/repository.ts`; `src/api.ts`).
- Relationship mutations are explicit audited domain operations. The portable import flow already models relationship suggestions as proposals that require confirmation before relationships are created (`apps/api/src/relationships.ts`; `apps/api/src/data-import.ts`; `apps/api/src/portable-format.ts`).
- The UI has no implemented Settings view; the earlier prototype reports that settings are outside that checkpoint (`src/App.tsx`).
- Existing verification surfaces include Vitest API tests, Playwright E2E and accessibility tests, typechecking, builds, migrations, and a complete release gate (`package.json`).

### Reasoned conclusions

- The narrowest safe first architecture is request/response assistance: the app gathers bounded context, invokes one configured lower-tier model, validates a structured proposal, and shows it for review. Direct model-authored domain mutations would bypass established user intent and optimistic concurrency boundaries.
- Note grooming can reuse the existing update route after the user accepts or edits a proposal; no model-specific mutation route is necessary.
- Relationship audits should use a durable or transient suggestion contract separate from established relationships. Applying suggestions is outside the selected scope.
- Failed-test summarization should separate deterministic command execution or pasted logs from model analysis. A model summary alone is not validation evidence.
- Provider choice is a material product decision because local Codex CLI, direct OpenAI API, and copy-to-Codex workflows have different authentication, billing, deployment, cancellation, and failure behavior.

### Assumptions and evidence gaps

- The initial workflows are user-triggered from the local UI, not scheduled.
- A lower-tier model should be configurable with a sensible default rather than hard-coded permanently.
- Whether assistant proposals persist across restarts should be decided during implementation planning after the invocation architecture is chosen; transient proposals are the minimal default.

### Approved decisions

- Implement only examples 1, 4, and 11.
- These capabilities belong inside Dashboard/Actionables.
- Relationship auditing remains recommendation-only.
- Invoke the installed local Codex CLI. Use explicit lower-tier model selection, read-only sandboxing, ephemeral sessions, and schema-constrained output.

### Decision gates

- None. DG-001 was resolved by the user in favor of local `codex exec`.

## Task ledger

Statuses: Pending, Blocked, Ready, Active, Complete. Only dependency-eligible leaves may be Ready or Active.

| ID | Parent | Outcome | Depends on | Status |
| --- | --- | --- | --- | --- |
| T-001 | None | A user can generate, review, edit, and explicitly apply a schema-validated note-grooming proposal from the Actionable inspector without the model mutating data directly. | None | Complete |
| T-002 | None | A user can run a relationship audit for one scoped work item and review non-mutating hierarchy/dependency recommendations with evidence. | T-001 | Complete |
| T-003 | None | A user can supply or produce failed-test output and receive a structured summary that separates observed failures from inferred causes and task routing. | T-001 | Ready |

## Task details

### T-001 — Local Codex note groomer

- Authority: User selected example 1 as a built-in Actionables feature and approved the local Codex CLI invocation boundary.
- Done when: From an Actionable inspector, the user can request a note-grooming proposal; the API invokes an injected or local read-only ephemeral Codex runner with a configured lower-tier model; contracts validate the response; the UI shows original and proposed content; nothing is persisted until the user explicitly applies the proposal through the existing versioned update path; CLI/configuration failures are recoverable and do not alter the Actionable.
- Touches: shared contracts; a narrow API assistant runner and route; server configuration; Actionable inspector/edit state; API and focused UI tests; setup documentation.
- Verify: contract/type checks, focused API tests with a stubbed runner, focused UI/E2E behavior where practical, formatting check, and review that no model output reaches a mutation without explicit user action.

### T-002 — Relationship auditor

- Authority: User selected example 4; global constraint requires recommendation-only behavior.
- Done when: The user can audit the selected top-level work item and review bounded hierarchy/dependency recommendations with cited Actionable IDs and reasons; no relationship mutation is exposed from the audit result.
- Touches: shared assistant contracts, bounded work-item context builder, API route, inspector UI, tests, documentation.
- Verify: focused tests for scope limits, invalid IDs, existing-relationship filtering, schema failures, recommendation-only UI, and no relationship mutation.

### T-003 — Failed-test summarizer

- Authority: User selected example 11; global constraint prohibits invented validation evidence.
- Done when: The user can submit bounded failed-test output through the app and review structured observed failures, inferred causes, relevant files, and candidate Actionable IDs; inference is visibly labeled and no Passed validation is recorded.
- Touches: shared assistant contracts, input-size and redaction boundary, API route, UI, tests, documentation.
- Verify: focused tests for size limits, malformed model output, observed-versus-inferred labeling, failure recovery, and absence of validation mutation.

## Deferred discoveries

- Scheduling the assistants, automatic relationship application, priority generation, lifecycle changes, notifications, and arbitrary background agents are outside the selected scope.
- A general settings framework may be useful later but is not justified unless the chosen model invocation boundary requires user-facing configuration.

## Scope audit log

- 2026-07-25: User narrowed the requested starter set from six workflows to examples 1, 4, and 11. Classified as Decomposition; the outcome was reduced before implementation planning.
- 2026-07-26: Generalize the note-groomer's assistant-context-too-large error for reuse by the relationship auditor while preserving the existing request limits and no-mutation behavior. Classified as Narrow support authorized by T-002's shared assistant boundary.

## Validation log

- T-001: `pnpm test` passed all 66 API/domain/integration tests, including generation-without-mutation, stale-version rejection before invocation, and malformed-output rejection.
- T-001: `pnpm run format:check`, `pnpm run typecheck`, `pnpm run build`, and `git diff --check` passed.
- T-001: Focused rerun `pnpm exec vitest run apps/api/tests/app.test.ts` passed 19/19 after final runner hardening and original-versus-proposal comparison UI.
- T-001: Live Playwright CLI smoke test against the running local app invoked `gpt-5.6-terra`, displayed a schema-validated editable proposal based on saved version 1, exposed explicit Apply and Discard actions, discarded without applying, and produced no browser console errors. No live model-authored content was persisted.
- T-001 refinement: Prompt now treats the finding as context-only and prohibits copying, paraphrasing, or restating it unless the description lacks necessary context; focused API tests passed 19/19, formatting and typechecking passed, and `git diff --check` found no errors.
- T-002: Focused API tests passed 21/21. Coverage verifies top-level-only scope, allowed-ID bounds, filtering of duplicate/out-of-scope/self/inapplicable recommendations, malformed-output rejection, and exact before/after equality of every audited task.
- T-002: `pnpm run format:check`, `pnpm run typecheck`, full `pnpm test` (68/68), `pnpm run build`, and `git diff --check` passed.
- T-002: Live Playwright CLI audit of existing work item #7 invoked `gpt-5.6-terra` over IDs 7, 3, 4, 5, and 6, returned no recommended changes, exposed only Dismiss, produced no browser console errors, and left version 1 plus all four hierarchy relationship IDs unchanged.

## Final reconciliation

- Pending.
