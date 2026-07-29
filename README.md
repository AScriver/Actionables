# Actionables

> Turn technical findings into an evidence-backed execution queue.

Actionables is a local, single-user Windows application for developers who need
to move findings from reviews, audits, and investigations into completed,
validated work. It keeps the original evidence, research, dependencies, and
activity history attached to each item instead of reducing findings to a flat
to-do list.

## What you can do

- Capture findings with priorities, source references, file locations, and
  research notes.
- Organize work by project, repository, and worktree, with one level of
  subtasks.
- Move work through an explicit lifecycle: `Inbox` → `Researching` → `Ready` →
  `In progress` → `Done`, with supported blocked and dismissed states.
- Track dependencies, validation requirements, ownership claims, and activity.
- Use dashboard queues, stale-work alerts, search, and filters to decide what
  needs attention next.
- Archive completed scopes and restore them later.
- Preview and reconcile portable JSON imports before saving, and export the
  complete local state for backup.
- Optionally let local coding agents create and coordinate scoped tasks through
  an authenticated MCP endpoint.

## Requirements

- 64-bit Windows
- Node.js `>=22.19.0 <25` (`24.18.0` is the intended runtime)
- pnpm `11.9.0`
- PowerShell 7
- Current Microsoft Edge or Google Chrome

See the [support policy](docs/support-policy.md) for the versions verified by
the project.

## Quick start

From the repository root:

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm run db:setup
pnpm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Press `Ctrl+C` in the
terminal to stop the web and API processes.

No `.env` file is required. The default SQLite database is created at
`data/actionables.db`. For detailed setup, restart, recovery, and
troubleshooting instructions, see
[Windows setup and local operation](docs/windows-setup.md).

## A typical workflow

1. Capture a finding in the `Inbox` with its evidence and intended outcome.
2. Research the finding and record enough context for another person or agent
   to continue confidently.
3. Mark it `Ready`, then move it to `In progress` when implementation begins.
4. Record actual validation and move it to `Done` only when the result passes.

The dashboard derives its queues and alerts from lifecycle, validation,
hierarchy, dependency, and claim state, so stalled or blocked work remains
visible.

## Optional agent features

Actionables can expose a loopback-only MCP endpoint for coding agents. The
endpoint is disabled by default and requires an `ACTIONABLES_MCP_TOKEN`.
Available-task discovery stays within one explicitly selected top-level feature
or bug and its direct subtasks; it does not return arbitrary pending work.

The app can also install its Codex coordination instructions and workflow skill
on an opt-in basis. Optional note-grooming and relationship-audit helpers use a
signed-in local Codex CLI and always require review before changes are applied.

See [Agent task MCP endpoint](docs/mcp-agent-tasks.md) for setup and security
details.

## Data and backups

Application state is stored in the local SQLite database. Portable JSON is the
supported backup and restore format; exports can contain source text, technical
paths, and research notes, so handle them as sensitive project data.

- [Backup and restore](docs/backup-restore.md)
- [Portable data format](docs/portable-data-format.md)

## Production-mode local run

```powershell
pnpm run build
pnpm run db:migrate
pnpm run start
```

The supported deployment remains local and single-user. There is currently no
installer, updater, published binary, hosted service, or supported non-Windows
deployment.

## Development and verification

Run the complete release gate with:

```powershell
pnpm run verify:release
```

This checks formatting, types, API and integration tests, browser end-to-end
tests, automated accessibility, the production build, migrations, SQLite
loading, seed idempotence, and the living plan.

Additional project documentation:

- [Windows setup and troubleshooting](docs/windows-setup.md)
- [Runtime and browser support](docs/support-policy.md)
- [Accessibility audit](docs/accessibility-audit.md)
- [Release-verification report](docs/release-verification.md)

## Current scope

Actionables is deliberately focused on local execution coordination. It does
not provide user accounts, team collaboration, notifications, cloud sync,
hosted deployment, Git operations, automatic relationship changes, or generic
project-management features.
