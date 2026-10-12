# October 12 follow-up friction delivery

The six findings in the [follow-up review](actionables-friction-review-2026-10-12-follow-up.md)
were created under the reopened root #969 and completed sequentially as
#975–#980. The original five children #970–#974 remain Done. No finding requires
another finding's output, so no blocking dependency edges were added.

| Task | Delivered behavior                                                                                                                                                                | Commit                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| #975 | Malformed MCP calls receive bounded structured recovery without relaxing strict inputs or exposing credentials.                                                                   | `e7b05b3b7921ab2dbc3d815d4d4b3653d824813e` |
| #976 | Explicitly authorized terminal work can reopen through MCP with scope, version, reason, archive and claim safeguards.                                                             | `ab291ed5700a12307236b15a8f3a47d40ef97b43` |
| #977 | Ordinary creation rejects an archived project, repository or worktree before allocating a record. Historical import and restore behavior remains available.                       | `1426e8a489cdf29a87ddcb37e5c87d00a980268d` |
| #978 | Integration status and MCP initialization identify the running build and contract/workflow fingerprints.                                                                          | `814b4bddbbd1de76f8ffbca473358e96e9c1ee5a` |
| #979 | Completion reviews retain Failed, Partial and superseded validation, newest first, with qualification and supersession intact.                                                    | `aa75aaaaad7c465cfbb1749940b256a8195742a9` |
| #980 | Browser tests share explicit TEMP data, outputs, profile and ports; reuse must match both health endpoints to the run and connected database. Existing databases are never reset. | `4b64572c88f2b9006da7bf19af3aa284b30531a4` |

Parent acceptance found that the new identity details plus an installation
notice could put Continue outside a laptop viewport. The existing setup dialog
now has a viewport height bound and vertical scrolling, committed as
`0306ed115fda8c3e663cf3c75490a80758cc34e5`. The original failing browser flow
passed in the final complete run.

## Aggregate acceptance

- Reconciled all six completion-view pages: 64 items, 11 Done descendants,
  each with qualifying validation, and no unfinished descendants or dependency
  blockers. Parent acceptance separately reviewed the planned checks and limits.
- The combined API/frontend run executed 344 tests: 343 passed and the committed
  workflow-history check exceeded its five-second timeout. The isolated installer
  rerun passed all 29 tests with no code or timeout changes. The timeout remains
  recorded as Partial evidence rather than rewriting the original result.
- All 82 Chromium browser/accessibility tests passed on the isolated TEMP sample
  database with ports 4973/4974. The server was freshly seeded before acceptance;
  explicit reuse preflight verified both health endpoints before the suite.
  The in-app browser also verified the actual runtime identity display and
  reachable setup footer.
- The task-owned test server and its descendants were stopped; ports 4973/4974
  are clear. The installed API on 4174 remains healthy. TEMP artifacts were left
  for Windows.
- All frontend/API/test TypeScript checks, repository formatting, API compilation,
  and dashboard/review production builds passed. Disposable build output stayed
  in a unique user TEMP directory.
- Actual Playwright invocations with a wrong run ID and wrong database both
  stopped before browser tests. The complete Actionables API response stayed
  unchanged across those rejection checks. Raw-file hashing was unavailable
  while SQLite held the file and is not used as preservation evidence.
- Focused protocol checks retain ownership, scope, exact-version, archive,
  dependency, bounded-response and parent-validation guards. The prior negative
  [agent-efficiency result](actionables-coordination-evaluation-2026-10-12.json)
  remains unchanged: control/narrow strict scores were both 1/2; narrow used
  26 calls and 89,923 uncached input tokens versus 24 and 67,308 for control.
  No new reasoning-token or human-time savings are claimed.

## Delivery limits and review baseline

These changes are source delivery and isolated acceptance. No managed update or
restart was performed in this follow-up pass. The earlier
[installed-runtime verification](actionables-friction-delivery-2026-10-12.md#installed-runtime-verification)
is evidence for that earlier release, not this code. Existing Codex chats may
need reconnection or a new chat after a subsequent deployment to expose the
changed tool catalog.

The September baseline and both October review snapshots are preserved. The
original baseline SHA-256 remains
`723FABAC7A4EF434C3BB6AA15B8C329343DC05C4DFD70482ED31A8B219D2FB27`.
The next incremental friction review starts strictly after the follow-up
review's cutoff, `2026-10-12T19:17:46.702Z`, including later turns in older and
archived chats. Implementation and test activity do not advance that cutoff.
