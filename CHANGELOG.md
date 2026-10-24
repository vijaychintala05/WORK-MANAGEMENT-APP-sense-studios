# Changelog

## [0.2.2] - 2026-10-21

### Changed

- Refine Dashboard data presentation from the V10 demo and prevent mobile bottom navigation overlapping the desktop sidebar.

- Complete the V10 Dashboard in the existing application: fixed factual task summaries, customizable account-specific desktop/mobile widgets, and a deduplicated attention queue.
- Connect timer controls to existing persistent Time commands with recoverable command identities and visible failures. Restrict performance to authorized management scope and supplied scores.
- Preserve existing reports, summaries, schedules, access rules and data. No new schema or migration.

V10 is verified and deployed to canonical local staging. Exact source, browser, cache and operational limits are recorded in the V10 completion report.

## [0.2.1] - 2026-10-21

### Changed

- Consolidate the existing Sense frontend, API and shared contracts through the recovery integration branch, preserving historical alternatives and deferring unaccepted client-password migration120.
- Present factual Dashboard source counts and health scales, add the configured Site employee's authorized snag summary, and restore frontend test-file isolation.
- Add commit-bound matched staging artifacts, visible web/API release identities, exact database/schema readiness, guarded Windows supervision and release-aware offline delivery.
- Keep canonical startup commands on the approved artifact workflow; preserve experimental demos and route new UI work into existing application pages.

Recovery acceptance remains in progress until exact-candidate persistence, browser and deployed-runtime checks are recorded. Actual-project and production readiness are not claimed.

## [0.2.0] - 2026-09-27

### Added

- Added passkey sign-in, secure sessions, Owner identity controls, and staff enrollment and recovery.
- Added organization, branch, team, employee, and scoped role-permission management with persisted audit history.
- Added append-only audit events, transactional outbox delivery, an in-app inbox, notification preferences and quiet hours, and verified mailbox challenges for email eligibility.
- Added Owner audit corrections, retention holds and notices, and guarded expiry with deletion tombstones.
- Added local verification and recovery workflows for PostgreSQL-backed deployments.

### Changed

- Delivery workers now claim one outbox item at a time and renew its fenced lease while processing.
- Owner audit search now uses a case-insensitive exact event key backed by an ordered composite index.
- Improved organization administration loading so changing the selected employee does not reload organization data.
