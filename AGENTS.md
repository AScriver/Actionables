# Actionables lifecycle accountability

- Track every Actionable created, claimed, or transitioned during a task, including accidental creations. Read-only inspection does not take lifecycle ownership.
- For a creation-only request, create each Actionable unclaimed in `Inbox` and stop. Do not claim or transition it unless the user also requested triage, research, or implementation.
- Treat user-provided reports as sources, not research. Recording, restating, or paraphrasing a report does not satisfy the `Researching` phase.
- A claimed Actionable may remain `Researching` between turns only while additional investigation is genuinely required. Before pausing, record the findings so far, the remaining questions, and the next research step. Do not force a status transition merely because a turn ended.
- Move an Actionable to `Ready` only after at least one independent investigative action, such as inspecting relevant code, reproducing the behavior, or consulting authoritative documentation. Record the action and its observed result; an unverified research note is insufficient.
- Before reporting completion, reconcile every tracked Actionable:
  - Completed work: record actual validation and move it to `Done`.
  - Research complete but implementation remains: move it from `Researching` to `Ready`.
  - Invalid, accidental, or disposable work: do not move it to `Dismissed`, archive it, or delete it unless the user explicitly authorizes that action. Without authorization, document the issue, leave its status unchanged, release any claim, and provide an explicit handoff.
  - Unfinished work: update its status, release any claim, and provide an explicit handoff.
- Never report research or the overall task as complete while a lifecycle-owned Actionable remains `Researching`. If research is the entire requested outcome, advance it through the permitted lifecycle, record actual validation, and move it to `Done`.
- Do not advance an Actionable merely to avoid leaving it in `Inbox`, `Researching`, or `Ready` when a turn or coding task ends. Creation-only Inbox items may remain unclaimed; reconcile lifecycle-owned work according to its actual state. Archiving changes visibility; it does not satisfy lifecycle completion.
- Run tests that create or mutate Actionables only against an isolated test database. If a test or helper writes to a non-test database, capture every created ID and reconcile it even when validation fails.
- Include the final IDs and statuses of lifecycle-owned Actionables in the completion response. If an Actionable cannot be reconciled, report the exact blocker instead of claiming the task is complete.
