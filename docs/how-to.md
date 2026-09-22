# How to use Actionables

[Back to the README](../README.md)

Use this guide to navigate the dashboard, organize work, and hand an Actionable
to Codex.

## Contents

- [Run Actionables and connect Codex](#run-actionables-and-connect-codex)
- [Navigate the dashboard](#navigate-the-dashboard)
- [Select multiple Actionables](#select-multiple-actionables)
- [Manage repositories and projects](#manage-repositories-and-projects)
- [Organize subtasks](#organize-subtasks)
- [Work-item progress](#work-item-progress)
- [Default scope for new Actionables](#default-scope-for-new-actionables)
- [Hand work to Codex](#hand-work-to-codex)
- [Customize Codex start prompts](#customize-codex-start-prompts)
- [Optional local Codex helpers](#optional-local-codex-helpers)
- [Local data](#local-data)
- [Development and verification](#development-and-verification)

## Run Actionables and connect Codex

Follow [Windows setup and local operation](windows-setup.md) for
[clean setup](windows-setup.md#clean-setup),
[development operation](windows-setup.md#development-operation), and
[production-mode local operation](windows-setup.md#production-mode-local-operation).
That guide covers commands, effective loopback URLs, custom ports, stopping,
restarting, recovery, and troubleshooting.

To connect Codex, follow [Enable the MCP endpoint](mcp-agent-tasks.md#enable-it)
for token generation, configuration, restart requirements, and connection
cautions. Install the optional coordination instructions and workflow skill
through the [Windows setup guide](windows-setup.md#optional-codex-instructions-and-workflow-skill).

## Navigate the dashboard

The sidebar lists repositories with their branches/worktrees underneath.
Repositories start collapsed on each page load and can be expanded or collapsed
independently. Project scopes remain available through the top-bar selector and
repository setup. Choosing
**Actionables** clears the project, repository, and worktree filters while
preserving other filters; the existing **Done** shortcut still returns to active
work when you choose **Actionables**. **Settings** is at the bottom of the
sidebar and remains available in its collapsed navigation rail.

## Select multiple Actionables

Click a row to select it and open the inspector. **Ctrl-click** (or **Cmd-click**)
adds or removes a row without opening it. **Shift-click** selects the visible
range from the last selection anchor; **Ctrl/Cmd+Shift-click** adds that range to
the selection. Selected rows are highlighted; no checkboxes are shown.

With a row focused, **Space** toggles it, **Shift+Up/Down** extends the range,
**Ctrl/Cmd+A** selects all shown rows, and **Escape** clears selection. **Enter**
opens a row without changing the selection. The toolbar also offers **Select all
shown** and **Clear selection**.
Only visible, loaded rows are selected, including expanded children, never hidden
descendants or another page. Changing filters, sorting, scope or view clears the
selection and range anchor; collapsing a branch removes its hidden selections.

Choose **Dismiss selected**, review the selected IDs, eligibility and relationship
impacts, then enter one required reason and confirm. Terminal and archived items
are excluded. Only explicitly selected eligible items change; unselected subtasks
stay unchanged. Dismissal is not completion. Each change uses the same version
checks and activity history as individual dismissal. Existing agent claims remain
unchanged by this human action.

Use **Archive selected** to review the existing per-item hierarchy and dependency
warnings before hiding items. Use **Restore selected** in Archive to bring directly
archived items back. Each action lists eligible and excluded targets before
confirmation and preserves workflow status, content and relationships. An item
hidden by an archived project, repository or worktree cannot be restored here;
restore its archived scope separately first. Neither action automatically changes
an unselected task or scope. A selection containing both active and archived items
offers both actions and explains which items each action excludes.

Choose **Edit selected** to set a common priority or effort, or add/remove tags.
Select the field and value, review each before/after value, then confirm. Each
update uses that item's current detail and version, preserving its other fields,
sources, workflow, scope, claims and relationships. Metadata edits retain the
same behavior for terminal and archived items as individual edits.

Separate tags with commas. Tag matching ignores case and retains existing
spelling; additions do not introduce duplicates and removals preserve unrelated
tags. Tags must be nonblank and at most 60 characters, with at most 30 resulting
tags per item. Items needing no change or exceeding a limit are excluded without
a write. A concurrent edit requires **Review remaining** before retrying so its
new content is preserved.

The dialog reports each success, exclusion and failure. Successful items leave
the selection; remaining visible items stay selected. **Review remaining** loads
current details before another confirmation. Interrupted responses are read back
before retry, and confirmed successes are never submitted again. Canceling before
confirmation performs no writes; an executing batch must finish before closing.

## Manage repositories and projects

To remove a repository from active navigation, use its **Archive repository**
button in **Repositories**, review the affected work, and confirm. The repository
and its worktrees disappear from the active sidebar and remain hidden after
refresh. If that repository was selected, its repository/worktree filters clear;
the project and other filters remain. Open **Archive** to find the repository and
use **Restore repository** to bring it back. Archiving preserves Actionables,
relationships, workflow status, history, and all local repository files.

Manage existing repository assignments under **Settings → Repository projects**.
Choose another active project or **No project**, then **Save assignment**.
Removing an assignment keeps the repository available under No project, with
the same local path, worktrees, Actionable IDs, history and workflow status.
Release active or expired agent claims before moving their repository; restore
an archived repository or project before changing its assignment. These changes
affect dashboard organization only and never move folders or modify Git.

For a monorepo, set **Project directory** when adding a repository or under
**Settings → Repository projects**. Enter a relative directory such as
`apps/web`; blank keeps the existing checkout-root behavior. Track sibling
projects as separately named repository entries with the same local checkout
and their own project directories. The selected entry determines the project;
Actionables does not infer ownership from titles or attached files.

**Open in Codex** resolves that directory inside the selected worktree (or the
repository path when no worktree path is saved). It checks that the directory
exists and stays inside that checkout, including junction resolution. An
unavailable or invalid configured directory shows an error and retry action;
it never silently launches at the broader root. Codex loads the applicable
`AGENTS.md` chain through this working directory, including project-specific
guidance. A directory moved on disk must be corrected in Settings.

For MCP creation with `ensureScope`, pass a path inside the intended project.
The deepest matching registered project directory wins; sibling projects stay
separate. Ambiguous registrations or a checkout-root path that does not select
any registered project return a correction error. Explicit scope IDs retain
their existing behavior. Directory edits require released claims and advance
the affected scope/task versions without changing their IDs or lifecycle.

## Organize subtasks

In **Relationships**, create a subtask or apply a task breakdown beneath any
task, including an existing subtask. **Link existing subtask**, **Change parent**,
and **Detach** preserve that task's descendants and relationship history.
Parent and child links open their immediate neighbors. Relationships must stay
within the same project, repository and worktree; self-links and cycles are
rejected. Each task has at most one active parent.

Expand any task with children in the Actionables list to browse further levels.
Indentation shows the parent order; each branch expands independently, and its
state survives reloads in the same browser tab. Search, hierarchy filters and
archive views show matching tasks as a flat list, including deep tasks whose
ancestors do not match. Use the Relationships links to navigate their parents.

In **Activity**, check **Show subtask activity** to include all attached
subtasks, including nested and archived subtasks. The combined feed runs from
oldest to newest and identifies each task by ID and title, with links to the
subtasks. Uncheck it to return to the parent's own activity and agent sessions.
The checkbox starts unchecked when opening the tab or selecting another task.
It only changes the displayed feed; stored activity is unchanged. Detached
subtasks and unrelated tasks are excluded.

## Work-item progress

Parents with subtasks show **Work-item progress** in the **Relationships**
tab: completed, dismissed, open, blocked, unclaimed and validation-ready counts.
All attached descendants count exactly once, including archived tasks. Blocked
and unclaimed are subsets of open; an expired claim remains claimed until released.
Validation ready means a current, unsuperseded Passed record under the existing
completion policy. List-row fractions count Done or Dismissed descendants out of
all attached descendants. Immediate child links remain separate from these totals.
The parent still needs its own Resolution and qualifying validation, and every
descendant must be Done or Dismissed before parent completion, even beneath a
terminal intermediate task.

Reopening a deep task or adding unfinished work through creation, breakdown or
reparenting reopens affected Done ancestors to Ready in the same transaction,
with activity and status history. Dismissed ancestors stay Dismissed. Moving or
detaching work updates progress but never automatically completes an ancestor;
normal implementation and validation are still required.

## Default scope for new Actionables

Under **Settings → Default actionable scope**, select a project / repository /
worktree and choose **Save default scope**. This preference is saved in the
current browser. A current scope selection takes precedence; without one,
creation uses the saved worktree or the first complete active scope if that
worktree was archived or removed. Repository reassignment follows the same
worktree under its current project. **Clear default scope** restores the normal
available-scope fallback. New items still start as Inbox, with Unset priority,
Unknown effort and Unclassified evidence. Existing items are unaffected.

## Hand work to Codex

1. Capture a top-level feature or bug in `Inbox` with its intended outcome,
   evidence, sources, relevant files, and planned validation. Add direct
   subtasks when the work needs independent execution units.
2. Open an eligible, unclaimed Actionable in `Inbox`, `Researching`, `Ready`, or
   `In progress` and choose **Open in Codex** to prepare a local chat with the
   displayed prompt and, when valid, the tracked workspace. Codex leaves the
   prompt in the composer for review rather than sending it. **Copy prompt**
   exposes the same text. Manual or dependency blockers, archived or terminal
   tasks, and active or expired claims show the relevant unblock, existing
   claim, or release guidance instead of start actions. For example, an `Inbox`
   prompt begins:

   ```text
   Use Actionables work item #42. Claim task #47 and begin the Researching phase.
   ```

3. Review and send the prepared prompt, or paste the copied prompt into Codex.
   It names the governing work item and task, tells Codex to treat the
   Actionable as authoritative, and keeps discovery inside that feature or bug.
4. Codex claims the task, records research, and moves it through `Ready` and
   `In progress` before editing. It records actual validation before marking the
   work `Done`, or saves handoff context when another task must continue.

For a task that is already `Researching` or `In progress`, Actionables generates
a prompt that resumes its recorded phase. A `Ready` prompt directs Codex to
confirm the recorded scope and move to `In progress` before editing. Claims
prevent two Codex tasks from silently working the same item, while leases and
handoffs make interrupted work visible.

### Choose the next subtask or a sequence

An eligible parent also shows **Work on subtasks**. Leave **Next task only**
selected to authorize one child, or explicitly choose **All subtasks, one at a
time**. Pick the first task when several are equally eligible; the list does
not invent an order between independent tasks. Nested coordination tasks become
eligible for finalization only after their children are terminal.

**Prepare subtask prompt** refreshes eligibility and the selected task before
offering **Open subtask work in Codex** and **Copy subtask prompt**. It preserves
the original root, tracked workspace, validation boundaries and references to
completed prerequisites. Preparation does not claim or change tasks. If work
changed, choose from the refreshed list and prepare again. The ordinary parent
prompt still coordinates and validates its subtree without executing children.

Sequential prompts authorize only the selected parent's subtree, require fresh
eligibility before each claim and completion/validation before the next task,
and stop for blockers, business decisions or required approvals. They do not
authorize separate deployment or live-operation gates, or automatically finish
the parent's aggregate validation.

## Customize Codex start prompts

Customize these prompts under **Settings → Codex start prompts**. Research and
implementation templates are saved independently of the three local helper
prompts. Each **Reset to default** button resets only its template; choose
**Save settings** to persist the change. Existing installations use the current
application defaults until a custom template is saved.

Templates accept the following literal, case-sensitive variables. Include both
ID variables to identify the correct work. Unknown names, malformed double
braces and missing IDs are rejected. Expressions are not evaluated, and inserted
titles are never interpreted as template syntax.

| Variable                         | Value                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `{{workItemId}}`                 | Governing top-level Actionable ID (required)                                  |
| `{{taskId}}`                     | Selected Actionable ID (required)                                             |
| `{{taskTitle}}`                  | Selected title as literal text                                                |
| `{{phaseAction}}`                | Begin/resume research or continue/resume implementation                       |
| `{{splitInstructions}}`          | Research splitting guidance for the selected task                             |
| `{{implementationInstructions}}` | Ready preflight and implementation or coordination-task finalization guidance |

The defaults retain the existing lifecycle, scope, splitting, validation and
handoff instructions. Custom templates affect both **Open in Codex** and
**Copy prompt** without changing workspace selection or claim eligibility.
Start actions wait for valid saved settings; a loading failure offers a retry.

The dashboard derives its queues and alerts from lifecycle, validation,
hierarchy, dependency, and claim state, so stalled or blocked work remains
visible.

## Optional local Codex helpers

See [Optional local Codex helpers](windows-setup.md#optional-local-codex-helpers)
for Inbox triage, note grooming, relationship auditing, configuration,
invocation, and troubleshooting.

## Local data

Application state is stored in the local SQLite database. The app no longer
provides a Data page or JSON import/export interface. Existing records and
source evidence remain available.

- [Local data and historical backups](backup-restore.md)
- [Internal seed reconciliation format](portable-data-format.md)

## Development and verification

Run the [release gate](windows-setup.md#release-gate) using the commands and
individual diagnostics in the Windows guide. See the
[release-verification report](release-verification.md),
[accessibility audit](accessibility-audit.md), and
[runtime and browser support policy](support-policy.md) for recorded results
and their scope.
