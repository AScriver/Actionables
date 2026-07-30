# Actionables repository safeguards

- When work in this repository is coordinated through Actionables, follow the `actionables-workflow` skill. If the skill is unavailable, use `resources/agent-integration/actionables-workflow/SKILL.md` as the workflow source.
- Run any test or helper that creates or mutates Actionables only with an explicit isolated `DATABASE_URL`; never use the default `file:./data/actionables.db`. If a command unexpectedly writes to a non-test database, capture every affected Actionable ID and reconcile it even when validation fails.
- Before marking a task `Done`, check whether the completed work requires updates to instructions or documentation in any repository `*.md` files, and make all necessary updates.
