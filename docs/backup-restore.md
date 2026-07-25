# Portable backup and restore

Portable JSON is the only supported MVP backup mechanism. Automatic backups and copying the SQLite database file are not supported recovery workflows.

## Create a backup

1. Open **Data** in the application.
2. Select **Export backup**.
3. Keep the timestamped `actionables-backup-YYYYMMDD-HHMMSSZ.json` file downloaded by the browser.
4. Confirm the document has `schemaVersion: 1` and a non-empty `metadata.exportedAt`.

Browsers normally save the file in the configured Downloads folder or prompt for a location. The application does not control or remember that destination.

The export includes projects, repositories, worktrees, actionables, user edits, imported evidence, sources, tags, hierarchy, dependencies and waivers, validation supersession chains, lifecycle/activity history, archive state, import provenance, and stable portable identifiers. It excludes the SQLite file, application binaries and dependencies, browser settings/history, OS configuration, and transient import-preview tokens.

Exports can contain sensitive technical paths, source excerpts, research notes, commands, and repository context. Store them using the same access controls and encryption expected for source material; do not attach them to public issues or chats.

## Restore into a fresh database

1. Stop the application.
2. Choose a new database path and apply all migrations:

   ```powershell
   $env:DATABASE_URL = 'file:./data/actionables-restore.db'
   pnpm run db:migrate
   pnpm run dev
   ```

3. Open **Data**, choose the backup JSON, and review the non-mutating preview.
4. Resolve any reported conflicts. Relationship suggestions are not facts until selected.
5. Select **Review selections**, then **Commit reviewed import**.
6. Verify the affected-record links and representative projects, relationships, validations, history, archive state, and provenance.
7. Export the restored database and compare it semantically with the source export. Generated export timestamps and database-local identifiers may differ; portable identities and domain content must match.
8. Stop the app and clear the override when finished:

   ```powershell
   Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
   ```

## Failure handling

- A malformed, future-version, stale-preview, conflicting, or invalid document must not partially commit.
- If `schemaVersion` is not `1`, retain the source file unchanged. Use the application version that supports it or a documented future converter.
- If restoration fails, keep the source export, record the correlation/request ID shown by the UI, and retry against another newly migrated empty database after resolving the reported cause.
- A successful preview is not a restore. The explicit commit and post-restore verification are required.
