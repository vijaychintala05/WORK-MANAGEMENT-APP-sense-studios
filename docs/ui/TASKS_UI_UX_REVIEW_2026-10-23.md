# Tasks tab review — 23 October 2026

Follow-up, 2026-10-24: TUX-01 through TUX-06 are implemented and live in controlled local staging. See [completion and verification](../development/TASKS_CLARITY_COMPLETION_2026-10-23.md). The original review checkpoint below remains preserved.

Review only. No application code, tasks, permissions, approvals or data were changed. Used ui-ux-pro-max accessibility/layout/forms/navigation checklist and existing Sense screens as the audit reference under the Refero audit workflow. No new external Refero reference research or redesign is claimed.

## Evidence and scope

Inspected the live authenticated Owner Tasks page at `/tasks?scope=all`, release footer `078e1c78` for both web/API. This is later than the previously accepted task-review release9f1da4b. Checked collapsed/expanded filters, organization list, two task details, back navigation and narrow layout. Viewports1280×720 and390×844. Temporary viewport override was reset and the separate audit tab closed. No workflow mutation or creation was submitted.

Screenshots: `.env.tasks-ux-review-20261023/tasks-mobile-overlap.jpg` and `tasks-desktop-detail-overlap.jpg`. These show retained synthetic test labels/account identifiers and remain private evidence. Findings combine live DOM/layout inspection with current source; this is not a full keyboard/contrast audit or an Employee/Leader acceptance run.

## Prioritized findings

### TUX-01 — P1: overlapping task rows make the list unreadable

Observed on both desktop and390px phone: task titles, field labels and the People control occupy the same space. Opening a detail panel narrows the desktop list to about236px, making overlap especially severe. This is a functional layout defect, not merely a taste preference.

Source diagnosis: `apps/web/src/my-work-visual.css:328–332` applies unscoped task-row rules, placing `.task-queue-open-main` absolutely over the row. In `apps/web/src/task.tsx:882` onward, that button contains title/status/date cells; only the owner cell remains a direct sibling in normal layout. The task-row grid therefore cannot allocate space for the fields inside the absolute button. Container rules in task.css adapt the outer grid but cannot repair that content structure. Project embedding has a separate static-button override in project.css, while the standalone Tasks page remains affected.

Fix first: explicitly scope the My Work overlay rules and give the standalone Tasks row a deliberate layout for its actual markup. Keep the People control separately operable. Verify list-only and list/detail at1280/1440/1024/783/390/320, including long titles/owners/statuses, without changing My Work or Project behavior.

### TUX-02 — P1: main task actions are buried and disabled without nearby guidance

For the inspected Not started task, Start task appeared far below the initial detail viewport, after empty Subtasks, facts, a full dependency editor, tags/checklist, description, committed-date form and reassignment controls. It was disabled with no title explanation; the required Reason for change field appeared separately above reassignment. The exact DOM measurement placed Start task roughly2087px below the current viewport origin at desktop.

Fix: put current state, one capability-appropriate next action and its required reason together under the task title. Explain unmet requirements beside the action. Preserve current authority and audit-reason rules. Move reassignment, committed-date changes and dependency editing into an explicitly opened Manage task area; retain read-only summaries when relevant.

### TUX-03 — P2: controls consume the first screen before work becomes visible

At1280×720, the account strip, page heading, scope buttons, four display options, Compact/Refresh and large search/filter container push the first actual task below the initial viewport. The collapsed filter area still shows a prominent Apply filters and Reset filters pair with substantial blank space. Expanding it adds a tall collection of advanced inputs.

Fix: compact header with Create task as its single primary action. One short toolbar for search, quick project/status filters, advanced Filters and a subordinate View menu. Show active filter chips and a pending-change signal. Preserve the explicit apply behavior consistently or deliberately redesign it; do not silently mix immediate and deferred filters.

### TUX-04 — P2: navigation gives different destinations the same name

The sidebar has My Work and Tasks. Inside Tasks, the scope control is also labelled My Work but switches scope within Tasks, while My Work now has its own management scopes. The inspected Owner account is not linked to an employee, making personal work and organization management particularly easy to confuse.

Fix: make Tasks clearly the task register; use an explicit personal scope label such as Assigned to me, keeping My Work as the separate daily-action destination. Explain the employee-less Owner personal empty state. Do not broaden accessible rows or replace the recently accepted My Work workflows.

### TUX-05 — P2: work states are exposed as internal workflow vocabulary

Filters offer both Status and Phase without explaining their relationship. Status includes13 granular options such as Submitted internal review, In internal review and Internal approved. A project task shows Open internal review even before work starts, while the list mostly offers Open task regardless of stage. Completed tasks appear alongside current work by default in the inspected organization register.

Fix: make Active/Waiting/In review/Completed/All understandable quick views, with detailed status as an advanced refinement. State what review is waiting for and who acts next using existing authorized evidence. Do not derive permission or reviewer/recipient identity from status alone. Preserve the distinct internal/client approval states and their backend gates.

### TUX-06 — P2: task ownership and dates are hard to scan

The inspected rows display long email identifiers, a separate repeated People label, uppercase priority and two dates, with Not committed repeated across most rows. The details also expose Version alongside business facts. Some of this is fixture data; real employee names were not independently assessed. The row structure still prioritizes repeated technical/empty metadata over the task's immediate relevance.

Fix: lead with title/project, then responsible person's display name, readable status and clearly labelled due date. Keep target and committed dates distinct; reveal their meaning/context on demand. Use human date formatting consistent with organization date rules. Move Version to activity/technical details. Do not fabricate names or collapse semantically different dates into one calculation.

## Recommended sequence

1. Repair TUX-01 first and verify all shared task embeddings before any redesign.
2. Reorder task details around a nearby, explained next action; keep management forms collapsed.
3. Simplify the toolbar, label personal scope clearly and make review progress understandable.

Recommended page hierarchy: Tasks + Create task → scope/search/quick filters → task list → selected-task details. Details hierarchy: title/state → next action/reason → description/evidence/checklist → optional management → activity.

Good existing foundations to preserve: dedicated Create task control, real labels, deep-linked task selection, Back to task list, server-enforced capabilities, immutable review evidence and separate formal client final approval. Fixing presentation must not relax these rules.

## Skill evidence

ui-ux-pro-max Quick Reference §§1,2,5,8,9 directly fits the observed hierarchy, responsive layout and feedback issues. Local searches for navigation hierarchy/progressive disclosure and complex forms returned broad or off-topic results; one narrower retry did not verify a specific progressive-disclosure match. No unverified dataset recommendation was persisted as authoritative evidence. Recommendations above follow the supplied checklist and observed Sense behavior. Refero craft guidance was consulted for focus preservation; no focus-ring removal is proposed.

Review performed by current Codex. No Opus/Sonnet, independent acceptance, full accessibility pass, implementation or deployment is claimed for this review.
