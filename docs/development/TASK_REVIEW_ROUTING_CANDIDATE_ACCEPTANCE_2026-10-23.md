# Task review routing — accepted candidate, activation pending

Activation follow-up: the Owner accepted this candidate and its reviewed migration/activation request. The matched release is now verified on canonical local staging. See TASK_REVIEW_ROUTING_COMPLETION_2026-10-23.md; pending-activation wording below is the preserved earlier checkpoint.


The Owner-authorized feature is implemented and accepted for the controlled activation step. Overall recovery/feature work remains IN PROGRESS until the retained upgrade and matched deployed release are verified. The feature is not live.

Selected commit: `9f1da4b140c005586dc909810ba267a2c156c500`.
Built artifact: `9f1da4b140c0-1792732431728`, under `.env.staging/releases/9f1da4b140c005586dc909810ba267a2c156c500`.

## Accepted behavior

- Separate Internal review required and Client review required checkboxes; client selection requires internal approval and captures current publishing authority. Task review requirements remain immutable.
- Exactly one submitted drawing revision, uploaded document or valid HTTPS link is required. Exact evidence and approval history remain immutable; links are not fetched or archived as file bytes.
- Independent internal approval precedes durable automatic client delivery. Current publishing authority, recipient, project and evidence access are rechecked. Blocked delivery preserves internal approval and supports authorized retry/revocation without duplicate publication.
- Only Primary Client formal final approval adds the exact approved evidence to Projects → Documents → Confirmed drawings. Approved links retain a clear label and external-content caveat; drawing issue and Confidential controls remain.

## Actual verification

Pinned Node24.19.0/pnpm11.19.0 were used. Final fingerprint-bound run `1792732410995_b9bfe38c801c` passed typecheck, lint, all523 API unit/API tests and656 web tests. The corrected assertions await asynchronous count effects without changing expected values. Two earlier full unit attempts exposed that existing race; their logs remain preserved. No failing final unit check is concealed.

Real PostgreSQL run `1792730890568_033921852a21` passed421 tests across64 suites, without skips. API implementation/migration are unchanged after that run; subsequent application change is the internal-review heading text only. Other subsequent changes are test fixtures, asynchronous assertions, browser runner settings, documentation and staging safeguards.

Browser run `1792731608461_e43e5e8e7bce` passed55 journeys without failures; its separate Time flag was absent, so two Time journeys were skipped in that invocation. Both were then explicitly enabled and passed in the focused desktop/mobile run on the same source and owned fixture, without retries. All57 distinct journeys therefore passed across those two invocations; this is not represented as a single57/57 run. The committed harness now enables the Time flag. Existing task, correction, document, client passkey/final-approval, gallery, issue, offline, automation and other journeys remain covered.

Additional desktop/mobile checkbox checks verified client selection checks and locks internal review, removing client selection leaves internal review checked and editable, and the review fieldset fits each viewport. No task was submitted by that capture utility.

Independent Codex review accepted bounded source through the selected commit and inspected desktop/mobile review options, submitted work and approved-link captures. No blocking source or visual finding remains. Full-page captures limit fine visual inspection; interaction assertions establish the link/checkbox behavior. Actual models used were current Codex and an independent Codex reviewer; no Opus/Sonnet acceptance is claimed.

All12 staging operations tests passed. Rejected schema120 promotion leaves the active pointer byte-identical and creates no preserved-pointer side effect. Artifact commit, schema profile/count, database identity and acceptance hash are checked before any pointer mutation. The private final-source-equivalence receipt compares709 tracked inputs to the selected commit: no semantic differences, with582 Windows line-ending-only differences.

The selected artifact was built from the exact committed export, installed using the frozen lockfile/offline store, built, packaged with sealed workspace dependency links and verified by the release inventory. Existing Vite chunk-size and ineffective dynamic-import warnings remain; they do not fail the build.

## Retained-data preservation

A read-only dump of the verified canonical119 database was restored into a new owned database on disposable port58440. Applying the additive `20261023000000_task_review_work_routing` migration preserved all174 original tables,37 populated tables and1,048 rows by original-column ordered digests. The successful backup, pre-upgrade snapshot and receipt remain in `.env.review-routing-20261023/retained-clone-1792731131053`. A prior rehearsal with a missing explicit Prisma configuration failed before migration and is preserved separately.

Only dedicated owned test targets were migrated. Historical migrations1–119, existing reviews, archives, unrelated Time/controller/composer CSS work and all test evidence are preserved. The excluded client-password migration120 and ArchiFlow were not integrated. All owned temporary test database processes were stopped; their data are retained.

## Controlled activation — Owner decision pending

The AGENTS direction says “never automatically migrate retained data.” No retained upgrade or feature promotion has been performed. Before activation, obtain explicit approval for this exact additive migration and selected matched artifact. The reviewed deployment sequence is:

1. Verify the current database identity/119 ledger and selected artifact inventory again. Preserve a fresh retained backup, current active pointer, runtime configuration and installed bootstrap receipts.
2. Stop only the verified canonical app for the maintenance interval; preserve PostgreSQL/NAS data. Apply the single reviewed additive migration from the selected committed source to the verified retained target. Compare all original-column digests and successful migration checksums.
3. Explicitly update runtime schema approval to120 with profile `task-review-work-routing-20261023`. Preserve and refresh the installed bootstrap manifest module from the selected artifact: the installed older module accepts119 only. Do not change scheduled-task principal, triggers or launcher behavior.
4. Promote only the selected artifact with its exact acceptance/manifest hash. Start through the guarded installed launcher. Verify retained identity/readiness, matching web/API commit/build, review states and an authorized real feature smoke check without altering historical evidence.
5. Preserve old artifacts and backups. Do not automatically downgrade schema or point a120 database at the prior119 artifact. Any recovery action requires an explicitly reviewed compatible candidate or approved restore procedure.

During the final status check, canonical app processes/listeners were absent while the approved pointer/runtime119 configuration remained. The cause of the earlier process termination was not established. The unchanged guarded scheduled launcher restored the prior approved release successfully: web/API both `7f3dee03551fc0a5fbbd483133b2bd423c032123`, build `7f3dee03551f-1792690569520`, schema119, readiness passed. This restoration did not activate the new feature.

Production, actual operational acceptance and reboot/backup custody limits from the recovery plan remain unchanged.
