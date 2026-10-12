# October 12 friction improvements: delivery status

All five implementations are committed and pushed to `AScriver`. Four children
are Done; actual-agent acceptance for #973 remains blocked. Root #969 remains
open until that acceptance and its own aggregate review finish.

| Task | Result                                                                                                                       | Commit                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| #970 | Done: automatic renewal preserves longer claim deadlines; renewing receipts show persisted expiry.                           | `ecb7bbefdb169543161fc7b3d2636c02e34c37a4` |
| #971 | Done: bounded changed-field readback and selected context reads reuse native value/text pages.                               | `4ec8871d6b5183230fbc18e3ce386153633d93fc` |
| #972 | Done: bounded append batches preserve retained research/source overflow and expose evidence capacity.                        | `a5d4e14aee4c75a5a45e36149c4abc9b2fec5330` |
| #973 | Implementation pushed; acceptance Blocked by CLI approval policy. Narrow discovery example and actual-agent evaluator added. | `0d9d23c7a88d0fee0174e33511ce6239c6bc3306` |
| #974 | Done: parent acceptance shows remaining checks and waiting dependents, with a scoped Codex prompt.                           | `3a7648fe81a3cd62e49d19f55c46a0be9a8ecf5f` |

The original [review](actionables-friction-review-2026-10-12.md) and its
[evidence manifest](actionables-friction-review-2026-10-12.json) describe the
pre-implementation findings. This document records the subsequent delivery.
The five changes are independent; their order does not establish dependencies.

## Verification and limits

- Claim ownership, optimistic concurrency, response bounds and completion
  guards remain covered by the focused service/MCP checks.
- A representative small update required zero follow-up reads instead of at
  least four full-context reads in the long-record fixture, with returned
  characters below one-quarter. This is a fixture result, not a reasoning-token
  or elapsed-time estimate.
- The evidence fixture retains 201 research notes and 51 sources through
  updates, completion, archived history and portable import into a fresh DB.
- Latest shared-path checks passed: 48 MCP, 28 prompt and 29 installer tests,
  plus three served Chromium browser tests and frontend/API/test typechecks.
  The browser tests used an explicitly isolated TEMP database and verified
  sample scope on dedicated ports 4973/4974. The [captured panel](images/parent-acceptance-2026-10-12.png)
  was inspected. The in-app browser stayed queued; no in-app acceptance is claimed.
- The actual CLI fresh/resumed control runs stopped when `transition_task`
  required approval under policy `never`. Neither completed, and the narrow
  variant was not attempted after that gate. Therefore no successful adoption
  or uncached-input reduction is established. The
  [measurement record](actionables-coordination-evaluation-2026-10-12.json)
  and [reproduction instructions](completed-history-agent-evaluation.md#active-coordination-companion)
  preserve the remaining acceptance. Approval policy was not changed.
- No installed-runtime update or restart was performed by this implementation
  run. Source and isolated-server verification do not prove deployed behavior.

## Baseline

The [September 22 baseline](actionables-friction-baseline-2026-09-22.md) remains
unchanged, SHA-256
`723FABAC7A4EF434C3BB6AA15B8C329343DC05C4DFD70482ED31A8B219D2FB27`.
The October review covered event times strictly after
`2026-09-23T00:04:15.004Z` through `2026-10-12T16:56:54.000Z` inclusive, including
later turns in older and archived chats. This delivery does not advance that
baseline or imply the new code was running during the reviewed events.
