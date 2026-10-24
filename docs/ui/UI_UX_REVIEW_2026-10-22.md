# Sense Studios UI/UX review — 22 October 2026

## Verdict

The application has a coherent visual foundation: pine navigation, warm neutral surfaces, labelled controls and recognizable workspaces. The main weakness is information hierarchy. Everyday work competes with configuration, evidence terminology and optional fields. Improve the shared shell, task composer and Project directory before adding more visual decoration.

This is a review, not an implementation or release-acceptance report. No application code, permissions, credentials, business records, migrations or deployments were changed. No task, project, review decision, email-code request or session revocation was submitted.

## Exact scope and evidence boundary

- Method: the explicitly requested **ui-ux-pro-max** skill, its Web-specific checklist and verified local UX searches for `error summary validation` and `focus not obscured`; live browser screenshots/accessibility snapshots/read-only DOM measurements; targeted source inspection.
- Browser: existing authenticated Owner session; Dashboard, Tasks, creation dialog, My Work, Projects, People and Settings. Client and external portal entry screens were inspected without signing in or requesting codes.
- The browser initially displayed an update notice and a cached shell using `/assets/index-DTyERBzP.js`, without the deployed-release footer. The Owner explicitly selected **“Review the current cached screen for now.”** The update was left unapplied and browser storage was not cleared.
- Independently read public web `/release.json` and API `/api/v1/health/release`: both identify commit `58872f0396a1fbbb3a6d4809edd1ba1ae02ec2c5`, build `58872f0396a1-1792601887224`, migration count **119**. These matching server manifests do not establish that the cached tab rendered that release.
- Source reviewed at checkout HEAD `60d9292eadb824bd78235e76ab35186244ecdf0c`. Pre-existing dirty dashboard CSS/components and ESLint changes were present; they were not edited or certified by this review.
- Actual measured viewport remained **1280×720**. A requested 390×844 browser override did not change the measured viewport. The override was reset. **No live phone/tablet/landscape pass is claimed**; mobile observations below are source-based recommendations where stated.
- Only the Owner and anonymous portal entry experiences were observed. Employee, leader, site, client-authenticated and assistive-technology journeys need separate checks. No complete accessibility conformance or performance benchmark is claimed.
- The read-only staging-status CLI failed with an Array-buffer allocation error on the host. This is a review-tool failure, not evidence that the application itself has a memory defect. Browser review and public release-identity reads remained available.

## Prioritized findings

### UX-01 · High · Cached desktop shell shows desktop and mobile navigation together

**Observed:** at 1280px, Tasks, My Work, Projects, People and Settings displayed the left sidebar and fixed bottom navigation simultaneously. DOM styles on Projects returned `display:flex` for both `.workspace-sidebar` and `.workspace-mobile-nav`. The bottom bar consumes vertical workspace and presents a second primary-navigation system. The Dashboard's shell also differs from the other routes.

**Important source distinction:** HEAD `60d9292` is already named `fix: keep mobile navigation below the desktop breakpoint`. Current `workspace-navigation.css` retains the desktop breakpoint and no longer overrides its display rule in the later mobile block. **Do not repeat this source fix based on the cached screenshot.** Confirm it in the approved matched release after an Owner-approved update.

**Acceptance:** one primary navigation pattern per breakpoint; no desktop bottom bar at 1280/1440; mobile bar and content inset verified at 390/320. Preserve the existing approved navigation destinations and permissions.

### UX-02 · High · Task creation places optional content ahead of the brief and required reason

**Observed:** the Owner form presents task name, type/priority/Target, project and ownership, followed by the collaborator checkbox list. Description appears later with stage/milestone, tags, checklist, start and effort. Mandatory Reason is last. At the measured desktop height, the first screen ends around the owner selector; important briefing and required reason need scrolling. The technical account-identity explanation takes the most prominent helper position.

**Change:** show Task name + Description as the brief; make project, Primary Owner, Target, priority, review summary and “Why is this task needed?” immediately discoverable. Collapse collaborators and additional planning into named sections. Replace the person wall with an eligible-person search/selection pattern. Explain Owner assignment as “Choose the employee responsible for this task.” Preserve the fact that an Owner account without an employee identity cannot self-own a task.

**Source:** `apps/web/src/task-composer-fields.tsx`, `task-create-dialog.tsx`, `task.tsx`.

**Acceptance:** an ordinary self-task can be composed without expanding optional groups; Owner sees an explicit employee requirement; every required field is visible or clearly signposted. Existing persistence and authority remain unchanged.

### UX-03 · High · Validation has a global error but lacks connected field-level guidance

**Source-confirmed:** `taskDraftError` returns one text error; `validateCreation` places it in shared `error` state, rendered as a top-level alert. Composer controls do not connect those errors using `aria-describedby`/`aria-invalid`; that custom-validation path does not focus a linked summary or the invalid field. Native `required` validation may help some fields, but it does not cover all cross-field/custom rules.

**Change:** maintain field errors, show them beside the corresponding controls, and focus a linked error summary after a multi-error submit or the first invalid field for a single error. Keep drafts intact. Explain disabled Create states, especially missing owner/reason and unavailable participants.

**Acceptance:** keyboard users can identify and reach the invalid field without searching a long scrolled form; date ordering/project-type/duplicate-tag errors are connected to the right control. This path was inspected, not exercised by submitting a retained-data command.

### UX-04 · Medium · Project remains labelled optional when the chosen task type requires it

**Observed:** selecting **Project** task type left **Project (optional)** and **No project** visible. Source uses a fixed optional label while validation requires a project for Project, Correction and Site tasks.

**Change:** show a contextual “Project — required” label for those types. Keep the type/context relationship clear, and explain selections cleared by a project change. Do not invent a project or automatically select an unrelated one.

**Source:** `apps/web/src/task-composer-fields.tsx`.

**Acceptance:** Project/Correction/Site cannot visually imply that no project is a valid completed form; Non-project remains project-free. Conditional required indicators match actual validation.

### UX-05 · High · Project template administration precedes the project directory

**Observed:** Projects opens with the template picker, template-management explanation, empty-template message and Create template action. At 1280×720, the actual project list is below the first viewport even though existing projects are available.

**Change:** lead with search, project rows and a clear New project entry. Put template selection inside project creation. Move template administration to a named secondary area/disclosure without removing it from authorized users.

**Source:** `apps/web/src/project.tsx:295`, `project-template.tsx`.

**Acceptance:** available project rows are visible before configuration controls on normal desktop entry; creating/editing templates still preserves versioning and authorization.

### UX-06 · Medium · Project creation asks ordinary users to enter internal identifiers

**Observed/source-confirmed:** Create Draft project includes free-text **Client ID** and **Won lead ID** fields.

**Change:** use authorized searchable Client/Lead selection with human-readable labels. Continue passing the existing canonical IDs internally. Keep direct-project creation clearly available. If a suitable authorized lookup API is absent, record that dependency rather than adding an unrestricted directory read or inventing data.

**Source:** `apps/web/src/project.tsx:322`.

**Acceptance:** a user can link an existing client/lead without finding or copying a UUID; lookup and create commands independently enforce access.

### UX-07 · High readability concern · Dashboard explanatory text reaches 9px

**Measured in the cached Dashboard:** summary status breakdowns are **9px**; source timestamps are **10px**; several widget subtitles are **10–11px**. These sentences contain functional distinctions, not merely decorative metadata. Large headline counts are easy to scan, but their meaning is much harder to read.

**Change:** reduce the amount of always-visible explanation and make the remaining helper text readable, normally at least 12–14px for this desktop product. Keep concise status summaries; put long source/policy details in accessible disclosures. Preserve overlapping-count semantics and unavailable-versus-zero distinctions.

**Scope:** cached measurement only. Dashboard files already have concurrent uncommitted changes; this report does not establish whether those changes address the issue or how the current approved artifact renders after updating.

**Acceptance:** readable count definitions at actual browser zoom; text remains available with scaling; no essential interpretation depends on a tiny colored segment or hover-only legend.

### UX-08 · Medium · Blocked completion explanations rely on a tooltip

**Source-confirmed:** some disabled Complete task paths put the child-completion/review explanation only in the button's `title` attribute. A disabled control and hover tooltip are an unreliable help path for touch and keyboard users.

**Change:** show a visible sentence adjacent to the action, such as “Complete the subtasks first” or “Finish the required review in Internal reviews,” with an authorized link where possible. Keep hidden/inaccessible blockers generic.

**Source:** `apps/web/src/task.tsx:933`.

**Acceptance:** the reason is available without hover or focusing a disabled button. Do not enable completion early or add Undo/reopen to terminal tasks.

### UX-09 · Medium · Account Settings is dominated by navigation and session history

**Observed:** the Settings navigation consumes most of the first viewport before Account & devices content begins. The **Active sessions** section then contains many **Expired** and **Revoked** records alongside the current/active devices.

**Change:** present a compact section navigation and place the selected section's content beside/below it with less vertical delay. Show current/active devices first; place expired/revoked records under a clear **Session history** disclosure/filter. Retain all evidence and the existing revoke behavior.

**Source:** `apps/web/src/settings-homes.tsx`, `apps/web/src/app.tsx:445`.

**Acceptance:** finding the current device or an active session does not require scanning historical rows; “Active sessions” accurately describes its contents. No records are deleted to simplify the view.

### UX-10 · Medium · Page landmarks and route focus are inconsistent

**Observed:** Dashboard, My Work and Projects have their main page title as H2 with no main H1. People and Settings do have H1. No skip-to-main link was found on the inspected shell. After returning to Dashboard, focus was on BODY rather than a useful main-heading target.

**Change:** use a consistent page-heading hierarchy, add a visible-on-focus Skip to main content link, and manage SPA route focus predictably. Preserve modal focus containment and restoration.

**Acceptance:** a keyboard user can bypass repeated navigation; route changes announce a useful page context. Absence of H1 alone is not being presented as an automatic accessibility-conformance failure.

### UX-11 · Medium · Technical evidence language competes with the action

**Observed:** prominent copy includes “authorized project snapshots and recorded signals,” “no active employee identity,” and “separate exact source counts.” Assigned-review rows display raw states and full ISO timestamps. The underlying distinctions are valid, but users must interpret implementation vocabulary before deciding what to do.

**Change:** use short action-oriented labels and human-readable dates in the primary layer. Keep source time, exact evidence and policy limitations available in secondary details. Show **My work / Organization work** scope explicitly where it changes the interpretation of counts. Do not merge unlike counts, invent missing scores or hide an unavailable source as zero.

**Acceptance:** a user can identify the next action and understand its date/scope without reading a technical paragraph. Date-only values stay date-only rather than being shifted through an arbitrary timezone conversion.

### UX-12 · Low–Medium · Client entry has weaker help and cross-portal orientation

**Observed:** Client portal sign-in exposes an email field and Send sign-in code action, with little recovery/help/orientation. The external portal has an Other sign-in options link and a different card hierarchy. The update notice reappeared across separate portal navigations in this cached session.

**Change:** align shared auth framing, explain that access is invitation-based, and offer clear help/other-entry navigation. Review resend/change-email/invalid-code states in a separate authorized flow test before recommending detailed behavior changes.

**Boundary:** CLIENT OTP is the accepted migration119 method; client-password migration120 is excluded by the current Owner direction. **Missing password/reset fields are not a defect in this candidate.** No real email was sent for this review.

## What is working and should be retained

- Pine/cream/white surfaces establish a recognizable product identity. The main screens have labelled inputs and named actions rather than icon-only primary controls.
- My Work correctly explains why an Owner without an employee identity has no personal tasks and offers a route to organization tasks. This is correct scope behavior, not missing work.
- Task creation uses a native modal, focuses its heading, locks background scrolling, and has a separated action footer. The inspected source includes focus restoration and pending/dirty-close guards.
- The creation source has a same-command recovery path and does not need replacement with a fresh “Try again” command. Preserve that contract during redesign.
- Project directory search/pagination, People filters and explicit empty states exist; improve their hierarchy rather than removing them.
- Client and external portal entries use distinct session boundaries. A UI review is not permission to unify or bypass those boundaries.

## Recommended implementation order

1. **Release-aware recheck:** when the Owner chooses to update, repeat the shared-shell review on the actual matched release. Do not redo the existing desktop navigation fix from a stale screenshot.
2. **Task composer:** hierarchy, searchable eligible participants, conditional labels, explicit required fields, connected validation and visible completion blockers. Preserve existing APIs and rules.
3. **Project directory:** project list first; templates inside creation/administration; human-readable client/lead selection with authorized lookup dependencies.
4. **Shared usability:** readable type scale, compact Settings and session history, consistent headings/route focus/skip link, and concise action-oriented copy.
5. **Broader acceptance:** actual 1440/1024/390/320 renders, phone software keyboard, text scaling, keyboard/screen-reader journeys and real Employee/Leader/Site/Client contexts. Validate a clean browser and an intentionally cached browser separately.

This review proposes presentation improvements. Any change to identity, task ownership, permissions, review/completion gates, visibility, notifications, durable drafts or retained evidence requires its existing domain contract and material Owner decisions. Generic skill advice about autosave, undo, exports or virtualization is not automatic authorization to add those features.

## Handoff

Reviewer: current Codex using ui-ux-pro-max; no independent reviewer or Opus/Sonnet review is claimed. Source changes were not made, so no implementation tests, build, `pnpm verify`, commit or deployment was performed. Browser inspection is evidence of the named screens/states only, not whole-app acceptance. User-approved cached-review limitations remain explicit above.
