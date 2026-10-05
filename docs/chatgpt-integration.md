# Local Desktop Actionables review plugin

This vertical slice exposes one known Actionable for review. It adds two tools,
one embedded card, and a separate loopback listener. The existing Codex MCP
endpoint and coordination catalog retain their existing behavior.

The primary deployment uses the user's authenticated ChatGPT Desktop/Codex
environment and a repository-local plugin. No Secure MCP Tunnel, OpenAI Platform
runtime API key, public endpoint, ngrok, or OpenAI API integration is required.
The listener and SQLite database stay on this machine. Returned tool content
still enters the authenticated ChatGPT conversation; local transport does not
make model processing offline.

The local marketplace installation and Codex runtime discovery are verified.
**Actual embedded rendering in ChatGPT Desktop remains pending.** The existing
simulated UI host checks are separate evidence, not desktop acceptance.

## Implemented boundary

```text
ChatGPT Desktop / Codex -> local Actionables Review plugin
                       -> http://127.0.0.1:4184/mcp (read-only listener)
                       -> existing getActionable and Actionables domain backend
                       -> existing local Prisma/SQLite database (read-only)
```

| File / symbol                                                                                     | Responsibility                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/chatgpt-server.ts` / `startChatgptServer`                                           | Separate executable; explicit existing database, token and port; schema readiness check without migrations or seed. Does not import executable `server.ts` or reconcile Codex configuration. |
| `apps/api/src/chatgpt-mcp.ts` / `buildChatgptApp`, `readReview`                                   | Exact two-tool catalog and one UI resource. Transactional authoritative reads, privacy projection, archive opt-in, bounded context, version/hash checks. No REST API routes.                 |
| `apps/api/src/repository.ts` / `getActionable`                                                    | Existing authoritative state, hierarchy, dependencies, readiness and validation derivation. Reused without changes.                                                                          |
| `apps/api/src/mcp.ts` / `registerMcpRoutes`, `runTool`, `readableItemsPage`, `readableTextChunks` | Shared stateless Streamable HTTP transport, bearer and Host/Origin guards, error classification and native content paging. Existing server factory remains the default.                      |
| `apps/api/src/database.ts` / `createPrismaClient`                                                 | Optional SQLite `readonly` and `fileMustExist`; existing callers retain writable defaults.                                                                                                   |
| `packages/contracts/src/chatgpt.ts`                                                               | ChatGPT wire projection and input/output schemas, based on existing domain schemas. Separate `@actionables/contracts/chatgpt` export.                                                        |
| `src/chatgpt-review.tsx`, `src/chatgpt-review.css`                                                | Focused React card and MCP Apps bridge; read continuations/reload only.                                                                                                                      |
| `src/Markdown.tsx`                                                                                | Existing Markdown renderer with an opt-in inert mode for this card. Dashboard defaults preserved.                                                                                            |
| `vite.chatgpt.config.ts`                                                                          | Builds JavaScript/CSS inline into `dist/chatgpt/review.html`; no remote assets.                                                                                                              |
| `apps/api/tests/chatgpt-mcp.test.ts`                                                              | Synthetic database, real HTTP MCP client, all-table snapshots and actual production bundle browser checks.                                                                                   |

`actionables.get_actionable` accepts a positive public numeric `id`, optional
`includeArchived` (default false), and optional `version`, `offset` and
`contentHash`. Initial reads start at offset zero. Continuations require the
returned version and hash and use the returned `nextOffset` until `complete`.
Each page contains at most 40 native items and 8,000 serialized item characters;
long text is delivered as labeled chunks of at most 1,000 UTF-16 units. Summary
names are bounded; full names are also paged. Counts include empty fields.

`actionables.render_actionable_review` requires an identified `id` and exact
`version`, accepts the same archive option and optional hash, and re-reads the
database. Supply the preceding result's hash as well. The tool accepts no
model-authored task contents. Missing/invalid IDs do not create replacements.
Directly archived tasks and tasks under an archived root require explicit
inclusion; archived related references are labeled as context.

The hash includes projected related/root context, so a prerequisite change is
detected even if the selected task's version remains unchanged. On
`VERSION_CONFLICT`, discard partial context and retrieve offset zero without
the old version/hash. No claiming read, settings initialization, lifecycle
cleanup, or write operation is called. The registered catalog and read-only
SQLite connection enforce the boundary; annotations describe it to clients.

## UI and compatibility

The render tool links `_meta.ui.resourceUri` to
`ui://actionables/review/v1.html`, served as `text/html;profile=mcp-app` using
`registerAppTool` / `registerAppResource`. The card uses the standard `App`
bridge, registers listeners before connecting, receives tool results, and calls
only `actionables.get_actionable` for continuation/reload. It does not fetch
localhost APIs, load images/fonts, open links, persist content, or send writes.
The inline resource has no permitted connect/resource/frame domains. See the
current [MCP Apps UI documentation](https://developers.openai.com/plugins/build/chatgpt-ui)
and [quickstart](https://developers.openai.com/plugins/build/app-quickstart).

The card shows backend values for identity/state, finding/description, root and
parent, direct children and descendant progress, manual and dependency blockers,
waived/dismissed prerequisites, plans/readiness, qualifying and superseded
validation, resolution, research, status history and activity. Native collapsible
sections keep this smaller than the dashboard. Partial context is labeled;
stale context is cleared before reload.

The projection excludes raw imported evidence, file/source locators, workspace
paths, source threads, ownership/claim metadata and private activity context.
Returned titles, descriptions, research, validation evidence and activity
summaries can themselves contain private text or paths and are sent to ChatGPT;
this is not an automatic prose redaction service. Use synthetic data for this
acceptance. Markdown HTML is skipped, links are inert and images are replaced
with text. Production UI transport debug logging is removed; server errors omit
raw exceptions/stacks while retaining the tool name and correlation ID. Tokens
and review payloads are not logged.

`@modelcontextprotocol/ext-apps` is pinned to **1.7.5** in the root and API
packages. Its peer dependencies support the existing MCP SDK 1.29 / Zod 4 /
React 19. The current 2.0.3 release requires the SDK 2.x packages; upgrading the
existing coordination server is outside this proof. No backend dependency
upgrade or domain migration was needed.

SDK 1.29 clients validate any `structuredContent` against the success output
schema even when `isError` is true. This adapter therefore returns shared
Actionables error JSON in standard text content, with `isError: true`, and
omits error `structuredContent`. Successes retain their structured output.
The existing Codex error contract is unchanged.

## Repeat the isolated local proof

From the repository root, use the pinned Node/pnpm versions. The outer database
guard below is disposable; the focused test creates and migrates its own unique
synthetic database and binds an ephemeral dedicated loopback port. Only fixture
setup and an explicit drift simulation write to that synthetic database.

```powershell
$proofDir = Join-Path ([IO.Path]::GetTempPath()) ('actionables-chatgpt-run-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $proofDir | Out-Null
$env:DATABASE_URL = 'file:' + (Join-Path $proofDir 'guard.db').Replace('\', '/')
corepack pnpm run build:chatgpt
corepack pnpm exec vitest run apps/api/tests/chatgpt-mcp.test.ts
```

The test prints a `proof.json` path containing the actual synthetic database
URL, built HTML path and public fixture IDs. Keep that manifest path to reuse
the fixture for Inspector and manual ChatGPT acceptance. No token is stored in
it. The tests stop their own listener/client/browser; disposable files remain
in Windows TEMP. Do not run `dev`, `db:setup`, or a sample seed against the
normal database for this proof.

In a dedicated PowerShell session, start the built listener:

```powershell
$manifest = Get-Content -Raw -LiteralPath '<printed proof.json path>' | ConvertFrom-Json
$env:DATABASE_URL = $manifest.databaseUrl
$env:CHATGPT_MCP_PORT = '4184' # Verify this dedicated port is unused first.
$env:ACTIONABLES_CHATGPT_MCP_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
corepack pnpm run start:chatgpt
```

Startup requires an explicit **absolute** `file:` URL naming an existing migrated
SQLite file, a token of at least 32 characters, the built UI resource and an
explicit port. It binds `127.0.0.1`, never migrates/seeds, and has no implicit
normal database or port fallback. Stop this owned foreground process with
Ctrl+C. Production connection to the normal database is a later deliberate
operator decision; use synthetic data for acceptance here.

## MCP Inspector

Create a private Inspector JSON configuration outside the checkout:

```json
{
  "mcpServers": {
    "actionables-proof": {
      "type": "http",
      "url": "http://127.0.0.1:4184/mcp",
      "headers": { "Authorization": "Bearer <proof listener token>" }
    }
  }
}
```

Treat the configuration as a secret. With the listener running:

```powershell
corepack pnpm dlx @modelcontextprotocol/inspector@latest --cli --config '<private inspector.json path>' --server actionables-proof --method tools/list --strict
corepack pnpm dlx @modelcontextprotocol/inspector@latest --cli --config '<private inspector.json path>' --server actionables-proof --method tools/call --tool-name actionables.get_actionable --tool-arg id=1001
corepack pnpm dlx @modelcontextprotocol/inspector@latest --cli --config '<private inspector.json path>' --server actionables-proof --method tools/call --tool-name actionables.render_actionable_review --tool-arg id=1001 --tool-arg version=1
corepack pnpm dlx @modelcontextprotocol/inspector@latest --cli --config '<private inspector.json path>' --server actionables-proof --method resources/list
corepack pnpm dlx @modelcontextprotocol/inspector@latest --cli --config '<private inspector.json path>' --server actionables-proof --method resources/read --uri ui://actionables/review/v1.html
```

Use the actual returned version/hash for render after edits. Also inspect UI
metadata with `ui-app-info`. Verify missing/invalid IDs, omitted authorization
(401), and unavailable write tools. GET/DELETE return 405; this stateless
endpoint does not expose a standalone event stream. UI resource inspection
confirms metadata/HTML, not a real ChatGPT host render.

## Install the repository-local desktop plugin

The minimum package is three JSON files: one marketplace, one plugin manifest,
and one MCP connection file. It bundles no skills, hooks, backend executable,
dashboard, auth client, or duplicate domain code. The compatibility manifest
format is supported by current OpenAI documentation and verified with this
host's installed `codex-cli 0.155.0`; migrating it to portable `plugin.json` /
`mcp.json` is unnecessary for this proof.

The files are `.agents/plugins/marketplace.json`,
`plugins/actionables-review/.codex-plugin/plugin.json`, and
`plugins/actionables-review/.mcp.json`. No additional package dependency or
HTTP-to-stdio adapter is needed.

From this repository root:

```powershell
codex plugin marketplace add . --json
codex plugin list --marketplace actionables-local --available --json
codex plugin add actionables-review@actionables-local --json
codex plugin list --marketplace actionables-local --json
```

The installed CLI supports `plugin add`; the desktop Plugins Directory is the
documented interactive alternative. Open this trusted repository in Desktop,
restart/refresh the desktop client, choose **Actionables (local)** in the
Plugins Directory, and install/enable **Actionables Review**. Use the existing
ChatGPT sign-in. Local marketplace availability can vary by client surface;
ChatGPT web cannot directly reach this machine's loopback server.

Codex stores the marketplace and enabled plugin choice in user configuration
outside Git and loads an installed cache copy. On this host the installer
reported `~/.codex/plugins/cache/actionables-local/actionables-review/0.1.0`;
use the returned `installedPath`, not an assumed cache version directory.
After package edits, refresh the marketplace/reinstall the local plugin and
restart the desktop client so the installed copy updates. The repo marketplace
remains the source of truth. An optional trusted repo setting can select it:

```toml
[plugins."actionables-review@actionables-local"]
enabled = true
```

Do not commit a token or a machine-specific database path. `.mcp.json` connects
directly to `http://127.0.0.1:4184/mcp` and uses
`bearer_token_env_var = ACTIONABLES_CHATGPT_MCP_TOKEN`. The installed runtime
was verified to send this credential as bearer authentication. Desktop must
inherit the **same** token as the listener: loading it in a child terminal
cannot alter an already-running desktop process. Fully quit Desktop and launch
it from the private PowerShell environment containing that token, or configure
the operator's existing machine-local environment and restart Desktop. Keep
the listener running in its own session. No Platform key is involved.

To launch both from one private environment, use the manifest/database/token
variables established above. Fully quit Desktop yourself first. Then, from
the repository root:

```powershell
$listener = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'apps/api/dist/chatgpt-server.js' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru
# Launch the installed interactive Desktop executable from this same environment.
Start-Process -FilePath '<installed ChatGPT Desktop / Codex executable>'
# After acceptance, stop only the listener started above.
Stop-Process -Id $listener.Id
```

Keep the listener alive throughout the Desktop check; run the last command
only afterward. Do not launch a second listener while the foreground example
is already running. A previous private `proof.env` can supply the same three
values to a new shell without displaying them; it is an operator artifact,
not plugin content. Sign-in and Desktop plugin selection remain operator steps.

Keep port 4184 dedicated. If it must change, update the plugin's loopback URL
and `CHATGPT_MCP_PORT` together, then refresh the installed copy. On 401/403,
verify process environment, port and loopback Host/Origin; retain the existing
guards. The listener is intentionally started separately so installation
cannot choose a database, migrate/seed it, or start the writable app.

For acceptance, select only this review integration. The existing full Codex
coordination server is a separate integration with write tools; it must not be
in the test chat's available tool context. Do not interpret a prompt refusal
while write tools remain callable as proof of mutation unavailability. Do not
disable unrelated integrations globally just to test this plugin.

See the current [OpenAI plugin packaging and local marketplace guide](https://developers.openai.com/plugins/build/plugins)
and [Desktop/Codex MCP configuration](https://developers.openai.com/codex/mcp).

No repository runtime code was added solely for Secure MCP Tunnel. Only the
former setup instructions and acceptance prerequisites depended on it. All
existing Streamable HTTP, bearer/Host/Origin, SQLite readonly, projection,
paging and MCP Apps UI work is reused. No tunnel client/service was installed
or started for this local deployment.

## Acceptance and evaluation record

Verified on 2026-10-05:

- Local `actionables-local` marketplace registration and installation of
  `actionables-review@actionables-local` passed using the installed CLI.
  Read-back reports installed/enabled and the correct repository source.
- The installed Codex runtime loaded the package with the existing ChatGPT
  sign-in and `bearerToken` authentication. Its review server discovers exactly
  `actionables.get_actionable` and `actionables.render_actionable_review`, both
  annotated read-only, and the MCP Apps UI resource.
- In a temporary in-memory app-server session, actual plugin calls retrieved
  synthetic Actionable 1001 and returned the render result with its version/hash.
  The fetched UI resource exactly matched the built 739,356-byte review HTML
  (SHA-256 `654baa05e1a8cb3f895d9be3f3b0373903297d8703b9c34949b0aa8a12af5e7a`).
  No model turn was started; the plugin contains no OpenAI API client or
  Platform key configuration.
- `actionables.update_task` was rejected as an unavailable tool; a missing ID
  returned an error. All 14 synthetic SQLite tables remained logically identical
  to the baseline (SHA-256
  `dfa70e01cbcc2e446fdbfd8ad69cba30e712eb696557d8862090562b96e3d6a3`).
  These are plugin/runtime checks; actual Desktop tool selection and visible
  embedded rendering remain pending.

- `build:chatgpt` and `typecheck` passed.
- Eight focused tests passed: exact catalog/write rejection; backend equality
  and privacy projection; ID/archive/version errors; large UTF-16 native paging
  and hash/offset errors; independent related-state drift; auth/Host/Origin and
  readonly/startup guards; built card delivery/safe Markdown; bridge paging and
  stale/error recovery.
- 111 existing tests passed across `mcp.test.ts`, `agent-tasks.test.ts`,
  `lifecycle.test.ts` and `relationships.test.ts`, with isolated databases.
- Every persisted table was identical before/after read workflows, including
  claims (expired and active), activity, versions, settings, receipts and
  migration state. The normal application database was not a proof fixture.
- Inspector CLI passed initialization, strict catalog/schema/annotation checks,
  get/render, UI metadata/resource reads, errors and missing-bearer rejection.
  Separate before/after snapshots of all 14 synthetic SQLite tables matched.
- Browser checks used the actual built HTML in a compatible **simulated** MCP
  Apps host with real MCP backend reads, no image/link loads or direct network
  requests. This is not a ChatGPT render result.

Manual ChatGPT evaluation remains pending. Use only the synthetic plugin/fixture
and record actual tool calls, arguments, card behavior and database comparison:

| Prompt / scenario                                                | Expected behavior                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| “Retrieve Actionable 1001 and show its review.”                  | Get known ID, then render with returned version/hash; actual card shows hierarchy, blockers, validation and history. |
| “Why is Actionable 1001 blocked, and what evidence supports it?” | Get 1001; report backend manual/dependency state and relevant context accurately.                                    |
| Follow-up “Show that one” / “What about its validation?”         | Preserve previously identified ID; reread as needed, render known version; no guessed IDs.                           |
| “Show Actionable 999999.” / invalid ID 0                         | Return missing/invalid result; no replacement and no write.                                                          |
| “Show archived Actionable 1008.”                                 | Explicit archive inclusion; labeled archive state, no restore.                                                       |
| “Review Actionable 1009.”                                        | Partial indicator, bridge continuation, full large text; no silent truncation.                                       |
| Change synthetic prerequisite between pages                      | Hash conflict discards partial context; deliberate fresh reload.                                                     |
| “Mark Actionable 1001 Done.”                                     | Explain read-only capability; no write call or claim.                                                                |
| “Explain photosynthesis.” / “What is invoice 1001?”              | No Actionables invocation merely because a number appears.                                                           |

Final desktop acceptance requires this real path: authenticated ChatGPT Desktop
-> installed local plugin -> read-only listener -> get -> render -> embedded
card, with synthetic hierarchy,
dependencies, validation and research displayed, rejected mutation calls, and
unchanged logical database snapshots afterward. Use the all-table snapshot
method in the focused test to compare the same synthetic database, rather than
comparing SQLite file bytes. Record actual Desktop discovery, calls and visible
rendering separately from Inspector or app-server metadata/resource checks.

Bounded search is explicitly deferred. This proof exposes known-ID retrieval
and rendering only.
