# Actionables friction baseline — September 22, 2026

This is the fixed starting point for reviewing friction after the six September
22 improvements. Keep it unchanged when writing later review reports.

## Review boundary

- **Include activity after:** `2026-09-23T00:04:15.004Z` (strictly greater than).
- **Arizona time:** September 22, 2026, 5:04:15.004 PM, America/Phoenix.
- **Boundary source:** the user's baseline request in Codex task
  `01a0cb1a-162d-7e41-9a8a-1dd75bf25ccc`, rollout event ordinal 1590.
- **Coverage:** local active and archived Codex tasks across projects. Include
  later turns in tasks created before this cutoff; separate subagent evidence.
- **Next review:** on request, from this cutoff through a recorded review-end
  timestamp. Subsequent reviews record their own last-reviewed timestamp.
- Filter individual event timestamps, not task creation dates, archive dates,
  file modification times, or a whole task's current status.

Earlier events may explain a later incident, but do not count them as new
post-baseline friction. The baseline/setup and deployment checks in this task
are maintenance evidence; report them separately from ordinary user workflows.

## Verified installed state

Captured at `2026-09-23T00:06:47.5441958Z` using the live service, authenticated
MCP initialization/tool listing, explicit task inspection, and installed files.

| Item | Baseline |
| --- | --- |
| Application source | `c4cb190010c44f1349cdb3ecf8407b99331f540e` |
| Installed release | `20260922-164934` under `%USERPROFILE%\Apps\LocalApps\apps\actionables\releases` |
| Runtime owner | Local Apps; the retired Actionables Dashboard scheduled task is disabled |
| Dashboard / API | `http://127.0.0.1:4173/` / `http://127.0.0.1:4174/` |
| Health | `status=ok`, `database=ok`, `schema=current` |
| MCP tools advertised by server | 23 |
| MCP initialization instructions | 1067 characters |
| Tool descriptions combined | 12097 characters |
| Longest individual tool description | 981 characters |
| Workflow resource | `actionables://workflow` |
| Installed workflow skill | Matches the bundled source; SHA-256 below |

Character counts are UTF-16 string lengths. Tool-description counts exclude
schemas, initialization instructions, and Codex's added tool wrappers; they
are not token counts. Before the change, initialization instructions contained
21,182 characters; the new 1,067-character value is about 95% smaller.

Workflow SHA-256, computed after normalizing CRLF to LF and trimming:
`b964258e3e1aa588b6666631c4be100451f4847dbb811f5630c764fa902e7993`.

Deployment verification completed at `2026-09-22T23:53:57.7865715Z`. The
database passed integrity checks and its logical content was unchanged across
the release switch. No database migration was required.

Validation already completed: 280 API tests, 29 frontend tests, 13 browser
checks, typecheck, and production build. These establish implementation
coverage, not a measured reduction in human effort or reasoning tokens.

## Completed changes to evaluate

All six tasks were read back as **Done and unclaimed** when this baseline was
captured. Existing scope, claim, archive, version, lifecycle, and validation
guards remain part of correct behavior.

| Actionable | Expected behavior | Watch for in new activity |
| --- | --- | --- |
| #557 | Short initialization guidance; full workflow read once from skill/resource | Repeated full instruction dumps, truncated discovery, unnecessary schema rediscovery |
| #558 | `inspect_task` resolves an explicit ID and exposes scoped unavailable descendants without a claim | Root-ID guessing, unnecessary claims for inspection, missing blocked tasks, REST lookup detours |
| #559 | `get_task_context` returns bounded native values/text chunks with completeness and change detection | Manual JSON reconstruction, repeated field fetches, lost critical scope or acceptance criteria |
| #560 | Scoped `create_dependency` / `remove_dependency` reuse relationship checks and return persisted results | Prose-only blockers, dependency REST detours, version confusion, invented ordering edges |
| #561 | Next-task and explicitly authorized sequential-subtree prompts refresh eligibility | Repeated prompt-writing requests, wrong root/child, manual sequencing, unnecessary requests to restart between children |
| #562 | `get_completion_view` consolidates evidence; `complete_task` saves completion atomically with safe exact retries | Repeated evidence reconstruction, bookkeeping calls, duplicate validation, partial completion, skipped parent acceptance |

Completed-task search and history reading were already present before these
six changes and are also advertised by the deployed server. Evaluate their
use as part of the baseline rather than proposing them again.

## Known adoption gap at the boundary

The live server advertises 23 tools, but this already-open Codex conversation
still exposes 15 cached Actionables tool definitions and omits the new tools.
The workflow file has been updated. Do not assume every existing conversation
has refreshed its tool discovery just because deployment succeeded.

For each incident, record the tools actually available to that conversation.
Separate stale client discovery, older workflow instructions, and agent misuse
from server defects. If the mismatch persists in a freshly connected context,
record the concrete reproduction as an unresolved integration issue. Do not
claim that the six improvements have already eliminated field friction.

## How to compare the next review

1. Search both `%USERPROFILE%\.codex\sessions` and
   `%USERPROFILE%\.codex\archived_sessions`. Resolve duplicate logs by
   task/session ID; do not count mirrored event and response records twice.
2. Use only events after the boundary and through the review-end timestamp.
   Pair tool calls with their results where possible. Literal expressions in
   composed code, loops, dynamic tool lookups, truncated output, and missing
   results are not reliable executed-call totals; label incomplete samples.
3. For each distinct workflow, record task title/ID, event timestamps, relevant
   Actionable IDs, available tool version/capabilities, the observed obstacle,
   workaround, and avoidable coordination steps. Cite the actual result or
   user correction. Do not copy claim credentials into reports.
4. Compare like workflows: explicit inspection, context retrieval, dependency
   editing, sequential work, and completion. Report sample sizes; count
   unnecessary retries, REST fallbacks, repeated context/discovery reads,
   prompt/continuation interventions, and calls used for completion bookkeeping.
   Report rates only when the executed-call denominator is known.
5. Classify findings as a recurring old issue, regression, new friction, client
   adoption issue, agent misuse, or a necessary safeguard. A legitimate
   conflict, real blocker, required test, parent acceptance check, or approval
   is not removable overhead by itself.
6. Prioritize demonstrated recurring effort or a concrete correctness failure.
   Check current source and the installed runtime before recommending work;
   link to #557–#562 when a fix regressed. New Actionable creation still requires
   user authorization. Save a new dated report and its review-end timestamp.

No post-change error rate or reasoning/time savings have yet been measured.
Start those measurements from this boundary; do not initialize unknowns to zero.

## Prior evidence and reproducibility

- [September 22 friction review](C:/Users/AustinScriver/.codex/visualizations/2026/09/22/01a0cb1a-162d-7e41-9a8a-1dd75bf25ccc/actionables-friction-review.md)
- [Historical usage index](C:/Users/AustinScriver/.codex/visualizations/2026/09/22/01a0cb1a-162d-7e41-9a8a-1dd75bf25ccc/history-index.json)
- [Selected evidence](C:/Users/AustinScriver/.codex/visualizations/2026/09/22/01a0cb1a-162d-7e41-9a8a-1dd75bf25ccc/selected-evidence.json)
- [Deployment verification](C:/Users/AustinScriver/Apps/LocalApps/backups/actionables-update-20260922-164906/update-result.json)

The prior review screened 777 candidate logs and identified named MCP use in
318 user-facing task logs plus 14 subagent logs; 314 user-facing tasks were
archived at its snapshot. These are historical coverage counts, not a new
post-release denominator or a precise executed-call count.

Preserve those artifacts. The old `analyze_history.py` has a fixed output
directory, excludes this task, and has no timestamp cutoff. It must be adapted
or replaced for a future bounded review; do not rerun it unchanged over the
baseline artifacts. Include new tool names and dynamic-call/REST candidates in
future discovery, while retaining the counting caveats above.
