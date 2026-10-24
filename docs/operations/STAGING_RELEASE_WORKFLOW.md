# Canonical Sense staging workflow

The canonical application is `D:/app/sensestudios work management app`: React in `apps/web`, NestJS in `apps/api`, shared contracts in `packages/contracts`. `codex/sense-integration` is the recovery integration branch. Historical branches, worktree archives, private snapshots and deferred prototypes remain recovery evidence. Do not merge old migration lineages or introduce a competing application.

Staging is `http://localhost:59443/`, with a fixed loopback API on59442 and the retained PostgreSQL database on45434. `config/local-runtime.json` pins the database name, user, OID, system identifier,119 migration count and retained file directory. `config/staging.json` defines the release and supervisor locations. Staging has no automatic migration, seed, bootstrap, mail/provider configuration, or background worker startup. Actual-project R-104/R-105 and production readiness remain unverified.

## Every future UI demo

1. Identify the existing route/page and its approved requirement IDs. Separate approved presentation from proposed changes to ownership, calculations, access, persistence, notifications or approvals. Resolve material unspecified rules before implementation.
2. Preserve the submitted editable demo and compare it with current accepted behavior. A demo is a reference, not a replacement backend or a source of permission grants.
3. Implement directly in the canonical frontend. Reuse current routes, components, real APIs and shared contracts. Keep unaffected features, loading/empty/error/denied states and unsaved work. Keep experimental previews clearly labeled and outside the staging build.
4. Reproduce defects, add useful regression coverage, verify appropriate frontend/backend/persistence/role checks and responsive widths. Record the current candidate's exact results and gaps.
5. Review and explicitly stage the intended source/tests/docs, scan for secrets and private evidence, then commit to the integration workflow. Never deploy a dirty checkout or stage all untracked artifacts.
6. Build matched web/API from the approved40-character commit, verify the exact artifact and compatible database on isolated targets, then promote only that artifact. Check clean and cached browsers and confirm both visible release identities match.

## Build and promotion

Use Node24.19.0 and pnpm11.19.0. The build exports an explicit Git commit into a fresh private directory, installs its frozen lockfile from the local package store, builds web/API/contracts together and deploys a self-contained production API dependency closure. The final artifact is `.env.staging/releases/<commit>/`; do not rename it, because Windows package junctions may be absolute. Build failures are preserved for diagnosis. No build command promotes a release.

Root `pnpm dev` and the compatibility `runtime:*` commands now use this same approved-release supervisor. They do not serve the dirty checkout on the canonical address. Developers may run the existing per-package development commands on their separate development ports with an explicitly selected disposable database; these previews are not staging releases.

```powershell
node scripts/staging/build.mjs 'D:/app/sensestudios work management app' <40-character-commit>
node scripts/staging/cli.mjs promote <40-character-commit> <private-acceptance-json>
node scripts/staging/cli.mjs install-startup
node scripts/staging/cli.mjs start
node scripts/staging/cli.mjs status
```

Promotion requires passing acceptance bound to the exact commit and private manifestSHA256. Preserve a prior active pointer before switching. A running supervisor validates a new pointer/artifact/database before changing either child. Rollback is the same explicit acceptance-and-promotion process for a preserved compatible artifact; no automatic database downgrade is provided. Old release directories are outside the web root.

The installer requests the current user's S4U identity with startup/logon triggers, one running instance and bounded task retries. On this host Windows denied S4U registration and the elevation prompt was canceled. The installed task instead uses HI's interactive identity and logon trigger, without a stored password. Earlier manual invocation and the corrected owned-process interruption rehearsal passed at their recorded artifact. Later scheduled launchers remained suspended by Windows before code execution; current staging was restored through a verified hidden direct bootstrap. After the Owner allowed the suspended process, the exact guarded scheduled startup reached READY and canonical browser checks passed again. Before-login startup and actual reboot behavior remain unverified. See the verification log for the exact boundaries.

The hidden launcher runs the generated local PowerShell script with process-only `RemoteSigned`, preserving the machine's execution policy. It hides the child console, waits with a retained process handle and propagates its exit status. `refresh-startup-launcher` requires the app stopped, validates the existing action, preserves task XML and launcher source, and compares principal/triggers/settings around the action-only update. `start` validates the single exact action, working directory and generated script before invoking it. These guards do not resolve an OS-suspended task. Vite development and preview reject59443 and use strict port binding so an occupied experimental port cannot fall through onto canonical staging.

The supervisor verifies its OS process identities, fixed loopback listeners, exact successful migration/checksum ledger, retained database identity, canonical file root and artifact integrity. It refuses unrelated occupied ports or contradictory database ownership. Child restarts are bounded; exhausted retry/log budgets persist `REQUIRES_ACTION` and preserve evidence. Stop uses a token-bound request and stops only owned app children; retained PostgreSQL data are kept.

On21October host CPU saturation exposed BelowNormal task/child scheduling: retained database connection attempts exceeded the unchanged4-second preflight budget. The current task was changed from its default priority7 to6 (Normal), with XML and exact-process receipts preserved; its action/principal/triggers/other settings were unchanged. Only the verified retained PostgreSQL and already-running canonical launcher families were normalized, with no database restart or migration. Three identical probes then passed54/188/199ms, followed by actual app/supervisor recovery. Future recreation must preserve the reviewed Normal priority. This is a recorded host setting, not a production performance guarantee. Read-only Windows inspections retry one actual OS query timeout; permission errors, exhausted timeouts and wrong identities still fail closed. Task mutations/mutex claims are not replayed.

## Cache and release verification

The visible release footer and `/release.json` identify the web build. `/api/v1/health/release` exposes only public API commit/build/time/schema count; `/api/v1/health/ready` additionally validates the full database identity and successful migration ledger. A mismatch/unavailable API is visible without automatically discarding drafts or reloading a page.

The staging worker checks the network for navigation, retains a release-specific offline fallback and never caches API responses. Updates use the existing explicit saved-work/other-window/pending-capture guard. A genuinely old cached shell cannot retroactively display the new footer. The historical-worker rehearsal required one explicit hard reload: save current work first, then use Ctrl+Shift+R while online and confirm the matching version footer. Close and reopen to verify the result. Do not clear browser storage; pending site captures and local drafts must remain intact. The rehearsal used isolated persistent profiles, not the user's personal browser profile.

Record actual deployed identity, tests, source/artifact fingerprints and remaining limitations in the recovery acceptance report. This document describes the controlled implementation; actual startup, cache, role, persistence and reboot results must be recorded separately.

## V10 Dashboard operation

V10 uses the existing `/dashboard` route. Five task summaries remain fixed and independent; their counts overlap. Links open the owning task workspace. Loading shows “Reading…” or “Loading…”; failed/missing evidence shows unavailable. Neither is a confirmed zero. The final Attention queue deduplicates task IDs and initially shows two rows.

Use **Edit widgets** to move, hide, add or reset widgets, then **Done**. On mobile, a long press on a noninteractive widget surface also opens editing. Preferences contain only widget IDs/order and are separate for each account and desktop/mobile mode on this device. Storage failure preserves edits for the current visit and displays a notice. Current permissions still filter visible widgets.

Time tracking uses ordinary Time commands and persistence. Select a project/task or supply the required non-project activity label, then a work note. Owner accounts without an employee identity use the existing Time workspace for management. Refresh rereads timer state without discarding an idle note. An uncertain same-input retry retains its command identity; pause/resume/stop use separate commands and current versions.

Performance shows only authorized management subjects and persisted scores. Owner Teams view uses the existing API's comparable employee-score cohort average for the selected employee's team, policy and period. Separate Team metric averages are unavailable; no browser calculation supplies them. Ordinary employees use the existing Performance workspace for their own authorized evidence.

The page finder searches known workspace destinations with Ctrl/Cmd+K; it does not search protected task/project content. New task opens the existing permission-checked task dialog. Confirm the current matched release footer after an upgrade; save work before any explicit reload and never clear browser storage to force an update.

## Shared navigation breakpoint and Dashboard refinement

The mobile bottom bar belongs below768px. The shared desktop sidebar takes over at768px, regardless of collapsed preference. Keep later decorative rules free of unconditional display overrides. Run node scripts/recovery/navigation-responsive.mjs from the repository root after shell styling changes. Summary bars use only each readable source section; overlapping task cards are not a combined total. Unavailable evidence remains unavailable. Current exact local/hosted boundaries are recorded in V10_DATA_NAVIGATION_ACCEPTANCE_2026-10-22.md.

## Approved task-review schema120 activation — 23 October2026

The Owner explicitly approved migration20261023000000_task_review_work_routing and matched release9f1da4b140c005586dc909810ba267a2c156c500. Canonical runtime now requires120 with profile task-review-work-routing-20261023; web/API build9f1da4b140c0-1792732431728 and retained identity/readiness are verified. This is separate from the excluded client-password120. The installed bootstrap manifest supports the reviewed profile; predecessor/config/task backups are preserved. Do not point the120 retained database at a119 artifact or run an automatic down-migration. Future migrations still require their own authorization. Exact preservation and browser/production limits are recorded in docs/development/TASK_REVIEW_ROUTING_COMPLETION_2026-10-23.md.

## My Work team/employee scopes

My Work contains personal obligations; All teams reads existing authorized tasks with primary-owner current-home-Team and employee filters. Team changes clear the employee; scope changes clear personal metrics and preserve the existing unsaved-drawer guard. Owner scope is organization-wide; Leader/manager scope never expands beyond current grants/reporting/project visibility. Production rules and task-review120 remain unchanged. Exact local acceptance and failed-run boundaries: MY_WORK_MANAGEMENT_SCOPES_2026-10-23.md.
