# Local data and historical backups

The API uses `DATABASE_URL`, defaulting to `file:./data/actionables.db` from the
repository root. The SQLite database holds tasks, scopes, relationships,
Research, Resolution, validation records, activity, claims, and shared settings.
A separately installed release may configure a different database path; inspect
its launch configuration before maintenance.

Some browser preferences, including the default creation scope, live in browser
storage. The launcher's `data/runtime-ports.json` (or
`ACTIONABLES_RUNTIME_PORT_STATE_PATH`) only stores a preferred port pair; it is
not task data or a backup. The MCP bearer token is supplied through the process
environment.

The Data page and public JSON import/export routes were removed on September 7, 2026. This version has no built-in backup or restore workflow. Application data
continues to live in the configured local SQLite database; the removal does not
delete existing records, source evidence, or provenance.

Keep any portable JSON backups created by earlier versions. Those files require
a version that supports their format to restore; the current app cannot load them.
The internal seed/snapshot helpers are not a general recovery command for a
populated database.

Development startup and `db:setup` apply migrations and reconcile sample data.
Use an explicit disposable database for tests or diagnostic resets, and preserve
the populated database before migration recovery. See
[migration troubleshooting](windows-setup.md#migrations-fail) and
[test isolation](windows-setup.md#release-gate).

The [internal seed format](portable-data-format.md) remains in use by the bundled
sample-data initializer. It is not a user-facing import/export interface.
