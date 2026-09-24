# Actionables

> Give Codex a persistent, evidence-backed execution queue.

Actionables is a local, single-user Windows companion for Codex. It turns
findings from reviews, audits, and investigations into scoped work that Codex
can research, claim, implement, and validate. The original evidence, decisions,
dependencies, and activity history stay attached to each item across Codex
tasks instead of disappearing into chat history or a flat to-do list.

![Actionables showing a selected Ready task and a wide Start with Codex handoff panel](docs/images/actionables-codex-workflow.png)

_The execution queue, lifecycle controls, recorded research and validation, and
built-in Codex handoff._

## What Actionables gives Codex

- A durable task record with priorities, intended outcomes, source references,
  file locations, research notes, and planned validation.
- Organize work by project, repository, and worktree, with nested
  scoped subtasks so Codex only discovers work from the selected feature or bug.
- An explicit lifecycle—`Inbox` → `Researching` → `Ready` → `In progress` →
  `Done`—with blocked and dismissed states.
- Ownership claims, dependencies, validation requirements, handoff context, and
  an auditable activity history.
- Dashboard queues, stale-work alerts, search, and include/exclude filters for
  deciding what should be handed to Codex next. Review bulk metadata edits,
  dismissal, archive, and restore actions before applying them.
- Codex handoff prompts for one task, the next eligible subtask, or an explicitly
  selected sequence. Repository and worktree settings target the right project
  directory, including projects inside a monorepo.
- An authenticated, loopback-only MCP endpoint for task creation, claims,
  dependency coordination, completion, and retrieval of completed research.
- Optional local Codex CLI helpers for Inbox triage, note grooming, and
  relationship recommendations.

## Requirements

- 64-bit Windows
- Node.js `>=22.19.0 <25` (`24.18.0` is pinned in [`.node-version`](.node-version))
- pnpm `11.9.0`
- PowerShell 7 and Git
- Current Microsoft Edge or Google Chrome
- Codex desktop for task handoff and MCP; a signed-in local Codex CLI for the
  optional helpers

See the [support policy](docs/support-policy.md) for declared support and dated
verification evidence.

## Run from source

From the repository root, with the required Node and pnpm versions installed:

```powershell
pnpm install --frozen-lockfile
pnpm run dev
```

Development startup builds the shared contracts, generates Prisma, migrates the
configured SQLite database, and reconciles the fictional 32-item sample seed.
The default database is `data/actionables.db`. Startup reports the web, API,
health, and MCP URLs; it starts with loopback ports `4173` / `4174` and saves an
available alternative pair when needed.

For built-mode operation after setup:

```powershell
pnpm run build
pnpm run db:migrate
pnpm run start
```

Built-mode startup does not migrate or seed the database. See
[Windows setup](docs/windows-setup.md) for a clean installation, environment
settings, managed installations, and isolated verification commands.

## Documentation

- **[How-to guide](docs/how-to.md)** — navigate the dashboard, organize work,
  manage settings, and hand tasks to Codex.
- [Windows setup and local operation](docs/windows-setup.md) — install, run,
  troubleshoot, and verify Actionables.
- [Connect Codex through MCP](docs/mcp-agent-tasks.md) — token setup,
  configuration, and the agent workflow.
- [Local data and historical backups](docs/backup-restore.md) — storage and
  recovery limitations.
- [Runtime and browser support](docs/support-policy.md) — supported configuration
  and the scope of earlier verification.
- [Release verification](docs/release-verification.md) and
  [accessibility audit](docs/accessibility-audit.md) — dated validation reports.
- [September 22 friction baseline](docs/actionables-friction-baseline-2026-09-22.md)
  — the fixed comparison point for later workflow reviews.

## Code layout

The React dashboard calls a Fastify API through Vite's `/api` proxy. The API
stores state in SQLite through Prisma and `better-sqlite3`; the MCP endpoint
uses the same domain operations and validation rules.

| Location                                                                         | Responsibility                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`src/`](src/)                                                                   | React 19 and TypeScript UI, TanStack Query data access, Markdown rendering, bulk actions, and Codex links. |
| [`apps/api/src/`](apps/api/src/)                                                 | Fastify routes, lifecycle and relationship rules, agent coordination, MCP, and local Codex helpers.        |
| [`packages/contracts/src/`](packages/contracts/src/)                             | Shared Zod schemas, types, runtime ports, and Codex prompt templates.                                      |
| [`prisma/`](prisma/)                                                             | SQLite schema and ordered migrations.                                                                      |
| [`scripts/`](scripts/)                                                           | Development/production launchers, test startup, and migration checks.                                      |
| [`resources/agent-integration/`](resources/agent-integration/)                   | Optional managed instructions and the canonical Actionables workflow skill.                                |
| [`apps/api/tests/`](apps/api/tests/), [`src/`](src/), [`tests/e2e/`](tests/e2e/) | API/domain tests, frontend unit tests, and Playwright browser/accessibility tests.                         |

Use the [verification guide](docs/windows-setup.md#release-gate) for the current
commands and test isolation requirements. The historical release report is not
a verification of the current checkout.

## Current scope

Actionables is focused on local execution coordination. It has no user accounts,
team roles, notifications, cloud sync, or hosted multi-user service. MCP bearer
authentication protects agent requests; the dashboard/API remain a local,
single-user application.

Repository scope provisioning reads Git metadata. Actionables does not commit,
push, switch branches, or edit tracked project files. Relationship changes use
explicit dashboard or MCP operations; the relationship auditor only recommends
changes. The repository contains source launchers, not an installer or updater.
Externally managed installations have their own release and restart procedures.
