# Technology Stack

## Overview

A DeepSeek Harness (DSH) plugin with two halves built by one script: a Node host half (tool + HTTP route) and a browser client half (React floating dock), each bundled separately so the client can never import host modules.

## Backend (host half)

- **Language**: TypeScript 5.5, strict mode, ES2022 target, `NodeNext` module resolution (`tsconfig.json`), ESM (`"type": "module"` in `package.json`).
- **Runtime**: Node (native `fetch`, `AbortController`/`AbortSignal.timeout`) inside the `dsh web` harness process.
- **Framework**: `@deepseek-ai/cordis` (peer dependency) for the plugin context; `@deepseek-ai/dsh-tools` `defineTool` for the `kenari_usage` tool; `@deepseek-ai/schemastery` for the config schema.
- **Version pinning**: `pnpm.overrides` pins the `@deepseek-ai/dsh-*` tree to a coherent `0.1.0-rc.8` line (caret rc ranges otherwise resolve across rc lines).

## Frontend (client half)

- **React 18** (`@types/react`/`@types/react-dom` in dev; react/react-dom/`@deepseek-ai/*` are esbuild externals resolved by the shell at runtime — not bundled).
- **Bundler**: esbuild 0.25 — `src/client/index.ts` → `dist/client.js` as a browser CJS bundle wrapped in `window.__ModuleLoader__.load({id: "dsh-kenari-usage", …})`.
- **Styling**: inline `CSSProperties` objects only; no CSS files, no CSS framework.

## Database

- None. Host state is module-level config memory; client persistence is `window.localStorage` (position/width/height/day-baseline keys).

## DevOps / Tooling

- **Package manager**: pnpm (≥10; git-hosted installs need `allowBuilds: dsh-kenari-usage: true` in the profile `pnpm-workspace.yaml` so the `prepare` build script may run).
- **Build**: `node build.mjs` — tsc emit for the host (`dist/kenari-usage.js` + `.d.ts`), esbuild bundle for the client (`dist/client.js`).
- **Typecheck**: `tsc --noEmit` (`pnpm typecheck`).
- **Tests**: vitest 3 (`pnpm test` → `vitest run`; 5 test files, ~39 tests).
- **Distribution**: installed into a DSH profile via `dsh plugin --profile web add github:azmirizkifar20/DSH-Kenari-Usage` (or a local dir/tarball); `package.json` declares `exports` plus a `dsh.client` block (`platform: web`, injected runtime packages) so the shell loads the dock.
