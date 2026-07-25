# MVP runtime and browser support

Verified 2026-07-25.

## Runtime

The enforced Node.js range is `>=22.19.0 <25`; pnpm is exactly `11.9.0`. Node 24.18.0 is the intended release runtime selected by `.node-version`. Node 22.19.0 is also supported because both completed isolated frozen-lockfile installs, native SQLite loads, and the same full release gate on Windows.

`package.json` is authoritative through `engines` and `packageManager`; `.npmrc` enables strict engine checking. Runtimes outside the declared range are unverified and installation is intentionally rejected.

## Browsers and platform

The verified platform is Windows 11 Enterprise 25H2, build 26200.8390, x64. The MVP supports current Microsoft Edge and Google Chrome on Windows. The release proof used Edge 150.0.4078.83 and Chrome 150.0.7871.182, with Playwright Chromium 149.0.7827.55 as the primary automated engine.

Firefox, Safari, macOS, Linux, mobile operating systems, and other Windows versions were not independently verified. This is an explicit evidence boundary, not evidence that they fail.

## Product boundary

The supported deployment is local and single-user. Authentication, accounts, collaboration, assignment, notifications, cloud synchronization, hosted deployment, live Codex integration, Git manipulation, AI-generated priority/dependencies, and generic project-management features are non-goals.
