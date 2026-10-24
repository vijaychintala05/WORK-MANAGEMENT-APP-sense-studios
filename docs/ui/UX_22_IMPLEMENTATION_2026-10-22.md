# UX-22 — review improvements — 2026-10-22

Status: COMPLETE for development/controlled local staging on2026-10-23. Owner instruction: “work to improve all the findings.” Scope is the twelve findings in UI_UX_REVIEW_2026-10-22.md, mapped in IMPLEMENTATION_PLAN.md. This is a refinement of existing Sense pages in apps/web, with migration119 unchanged; client-password120 and ArchiFlow remain excluded. Production and whole-current-checkout acceptance are not claimed.

## Accepted release

The deployed matched release is7f3dee03551fc0a5fbbd483133b2bd423c032123, build7f3dee03551f-1792690569520, at http://localhost:59443/. The actual supervisor/child ownership check reports READY; public web/API identities match and database readiness passes. Only the selected artifact was promoted, with the prior active pointer preserved. No retained migration or fixture write occurred.

Final checks passed: pinned typecheck/lint/production build,508 API unit,652 web unit, all57 desktop/mobile browsers, six bounded real-session browser cases at1440/1024/390/320px, two project database cases,420 PostgreSQL integration and9 receipt tests across the explicit unchanged-backend boundary below. Final accepted runs have zero failures or skips. Isolated artifact cache/update/offline/draft/pending-capture checks passed; live delivered-CSS navigation passed28 cases, and anonymous client sign-in passed at all four widths with zero write requests.

Read-only snapshots immediately before and after promotion match all174 table fingerprints and1045 rows, with the identical119-migration ledger. Across the longer interrupted interval,173 tables match and only sessions differs; that interval does not establish session-byte equality or the cause of its changes. All temporary acceptance database processes were stopped with their data/evidence retained. The user's cached browser/profile was not forcibly updated or cleared; save open work before using the normal Update and reload action.

Private machine evidence: .env.ux-review-20261022/release-acceptance.json, live-report.json, live-status.json and promotion-preservation.json; final isolated run1792723907191-863fa897573c in the7f3dee03551f-1792690569520 build export. These files contain operational fingerprints and stay outside published web assets. The reviewed application source remains7f3dee0; the later91516fa Dashboard work remains preserved and excluded from this release/acceptance.

## Design and requirement boundary

The existing Sense design system is the locked visual target: warm canvas, pine primary actions, white surfaces, restrained borders and existing status meanings. References remain the Refero research in TASK_CREATION_DEMO_BRIEF_2026-10-20.md and docs/design/TASK_CREATION_COMPLETED_UX_RESEARCH_2026-10-16.md. This implements the reviewed usability changes rather than a new frontend or prototype contract. ui-ux-pro-max supplies supplemental keyboard, form, touch, typography and responsive checks.

| Finding | Implementation and preserved boundary |
|---|---|
| UX-01 | Retain accepted desktop/mobile navigation breakpoint fix at60d9292; validate its delivered behavior. |
| UX-02 | Shared task composer puts brief/required context first. Collaborators and planning use disclosures; eligible owner/collaborator search keeps selected people. Existing API eligibility remains authoritative. |
| UX-03 | One validation pass supplies command guard, field errors, aria descriptions and a focused error summary. Error links reveal optional groups. Invalid fields never submit commands. |
| UX-04 | Project is required for Project/Correction/Site task types; optional context retains the existing type/context clearing behavior. |
| UX-05 | Directory leads; template selection/management is secondary within project creation, with separate retained Staff reference/management access. Pending/recovery commands lock template controls as before. |
| UX-06 | Project relationships use authorized CRM client/won-lead names, search, paging, loading/error/retry and stale-branch guards. Optional direct-project behavior and backend reauthorization remain. |
| UX-07 | Scoped Dashboard typography increases functional microcopy/control sizing and permits wrapping without changing source counts or metric calculation. |
| UX-08 | Task completion explains unfinished-child/required-review blocking visibly. Existing transition gates remain unchanged. |
| UX-09 | Compact Settings navigation; current/active sessions precede a collapsed retained history. Existing session revoke permissions remain. |
| UX-10 | Dashboard/My Work/Projects page H1s, shared skip link and pathname focus; native modal focus is preserved. Search/filter changes do not refocus the route. |
| UX-11 | Human-readable review dates/states, clearer report/Owner empty-state copy. Operational dates use UTC formatting of the date component without viewer-timezone shifting. Missing evidence remains unavailable. |
| UX-12 | Client email-code sign-in uses shared auth framing with invitation, delivery-help and other-sign-in guidance. Existing email-code/passkey/security contracts remain. |

## Preservation and review

Pre-existing Dashboard CSS/widget edits and eslint configuration were preserved separately and excluded from this selected change. Dashboard source is staged only for this task's date/state/heading/copy edits. No retained-data migration, fixture insertion, credential request or storage clearing is authorized by this slice.

Independent Codex source review found two regressions in template placement (lost Staff panel and lost pending/recovery lock). Both were corrected and the reviewer confirmed resolution. The existing exact-body uncertain-template recovery test verifies the lock; a new regression verifies granted Staff management. No Opus/Sonnet or independent test execution is claimed.

## Verification record

Implementation runs and failed attempts are retained privately in .env.ux-review-20261022. The first unit run encountered sandbox temporary-directory ENOENT errors; later runs use an owned workspace TEMP/TMP directory. A malformed lookup response exposed a render-crash path during branch testing; client and lead response-shape guards now reject it. An initial navigation command could not find the sandbox browser path; rerunning with the installed managed-browser path passed all28 cases.

The selected final application candidate is7f3dee03551fc0a5fbbd483133b2bd423c032123, built as7f3dee03551f-1792690569520. Its674-file source fingerprint is1396c49a13f4e5b099c3dbcf6e72d6a5d4114d077d1eaa7f9df3df8790079162. Pinned Node24.19.0/pnpm11.19.0 exact-export typecheck, lint, production build,508 API unit and652 web unit tests passed. All6 bounded browser cases and2 project database cases passed, including real task/project persistence, recovery, authorization, error focus and1440/1024/390/320px layouts. The full57-browser regression and matched staging verification subsequently passed on2026-10-23.

Real PostgreSQL420 integration tests and9 receipt tests passed at the earlier exact export1e7dfffa83ae1a921b40d015fd0ec205efeb7ad9, source88a6677a9fb864a03b1641615132286d51ba228aff91b2096a9cf303b6f1cce0. The only subsequent source differences are task.tsx, task-composer-fields.tsx and their two frontend regression files; backend, dependencies and119-migration schema are unchanged. This boundary was checked mechanically before promotion; it is not a claim that PostgreSQL tests ran again at the later frontend fingerprint.

The final sealed artifact passed isolated historical-worker/cache update, offline fallback, draft and pending-capture preservation. Independent Codex source review resolved template preservation/locking, fixed-project error targeting and same-document navigation. Independent visual review of six final captures (Dashboard1440/320 and task errors at all four widths) found no blocking issue; interaction correctness is supported separately by browser assertions.

Preserved failed attempts include649pass/1 old-copy unit assertion, the pre-fix c31579a browser run (2pass/4fail) where error links triggered the draft-leave guard, and an interrupted quality run with an orphaned lock. The absent runner PID was verified before its lock was preserved byte-for-byte and only its owned disposable databases were stopped. Fresh run1792723907191-863fa897573c supplies the final-source evidence. No failed or interrupted attempt is relabeled as passing.

Concurrent Dashboard/ESLint work was separately committed as91516fa after the selected candidate. It remains outside this artifact and this acceptance. No hosted-CI pass, production readiness, R-104/R-105 operational acceptance, NAS/offsite/key-custody/provider/legal or reboot/before-login acceptance is claimed.
