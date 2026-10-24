# Task review evidence and automatic routing

Status: IMPLEMENTATION IN PROGRESS. Owner-authorized feature request, 2026-10-23. This document does not claim implementation or acceptance.

## Owner direction

- Provide separate **Internal review required** and **Client review required** checkboxes on the existing task flow. New selections map to the existing NONE/INTERNAL/BOTH requirement; CLIENT remains a historical value.
- Work sent for review must have an uploaded file or a review link. Task text alone is insufficient.
- Route the submitted work automatically to the required review workflow.
- Confirmed clarification: an Owner or someone with existing client-publishing permission authorizes automatic client routing during task configuration. If both requirements are selected, internal approval comes first. Task ownership alone grants no new client-publishing permission.
- Confirmed submission trigger: the Owner specified “when work is subbmitted and internal review is also done- then only”. Work submission with a file/link starts internal review; only APPROVED internal review of that exact submission permits automatic client routing. Task creation, attaching evidence alone, starting review or requesting corrections cannot publish to clients. Selecting Client review required also selects and requires Internal review required; new CLIENT input is normalized server-side to BOTH. Historical CLIENT tasks remain unchanged.

## Existing page and requirement mapping

Extend apps/web task composition/details, the existing internal Review workspace and Client reviews/portal. Reuse TSK/REV/DOC/ACC contracts. No competing application or prototype backend.

- R-018–R-024: task fields, owner and dedicated guarded state transitions.
- R-027.a–b: configured internal review and eligible independent reviewer.
- R-028.a–b: immutable submissions, new correction rounds and exact evidence history.
- R-032–R-034 and R-037/S13/S14: scoped client review, exact signatures and drawing approval/issue boundaries.
- R-099–R-102: backend authorization, persistence, regression and responsive acceptance.

The request adds a prospective mandatory evidence rule to the earlier task-only review behavior. The change must be recorded explicitly rather than silently rewriting S13/S14 history. Existing review requirements are project-bound; non-project work must not acquire an invented client audience or reviewer scope.

## Design constraints to carry into implementation

1. Checkboxes configure requirements; no approval or review permission is granted by visibility or selection. Internal reviewer appointment and client publication authorization remain server-enforced and current-access checked.
2. New internal submissions and client packages must reject missing, inaccessible, wrong-project or otherwise invalid evidence before any task state/audit/outbox write. An exact drawing revision remains valid file evidence and keeps its existing R/CR rules.
3. Generic uploaded files use the existing private document storage, authorized project/file scope and immutable blob/checksum identity. Client-visible content remains subject to existing file-type and Confidential restrictions.
4. Links need an explicit safe URL contract. Do not fetch arbitrary URLs server-side or treat mutable external content as an archived binary. Preserve the submitted URL per round; a link must never synthesize an exact drawing revision approval or bypass S12 issue rules.
5. BOTH routing must use the same evidence that passed internal review. Subsequent changes need a new submission/round. New client-review configuration always requires internal approval. Internal-only work keeps its existing completion path. Historical CLIENT rows keep their existing capabilities and state rules and do not acquire automatic routing without explicit authorization.
6. Durable automatic-routing authorization must identify the authorizing actor and exact task/configuration, support revocation/current-access rechecks, and survive retries without duplicate client packages. Do not overload task tags/checklists or infer authorization from historical review flags.
7. Missing reviewer, Primary Client, scope/grants or inaccessible evidence must produce an actionable blocked state. Failed client delivery must not silently publish, discard evidence or rewrite a valid internal decision.
8. Historical submissions, approvals, issued revisions and client signatures remain immutable. Do not backfill retained reviews or automatically withdraw/advance them. The new mandatory evidence rule applies prospectively to new submissions/publications. Pending historical task-only rounds retain their original decision rules; there is no retroactive approval gate.
9. Preserve migration119 and the excluded client-password120 branch. Any necessary additive schema proposal must be reviewed and tested separately on dedicated databases; never migrate retained data automatically.

## Implementation slice and acceptance plan

The trigger is settled. Implement one vertical slice through the existing task/review APIs with the reviewed routing/evidence contract and additive schema consequences. Include checkbox combinations, required evidence input, upload/link status, reviewer/client readiness, exact submitted evidence display, errors/retry and mobile/keyboard behavior. Keep correction, hold/cancellation/exit, permissions, current clients and formal client approval gates intact.

Verify missing evidence at both API and service boundaries, file/link validation, ID tampering/cross-project/Confidential leakage, revoked authorizer/grants, self-review, internal-before-client sequencing, exact evidence across corrections, stale versions, duplicate/concurrent submission, transaction rollback and uncertain responses. Run real PostgreSQL persistence/security cases, relevant desktop/mobile journeys, pinned typecheck/lint/build/unit/full gates and independent Codex review. Only a reviewed exact commit may enter controlled staging, with retained-data preservation and matched web/API identity verified. Unrun gates stay explicit.

## Inspection checkpoint

Current source already has the four-valued task review requirement, immutable internal ReviewSubmission.taskSnapshot and ClientReviewItem.snapshot records, exact revision/file authorization, reviewer appointment and separate client publication authority. Internal submit currently permits task-only snapshots; BOTH client publication currently requires exact internally approved revision evidence. These paths need a deliberate extension for generic file/link work, not a cosmetic checkbox change. No application, schema, runtime or retained-data change has been made by this feature checkpoint.

## Independent design review

Independent Codex source review confirmed that a sound extension needs a versioned routing-authorization record, immutable discriminated drawing/file/link evidence shared by internal and client review, and a unique durable routing attempt. Publication must recheck the authorizer's current ClientPortalScopeService manage authority, including the existing project-lead exception; task flags alone are insufficient authorization.

Generic BOTH evidence must match the exact approved submission identity and unchanged task scope. Client-safe evidence reads and both item/final signature bindings must include that evidence identity. The existing PostgreSQL final-item snapshot and immutable/audit guards also need a reviewed additive extension; service/UI changes alone are insufficient. Valid internal approval must commit independently of a blocked client publication, with a durable retriable intent and no duplicate package/item. Historical task-only submissions must remain preserved without silent new decision gates. The reviewer originally deferred dependent implementation pending the trigger. The Owner has now settled it: submitted work, then internal approval, then client review. This clarification is recorded above and removes that design dependency. This was design/source review only; no tests or implementation acceptance are claimed.

## Settled state sequence

- No review selected: ordinary task workflow, unchanged.
- Internal review selected: submit work with a file/link → assigned independent internal reviewer → corrections and a new evidence round, or internal approval → existing authorized completion.
- Client review selected: internal review is mandatory. Submit work with a file/link → assigned independent internal reviewer → APPROVED → automatic client routing under the saved publishing authorization.
- Client delivery retries preserve the approved evidence and cannot create a duplicate publication. Corrections, revoked authority, missing recipients or inaccessible evidence block delivery with an actionable status.

This is the confirmed product contract. Application/schema implementation, test acceptance and deployment remain IN PROGRESS; recording the decision does not enable this behavior in the running release.

## Owner extension: confirmed drawings in Project Files

The Owner requested that client-reviewed work be added to Projects → Files → Confirmed drawings. The follow-up explicitly selected “Keep approved link, clearly labelled” for link submissions. This extends the requested implementation; it is not live functionality.

- Trigger: successful Primary Client final approval through the existing formal approval workflow, after all required item approvals. Starting/finishing review, a comment, an individual item decision or requested corrections must not add an entry.
- Automatically surface the exact approved evidence in that project's Files → Confirmed drawings, bound to its task, internal submission/round, client item/package and final approval. Preserve immutable approval history and current project/file visibility permissions.
- Uploaded drawing evidence refers to its exact approved revision/blob/checksum in existing private storage. Do not move the source file, duplicate its bytes or silently replace an earlier approved version. New approved revisions retain version and approval history.
- Link evidence appears as an explicitly labelled “Approved link”, with its preserved reviewed URL and approval details. It must not imply the external site's content was captured, frozen or validated. Do not fetch it server-side or invent a file/blob/drawing revision. Generic file evidence remains labelled as an approved file rather than fabricated drawing metadata.
- Filing/display is idempotent for the exact final approval and evidence identity. A retry cannot duplicate entries, and newer task evidence cannot replace what was actually approved.
- This presentation rule does not itself issue a drawing for construction, grant additional client/staff access or bypass the existing formal issue/download/Confidential controls. A link creates no S12 exact revision approval/issue fact.
- Acceptance includes successful file/link filing only after final approval, no filing for corrections or incomplete item approvals, duplicate/concurrent retry safety, exact-version history, scoped reads, revoked grants and responsive accessible file/link labels.

## Source implementation checkpoint

The implementation extends existing task/review/client APIs and Project Files. Review requirements remain immutable after task creation. New client selections normalize to BOTH and capture current publishing authorization in the create transaction. Existing BOTH work can receive explicit authorization, revocation and replacement authorization without changing its review requirements. Replacement authorization is limited to initial setup or the unchanged internally approved work.

Work evidence is stored in the already immutable ReviewSubmission.taskSnapshot, with DRAWING/FILE/LINK discrimination and a canonical SHA-256 digest; a separate evidence table is unnecessary because the submission itself supplies the immutable identity. ClientReviewItem.workSubmissionId binds the exact approved round and is unique across all authorizations. Attempts are unique by submission plus authorization. Historical task-only rows remain readable and keep their prior decision rules; new submissions/publications require evidence. URLs remain in scoped immutable snapshots, are not fetched, and are redacted from publication audit/event snapshots in favor of their bound digest. Exact final-signature snapshots include submission identity/digest for new items only.

The reviewed additive candidate is 20261023000000_task_review_work_routing, the 120th migration by count. It does not import the excluded client-password migration120. Baseline migrations1–119 are unchanged. Only newly created, manifest-owned test clusters have received this candidate; retained data and canonical staging remain at119. The old recovery119 harness and its capability checks remain unchanged. A separate owned120 test capability verifies the exact source fingerprint, migration ledger and live database identity for commit/parity regression tests.

Earlier isolated checks passed15 evidence-policy unit cases and both affected PostgreSQL suites5 cases, including internal-before-client routing, concurrent deduplication, file/link formal final approval and derived Confirmed drawings. Broader checks passed523 API unit and656 web tests on their recorded source checkpoint. Failed full attempts are preserved: an initial stale UI assertion; incorrect fixture singleton seeding; old tests omitting newly required evidence; missing isolated accounting receiver; frozen119-only test guards; and review configuration conflicting with immutable task requirements (corrected by preserving requirements and limiting configuration to publishing authorization). These are not final exact-candidate acceptance claims. A concurrent unselected Time module change introduced unrelated type errors; acceptance must use an isolated selected-file candidate.

Remaining work: exact-candidate typecheck/lint/unit/build, all PostgreSQL suites, desktop/mobile journeys and new evidence UI, independent final source/visual review, explicit selected commit and controlled release preparation. Retained schema promotion and a matched live release are not claimed.


## Verification checkpoint — 2026-10-23

Application source remains the reviewed cf0acab behavior, with subsequent commits limited to test fixtures and staging safeguards. Dedicated source115b5c6 passed pinned typecheck, lint, 523 API unit tests and 656 web tests. After the isolated parity fixture explicitly creates its private NAS mount, source5fbe4c0 passed all421 PostgreSQL tests across64 suites, without skips. All12 staging operations tests passed, including actual rejected promotion with byte-identical active pointer and no preserved-pointer side effect. The promotion command validates schema count/profile, artifact commit and retained database identity before any pointer write.

A read-only dump of the verified retained119 database was restored to a new database on owned disposable port58440. Applying only the reviewed additive migration preserved all174 original tables,37 populated tables and1,048 rows by ordered old-column digests. The successful receipt and backup are preserved under .env.review-routing-20261023/retained-clone-1792731131053. A prior failed rehearsal (missing explicit Prisma config) is preserved separately. No retained migration was run.

An immutable86250855202434b073fa0acb8a325f596459509f artifact was built successfully (build862508552024-1792731000964) and remains unpromoted. Later changes address browser acceptance only: preview working directory, post-revocation fixture version, unique screenshot directories, complete isolated client/time test flags and a separate identity-verified automation test helper. The first browser attempts are diagnostic and do not constitute acceptance. Final browser/visual acceptance and an artifact matching the final selected candidate remain pending.

### Operator behavior

At task creation, select Internal review required and/or Client review required. Selecting client review also requires internal review and current publishing authority. Appoint an independent reviewer using the existing review workflow. Start the task, then submit an exact drawing revision, an uploaded document or a valid HTTPS review link; text alone cannot submit work for review. Existing Documents upload remains the upload entry point, with a refreshable evidence selector in Reviews.

Internal approval commits before client delivery. Automatic delivery uses the exact approved submission. If a Primary Client, current authorization or permitted evidence is unavailable, routing displays a blocked reason; an authorized publisher can resolve the cause and retry. Revoke disables that authorization; reauthorization is explicit and retains history. Corrected work needs a new submission and approval.

After the Primary Client's formal final approval, open Projects, select the project, then Documents to find Confirmed drawings. Approved links are labelled and open separately; the URL is preserved while external content may change. Existing file visibility and Confidential controls still apply. This feature is not yet live on canonical staging.


## Final candidate checkpoint

Candidate9f1da4b is accepted for activation, with exact evidence and remaining Owner migration/deployment decision recorded in TASK_REVIEW_ROUTING_CANDIDATE_ACCEPTANCE_2026-10-23.md. Earlier pending-check language above is historical. Overall feature/recovery remains IN PROGRESS until the retained upgrade and matched live release are verified.


## Owner-approved activation completed

The Owner accepted the explicit migration120 and9f1da4b activation request. The matched web/API release is live and READY on canonical local staging, with original174 tables/1,048 rows preserved before and after startup. See TASK_REVIEW_ROUTING_COMPLETION_2026-10-23.md for final evidence, independent acceptance and current-browser/production limits. Earlier pending-activation statements are retained historical checkpoints.
