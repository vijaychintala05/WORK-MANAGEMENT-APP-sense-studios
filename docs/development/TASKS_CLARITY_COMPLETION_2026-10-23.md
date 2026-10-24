# Tasks register clarity

Status: COMPLETE for development and controlled local staging, 24 October 2026. All six findings from docs/ui/TASKS_UI_UX_REVIEW_2026-10-23.md are addressed on the existing standalone /tasks route. No backend, schema, migration, access grant or review rule was added.

Selected73b41360e9cd022ffbfd372035521fa6fa643d83 is live at http://localhost:59443/tasks?scope=all with matching web/API build73b41360e9cd-1792780064980. READY, schema120, served index and anonymous queue401 were verified. Final application source is mechanically identical to0e32695; subsequent commits correct browser assertions only.

## Implemented behavior

- TUX-01: normal-flow task facts and independently operable People controls no longer overlap. A named list container handles the narrowed list beside details. Strong standalone selectors and final CSS import prevent shared-style overrides.
- TUX-02: Next step puts existing permitted Start/Complete/Resume commands, audit reasons and blocking guidance near the title and within the tested first screen. Selecting work hides list controls; Back restores them. Dependency, date, reassignment and waiting forms are disclosed. Authority, versions and review gates remain.
- TUX-03: compact scope toolbar, subordinate View options, phase views, advanced filters, applied chips and pending-change guidance. Phone phases scroll in one row; shorter heading and collapsed redundant single-page paging leave titles visible. Search text clears its icon. Immediate phase views preserve pending search/refinement drafts, which still require Apply filters.
- TUX-04: staff scope reads Assigned to me. Owner scope reads Organization, accurately reflecting the server's existing organization-wide legacy mine/assigned scopes. Bookmarks retain results. My Work remains the separate daily-action page.
- TUX-05: broad phases complement detailed statuses. No premature review link for new tasks; started required-review work links to the existing submission workflow. Correction children retain linked parent instructions even with NONE requirements. Copy does not infer reviewer assignment. Client links appear at client states.
- TUX-06: readable calendar dates/priorities, distinct Target/Committed fields, less repeated People/empty metadata and disclosed Version. Long identifiers truncate visually while accessible names/dialogs retain authorized identities. No names or date calculations are invented.

Review links, row selection, scope/phase and filters use the dirty-task leave guard. My Work and Project embeddings retain presentation and commands. Mandatory evidence, independent internal approval before authorized automatic client delivery, and Primary-final-approved Confirmed drawings remain intact. Concurrent Time/Dashboard and pre-existing plan edits are excluded.

## Verification boundaries

82 focused Tasks tests passed during implementation. Final app source0e32695 passed web typecheck, full lint and671 frontend tests/69 files with one worker; selected73b4136 has identical application files. Its changed browser test passed lint and collection. Earlier summary metadata undercounted web tests by one; the actual671-test log and corrected final receipt are authoritative.

Full typecheck and523 API tests/67 suites passed onc31aa7f. Backend/contracts/acceptance scripts are unchanged.422 real PostgreSQL results are explicitly reused from accepted078e1c78. No new PostgreSQL run or literal whole-checkout pnpm verify is claimed.

57 distinct browser journeys passed across explicit source-equivalent runs: broad11f82a8 recorded56 passes/1 failure;73b4136 then passed identity and both affected Tasks journeys3/3. Cases were mechanically matched. No skips or retries were introduced. The prior failure remains a failure, not a passing full-run receipt.

Final Tasks journeys check1440/1280/1024/783/390/320 widths for row/People separation, no register overflow, visible title/Start action and effective search padding. They execute the actual320px Start command and verify persisted state/version/audit before continuing existing edit/wait/resume/date/completion/access-denial checks at the original project viewport.

Independent current Codex accepted source and all12 actual saved list/detail captures across six widths, including the final test isolation correction. Receipt review confirmed release/preservation consistency. No Opus/Sonnet or independent rerunning of services/digests is claimed. Final sealed build, cache upgrade, offline reopen, saved drafts and pending capture preservation passed in isolated profiles. Controlled cache metadata does not claim real backend/role acceptance; live identity/readiness/index/authentication were checked separately.

The separate legacy /workspace320px overflow remains OPEN; see docs/ui/LEGACY_WORKSPACE_320_FINDING_2026-10-24.md. The viewport loop had unintentionally extended that older journey beyond its baseline. All Tasks assertions and the original legacy overflow assertion remain. Independent review accepted viewport restoration before that separate continuation.

## Preservation and release

Exact accepted commit and sealed manifest were promoted app-only. All prior releases/configurations/refs and failed fixtures remain retained. Read-only repeatable-read before/after snapshots matched176 tables/1051 rows, schema120 and all172 business fingerprints. Only sessions changed during active use; every other table fingerprint matched. No retained fixture or migration was created.

Private evidence: .env.tasks-ux-fix-20261023/release-acceptance.json, release-browser.json, selected-acceptance.json, final-web-unit.log, source-review.md, visual-review-final.md, live-verification.json and immutable snapshots. Source hash:c3eb2e7e955c0da70c53beb995dbd34283fc3d650fba2810341e7c8938de4fcf. Broad run:1792779742016_a0b34773fd6d; passing focused run:1792780158209_086120bae1f9.

Preserved failures include selection-helper decoding, packaging-pruned test tools, unsupported test options, fixed-port startup conflicts, duplicated browser assertions and legacy viewport carryover. Port58430 belonged to an unrelated codex.exe outbound HTTPS connection. Reviewed private harness copies used loopback38430/38431 with matching strict assertions and unchanged source/database120 guards. No unrelated process or OS connection was stopped.

Personal browser refresh was not forced or claimed. Save work before ordinary Update and reload; never clear storage. Actual operational R-104/R-105, hosted CI, production/NAS, offsite backup, key custody and reboot acceptance remain outside this completion.
