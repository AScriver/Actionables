---
name: actionables-workflow
description: Coordinate Actionables within an explicitly identified feature or bug work item through authorized task creation, planning, research, implementation, debugging, handoff, and validation using the Actionables MCP tools. Use at the start or resumption of substantive tracked work, when the user explicitly asks to create tasks, when reporting meaningful progress or blockers, and before completing or handing off work. Do not use for simple questions, unrelated work, or arbitrary backlog discovery.
---

# Actionables Workflow

Use Actionables as the coordination record for substantive work without letting task administration replace the user's requested outcome.

## Start or resume work

1. Let the Actionables MCP server derive the current Codex thread ID from host-supplied request metadata. Never supply, invent, or persist a model-authored agent ID.
2. Call `actionables.list_tasks` with `view: mine`; the server uses the calling thread as claim identity.
3. Resolve the governing feature or bug's top-level Actionable ID as `workItemId` from the task context. Never infer it from repository, worktree, title, tags, or arbitrary pending work.
4. If no owned task clearly matches and no `workItemId` was provided, do not list `available`; continue without claiming and report the missing tracking scope.
5. Otherwise call `actionables.list_tasks` with `view: available` and that `workItemId`.
6. Claim only the root or a direct task returned from that work item, using the same `workItemId` and listed version. The server assigns the claim to the calling Codex thread and returns compact task detail plus the secret token, so do not immediately fetch again.
7. For a newly claimed Inbox task, transition to Researching before beginning investigation.
8. Record at least one non-empty Research note before moving from Researching to Ready.
9. Transition from Ready to In progress before making any implementation changes.
10. If no task in that work item matches, continue the user's work without claiming anything and state in the final report that Actionables was not updated.

If the Actionables MCP server or required tool is unavailable, continue the user's work and report the tracking limitation. Never claim a merely adjacent task.

## Create authorized tasks

- Create a task only when the user explicitly requests or approves its creation and the dedicated `actionables.create_task` tool is available.
- For a creation-only request, create each authorized Actionable unclaimed in Inbox and stop unless the user also requested triage, research, or implementation.
- Generate one caller-stable idempotency UUID for each intended task. Reuse it only for an exact retry and never for a different task.
- Provide a deliberate priority other than `Unset`, an effort estimate other than `Unknown`, and at least one meaningful tag for every created task.
- For a direct subtask, pass `parentId`; the server inherits the parent's scope. Do not also pass top-level placement fields.
- For a top-level task with known scope IDs, pass `projectId`, `repositoryId`, and `worktreeId`.
- If the current local Git repository is not tracked yet, pass its absolute path as `repositoryPath` with `ensureScope: true`. The server resolves the Git roots and atomically creates any missing project, repository, or worktree before creating the task.
- Treat the task detail returned by creation as verification. Do not claim a newly created task only to fetch it again.
- Creation records the calling Codex thread as creator provenance. Do not dismiss, archive, or delete an invalid, accidental, or disposable task without explicit user authorization. When dismissal is authorized and a task created by this same thread is still active and unclaimed, call `actionables.dismiss_task` with only its ID and a required reason.
- Automatic scope provisioning does not authorize arbitrary backlog discovery or creation outside the repository and task content the user placed in scope.

## Maintain the task

- Treat the claim token as a secret capability. Keep it only in tool-call context; never place it in chat, code, files, logs, task text, or validation evidence.
- After claim, use the task ID, claim token, and latest version where required. Do not repeat the agent ID or mutation lease duration; only explicit renewal accepts `leaseMinutes`.
- Re-fetch after a version conflict, reconcile the current record, and retry only if the intended change is still valid.
- Follow structured error `nextAction` guidance. Retry only when `retryable` is true and the stated prerequisite has been satisfied.
- Prefer `appendResearch`, `appendPlannedValidation`, and `addUserSources` when adding material; use replacement fields only for intentional rewrites.
- Record meaningful state changes, research conclusions, decisions, plans, blockers, and validation evidence. Do not emit heartbeat or narration-only updates.
- Renew explicitly during long periods without mutations. Successful claimed mutations may renew the lease automatically.
- Follow permitted lifecycle transitions instead of forcing a status.
- Do not edit implementation files until the claimed task is In progress. Inbox is untriaged, Researching is investigation, and Ready means implementation may begin after the explicit transition.
- Before transitioning a task to Done, populate its Resolution with the completed changes and important implementation decisions.
- Lifecycle enforcement governs Actionables mutations but cannot prevent filesystem writes outside the MCP. A hard write gate requires orchestration support and is outside this workflow unless separately authorized.

## Lifecycle accountability

- Track every Actionable created, claimed, or transitioned during the task, including accidental creations. Read-only inspection does not create lifecycle ownership.
- Treat user-provided reports as sources, not research. Recording, restating, or paraphrasing a report does not satisfy the Researching phase.
- A claimed Actionable may remain Researching between turns only while additional investigation is genuinely required. Before pausing, record the findings so far, remaining questions, and the next research step. Do not force a status transition merely because a turn ended.
- Move an Actionable to Ready only after at least one independent investigative action, such as inspecting relevant code, reproducing the behavior, or consulting authoritative documentation. Record the action and its observed result; an unverified research note is insufficient.
- Before reporting completion, reconcile every lifecycle-owned Actionable:
  - Completed work: record Resolution content and actual validation, then move it to Done.
  - Research complete but implementation remains: move it from Researching to Ready.
  - Invalid, accidental, or disposable work: without explicit user authorization, document the issue, leave its status unchanged, release any claim, and provide an explicit handoff.
  - Unfinished work: update its status, release any claim, and provide an explicit handoff.
- Never report research or the overall task complete while a lifecycle-owned Actionable remains Researching. If research is the entire requested outcome, advance it through the permitted lifecycle, record actual validation, and move it to Done.
- Do not advance an Actionable merely because a turn or coding task ended. Creation-only Inbox work may remain unclaimed; reconcile lifecycle-owned work according to its actual state. Archiving changes visibility; it does not satisfy lifecycle completion.
- In the final response, list every lifecycle-owned Actionable ID and status. If reconciliation failed, report the exact blocker instead of claiming completion.

Use lifecycle states consistently:

- Researching: active investigation is needed; save durable findings and research notes.
- Ready: research and the planned validation are sufficient for implementation.
- In progress: implementation or active execution has begun.
- Blocked: progress cannot continue; include the concrete blocker and needed resolution.
- Done: the requested outcome is complete, Resolution content is populated, and qualifying validation evidence has been recorded.
- Dismissed: work is intentionally declined or obsolete; include the reason.

## Finish or hand off

1. Record Resolution content plus actual validation with commands, results, or other evidence before transitioning to Done.
2. Transition to Done only when the existing completion rules pass. A terminal transition releases the claim.
3. Release a nonterminal claim when abandoning the work or handing it to another agent.
4. Keep the claim only when the same agent is expected to continue promptly; renew it when necessary.
5. Include the final Actionables status in the user-facing handoff without exposing credentials.

Do not create tasks beyond the authorized `create_task` operation, modify other hierarchy or dependencies, archive records, bypass validation, or broaden scope unless dedicated tools and explicit user authority exist.
