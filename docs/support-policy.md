# Runtime and browser support

Current runtime requirements come from the checked-in manifests. The exact
platform and browser versions below are historical verification from July 25,
2026; they do not establish that every later change passed the same release gate.

## Runtime

The declared Node.js range is `>=22.19.0 <25`; pnpm is exactly `11.9.0`.
Node `24.18.0` is pinned in [`.node-version`](../.node-version).
Node `22.19.0` and `24.18.0` both completed isolated frozen-lockfile installs,
native SQLite loads, and the release gate recorded in the
[original release report](release-verification.md).

[`package.json`](../package.json) is authoritative through `engines` and
`packageManager`; [`.npmrc`](../.npmrc) enables strict engine checking.
Runtimes outside the declared range are unsupported. Setup also uses PowerShell
7 and Git. Check `node --version` and `pnpm --version` before installing; a
different package manager on `PATH` may not honor the project's pin.

## Browsers and platform

The recorded platform was Windows 11 Enterprise 25H2, build 26200.8390, x64.
The supported browser targets are current Microsoft Edge and Google Chrome on
Windows. The July release proof used Edge `150.0.4078.83` and Chrome
`150.0.7871.182`, with Playwright Chromium `149.0.7827.55` as its primary
automated engine. These are recorded versions, not recommendations to install
old browser releases.

Firefox, Safari, macOS, Linux, mobile operating systems, and other Windows versions were not independently verified. This is an explicit evidence boundary, not evidence that they fail.

## Product boundary

The supported deployment is local and single-user, with both listeners bound to
`127.0.0.1`. There are no user accounts, team roles, notifications, cloud sync,
or hosted multi-user deployment.

Codex integration is implemented: desktop handoff links, an authenticated MCP
endpoint, and optional local CLI helpers. The Inbox triager can update priority
and other triage fields; note grooming requires review and apply; the relationship
auditor returns recommendations without changing relationships. The MCP bearer
token is not dashboard login or multi-user authentication.

Repository provisioning reads Git metadata to resolve local scope. Actionables
does not mutate Git or implement project code. Source startup scripts are bundled;
external runtime managers, installers, and update mechanisms are outside this
repository. See [Windows setup](windows-setup.md) for source operation and
verification, and [local data](backup-restore.md) for storage limitations.
