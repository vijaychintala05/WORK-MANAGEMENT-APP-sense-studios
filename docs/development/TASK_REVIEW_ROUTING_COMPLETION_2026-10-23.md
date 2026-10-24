# Task review evidence/routing — controlled local staging complete

Status: COMPLETE for development and controlled local staging, 23 October 2026. The Owner's “feacher accepted” response accepted the preceding request to apply reviewed migration120 and activate release9f1da4b. This supersedes the prior pending-activation checkpoint for this exact feature only. Production and actual operational R-104/R-105 acceptance are not claimed.

## Deployed release

- Canonical app: `http://localhost:59443/`; API loopback59442.
- Selected immutable source: `9f1da4b140c005586dc909810ba267a2c156c500`.
- Matched web/API build: `9f1da4b140c0-1792732431728`.
- Manifest SHA-256: `8c85787ca58a5bbe986069d13639ec728c4b4fd90775cfb0dbae6d5d54231c87`.
- Schema120: additive `20261023000000_task_review_work_routing`; excluded client-password120 and ArchiFlow remain excluded. Historical migration checksums1–119 remain unchanged.
- Runtime database identity remains loopback45434, retained database `sense_latest_retained_20261014_test`, OID145606 and system7693570241708228348.

The existing guarded scheduled launcher started the selected release. Status reported READY; `/release.json` and `/api/v1/health/release` returned matching source/build/schema120 with no-store, and `/api/v1/health/ready` returned200 with database ready. Old artifacts, pointers, runtime settings, startup receipts and historical refs remain preserved.

## Behavior now available

Create project tasks with separate Internal review required and Client review required checkboxes. Client review includes internal review and captures existing publishing authority. Appoint an independent reviewer, then submit exactly one file, drawing revision or valid HTTPS link when work is ready. Text-only new submissions/publications are rejected.

Automatic client delivery follows independent internal approval of that exact evidence, with current authorizer/Primary Client/project/file permissions rechecked. Blocked delivery preserves internal approval and supports authorized retry/revocation without duplicate publication. Historical task-only rounds and task review requirements remain immutable.

After formal Primary Client final approval, Projects → Documents → Confirmed drawings shows the exact approved evidence. Approved links are labelled and retain an external-content caveat. Existing Confidential, signature, revision and formal issue gates remain. No historical task was automatically authorized or routed by deployment.

## Preservation and activation evidence

Private receipts are preserved under `.env.review-routing-20261023/activation-1792735386849`.

Before maintenance, exact selected artifact/migration files, the current119 release/database ledger and database identity were verified. The active pointer, runtime configuration, bootstrap directory and scheduled-task XML were preserved. Only the verified canonical app was stopped; PostgreSQL and retained data were kept.

A fresh consistent pg_dump snapshot and original-column digests captured174 original tables and1,048 rows. The canonical NAS root was copied and its file inventory verified; it contained zero files, so this is empty-inventory preservation, not evidence of populated binary-file restoration. Prior populated test/rehearsal evidence remains recorded separately.

Applying the single selected migration preserved every original table count and old-column digest. New routing authorization/attempt tables contained zero rows. The approved runtime schema profile was set to `task-review-work-routing-20261023`; only the installed bootstrap manifest module was refreshed from the selected artifact, with its predecessor preserved. Scheduled-task XML remained byte-identical, including action/principal/triggers/settings. Promotion used the exact acceptance manifest hash.

After startup, all174 original tables/1,048 rows still matched pre-migration digests, and both new routing tables remained empty. The first post-start verifier used the application's UTC adapter against backup JSON timestamp digests produced in the retained server's Asia/Calcutta session timezone. That serialization mismatch was investigated; repeating the read-only calculation with the same backup connection settings passed all tables. No stored values were changed to resolve the verifier mismatch.

Live unauthenticated access to the new confirmed-drawings endpoint returned401/no-store. A read-only invocation of the exact released ReviewService, using the current persisted Owner and project authority, loaded the confirmed-drawings projection successfully with zero entries. No test task, approval, client grant, credential or session was inserted into retained data for smoke testing.

Browser control reported “Local browser use is disabled in Work settings.” The current user's browser, cookies, drafts and cached shell were not accessed, cleared or forcibly reloaded. This deployment does not claim a fresh authenticated journey in that personal browser. Accepted desktop/mobile journeys and visual captures cover the matching application source. Users should save work and use the app's ordinary update/reload control to load the new shell; do not clear browser storage.

## Verification and boundaries

The candidate report records exact test checkpoints: pinned typecheck/lint/build,523 API unit/API tests,656 web tests,421 PostgreSQL tests/64 suites,12 staging checks and57 distinct desktop/mobile journeys (55 in the full run plus two separately enabled Time journeys). No single57/57 invocation or new full suite after the runtime-config/documentation-only activation is claimed. Independent source/desktop/mobile visual review passed through the selected candidate.

An independent Codex reviewer also read the deployment receipts, verified canonical guarded status, compared active pointer/manifest/authorization and checked the retained backup hash. The reviewer accepted controlled local staging, with preservation digests reviewed through receipts rather than independently recomputed. Actual routing used current Codex and an independent Codex reviewer; no Opus/Sonnet result is claimed.

Unrelated concurrent Time/controller/UI/composer CSS work remains outside the selected release. This completion covers the accepted feature on canonical local staging. Production NAS, hosted CI/default-branch promotion, reboot behavior, offsite backup custody and actual operational acceptance retain separate gates. Future retained migrations require their own explicit authorization; no automatic downgrade or restore is authorized.
