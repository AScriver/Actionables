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
- [Runtime and browser support policy](docs/support-policy.md)
- [Accessibility audit](docs/accessibility-audit.md)
- [Release-verification report](docs/release-verification.md)

The complete ordered gate is:

```powershell
pnpm run verify:release
```

It checks formatting, types, API/domain/integration tests, browser E2E tests, automated accessibility, the production build, empty-database migrations and seed idempotence, native SQLite loading, and the living plan.

## MVP boundary

The MVP includes local project/repository/worktree scopes, actionable capture and triage, lifecycle and validation, one-level subtasks, cross-scope dependencies, dashboard/search/filtering, archive/restore, reviewed-seed import, and portable JSON backup/restore.

It does **not** provide authentication, accounts, collaboration, assignment, notifications, cloud sync, hosted deployment, live Codex integration, Git manipulation, AI-generated priority/dependencies, or generic project-management features. There is no installer, updater, published binary, or supported non-Windows deployment.
