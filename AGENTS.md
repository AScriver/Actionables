# Actionables repository safeguards

- For future Actionables friction reviews, start with [the September 22 baseline](docs/actionables-friction-baseline-2026-09-22.md). Apply its event-time cutoff to both active and archived Codex tasks, including later turns in older tasks, and preserve the original baseline when recording new review results.
- When work in this repository is coordinated through Actionables, follow the `actionables-workflow` skill. If the skill is unavailable, use `resources/agent-integration/actionables-workflow/SKILL.md` as the workflow source.
- Run any test or helper that creates or mutates Actionables only with an explicit isolated `DATABASE_URL`; never use the default `file:./data/actionables.db`. If a command unexpectedly writes to a non-test database, capture every affected Actionable ID and reconcile it even when validation fails.
- When reusing a Playwright server, set explicit dedicated `WEB_PORT` and `API_PORT` in the test process as well as `DATABASE_URL`. Verify that server's scope data and runtime before starting; a client-side database variable does not change the database of an already running server.
- Before marking a task `Done`, check whether the completed work requires updates to instructions or documentation in any repository `*.md` files, and make all necessary updates.
