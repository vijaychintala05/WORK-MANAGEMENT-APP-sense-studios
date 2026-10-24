# Shared internal workspace shell — 2026-10-24

Status: implemented and verified for the bounded frontend shell; whole-checkout/release acceptance remains IN PROGRESS. Owner request: use the same shell layout for all tabs and make the UI consistent. Existing Sense routes and the approved studio shell are the implementation target.

Requirement slice: FND SC-00/SC-01, R-005.a–b/R-007.a/c existing account/session presentation, R-006 existing navigation/access boundaries, R-071 responsive presentation, and R-100–R-102 regression/accessibility/verification. No domain requirement is reinterpreted.

In scope: one global authenticated header with current page context, page finder, task entry, notifications, account/settings and existing logout; consistent page gutters/canvas; sidebar collapse and route continuity; the existing 768px desktop/mobile navigation boundary. Internal tab content continues to use its owning component and existing APIs. Out of scope: portals/public/auth redesign, backend/schema/migrations, permissions, calculations, notifications, review workflows, retained data/fixtures and runtime promotion.

Dependencies: HeaderControls' existing session probe/logout, WorkspaceHeader/WorkspaceNavigation/WorkspaceLayout, studio-theme.css, existing protected routes. Preserve pre-existing Dashboard/Time/composer work and all historical evidence. Current implementation and review use the current Codex model; no Opus/Sonnet or independent review is claimed.

## Reference lock and decision ledger

Primary reference: existing Sense studio shell in my-work-shell.css/studio-theme.css. Preserve pine navigation, warm paper canvas, white surfaces, Inter UI type, restrained borders, current route groups and mobile five-destination navigation. No bitmap assets are needed.

Supplementary live Refero research: Wispr Flow style19ad88e8-db98-499c-a68d-cd519a7f9d4b (cream/forest visual language), Attio style9f0c028b-6b11-415e-ab92-f32e4597cbe2 (UI typography, border-based hierarchy, consistent controls), and Linear screen4a094449-e0ab-4893-8e58-c6239e7c228c (stable sidebar/page context). The searches and full style references were retrieved before implementation. Existing Sense is the build target; marketing hero typography, palettes and imagery are not adopted.

| Decision | Source and bounded role | Reason |
| --- | --- | --- |
| Reuse existing global header, eliminate Dashboard's duplicate header | Owner consistency request; existing WorkspaceHeader | All internal tabs expose the same shell actions and location |
| Retain current palette, UI typography and control tokens | Existing Sense target; Attio UI-only consistency detail | Preserve established identity and semantic status colors |
| Shared sidebar width/offset and in-session collapsed preference | Existing Sense sidebar; ui-ux-pro-max consistency/breakpoint guidance | Prevent empty gutters and navigation shifts between tabs |
| Inline compact phone header actions, existing bottom bar | Existing 768px boundary; ui-ux-pro-max focus-not-obscured/target guidance | Keep actions reachable without floating over module controls |

ui-ux-pro-max's Python launcher is unavailable on this machine; its local quick-reference guidance was read directly (consistency, breakpoint-consistency, focus-not-obscured, icon-style-consistent). No generated design-system search result is claimed.

## Acceptance and test plan

Capture baseline affected frontend checks before implementation. Run affected account/session/navigation regressions, full web unit tests, web typecheck, application lint and production web build. Exercise all internal route shells with synthetic in-memory read responses at desktop/tablet/phone widths, plus focused keyboard page finder, More dialog, collapsed-route continuity, sticky header, touch sizes and long account/page labels. Inspect rendered screenshots against the existing Sense lock. Synthetic browser checks are presentation evidence, not real-session/domain acceptance. Record exact results and pre-existing failures. Do not run retained migrations or mutate real records.

## Implemented behavior

All 28 current internal tab routes share the global header, contextual page label, page finder, task entry, notifications, account/settings and existing logout. Dashboard's second header and competing absolute-header/sidebar/mobile overrides were removed. Duplicate account strips were removed from internal page bodies, including People. Module headings, content, commands and guards remain in their existing components.

The shared shell stylesheet loads after module styles from main.tsx. One sidebar-width token controls header, page and footer offsets:232px expanded desktop,72px tablet/collapsed desktop,0px phone. The768px navigation boundary remains. Collapse is retained in per-tab sessionStorage and remains usable when storage is denied. The account link remains accessible on phones; compact header actions stay inline with44px targets. Canvas and page gutters are shared; My Work no longer has a competing maximum page width.

## Verification on 2026-10-24

Pinned Node24.19.0/pnpm11.19.0:

- Final affected suite:117/117 tests across6 files passed (navigation, shared App shell, App/session identity, actor revalidation, People route and design-system contracts). Log:.env.shell-consistency-20261024/final-affected.log.
- Web typecheck exited0. Changed TypeScript/TSX ESLint exited0. Final production web build exited0. Existing bundle-size and ineffective dynamic-import warnings remain; no bundle refactor is included.
- Development browser:28 routes ×7 widths=196 checks passed. Production browser:the same196 checks passed. Widths320/390/767/768/783/1024/1440; exactly one header and one navigation mode, matched header/page/sidebar offsets, one common canvas, all header controls at least44px, no clipped controls or horizontal document overflow. Both runs passed collapsed-route continuity, keyboard page search, More/Escape focus restoration, phone account/settings access and sticky header. All API requests were intercepted; no unexpected writes or page errors occurred. Site used a synthetic authorized empty-project response because its ordinary denied-read behavior correctly revokes the session. Evidence/scripts:.env.shell-consistency-20261024/browser.mjs, browser.json, production-browser.json and six Dashboard/Tasks screenshots. Saved390px/1440px captures were visually inspected against the existing Sense frame.
- Full web suite:683 passed/8 failed across70 files. Failures concern concurrent task-composer fields/validation/create flows in task.test.tsx, project-task-context.test.tsx, task-composer-fields.test.tsx, task-creation-flow.test.tsx and ux-usability.test.tsx. These cases do not import the changed App/header/layout modules. A separate source snapshot restored all shell files to HEAD while retaining the concurrent component source:four of the eight failures reproduced;four passed in that rerun. That does not establish a cause for the non-reproduced failures. The selection intentionally skipped110 unrelated cases; it is not a full-suite pass. Logs:full-web.log and composer-baseline.log under the evidence directory. Concurrent composer/test changes continued during this work; no exact whole-checkout acceptance is claimed.
- Initial baseline attempt:App80 tests passed;three other suites failed before executing with a sandbox temporary-file ENOENT. A workspace-local TEMP/TMP directory resolved the runner issue. An intermediate affected run had110 passes/one failure because the new account header made an old identity-text query ambiguous; the assertion was scoped to the main identity content, and the final117 passed. The initial scoped lint found one now-unused page-label variable after strip removal; it was removed before the passing final lint.
- Earlier browser attempts failed at sandbox network access, then exposed the Dashboard override and a synthetic Site403 session revocation. These attempts remain retained and are not relabelled as passing. A baseline-snapshot attempt initially lacked a dependency junction/relative tsconfig; the corrected snapshot produced the explicit4-fail/4-pass result above.

No backend/API/schema/migration, retained database/fixture, canonical staging, service-worker storage or operational/production operation was performed. No full pnpm verify, real-session browser acceptance, independent reviewer, hosted CI or matched-release deployment is claimed. Current Codex performed implementation, source review and visual inspection. Historical and unrelated working changes remain preserved.
