# Actionables lifecycle accountability

- Track every Actionable created, claimed, or transitioned during a task, including accidental creations. Read-only inspection does not take lifecycle ownership.
- Before reporting completion, reconcile every tracked Actionable:
  - Completed work: record actual validation and move it to `Done`.
  - Invalid, accidental, or disposable work: move it to `Dismissed`, or delete it only when deletion is explicitly authorized.
  - Unfinished work: update its status, release any claim, and provide an explicit handoff.
- Never leave an agent-created Actionable in `Inbox`, `Researching`, or `Ready` merely because the coding task ended. Archiving changes visibility; it does not satisfy lifecycle completion.
- Run tests that create or mutate Actionables only against an isolated test database. If a test or helper writes to a non-test database, capture every created ID and reconcile it even when validation fails.
- Include the final IDs and statuses of lifecycle-owned Actionables in the completion response. If an Actionable cannot be reconciled, report the exact blocker instead of claiming the task is complete.
