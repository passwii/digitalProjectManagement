# Graphite Workbench Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to execute this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Apply the approved graphite-dark visual direction across the authenticated cloud office workbench while preserving business data, routing, permissions, mobile navigation, and accessibility.

**Architecture:** Add a workbench-scoped semantic token layer to the existing shell so login, Spark, and Stream Monitor keep their isolated surfaces. Shared controls and page-specific CSS consume that layer; Dashboard receives the most visible treatment first. Refresh `DESIGN.md` and its Impeccable sidecar from the implemented tokens.

**Tech Stack:** Next.js 14, React 18, TypeScript, CSS Modules, global CSS tokens, Vitest, Impeccable.

## Global Constraints

- The authenticated workbench uses graphite surfaces with saturated blue, mint, amber, coral, and rose data colors; border highlights use bright edges and inset top lines.
- Blue is the primary action, focus, and selection signal; mint marks positive status and data instead of becoming the default primary-button fill.
- Ordinary workbench cards use their border and inset top highlight without a broad outer shadow; reserve soft shadows for floating menus and dialogs.
- Keep the dark theme as the default; the light theme remains available with equivalent semantic roles and readable contrast.
- Apply new workbench tokens only under `.shell[data-console-shell="true"]`; preserve `/login`, `/spark`, and `/stream-monitor` color systems.
- In global CSS, scope workbench rules with `[data-console-shell="true"]`; the actual `.shell` class is a CSS Module hash and cannot be matched literally from `globals.css`.
- Preserve API response fields, route behavior, URL state, permission checks, and mobile Dock grouping.
- Keep CSS colors and motion durations in semantic tokens; use `var(--av-*)` for motion timing and preserve `prefers-reduced-motion` / `?static=1` behavior.
- Keep desktop table column relationships; retain existing mobile card adaptations and 44px minimum touch targets.
- Do not add page-level explanatory labels that repeat what layout already communicates.

---

## Files and Ownership

- `web/components/ui/Shell.module.css`: workbench-scoped dark/light palette, shell, navigation and topbar treatment.
- `web/app/globals.css`: shared buttons, fields, tables, cards, badges and page primitives; continue to consume semantic variables.
- `web/components/ui/*.module.css`, `web/components/mobile/*.module.css`, `web/components/theme/ThemeModePicker.module.css`, `web/components/pwa/InstallPrompt.module.css`, `web/components/auth/ChangePasswordForm.module.css`: shared interactive primitives and responsive states.
- `web/lib/workbenchPortalContainer.ts` and `web/lib/workbenchPortalContainer.vitest.test.ts`: shared portal target selection and its DOM contract.
- `web/components/ui/Modal.tsx`, `web/components/ui/Select.tsx`, `web/components/mobile/BottomSheet.tsx`, `web/components/pwa/InstallPrompt.tsx`: mount Dialog, Drawer, Confirm, Select listbox, BottomSheet, and install-prompt overlays inside the authenticated shell when it exists so scoped tokens reach them; keep `document.body` as the target on isolated routes.
- `web/app/(dashboard)/dashboard/dashboard.module.css`, `web/components/dashboard/*.module.css`: Dashboard hierarchy, chart panels, project health and intervention queue.
- `web/app/(dashboard)/assets/assets.css`, `web/app/(dashboard)/finance/finance.module.css`, `web/app/(dashboard)/projects/[id]/ProjectReceivables.module.css`, `web/app/(dashboard)/changelog/changelog.module.css`, `web/app/(dashboard)/dev/date-picker/date-picker.module.css`: feature-specific surfaces.
- `web/lib/workbenchThemeTokens.vitest.test.ts`: scoped palette and contrast contract.
- `DESIGN.md`, `.impeccable/design.json`: canonical workbench design and generated Impeccable sidecar.

## Tasks

### Task 1: Define the palette contract

**Files:** Create `web/lib/workbenchThemeTokens.vitest.test.ts`.

- [x] Test that the console shell owns `--bg`, `--card`, `--card-lift`, `--ink`, `--line`, `--brand`, status colors, and data-series colors in both dark and light themes.
- [x] Test dark text/surface, light text/surface, navigation, focus, and primary-action contrast using the literal values parsed from the shell token blocks.
- [x] Test that global root light-theme tokens remain defined for isolated routes.
- [x] Run `cd web && npx vitest run lib/workbenchThemeTokens.vitest.test.ts`; confirm it fails because the scoped console palette is not yet defined, then rerun after implementation and confirm all assertions pass.

### Task 2: Add workbench-scoped tokens and shell styling

**Files:** Modify `web/components/ui/Shell.module.css`; create the token implementation required by Task 1.

- [x] Define graphite dark values on `.shell[data-console-shell="true"]` and bright-light values on the corresponding `:global(:root[data-theme="light"])` selector.
- [x] Alias existing semantic names (`--bg`, `--card`, `--ink`, `--brand`, `--action`, `--warn`, `--danger`, `--done`, `--line`, `--nav-*`, and data series) to the console palette so descendants use the new design without route or API changes.
- [x] Set workbench-only radii to 10px controls, 6px compact badges, 12px panels, and retain the 18px mobile sheet surface.
- [x] Strengthen the expanded/collapsed rail, active-navigation outline, topbar boundary, account menu, and 767px mobile shell while preserving the fixed five-slot Dock.
- [x] Run the focused token contract test; confirm all assertions pass.

### Task 3: Restyle shared controls and page primitives

**Files:** Modify shared sections of `web/app/globals.css`; modify the shared UI, mobile, theme, PWA, and auth CSS files listed under Files and Ownership.

- [x] Give buttons, inputs, selects, table frames, page headers, pagination, badges, cards, dialogs, drawers, empty/error states, and toasts stronger neutral borders with visible inset highlights.
- [ ] Keep ordinary bordered cards edge-led by removing their broad outer shadow; retain soft elevation for floating overlays.
- [x] Use saturated semantic edges only for focus, selection, status, warnings, danger, and success; keep hover and disabled states legible in both themes.
- [x] Preserve current interaction dimensions and keyboard behavior; use `var(--av-*)` for motion and the reduced-motion behavior already present.
- [x] Resolve the portal boundary for Dialog, Drawer, Confirm, Select listbox, BottomSheet, and the install prompt: mount inside `.shell[data-console-shell="true"]` when it exists so the scoped workbench tokens apply, and fall back to `document.body` on `/login`, `/spark`, and `/stream-monitor`. Keep `PullToRefresh` scroll behavior unchanged.
- [x] Scope global workbench rules through `[data-console-shell="true"]`, not the hashed `.shell` class; extend the palette test to prevent stale literal `.shell[data-console-shell="true"]` selectors in `globals.css`.
- [x] Confirm no shared CSS edit changes isolated login, Spark, or Stream Monitor presentation.

### Task 4: Restyle Dashboard

**Files:** Modify `web/app/(dashboard)/dashboard/dashboard.module.css` and `web/components/dashboard/DashboardReadout.module.css`, `DashboardRouteField.module.css`, `DashboardInterventionQueue.module.css`.

- [x] Apply the approved reference direction to the KPI row, project health list, intervention queue, spend trend, subject breakdown, and delivery log.
- [x] Use blue, mint, amber, coral, and rose only where their data or state meaning is clear; strengthen panel edges and project rows without adding decorative loops.
- [x] Preserve the API model, role-specific approval/notification content, data sorting, empty states, retry behavior, and chart animation controls.
- [x] Check compact widths so project names, progress, status, and dates retain their alignment.

### Task 5: Restyle remaining authenticated page-specific surfaces

**Files:** Modify the feature CSS files listed under Files and Ownership.

- [ ] Carry the same edge, surface, state, table, and field language through assets, finance, project receivables, changelog, and the date-picker development surface.
- [ ] Keep business tables dense and aligned; keep financial amounts right-aligned; use status hues consistently; maintain attachment, import, destructive-confirmation, and loading/error states.
- [ ] Remove local hard-coded color drift where the workbench semantic tokens cover the same role.
- [ ] Check that the shared primitives cover `/projects`, `/opportunities`, `/partners`, `/contacts`, `/progress`, `/costs`, `/approvals`, `/reports`, `/admin`, and the intercepted credential-update flow; keep their existing route-specific table, form, drawer, dialog, and permission behavior.

### Task 6: Update and synchronize Impeccable design artifacts

**Files:** Update `DESIGN.md`; regenerate `.impeccable/design.json` using the installed Impeccable `document` workflow.

- [ ] Document the approved graphite console world, its semantic color roles, typography, spacing, rounded controls, edge highlights, elevation and responsive rules.
- [ ] Keep isolated `/login`, `/spark`, and `/stream-monitor` surface notes distinct from the authenticated workbench palette.
- [ ] Run `impeccable doctor --json`; confirm the stale-sidecar finding is gone and report any remaining version or truth-drift finding accurately.

### Task 7: Verify the complete workbench

**Files:** No new production files unless a concrete defect is found.

- [ ] Run `cd web && npm test` and `cd web && npm run build` per `TESTING.md`.
- [ ] Run the Impeccable detector once over the changed workbench UI targets and resolve actionable findings.
- [ ] Inspect desktop, tablet, and mobile Dashboard; check both themes, manager/member variation, loading/empty/error/permission states, focus visibility, chart contrast, and horizontal overflow.
- [ ] Review the final diff for unintended changes to login, Spark, Stream Monitor, API, routing, or business behavior.
