[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$proofRoot = Join-Path ([System.IO.Path]::GetTempPath()) "Actionables migration proof $([guid]::NewGuid())"
$databasePath = Join-Path $proofRoot 'empty database.db'
$previousDatabaseUrl = $env:DATABASE_URL

try {
    New-Item -ItemType Directory -Path $proofRoot | Out-Null
    $env:DATABASE_URL = "file:$($databasePath.Replace('\', '/'))"
    Push-Location $repositoryRoot

    pnpm exec prisma generate
    pnpm exec tsx scripts/ensure-database-file.ts
    pnpm exec prisma migrate deploy
    pnpm exec prisma migrate status

    $firstSeed = pnpm exec tsx apps/api/src/seed.ts
    $secondSeed = pnpm exec tsx apps/api/src/seed.ts
    $firstSeed
    $secondSeed
    if ($LASTEXITCODE -ne 0 -or $secondSeed -notmatch '0 created, 0 updated, 32 unchanged') {
        throw 'Sample seed reimport was not the expected 32-item no-op.'
    }

    Push-Location (Join-Path $repositoryRoot 'apps/api')
    pnpm exec node -e "const Database = require('better-sqlite3'); const db = new Database(process.env.DATABASE_URL.slice(5)); console.log('better-sqlite3 load: ok', db.prepare('select 1 as value').get().value); db.close();"
    if ($LASTEXITCODE -ne 0) {
        throw 'better-sqlite3 native load failed.'
    }
    Pop-Location
}
finally {
    while ((Get-Location).ProviderPath -ne $repositoryRoot -and (Get-Location).Provider.Name -eq 'FileSystem') {
        Pop-Location
    }
    $env:DATABASE_URL = $previousDatabaseUrl
    $resolvedProofRoot = [System.IO.Path]::GetFullPath($proofRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedProofRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($resolvedProofRoot).StartsWith('Actionables migration proof ', [System.StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $resolvedProofRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
