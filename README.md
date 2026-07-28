# Actionables

Actionables is a local, single-user Windows web application for turning technical findings into an execution queue while preserving evidence, hierarchy, dependencies, validation, activity, and import provenance.

## Quick start

Prerequisites and supported versions are in [Windows setup and operations](docs/windows-setup.md) and [runtime and browser support](docs/support-policy.md).

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm run db:setup
pnpm run dev
```

Open `http://127.0.0.1:4173`. Stop both local processes with `Ctrl+C`.

For a production-mode local run:

```powershell
pnpm run build
pnpm run start
```

## Verification and operations

- [Windows setup, local operation, and troubleshooting](docs/windows-setup.md)
- [Backup and restore runbook](docs/backup-restore.md)
- [Portable JSON format](docs/portable-data-format.md)
- [Agent task MCP endpoint](docs/mcp-agent-tasks.md)
- [Runtime and browser support policy](docs/support-policy.md)
- [Accessibility audit](docs/accessibility-audit.md)
- [Release-verification report](docs/release-verification.md)

The complete ordered gate is:

```powershell
pnpm run verify:release
```

It checks formatting, types, API/domain/integration tests, browser E2E tests, automated accessibility, the production build, empty-database migrations and seed idempotence, native SQLite loading, and the living plan.

## MVP boundary

The MVP includes local project/repository/worktree scopes, actionable capture and triage, lifecycle and validation, one-level subtasks, cross-scope dependencies, dashboard/search/filtering, archive/restore, reviewed-seed import, portable JSON backup/restore, an explicitly enabled local MCP endpoint for agents to create tasks and manage claimed tasks, opt-in installation of the Actionables Codex instructions and workflow skill, a review-before-save note groomer, and a recommendation-only relationship auditor backed by the signed-in local Codex CLI.

MCP available-task discovery is intentionally scoped to one top-level feature or bug Actionable and its direct subtasks; it never falls back to arbitrary pending work.

It does **not** provide user accounts, collaboration, notifications, cloud sync, hosted deployment, Git manipulation, AI-generated priority/dependencies, automatic relationship changes, arbitrary MCP hierarchy/dependency editing, or generic project-management features. The optional Codex-file integration is not an application installer: there is no application installer, updater, published binary, or supported non-Windows deployment.
