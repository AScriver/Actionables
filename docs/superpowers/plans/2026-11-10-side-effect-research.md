# Side-effect Research Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this small update in the current checkout.

**Goal:** Require proportional research, concrete evidence, prevention steps, and regression checks for credible side effects.

**Architecture:** Extend the existing research and implementation prompt templates and reuse their guidance for agent-selected subtasks. Update the canonical workflow and preserve the existing installer path for unmodified older skills and protection for customizations.

**Tech Stack:** TypeScript, Markdown, Vitest.

**Spec:** The user's approved scope in this chat on November 10, 2026.

## Global Constraints

- Keep research within the authorized task and proportional to the change's reach and risk.
- Record affected behavior, concrete evidence, prevention steps, and focused regression checks for credible side effects.
- Distinguish verified facts, assumptions, unrun checks, and remaining uncertainty.
- Preserve existing lifecycle, claim, authorization, and customization behavior.
- Run validation with an explicit isolated TEMP `DATABASE_URL`; do not update Actionables without a supplied `workItemId`.

## Review Focus

- A narrow text change should receive a brief check without invented risks.
- Shared code changes should trace affected callers and preserve existing behavior.
- Implementation should refresh stale research and report actual regression results.
- Agent-selected subtasks and parent acceptance should retain the guidance and existing authorization limits.
- Previously installed canonical skills should upgrade, while customized skills and saved prompt overrides remain protected.

### Task 1: Update agent guidance and preserve delivery

**Files:**
- Modify `packages/contracts/src/codex-prompts.ts` and `resources/agent-integration/actionables-workflow/SKILL.md`.
- Modify `apps/api/src/agent-integration.ts` and `apps/api/tests/agent-integration.test.ts`; preserve the previous skill as `apps/api/tests/fixtures/actionables-workflow-v13.md`.
- Update the workflow summary in `docs/mcp-agent-tasks.md`.

**Interfaces:** Existing prompt variables, task lifecycle, settings, and installer operations remain unchanged.

- [x] Inspect prompt renderers, settings overrides, workflow delivery, installer safeguards, and applicable instructions. Baseline: 58 prompt and installer tests passed.
- [x] Add the previous canonical skill to the installer regression cases and observe the missing upgrade recognition.
- [x] Update both prompts, agent-selected subtask guidance, the workflow, its summary, and legacy recognition.
- [x] Validate the skill and run prompt, installer, settings, and MCP coverage using the isolated database; check formatting and types.
- [x] Review the diff independently and record actual results and limitations.

## Execution Notes

- The ambient pnpm version is 11.25.0; use `corepack pnpm` to select the repository's required 11.9.0.
- The current checkout is clean on `AScriver`; this change is being made in place.
- Task creation and live prompt-setting changes remain outside scope. The user authorized committing, pushing `AScriver` to its existing upstream, and deploying the verified commit through the backed-up Local Apps workflow.
- Upgrade regression: after the workflow edit, the previous canonical skill was incorrectly classified as `modified`; registering its normalized hash restored `outdated` recognition and the existing selected-upgrade behavior. The new fixture also exercises customization protection for that revision.
- Final validation: all 339 API tests across 21 files passed with `corepack pnpm test --maxWorkers=2 --testTimeout=15000` and an explicit isolated TEMP `DATABASE_URL`. Full type checking, changed TypeScript file formatting, skill `quick_validate.py`, and `git diff --check` passed.
- Behavioral checks used a shared child-summary change and a narrow button-label change. Baseline and updated samples preserved archived-child completion blockers and kept the label change bounded. These samples establish the intended interpretation, not a measured improvement in reliability.
- A further behavioral check read actual compiled research, implementation, and agent-selected handoffs. Each delivered the phase-appropriate requirements. The agent-selected handoff retains its existing reliance on the workflow for returning to Researching.
- Review ruling: the independent reviewer requested exact-text prompt assertions but reported no functional defect. Those assertions were not added because they would detect wording changes rather than agent behavior. Existing renderer tests and the generated-handoff behavioral check cover delivery for this update; future prompt compliance remains agent-dependent.
- Browser interaction and broad agent reliability were not tested. Saved custom prompt overrides retain their existing wording. Deployment verification will use the managed process, API and dashboard health, served build identity, effective prompts, and the Local Apps release-verification record.
