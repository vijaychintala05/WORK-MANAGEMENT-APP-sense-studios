# Dashboard data presentation refinement — 22 October 2026

Status: COMPLETE for Owner-authorized development/local staging; see V10_DATA_NAVIGATION_ACCEPTANCE_2026-10-22.md for exact deployed identity, successful checks and preserved failures. Hosted acceptance remains blocked by account billing. Owner requested closer data presentation to the existing V10 demo. R-073.a–c/R-074.a–b and R-100–102; no API/schema/business-rule changes.

Primary reference: demos/Sense_Studios_Codex_Dashboard_V10_Handoff/reference/Sense_Studios_Dashboard_V10_Refined_Shell.html and1440/1024/390/320 screenshots. Lock: cream canvas/paper cards, compact sans hierarchy, Today at a glance strip, narrower Time/Projects lane and wider Decisions/Performance lane, final fixed queue. Existing Refero Linear/Asana/Wrike locks remain. Supplementary Refero Perplexity style b95e58ce-d00e-4de1-ad6b-6f1c7d7a5593 informed only compact text hierarchy/subtle surface separation; its monochrome/pill tokens do not override the Owner's pine/paper design.

Presentation decisions:
- Scope CSS above the shared identity/theme selectors so the Dashboard canvas is transparent and individual cards remain distinct. Existing routes, actions and reports tabs remain.
- Add source-local task-state bars and exact textual counts to the five independent summaries. Missing/loading/unavailable sections never render an empty bar as zero. Do not aggregate overlapping summaries or invent priority breakdowns that the API does not provide. Accessible descriptions connect exact mix text to each card.
- Add functional line icons, grouped approval/review sections, a factual project-source count and count of supplied finite scores. Missing or unavailable health sections show explicit unavailable text. A verified empty readable section may show zero.
- Keep real timer inputs and performance data contracts. No fake Owner timer, fabricated Team metrics or inferred health thresholds.
- Wrap narrow queue dates/chips/actions and long evidence text; assert internal card bounds, not only document width.

Preservation: preexisting uncommitted source is snapshotted in ignored .env.consolidation-20261021/ui-data-baseline-1792603024580. Only the selected clean dashboard.tsx plus new presentation files and bounded acceptance assertion are intended for this candidate. No user demo, private fixture or unrelated navigation/timer edit is promoted.

Evidence so far: full working-tree web641 passed before three added project-state tests; focused27 current cases, types/lint passed. This includes one preexisting unselected test and does not certify the final clean candidate. Isolated labeled synthetic visual report ui-data-visual-1792639022958 has four widths, no page errors or document overflow and all40 queue-child bounds inside their cards. Real application/session acceptance and exact artifact verification remain pending. Independent current Codex found project-zero/mobile-clipping/accessibility issues; source fixes are accepted and refreshed visual review is pending. No Opus/Sonnet claim.
