# Actionables lifecycle accountability

- Track every Actionable created, claimed, or transitioned during a task, including accidental creations. Read-only inspection does not take lifecycle ownership.
- A claimed Actionable may remain `Researching` between turns only while additional investigation is genuinely required. Before pausing, record the findings so far, the remaining questions, and the next research step. Do not force a status transition merely because a turn ended.
- Before reporting completion, reconcile every tracked Actionable:
  - Completed work: record actual validation and move it to `Done`.
  - Research complete but implementation remains: move it from `Researching` to `Ready`.
  - Invalid, accidental, or disposable work: move it to `Dismissed`, or delete it only when deletion is explicitly authorized.
  - Unfinished work: update its status, release any claim, and provide an explicit handoff.
- Never report research or the overall task as complete while a lifecycle-owned Actionable remains `Researching`. If research is the entire requested outcome, advance it through the permitted lifecycle, record actual validation, and move it to `Done`.
- Never leave an agent-created Actionable in `Inbox`, `Researching`, or `Ready` merely because the coding task ended. Archiving changes visibility; it does not satisfy lifecycle completion.
- Run tests that create or mutate Actionables only against an isolated test database. If a test or helper writes to a non-test database, capture every created ID and reconcile it even when validation fails.
- Include the final IDs and statuses of lifecycle-owned Actionables in the completion response. If an Actionable cannot be reconciled, report the exact blocker instead of claiming the task is complete.
