# October 12 friction improvements: delivery status

Root #969 and all five children (#970–#974) are Done. The evaluator approval blocker is resolved and its
real-agent comparison is complete, including the negative efficiency result.
Aggregate acceptance is complete. Local Apps now runs the verified October 12
release with the installed database preserved.

| Task | Result                                                                                                                   | Commit                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| #970 | Done: automatic renewal preserves longer claim deadlines; renewing receipts show persisted expiry.                       | `ecb7bbefdb169543161fc7b3d2636c02e34c37a4`                                             |
| #971 | Done: bounded changed-field readback and selected context reads reuse native value/text pages.                           | `4ec8871d6b5183230fbc18e3ce386153633d93fc`                                             |
| #972 | Done: bounded append batches preserve retained research/source overflow and expose evidence capacity.                    | `a5d4e14aee4c75a5a45e36149c4abc9b2fec5330`                                             |
| #973 | Done: narrow discovery and actual-agent evaluation delivered; isolated invocation permissions resolve the approval gate. | `0d9d23c7a88d0fee0174e33511ce6239c6bc3306`, `c5bf7b2ce606f557b2bfe3d9cbd4d07e9ba688c0` |
| #974 | Done: parent acceptance shows remaining checks and waiting dependents, with a scoped Codex prompt.                       | `3a7648fe81a3cd62e49d19f55c46a0be9a8ecf5f`                                             |

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
- Initial CLI runs stopped at the approval gate. Invocation-only per-tool
  approvals on the isolated proxy now permit the authorized fixture writes,
  with global permissions unchanged. Final control/narrow fresh/resumed cases
  all reached Done with validation and released claims; both resumed cases
  recovered a real stale-version conflict. Each variant scored 1/2 strict
  passes because its other case corrected two malformed requests. Narrow used
  26 calls and 89,923 uncached tokens versus 24 and 67,308 for control; no native
  CLI efficiency gain is established. The
  [measurement record](actionables-coordination-evaluation-2026-10-12.json)
  and [reproduction instructions](completed-history-agent-evaluation.md#active-coordination-companion)
  preserve both historical failures and final results. The review accepted the
  completed experiment without changing its strict failure scores.
- The initial implementation run did not deploy. The separately authorized
  update and restart are verified in the installed-runtime section below.

## Aggregate acceptance follow-up

The completion view was reconciled through all four current pages: all five
children are Done, each has its own qualifying acceptance, and no unfinished
descendant or dependency remains. Parent review separately checked the original
scope, long-evidence/request measurements, lifecycle guards and documentation.
The source changes were accepted with the real-agent efficiency and strict-score
limits above intact.

Full API validation passed 304 tests; frontend validation passed 29. Formatting,
frontend/API/test TypeScript and evaluator self-checks passed. The initial full
browser suite passed 75/82. Six failures inherited an archived worktree from the
default-scope fixture; its archive exercise now restores that worktree in
`finally`. The seventh asserted an unsupported tag pixel width; visibility and
actual filtering assertions remain. A fresh isolated 15-test rerun passed,
covering every initially failed case plus the surrounding default-scope,
capture and layout flows. An intermediate reused-database rerun encountered
duplicate fixture titles; it is not counted as the fresh rerun.

Browser data lived under Windows TEMP with explicit `DATABASE_URL`,
`WEB_PORT=4973` and `API_PORT=4974`; the served sample scope was checked before
execution. No fixture writes targeted the installed database. Fresh migration
and native SQLite checks passed; repeating the 32-item sample seed changed no
records.

## Installed-runtime verification

On October 12 at 19:10 UTC, Local Apps switched Actionables from
`20261006-133516` to `20261012-120840`, built from
`a119aee43c469bbb0f98ef69a60d13f967f6f606`. The frozen-lock package build passed
for both dashboard and review assets. The manager reports Running with five
owned processes; previous Actionables processes exited. Ports 4173/4174,
startup/recovery preferences, the database path and sibling apps were preserved.

Health reports `status=ok`, `database=ok`, `schema=current`. No migration was
required. All 23 MCP tools are advertised, including selected context fields,
changed-context receipts, claim expiry, evidence capacity and parent acceptance
contracts. Both MCP resources are present; workflow text matches the package.
Served HTML, JavaScript and CSS match the packaged bytes. Read-only inspection
confirmed #969–#974 are Done and unclaimed. Reloading the in-app browser showed
the parent as Done and Unclaimed on the updated dashboard.

Consistent SQLite backups before and after the switch have identical logical
SHA-256 `25278a59f9dac0c9ade7eede9462a587a46020b643ca4a42277035c6764b009f`,
with integrity checks passing across all 14 tables. The unmodified older
workflow skill was backed up and updated through the existing installer;
normalized contents now match the package. Global Codex configuration and
instructions hashes stayed unchanged. No missing instruction component was
installed. All task-owned browser-test servers have stopped; TEMP artifacts
remain for Windows.

[Local deployment evidence](C:/Users/AustinScriver/Apps/LocalApps/backups/actionables-update-20261012-120840/release-verification.json)
records release identity, contracts, assets, terminal states and data preservation.
The active Codex turn still has its earlier input schema cached. The new server
contracts are verified; automatic refresh of existing chats is not established.
A refreshed tool catalog or new chat may be needed to expose the new inputs.

## Baseline

The [September 22 baseline](actionables-friction-baseline-2026-09-22.md) remains
unchanged, SHA-256
`723FABAC7A4EF434C3BB6AA15B8C329343DC05C4DFD70482ED31A8B219D2FB27`.
The October review covered event times strictly after
`2026-09-23T00:04:15.004Z` through `2026-10-12T16:56:54.000Z` inclusive, including
later turns in older and archived chats. This delivery does not advance that
baseline or imply the new code was running during the reviewed events.
