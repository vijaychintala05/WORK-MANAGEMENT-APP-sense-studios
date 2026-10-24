# Sense recovery and controlled staging — 21 October 2026

Status: COMPLETE for development/local staging. Matched V10 release58872f0 is live; exact acceptance and remaining operational/production limits are recorded in V10_COMPLETION_REPORT_2026-10-21.md. Current Owner instruction authorizes non-destructive preservation, integration, verification and local staging. No production or actual-project acceptance is implied. The Owner explicitly approved current Codex architecture/security/final acceptance reviews in place of unavailable Opus/Sonnet for this recovery. Actual reviewers and check results must be recorded.

## Authority and requirements

Canonical source remains `D:/app/sensestudios work management app`: `apps/web`, `apps/api`, `packages/contracts`. Start from `codex/s20-site-integration` at `3f06f9c`; retain it and all historical refs. Integration branch: `codex/sense-integration`. ArchiFlow is excluded.

Requirement anchors: R-005.a–d identity kinds; R-006 permission model; R-011–R-017 Projects; R-018–R-024 tasks; R-027–R-029/R-037/R-039 reviews and controlled evidence; R-041–R-043 time; R-068–R-070 site; R-073.a–c/R-074.a–b dashboards; R-099.a–f security; R-100–R-102 verification; C-007 backup/recovery; C-008 passkeys/recovery. Existing S18 migrations110–114 and S27 at115 remain unchanged. R-104/R-105 operational and production gates remain unverified.

## Ordered slices

1. REC-01 preserve all tracked/untracked source, ignored configuration/evidence/offline database files, ref history and external reference package; restore and verify checksums before app changes.
2. REC-02 reconcile the main Sense implementation against accepted reports/demos and archived alternatives. Preserve every deferred artifact. Do not replay old S18 migrations or import ArchiFlow rules.
3. REC-03 prepare a migration119 candidate. Move unaccepted client-password implementation/migration120 into preserved deferred storage, remove only its registration/schema additions and restore the accepted client sign-in entry point. Retain existing staff passkeys, client OTP/passkeys and external identity behavior.
4. REC-04 provide immutable matched web/API artifacts from an explicit commit, public non-secret release identity, visible frontend/backend versions, schema/checksum-aware staging readiness and supervised local serving on59443/59442. Keep canonical DB45434/OID145606/system7693570241708228348; no automatic migration, seeding or credential setup.
5. REC-05 verify isolated populated restore/migration preservation, supported unit/type/lint/build/integration/browser checks, denied-role boundaries and four-width UI. Record exact scope and failures. Never use retained data as a destructive fixture.
6. REC-06 select named reviewed paths for traceable commits; promote only a clean explicit release commit. Verify hosted default branch and configure the reviewed integration branch after validated push. Retain old refs and rollback releases.
7. REC-07 verify the deployed artifact/hash/commit/DB binding, clean and cached browser behavior and supervised recovery. Record which reboot/ordinary-login/role acceptance remains unverified.

## Scope boundary

In scope: preserve and consolidate existing authorized functional implementations; restore release consistency; correct demonstrated defects; release identity, safe local deployment, startup/recovery, update visibility and future demo integration rules.

Out of scope: new business policy or permissions, replacing backend logic, destructive cleanup, production changes, live inference/transmission, migrating retained data to unaccepted120, promoting standalone fixture screens, claiming new formal operational acceptance. Conflicting unapproved alternative designs remain deferred for Owner decision.

## Acceptance and tests

Preservation: verified regular-file restore and link metadata, all-ref bundle, intact historic archives, backup listing and isolated DB restore/preservation evidence. Source: module/approval matrix, no fixture routes replacing production routes, secret/generated/private-data selection report. Release: exact immutable commit and hashes shared by web/API; expected migration count/checksums and configured database identity; stale or mismatched artifacts fail closed. Runtime: one bound loopback stack, canonical static root, owned-process recovery, bounded logs, startup task metadata and manual invocation evidence; no stop/start of unrelated services. Browser: real source UI, login/denied states, relevant task/project/review/People/site/time journeys, widths1440/1024/390/320, clean profile plus a profile carrying an older service worker. Required toolchain: Node24.19.0/pnpm11.19.0.

Historical tests certify only their pinned source. Current results must be rerun and reported; no earlier pass substitutes for current verification. New evidence remains private/ignored where it contains synthetic sessions, data or credentials.

## Rollback and restoration

Preservation lives in ignored `.env.consolidation-20261021/`: complete history bundle, source manifest, regular-file archive, original index and binary diffs, link records, restored/verified files and Owner references. Do not extract over the current checkout. Recover into a separate empty location, verify hashes, then reconcile explicitly. Database recovery uses verified copies/backups and a separate target before any approved restoration. Release rollback selects a retained matched web/API artifact only after schema compatibility checks; no automatic down-migration or data overwrite.
