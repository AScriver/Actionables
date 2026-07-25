# Windows setup and local operation

## Prerequisites

- Supported 64-bit Windows version and Node runtime listed in [support policy](support-policy.md).
- PowerShell 7.
- Current Microsoft Edge or Google Chrome.
- Git for a source checkout.

The repository pins pnpm through `package.json` and the intended Node release line through `.node-version`. Do not install project packages globally.

No `.env` file is required. The default database is `file:./data/actionables.db`; set `DATABASE_URL` only when an isolated database is intentional.

## Clean setup

Run from a normal Windows path; spaces are supported.

```powershell
git clone <repository-url> 'C:\Users\<you>\Documents\Actionables Dashboard'
Set-Location -LiteralPath 'C:\Users\<you>\Documents\Actionables Dashboard'
node --version
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm --version
pnpm install --frozen-lockfile
pnpm run db:generate
pnpm run db:migrate
pnpm run db:seed
pnpm run db:seed
```

The second seed import must report `0 created, 0 updated, 32 unchanged`.

The default database is `data/actionables.db`. To isolate a database for testing or recovery:

```powershell
$env:DATABASE_URL = 'file:./data/actionables-recovery.db'
pnpm run db:migrate
pnpm run db:seed
```

Unset the override when finished:

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

## Development operation

```powershell
pnpm run dev
```

This migrates and seeds the configured database, then starts:

- Web: `http://127.0.0.1:4173`
- API: `http://127.0.0.1:4174`
- Health: `http://127.0.0.1:4173/api/health`

Stop with `Ctrl+C`. A repeat `pnpm run dev` is the supported restart.

## Production-mode local operation

```powershell
pnpm run build
pnpm run db:migrate
pnpm run start
```

Verify health:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/health'
```

Stop with `Ctrl+C`; repeat `pnpm run start` to verify a clean restart.

## Release gate

```powershell
pnpm run verify:release
```

Individual diagnostics:

```powershell
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run test:e2e
pnpm run test:a11y
pnpm run build
pnpm run verify:migrations
pnpm run verify:living-plan
```

## Troubleshooting

### Native SQLite installation or load

Always install from the lockfile under a supported Node runtime. Clear only the checkout-local install and reinstall if the ABI changed:

```powershell
Remove-Item -LiteralPath '.\node_modules' -Recurse -Force
pnpm install --frozen-lockfile
pnpm --filter @actionables/api exec node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); console.log(db.prepare('select 1 as value').get()); db.close();"
```

pnpm can retain native-package side effects in a shared store. The release proof found that a store populated under Node 22 could reuse an incompatible native ABI artifact under Node 24 even after checkout-local `node_modules` was removed. Repeat the install with a new runtime-specific store:

```powershell
Remove-Item -LiteralPath '.\node_modules' -Recurse -Force
$runtimeStore = Join-Path $env:LOCALAPPDATA 'Actionables\pnpm-store-node24'
pnpm install --frozen-lockfile --store-dir $runtimeStore
pnpm --filter @actionables/api exec node -e "const Database = require('better-sqlite3'); const db=new Database(':memory:'); console.log(db.prepare('select 1 as value').get()); db.close();"
```

The verified clean Node 24 install used the package's prebuilt binary. If installation attempts unexpected local compilation or the load still fails, record Node, pnpm, architecture, store path, and the full output. Do not work around the gate with an unreviewed package upgrade.

### Ports 4173 or 4174 are busy

```powershell
Get-NetTCPConnection -LocalPort 4173,4174 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,State,OwningProcess
```

Stop the known process or use a different API port and matching Vite proxy configuration. The documented release proof uses the default ports.

### Migrations fail

```powershell
pnpm exec prisma migrate status
pnpm run verify:migrations
```

Never edit an already-applied migration. Preserve the database and export a portable backup before recovery.

### Database reset or recovery

Portable JSON is the supported backup and restore mechanism. Follow [backup and restore](backup-restore.md). For a disposable database only, stop the app, verify the exact `data\*.db` target, remove it, then rerun `pnpm run db:migrate`. Do not delete a populated database until a verified portable export exists.

### Browser does not start

Open `http://127.0.0.1:4173` manually in a supported browser and verify `/api/health`. For Playwright:

```powershell
pnpm exec playwright install chromium
pnpm run test:e2e
```

### Unsupported import version

The MVP accepts portable schema version `1` exactly. Do not hand-edit a future-version export into version 1. Keep the original file and use the application version that created it or a documented future migration tool.
