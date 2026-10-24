# V10 Dashboard Integration — Gap Report

**Source of truth for this work:** `docs/design/DASHBOARD_V10.html` (visual spec),
V10 acceptance matrix (embedded in the handoff). This file records what landed,
what remains, and the exact status of each acceptance row. It is the handoff
document for the next developer and for any reviewer.

**Scope status of this document:** `dashboard.tsx` (V10 widget render) and the
V10 app shell (`workspace-navigation.tsx` / `workspace-navigation.css`) are
**IN-PROGRESS, NOT ACCEPTED, NOT COMPLETED**. No visual acceptance has been
claimed. No authenticated screenshots, no 6-context auth verification, no
390/320 audit were performed — the browser was not available in this
environment. All statuses below are `NOT TESTED` or `BLOCKED`, never `PASS`,
until the matrix in §5 is executed.

---

## 1. What actually landed (verified on disk)

| Component | File | Status | Notes |
|---|---|---|---|
| V10 app shell | `apps/web/src/workspace-navigation.tsx` + `.css` | IN PROGRESS | Dark-pine collapsible rail, mobile 5-tab bottom bar (Home/My Work/Projects/Decisions/More), Ctrl/Cmd+K page finder, Settings footer. |
| Widget registry + localStorage persistence | `apps/web/src/dashboard-widgets.ts` | IN PROGRESS | `WIDGET_INFO`, `ALL_WIDGET_IDS`, `loadLayout`/`saveLayout`/`resetLayout`/`defaultLayoutForRole`. Layout intersects saved IDs with the authorized catalog on every load (§I.8). |
| Widget CSS | `apps/web/src/dashboard-widgets.css` | IN PROGRESS | `.dv-*` summary strip, widget grid, attention queue, edit-mode chrome. 24,848 bytes. |
| dnd-kit dependency | `apps/web/package.json` | INSTALLED | `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `dnd-kit`. |
| V10 dashboard render | `apps/web/src/dashboard.tsx` | **IN PROGRESS — this is what Gap 1 just landed** | 565-line diff. Fixed 5-card summary strip (`.dv-summary-strip`), two-column dnd-kit sortable widget grid (`.dv-widget-grid` + `SortableWidget`), fixed bottom attention queue (`.dv-attention-queue`, max 2 rows, expandable), live timer read from `GET /time`, per-user layout persistence to `localStorage`, widget gallery + reset + keyboard move controls. |
| Test updates for V10 render | `apps/web/src/dashboard.test.tsx` | UPDATED | `tile()` helper now queries `.dv-summary-card[data-summary="..."]` instead of `.dashboard-kpi`. Unavailable text assertion uses the bare word "Unavailable" (matches the V10 summary card's `dv-summary-unavailable` div). 14/14 dashboard tests pass. |

**Typecheck:** `pnpm exec tsc --noEmit` in `apps/web` — clean (0 errors in
`dashboard.tsx`, `dashboard.test.tsx`, `workspace-navigation.tsx`,
`dashboard-widgets.ts`).

**Full web test suite:** 621 passed / 1 flaky. `dashboard.test.tsx` runs
17/17, including three new GAP tests (dial, review rounds, embedded
timer start). The single intermittent failure in
`client-portal-auth.test.tsx` ("sends CSRF with passkey registration…")
passes in isolation (8/8) and has passed in earlier full-suite runs — it
is flaky under parallel load, not a regression from the V10 work.
`actionable-work` and `task-creation-flow`, which failed in the first
full-suite run, also pass since; they are part of the 369-change
uncommitted tree and pass on re-run.

---

## 2. What did NOT land (honest status)

| Item | Status | Detail |
|---|---|---|
| **Time Tracking widget with in-widget start/pause/stop** | **CLOSED** (Gap 12) | Embedded start/pause/resume/stop driven by `POST /time/timers` and `POST /time/timers/:id/:action` with `expectedVersion` and `commandId`. Idle state has a compact work-note + location + billable form. Stop requires a reason (via `window.prompt`), matching the Time module's audit contract. |
| **Performance widget live scores** | **CLOSED** (Gap 10) | Reads `GET /performance/context` and `GET /performance/employees/:id` to render the latest `SCORED` snapshot's score, period, team average, and relative-to-team delta in a conic-gradient dial. States: `SCORED` snapshot, `no-snapshot` (with policy-vs-no-policy messaging), and `loading`/`unauthorized`. No invented scores. |
| **Decisions widget — "Assigned review rounds" sub-section** | **CLOSED** (Gap 11) | Reads `GET /reviews/inbox?limit=5` to render up to 5 assigned rounds below the approval chips, each linking to `/reviews?taskId=…&roundId=…` with task title, revision label, project, round number, status, due date. Unavailable state renders "Review source unavailable." |
| **6-context authenticated visual acceptance** | NOT TESTED / BLOCKED | No screenshots at 1440/1024/390/320 in the 6 role contexts (Owner, Team Leader, Employee, Site, Reviewer, Cross-branch). Browser not available in this environment; seeded accounts not logged in. |
| **320px mixed-attention scroll audit** | NOT TESTED / BLOCKED | Cannot confirm whether the attention queue fits at 320px without horizontal/vertical scroll. |
| **Full-shell visual comparison** | NOT TESTED / BLOCKED | No side-by-side of the V10 HTML demo vs. the live app. |
| **`pnpm verify` baseline re-run** | NOT RUN | The pre-existing 3 test failures mean a clean `pnpm verify` run cannot be claimed as "0 regressions" without first triaging those 3. |

---

## 3. Acceptance matrix (V10) — current status

Each row: what to verify, how to verify, and current status.

| # | Row | Verification method | Status |
|---|---|---|---|
| 1 | Fixed 5-card summary strip renders: Overdue, Due today, High priority, Waiting/blocked, Review/corrections | Authenticated sign-in at 1440px, inspect `.dv-summary-strip` | NOT TESTED |
| 2 | Each summary card links to the correct authorized destination | Click each card, confirm `href` | NOT TESTED |
| 3 | Overlapping task buckets are not summed into a single total | Inspect card values; confirm no "work total" appears | NOT TESTED |
| 4 | Widget grid is draggable (dnd-kit) and columns are independently scrollable | Drag a widget in edit mode; confirm no horizontal wrap | NOT TESTED |
| 5 | Edit mode exposes drag handles, hide (−), keyboard ↑/↓/⇄, gallery, reset, Done | Enter edit mode; test each control | NOT TESTED |
| 6 | Hidden / reordered layout persists per-account in `localStorage` and is re-intersected with authorized catalog on reload | Customize; sign out/in or switch account; confirm inaccessible widgets are dropped | NOT TESTED |
| 7 | Attention Queue is fixed at the bottom, shows max 2 rows, "Show more · N" expands | Inspect `.dv-attention-queue` at 1440/1024/390/320 | NOT TESTED |
| 8 | Time widget shows the real active timer from `GET /time` (no invented timer entries) | Start a timer in `/time`; confirm dashboard time widget reflects it | NOT TESTED |
| 9 | Project Health widget shows authorized project health without inventing scores | Confirm only `HealthScore` values from the API render | NOT TESTED |
| 10 | Performance widget shows live scores, period, and lead name (demo parity) | **CLOSED** — reads `/performance/context` + `/performance/employees/:id`, renders dial + period + team avg + delta. Test: "renders the performance dial…" | CODE + UNIT TESTED (visual acceptance still NOT TESTED) |
| 11 | Decisions widget shows "Assigned review rounds" sub-section (demo parity) | **CLOSED** — reads `/reviews/inbox?limit=5`, lists up to 5 rounds with task/round/status/due. Test: "lists assigned review rounds…" | CODE + UNIT TESTED (visual acceptance still NOT TESTED) |
| 12 | Mobile bottom bar: Home/My Work/Projects/Decisions/More with correct routes at 390/320 | Resize to 390px and 320px; confirm nav | NOT TESTED |
| 13 | Page finder (Ctrl/Cmd+K) lists authorized destinations | Press Ctrl+K; confirm list matches account access | NOT TESTED |
| 14 | 6-context auth: Owner, Team Leader, Employee, Site, Reviewer, Cross-branch each see only authorized widgets and destinations | Sign in as each persona; compare visible widgets to `WIDGET_INFO` + `permittedWidgetIds()` | NOT TESTED |
| 15 | 320px mixed-attention scroll audit: attention queue fits without overflow | Resize to 320px with multiple attention rows | NOT TESTED |
| 16 | All 5 summary cards + attention queue have "Read at" or "Unavailable · retry" states, never silent blanks | Inspect loading / error / empty states | NOT TESTED |

---

## 4. How to run the next verification session

1. **Restore `node_modules` on the Windows host** (if not already healthy):
   ```bash
   pnpm install --frozen-lockfile --offline --ignore-scripts
   ```
   Per `docs/development/DEPENDENCY_RECOVERY_2026-10-14.md`. Do NOT use
   `scripts/repair-*.mjs` or `scripts/fix-node-modules.mjs`.

2. **Start the API on the prepared ports** (Owner approval required for the
   retained preview at 59442/59443; see `CLAUDE.md` § Servers):
   ```bash
   pnpm --filter @sense/api start   # API
   pnpm --filter @sense/web dev    # web
   ```

3. **Sign in as each of the 5 ACTIVE staff personas + Owner** in a fresh
   Chromium. The retained preview has 50 seeded tasks and 5 staff.

4. **Execute acceptance matrix rows 1–16** above. Screenshot at
   1440×900, 1024×900, 390×844, 320×740 for each of the 6 role contexts.

5. **Close Gaps 10 and 11** (Performance live scores, Decisions review
   rounds) before claiming full demo parity.

6. **Triage the 3 pre-existing test failures** (`actionable-work`,
   `client-portal-auth`, `task-creation-flow`) — these are in the
   369-change uncommitted tree and must be resolved or explicitly scoped
   out before a clean `pnpm verify` can be claimed.

---

## 5. Open questions / decisions for the next developer

- **Time widget controls:** embed start/pause/stop in the widget (full demo
  parity) or keep the link-out-to-`/time` pattern (current implementation)?
  If embedding, the widget needs write access to the Time API and must
  respect the single-active-timer rule (confirm before task switch).
- **Performance scores:** the API has `GET /performance/context` and
  team/employee snapshot reads. Confirm the exact endpoint shape before
  wiring. The widget must show the supplied scale, never invent one.
- **Decisions "Assigned review rounds":** confirm whether this comes from
  `/reviews/inbox` (review.rounds) or from a dedicated decisions
  sub-endpoint. The demo shows a separate list below the approval chips.
- **`git status` baseline:** the 369-change tree is uncommitted. Confirm
  with the Owner which of those changes are in-scope for the V10
  acceptance run and which are unrelated.
