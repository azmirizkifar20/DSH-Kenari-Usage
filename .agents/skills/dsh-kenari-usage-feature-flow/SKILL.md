---
name: dsh-kenari-usage-feature-flow
description: Workflow for implementing, changing, extending, or refactoring features in dsh-kenari-usage. Covers current-state documentation, runtime-path tracing, tests, verification, and documentation updates.
---

# dsh-kenari-usage Feature Flow

Follow this flow for feature work in this repository.

## 1. Read the current-state docs first

- Start by checking [docs/features/README.md](../../../docs/features/README.md).
- Find the most relevant existing doc with repo terms before coding: `01-kenari-usage-tool.md` covers the host half (tool + route), `02-usage-dock-ui.md` covers the browser dock.
- Also check [docs/steering/](../../../docs/steering/) for architecture, routing, tech-stack, api-conventions, and system-flow context.

## 2. Trace the real runtime path

- Prove the implementation path from the repo, not from assumptions.
- Entry points: host `apply(ctx, config)` in `src/kenari-usage.ts`; client `apply(ctx)` in `src/client/index.ts`; dual build in `build.mjs`.
- The client half cannot import host modules — `react` and `@deepseek-ai/*` are shell-provided esbuild externals. Shared values must travel through the `GET /dsh-kenari-usage` JSON contract (`src/client/api.ts` mirrors it in `DockPayload`/`DockFailure`).

## 3. Add or update tests when they materially protect the change

- Treat test evaluation as part of the implementation, not optional follow-up.
- Add a focused test or update an existing one when the change affects behavior that is easy to regress or expensive to verify manually (feature flow, domain rules, calculations, parsers, persistence, reusable UI logic with meaningful branching).
- Do not force tests for every low-risk edit (copy tweaks, layout-only adjustments, trivial wiring). When you choose not to add tests, state the reason in the completion summary.
- Match the existing vitest layout in this repo:
  - Unit tests for isolated domain logic, formatting, helpers: `src/quota.test.ts` (live parsers/formatters).
  - Integration tests with mocked fetch: `src/tool.test.ts` (tool execute/render), `src/route.test.ts` (route contract).
- Framework is vitest only (see `package.json` `test` script); there is no phpunit/jest/pytest config.

## 4. Verify the changed path

- Run the focused tests you added or changed; confirm they pass. Repo test command: `pnpm test` (vitest run). Focused: `npx vitest run src/route.test.ts`.
- Also run `pnpm typecheck` (tsc --noEmit) and `pnpm build` (node build.mjs) when touching `src/` or `build.mjs`.
- After installing or rebuilding into a profile, restart `dsh web` — the client module table is scanned at boot, so dock changes do not appear until restart.
- If no test was added because the change was low-value to cover, verify the path with another focused check matching the risk (manual run, targeted curl of `/dsh-kenari-usage`, DevTools check of the dock).

## 5. Update or create docs after implementation

Docs are part of feature work, not optional follow-up. Never leave implementation reflected only in code.

**When creating a NEW feature or a feature not covered by an existing doc:**
1. Create a new numbered feature doc in `docs/features/...md` (sequential numbering, e.g. if highest is `02-...md`, new doc is `03-...md`)
2. Follow the same structure as existing feature docs (flow, routes, domain, UI, data shape)
3. Add an entry + link to that new doc in `docs/features/README.md` index

**When REVISING/CHANGING an existing feature:**
1. Update the existing feature doc in `docs/features/` that covers it
2. REPLACE the `**Recent**:` line in `docs/features/README.md` with ONLY the latest change — one short sentence ≤ 300 chars (never append to it — the line holds just the single most recent change); set `**Updated**:` to today's date
3. If the change affects the dock UI, also update the relevant `docs/design-system/dock/` doc, and REPLACE the `**Updated**:` line in `docs/design-system/README.md` with ONLY today's date + the latest change — one short sentence ≤ 300 chars (never append to it)

**When a bug / root cause is investigated or fixed:**
1. Create `docs/issue/YYYY-MM-DD_nama-issue.md`
2. If it changes feature behavior, update the matching `docs/features/` doc too

## Repo conventions

- TypeScript strict, ESM (`"type": "module"`, NodeNext); host imports of sibling modules use explicit `.js` extensions (`./quota.js`).
- Semicolon style is mixed: `src/quota.ts` uses semicolons; everything else (`src/kenari-usage.ts`, `src/client/*`, tests, `build.mjs`) omits them — match the file you are editing.
- 2-space indent, single quotes, trailing commas in multi-line literals.
- Host/client services are consumed through structural mirrors (local interfaces like `UsageWebServer`, `DockSlotsService`), never through direct imports of host internals.
- Tool render/card functions (`output.render`, `presentationMeta`, `presentCall`, `presentResult`) and everything in `src/quota.ts` are pure — no I/O, no clock, no random — so they replay safely.
- Error shape: `{error: string, retryable: boolean}`; route failure `{ok: false, error, retryable}`; 401/403 map to non-retryable errors with actionable messages.
- Secrets: the `kn-` apiKey lives only in the profile's `cordis.patch.yml` — never commit it, never bundle it into `dist/`, never log it, never return it from the route.
- Display formatting: the dock localizes client-side (`formatInt`/`formatRpId`/`formatCompact` in `src/client/KenariDock.tsx`); host tool text stays plain (`formatRp` in `src/quota.ts`).
<!-- feature-flow-creator v2.4.6 -->
