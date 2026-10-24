import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { TASK_DESCRIPTION_MAX_LENGTH, type TaskListSort } from "@sense/contracts";
import { MyWorkPhaseSummary, MyWorkTaskCountInformation, type MyWorkAttentionSourceRequest, type MyWorkActionCounts } from "./my-work-attention.js";
import { MyWorkFilterChips, type AppliedTaskFilter } from "./my-work-filter-chips.js";
import { TaskPeople } from "./task-people.js";
import { ActionableWork } from "./actionable-work.js";
import { TaskComposerFields, taskCreateBody, taskDraftError, type TaskComposerDraft } from "./task-composer-fields.js";
import { useTaskCreationOptions } from "./task-creation-options.js";
import { TaskRefinementFields } from "./task-refinement-fields.js";
import { taskRefinementError, selectionValues } from "./task-query-refinements.js";
import { TaskCreateDialog } from "./task-create-dialog.js";
import { TaskDetailDrawer } from "./task-detail-drawer.js";
import { MyWorkTopCards, overdueTaskFilters, previousCalendarDay } from "./my-work-metrics.js";
import { MyWorkMetricFocus } from "./my-work-metric-focus.js";
import type { OverdueCalendar } from "./my-work-metrics.js";
import { MyWorkQueuePreferences } from "./my-work-queue-preferences.js";
import type { QueuePreferenceMode } from "./my-work-queue-preferences.js";
import type { MyWorkSnapshot } from "./my-work-saved-views.js";
import { parityPriorityClass, parityPriorityLabel } from "./my-work/my-work-parity.js";
import { MyWorkParityList, type MyWorkParityRow } from "./my-work/my-work-parity.js";
import "./task.css";
import "./my-work-visual.css";
import "./my-work/my-work-visual-overrides.css";
import "./my-work/my-work-parity.css";
import "./task-register.css";

/** Field-help fragments stay within the current document and do not discard drafts. */
function isInPageAnchor(anchor: HTMLAnchorElement): boolean {
  return !!anchor.hash && anchor.origin === window.location.origin && anchor.pathname === window.location.pathname && anchor.search === window.location.search;
}

/** Renders a structured empty-state with an optional Clear filters action button. */
function TaskEmptyState({ message, showClearFilters, onClearFilters }: { message: string; showClearFilters: boolean; onClearFilters: () => void }): React.JSX.Element {
  return (
    <div className="task-empty-state" role="status">
      <svg className="task-empty-state__icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10m-7 6h4"/></svg>
      <p className="task-empty-state__title">{message}</p>
      {showClearFilters && <button type="button" className="task-empty-state__action" onClick={onClearFilters}>Clear filters</button>}
    </div>
  );
}

type Project = { id: string; title: string; status: string; branchId: string; canApproveCloseout?: boolean };
type Employee = { id: string; name: string; homeBranchId: string; homeTeamId?: string; homeTeamName?: string };
type PlanItem = { id: string; projectId: string; kind: "STAGE" | "MILESTONE"; label: string };
type CreationProfile = { version: 1; variant: "OWNER" | "EMPLOYEE" | "LEADER" | "SITE"; resolution: "ACCOUNT_KIND" | "CONFIGURED_ROLE" | "GENERIC_FALLBACK" | "AMBIGUOUS" };
type Setup = { actorEmployeeId: string | null; projects: Project[]; employees: Employee[]; planItems: PlanItem[]; canAssign: boolean; creationProfile?: CreationProfile };
export type Task = {
  id: string; title: string; type: string; priority: string; targetDate: string; description?: string | null; startDate?: string | null; estimatedHours?: number | string | null;
  projectId?: string | null; planItemId?: string | null; tags: string[]; checklist: Array<{ label: string; checked: boolean }>; primaryOwnerEmployeeId: string; requiresReassignment?: boolean; status: string; version: number;
  reviewRequirement: string; createdAt: string; committedDueDate?: string | null; waitingReason?: string | null; waitingDelayCause?: string | null; waitingResponsibleParty?: string | null;
  isSubtask?: true;
  primaryOwner?: { account?: { normalizedEmail?: string | null } | null } | null;
};
type TaskPage = { total: number; items: Task[] };
type HistoryEntry = { id?: string; reason?: string; action?: string; fromStatus?: string; toStatus?: string; delayCause?: string | null; responsibleParty?: string | null; oldOwnerEmployeeId?: string; newOwnerEmployeeId?: string; occurredAt?: string };
type CommittedDateChange = { id: string; oldDate: string | null; newDate: string; actorId: string; reason: string; taskVersion: number; occurredAt: string };
type DependencySummary = { id: string; title: string; status: string };
type SubtaskSummary = { id: string; title: string; status: string; targetDate: string; primaryOwnerEmployeeId: string; primaryOwnerName: string; version: number };
type SubtasksProjection = { items: SubtaskSummary[]; parent: { id: string; title: string } | null; isSubtask: boolean; completionBlocked: boolean; canCreate: boolean; taskVersion: number };
type Extension = { id: string; previousDate: string; proposedDate: string; reason: string; state: string; requesterId: string; approverId: string; requestedAt: string; decision?: { outcome: string; reason: string; decidedAt: string } | null; canDecide: boolean; canWithdraw?: boolean };
type ExtensionApprover = { accountId: string; name: string; kind: string };
type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY";
type RecurrenceRule = { id: string; sourceTaskId: string; frequency: RecurrenceFrequency; anchorDate: string; effectiveFromDate: string; paused: boolean; version: number; configuredById: string; createdAt: string; updatedAt: string };
type RecurrenceHistory = { id: string; ruleVersion: number; action: "configured" | "paused" | "resumed"; actorId: string; reason: string; before: unknown; after: unknown; occurredAt: string };
type RecurrenceData = { rule: RecurrenceRule | null; history: RecurrenceHistory[]; capabilities: { configure: boolean; pause: boolean; resume: boolean }; timezone: string };
export type Detail = { task: Task; linkedReviewTaskId?: string | null; people?: { assignedBy: { name: string; kind: "OWNER" | "STAFF" }; collaboratorAdders: Array<{ employeeId: string; name: string }> }; collaborators: Array<{ employeeId: string; name: string; estimatedHours?: number }>; history: { statusChanges: HistoryEntry[]; ownerChanges: HistoryEntry[]; committedDateChanges?: CommittedDateChange[] }; extensions?: Extension[]; dependencies?: { predecessors: DependencySummary[]; hasUnfinished: boolean; hiddenCount: number }; closeoutApproval?: { approverId: string; reason: string; workScope: string; approvedAt: string; revokedAt: string | null; revocationReason: string | null } | null; capabilities: { edit: boolean; transition: boolean; reassign: boolean; wait?: boolean; resume?: boolean; changeCommittedDate?: boolean; requestExtension?: boolean; manageDependencies?: boolean; revokeCloseout?: boolean } };
export type TaskProjectContext = { id: string; title: string; status: string };
type Props = { projectContext?: TaskProjectContext; onLeaveGuard?: (guard: (() => boolean) | null) => void; csrfToken: string; owner: boolean; accountId?: string; listFirst?: boolean; personalOnly?: boolean; personalObligations?: (context: { employeeLessOwner: boolean; sourceRequest?: MyWorkAttentionSourceRequest; onActionCounts: (counts: MyWorkActionCounts) => void }) => ReactNode; onSessionExpired?: () => void };
type TaskFilters = { priorities: string; collaboratorEmployeeIds: string; projectId: string; planItemId: string; ownerEmployeeId: string; teamId: string; q: string; status: string; phase: string; dateBasis: string; dateFrom: string; dateTo: string; sort: TaskListSort };
type Scope = "mine" | "assigned" | "personal" | "all" | "owned" | "created" | "collaborating";

const ROOT = "/api/v1/tasks";
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const TASK_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "WAITING", "SUBMITTED_INTERNAL_REVIEW", "IN_INTERNAL_REVIEW", "CORRECTIONS_REQUIRED", "INTERNAL_APPROVED", "SUBMITTED_CLIENT_REVIEW", "IN_CLIENT_REVIEW", "CLIENT_REVISION_REQUIRED", "CLIENT_APPROVED", "COMPLETED", "STOPPED_DUE_TO_PROJECT_CANCELLATION"];

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.clone().json().catch(() => ({})) as { message?: string; error?: { message?: string } };
    const error = new Error(body.error?.message ?? body.message ?? `Request failed (${response.status})`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}
function statusOf(error: unknown): number | undefined { return error instanceof Error ? (error as Error & { status?: number }).status : undefined; }
function stateLabel(value: string): string { return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
/**
 * Presentation label for the parity row's last-column action button.
 * Mirrors the intent of the demo's `t.next` field: a one-phrase invitation
 * to open the task. It is status-derived only and can never widen permissions.
 * Must stay in sync with the "Next action" label the legacy queue row renders.
 */
function parityNextAction(task: { status: string; type: string }): string {
  switch (task.status) {
    case "CORRECTIONS_REQUIRED": return "Open correction";
    case "INTERNAL_APPROVED": return "Submit for review";
    case "SUBMITTED_CLIENT_REVIEW": return "Await client review";
    case "CLIENT_REVISION_REQUIRED": return "Client revisions";
    case "IN_CLIENT_REVIEW": return "Under client review";
    case "CLIENT_APPROVED": return "Complete task";
    case "SUBMITTED_INTERNAL_REVIEW": return "Review pending";
    case "IN_INTERNAL_REVIEW": return "Under internal review";
    default: return "Open task";
  }
}
/**
 * Overdue test for the row's mobile due chip. Uses the organization-calendar
 * cutoff the server supplies through the Overdue metric (`before` is the last
 * day that is still on time), never the browser clock. Without a resolved
 * cutoff the chip simply renders without the overdue treatment rather than
 * guessing from the user's local timezone.
 */
function rowIsOverdue(targetDate: string, before: string | undefined): boolean {
  if (before === undefined) return false;
  return targetDate.slice(0, 10) < before;
}
type TaskView = "list" | "cards" | "board" | "timeline";
const FILTER_KEYS: Array<keyof TaskFilters> = ["priorities", "collaboratorEmployeeIds", "projectId", "planItemId", "ownerEmployeeId", "teamId", "q", "status", "phase", "dateBasis", "dateFrom", "dateTo"];
function taskUrlKey(key: string, projectContext?: TaskProjectContext): string { return !projectContext ? key : key === "taskId" ? "projectTaskId" : `projectTask${key[0]?.toUpperCase()}${key.slice(1)}`; }
function readTaskUrlState(personalOnly: boolean, owner: boolean, listFirst: boolean, projectContext?: TaskProjectContext): { taskId: string; scope: Scope; filters: TaskFilters; offset: number; view: TaskView; temporaryPhase: string } {
  const source = new URLSearchParams(window.location.search);
  const params = new URLSearchParams();
  for (const key of [...FILTER_KEYS, "taskId", "scope", "offset", "view", "sort", "workPhase"]) { const value = source.get(taskUrlKey(key, projectContext)); if (value !== null) params.set(key, value); }
  if (projectContext) params.set("projectId", projectContext.id);
  const rawOffset = Number(params.get("offset"));
  const sortValue = params.get("sort");
  const sort: TaskFilters["sort"] = sortValue === "target_asc" || sortValue === "title_asc" || sortValue === "owner_asc" || sortValue === "priority_desc" ? sortValue : "created_desc";
  const filters: TaskFilters = { ...Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? (key === "phase" && personalOnly ? "active" : "")])) as Omit<TaskFilters, "sort">, sort };
  const scopeValue = params.get("scope");
  const phaseSelection = params.get("workPhase") ?? "";
  return {
    taskId: params.get("taskId") ?? "",
    scope: projectContext ? "all" : personalOnly ? scopeValue === "all" ? "all" : "personal" : owner && !listFirst ? "all" : scopeValue === "all" || scopeValue === "owned" || scopeValue === "created" || scopeValue === "collaborating" || scopeValue === "assigned" || scopeValue === "mine" ? scopeValue : owner ? "all" : "mine",
    filters,
    temporaryPhase: personalOnly && scopeValue !== "all" && ["active", "waiting", "review", "reviews", "completed", "overdue", "attention"].includes(phaseSelection) ? phaseSelection : "",
    offset: Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0,
    view: params.get("view") === "cards" ? "cards" : params.get("view") === "board" || params.get("view") === "kanban" ? "board" : params.get("view") === "timeline" ? "timeline" : "list"
  };
}
function writeTaskUrlState(state: { taskId: string; scope: Scope; filters: TaskFilters; offset: number; view: TaskView; temporaryPhase: string; personalOnly: boolean }, projectContext?: TaskProjectContext): void {
  const url = new URL(window.location.href);
  const values: Record<string, string> = { scope: state.scope, offset: state.offset ? String(state.offset) : "", view: state.view === "list" ? "" : state.view, taskId: state.taskId, sort: state.filters.sort === "created_desc" ? "" : state.filters.sort, workPhase: state.personalOnly ? state.temporaryPhase : "" };
  for (const key of FILTER_KEYS) values[key] = key === "dateBasis" && !state.filters.dateFrom && !state.filters.dateTo ? "" : state.filters[key];
  for (const [key, value] of Object.entries(values)) {
    if (projectContext && key === "projectId") continue;
    const urlKey = taskUrlKey(key, projectContext);
    if (value) url.searchParams.set(urlKey, value);
    else url.searchParams.delete(urlKey);
  }
  window.history.replaceState(window.history.state, "", url);
}

export function TaskWorkspace({ projectContext, onLeaveGuard, csrfToken, owner, accountId, listFirst = false, personalOnly = false, personalObligations, onSessionExpired }: Props): React.JSX.Element {
  const registerMode = listFirst && !personalOnly && !projectContext;
  const initialUrlState = useRef(readTaskUrlState(personalOnly, owner, listFirst, projectContext)).current;
  const deepLinkInitialized = useRef(false);
  const requestId = useRef(0);
  const pageContextRef = useRef("");
  const [setup, setSetup] = useState<Setup>();
  const [scope, setScope] = useState<Scope>(initialUrlState.scope);
  const defaultFilters: TaskFilters = { ...initialUrlState.filters, priorities: "", collaboratorEmployeeIds: "", projectId: projectContext?.id ?? "", planItemId: "", ownerEmployeeId: "", teamId: "", q: "", status: "", phase: personalOnly ? "active" : "", dateBasis: "", dateFrom: "", dateTo: "", sort: "created_desc" };
  const [draftFilters, setDraftFilters] = useState<TaskFilters>(initialUrlState.filters);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterDisclosureRef = useRef<HTMLDetailsElement>(null);
  const [filterPosition, setFilterPosition] = useState({ top: 120, right: 16, maxHeight: 500 });
  const [filters, setFilters] = useState<TaskFilters>(initialUrlState.filters);
  const [offset, setOffset] = useState(initialUrlState.offset);
  const [view, setView] = useState<TaskView>(initialUrlState.view);
  const [urlTaskId, setUrlTaskId] = useState(initialUrlState.taskId);
  const [temporaryPhase, setTemporaryPhase] = useState(initialUrlState.temporaryPhase);
  const [overdueCalendar, setOverdueCalendar] = useState<OverdueCalendar>({ status: "loading" });
  const [managementToday, setManagementToday] = useState<string>();
  const workspaceRef = useRef<HTMLElement>(null);
  const queueHeadingRef = useRef<HTMLHeadingElement>(null);
  const displayOptionsRef = useRef<HTMLDetailsElement>(null);
  const detailDraftDirtyRef = useRef(false);
  const drawerHistoryRef = useRef<{ taskId: string; url: string; state: unknown; canLeave: () => boolean }>({ taskId: "", url: window.location.href, state: null, canLeave: () => true });
  const [queueReveal, setQueueReveal] = useState(0);
  useLayoutEffect(() => {
    if (!queueReveal) return;
    // Reveal the real queue after the new selection has committed. Move focus
    // with it so keyboard users continue at its controls, below the header.
    queueHeadingRef.current?.focus({ preventScroll: true });
    queueHeadingRef.current?.parentElement?.parentElement?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [queueReveal]);
  const updateOverdueCalendar = useCallback((calendar: OverdueCalendar) => setOverdueCalendar(calendar), []);
  const [summaryRevision, setSummaryRevision] = useState(0);
  const [compact, setCompact] = useState(false);
  const [preferenceMode, setPreferenceMode] = useState<QueuePreferenceMode>(null);
  const [sourceRequest, setSourceRequest] = useState<MyWorkAttentionSourceRequest>();
  const [actionCounts, setActionCounts] = useState<MyWorkActionCounts>({ corrections: { status: "loading" }, management: { status: "loading" } });
  const updateActionCounts = useCallback((counts: MyWorkActionCounts) => setActionCounts(counts), []);
  const [desktop, setDesktop] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches);
  /**
   * Demo-parity row rendering, active only for the personal My Work list. It
   * is presentation only: the same authorized page renders through
   * `MyWorkParityList` instead of the legacy `.task-queue-row` markup. The
   * Cards / Board / Timeline views and every non-personal route keep their
   * existing markup, so the Tasks route is untouched.
   *
   * The legacy `<nav>` still renders around it, but only for its empty state:
   * when rows exist and parity is active the legacy rows are suppressed, so
   * the page shows exactly one row set. The `.task-queue-row` markup remains
   * the accepted contract for every non-personal route and for the empty and
   * card/board/timeline views.
   */
  const parityEnabled = personalOnly && listFirst;
  const [, setMobileLayout] = useState(() => window.innerWidth <= 700);
  const [page, setPage] = useState<TaskPage>();
  const pageRef = useRef(page);
  pageRef.current = page;
  const [detail, setDetail] = useState<Detail>();
  const [subtasks, setSubtasks] = useState<SubtasksProjection>();
  const [subtasksTaskId, setSubtasksTaskId] = useState("");
  const [subtasksLoading, setSubtasksLoading] = useState(false);
  const [subtasksError, setSubtasksError] = useState("");
  const [subtasksRetry, setSubtasksRetry] = useState(0);
  const [showSubtaskForm, setShowSubtaskForm] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const creationPending = useRef(false);
  const creationAttempt = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const [uncertainCreation, setUncertainCreation] = useState<{ body: Record<string, unknown>; parentId?: string }>();
  const [createdSubtask, setCreatedSubtask] = useState<{ id: string; parentId: string }>();
  useEffect(() => {
    if (!uncertainCreation) return;
    const surface = document.querySelector("dialog[open]") ?? document;
    surface.querySelector<HTMLButtonElement>("[data-task-creation-recovery]")?.focus({ preventScroll: false });
  }, [uncertainCreation]);
  const [overloadPrompt, setOverloadPrompt] = useState<{ kind: "create"; body: Record<string, unknown>; message: string; parentId?: string; expectedParentVersion?: number } | { kind: "reassign"; taskId: string; body: Record<string, unknown>; message: string }>();
  const [showForm, setShowForm] = useState(false);
  const [validationAttempt, setValidationAttempt] = useState(0);
  useEffect(() => { setValidationAttempt(0); }, [showForm, showSubtaskForm]);
  const createDraftDirtyRef = useRef(false);
  const [showCloseoutForm, setShowCloseoutForm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [assignTo, setAssignTo] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("NON_PROJECT");
  const [priority, setPriority] = useState("MEDIUM");
  const [reviewRequirement, setReviewRequirement] = useState("NONE");
  const [targetDate, setTargetDate] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(projectContext?.id ?? "");
  const [ownerId, setOwnerId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [estimatedHours, setEstimatedHours] = useState("");
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([]);
  const [collaboratorHours, setCollaboratorHours] = useState<Record<string, string>>({});
  const [workScope, setWorkScope] = useState("");
  const [planItemId, setPlanItemId] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [checklistText, setChecklistText] = useState("");
  const [reason, setReason] = useState("");
  const creationProjectId = showSubtaskForm ? detail?.task?.projectId ?? "" : projectContext?.id ?? projectId;
  const creation = useTaskCreationOptions(showForm || showSubtaskForm, creationProjectId, onSessionExpired);
  useEffect(() => {
    const options = creation.options;
    if (!options) return;
    if (!options.canAssign) setAssignTo(false);
    setOwnerId(current => options.owners.some(person => person.id === current) ? current : "");
    setCollaboratorIds(current => current.filter(id => options.collaborators.some(person => person.id === id)));
  }, [creation.options]);
  const composerDraft: TaskComposerDraft = { title, type, priority, targetDate, description, projectId: creationProjectId, ownerId, startDate, estimatedHours, collaboratorIds, collaboratorHours, planItemId, tagsText, checklistText, reason, assignTo, reviewRequirement };
  const changeComposer = (patch: Partial<TaskComposerDraft>): void => {
    if (uncertainCreation) return;
    if (overloadPrompt?.kind === "create") setOverloadPrompt(undefined);
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.type !== undefined) setType(patch.type);
    if (patch.priority !== undefined) setPriority(patch.priority);
    if (patch.targetDate !== undefined) setTargetDate(patch.targetDate);
    if (patch.description !== undefined) setDescription(patch.description);
    if (patch.projectId !== undefined) setProjectId(patch.projectId);
    if (patch.ownerId !== undefined) setOwnerId(patch.ownerId);
    if (patch.startDate !== undefined) setStartDate(patch.startDate);
    if (patch.estimatedHours !== undefined) setEstimatedHours(patch.estimatedHours);
    if (patch.collaboratorIds !== undefined) setCollaboratorIds(patch.collaboratorIds);
    if (patch.collaboratorHours !== undefined) setCollaboratorHours(patch.collaboratorHours);
    if (patch.planItemId !== undefined) setPlanItemId(patch.planItemId);
    if (patch.tagsText !== undefined) setTagsText(patch.tagsText);
    if (patch.checklistText !== undefined) setChecklistText(patch.checklistText);
    if (patch.reason !== undefined) setReason(patch.reason);
    if (patch.assignTo !== undefined) setAssignTo(patch.assignTo);
    if (patch.reviewRequirement !== undefined) setReviewRequirement(patch.reviewRequirement);
  };
  const validateCreation = (): boolean => {
    setValidationAttempt(value => value + 1);
    const options = creation.options;
    if (!options || !options.canCreate) { setError("Load eligible participants before creating this task."); return false; }
    const fieldError = taskDraftError(composerDraft);
    if (fieldError) { setError(""); return false; }
    const explicit = options.canAssign && assignTo || options.actorEmployeeId === null;
    const chosenOwner = explicit ? ownerId : options.actorEmployeeId;
    if (!options.owners.some(person => person.id === chosenOwner) || explicit && !options.canAssign || collaboratorIds.some(id => id === chosenOwner || !options.collaborators.some(person => person.id === id))) {
      setError("Review the primary owner and collaborators for the current context."); return false;
    }
    return true;
  };
  const creationBlocked = creation.status !== "ready" || !creation.options?.canCreate;
  const [reassignId, setReassignId] = useState("");
  const [waitReason, setWaitReason] = useState("");
  const [delayCause, setDelayCause] = useState("");
  const [responsibleParty, setResponsibleParty] = useState("");
  const [resumeReason, setResumeReason] = useState("");
  const [dependencyCandidates, setDependencyCandidates] = useState<DependencySummary[]>([]);
  const [dependencySearch, setDependencySearch] = useState("");
  const [predecessorId, setPredecessorId] = useState("");
  const [dependencyReason, setDependencyReason] = useState("");
  const [confirmEarlyStart, setConfirmEarlyStart] = useState(false);
  const [committedDate, setCommittedDate] = useState("");
  const [committedDateReason, setCommittedDateReason] = useState("");
  const [extensionApprovers, setExtensionApprovers] = useState<ExtensionApprover[]>([]);
  const [extensionApproversLoading, setExtensionApproversLoading] = useState(false);
  const [extensionApproversError, setExtensionApproversError] = useState("");
  const [extensionApproverRetry, setExtensionApproverRetry] = useState(0);
  const [extensionDate, setExtensionDate] = useState("");
  const [extensionReason, setExtensionReason] = useState("");
  const [extensionApproverId, setExtensionApproverId] = useState("");
  const [extensionDecisionReason, setExtensionDecisionReason] = useState("");
  const [recurrence, setRecurrence] = useState<RecurrenceData>();
  const [recurrenceLoading, setRecurrenceLoading] = useState(false);
  const [recurrenceError, setRecurrenceError] = useState("");
  const [recurrenceRetry, setRecurrenceRetry] = useState(0);
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<RecurrenceFrequency>("WEEKLY");
  const [recurrenceDate, setRecurrenceDate] = useState("");
  const [recurrenceReason, setRecurrenceReason] = useState("");
  const [recurrenceActionReason, setRecurrenceActionReason] = useState("");

  useEffect(() => {
    if (!detail?.task.id) { setSubtasks(undefined); setSubtasksTaskId(""); setSubtasksError(""); return; }
    let active = true;
    setSubtasks(undefined); setSubtasksTaskId("");
    setSubtasksLoading(true); setSubtasksError("");
    void fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}/subtasks`, { credentials: "include", cache: "no-store" })
      .then((response) => json<SubtasksProjection>(response))
      .then((value) => {
        const validItems = Array.isArray(value?.items) && value.items.every((item) => item && typeof item.id === "string" && item.id.length > 0 && typeof item.title === "string" && item.title.trim().length > 0 && typeof item.status === "string" && item.status.length > 0 && typeof item.targetDate === "string" && Number.isFinite(Date.parse(item.targetDate)) && typeof item.primaryOwnerEmployeeId === "string" && item.primaryOwnerEmployeeId.length > 0 && typeof item.primaryOwnerName === "string" && item.primaryOwnerName.length > 0 && Number.isSafeInteger(item.version) && item.version > 0);
        const validParent = value?.parent === null || !!value?.parent && typeof value.parent.id === "string" && value.parent.id.length > 0 && typeof value.parent.title === "string" && value.parent.title.trim().length > 0;
        if (!value || !validItems || !validParent || typeof value.isSubtask !== "boolean" || typeof value.completionBlocked !== "boolean" || typeof value.canCreate !== "boolean" || !Number.isSafeInteger(value.taskVersion) || value.taskVersion < 1) throw new Error("subtasks-response-invalid");
        if (active) { setSubtasks(value); setSubtasksTaskId(detail.task.id); }
      })
      .catch(() => { if (active) { setSubtasks(undefined); setSubtasksError("Subtasks could not be loaded."); } })
      .finally(() => { if (active) setSubtasksLoading(false); });
    return () => { active = false; };
  }, [detail?.task?.id, detail?.task?.version, subtasksRetry]);

  /**
   * "Site work" is a presentation scope over the existing `all` backend
   * scope, narrowed to site-type tasks. Applying it as a type filter keeps
   * the backend authorization path exactly as it is for `all`, so no new
   * authorization rule is introduced. Declared here because `queueFilters`
   * below needs it, and it must not depend on anything declared later.
   */
  const siteWorkScope = !projectContext && !owner && scope === "all" && (() => {
    const profile = setup?.creationProfile;
    return profile?.version === 1 && profile.variant === "SITE";
  })();
  const queueFilters = useMemo(() => {
    const base = personalOnly && temporaryPhase === "overdue" && overdueCalendar.before
      ? overdueTaskFilters(filters, overdueCalendar.before)
      : personalOnly && temporaryPhase === "reviews" ? { ...filters, metric: "reviews", phase: "" } : personalOnly && temporaryPhase && !["overdue", "attention"].includes(temporaryPhase) ? { ...filters, phase: temporaryPhase } : filters;
    return siteWorkScope ? { ...base, type: "SITE" as const, phase: "" } : base;
  }, [filters, personalOnly, temporaryPhase, overdueCalendar.before, siteWorkScope]);
  const taskPageContext = JSON.stringify([scope, Object.entries(queueFilters).sort(([left], [right]) => left.localeCompare(right)), offset]);
  const visiblePage = pageContextRef.current === taskPageContext ? page : undefined;
  const [pageStale, setPageStale] = useState(false);
  const [pageRefreshedAt, setPageRefreshedAt] = useState<number>();

  const load = useCallback(async (preferredId = "", requestedOffset = offset) => {
    const request = ++requestId.current;
    const contextKey = JSON.stringify([scope, Object.entries(queueFilters).sort(([left], [right]) => left.localeCompare(right)), requestedOffset]);
    let readingDetail = false;
    setLoading(true); setError(""); setDenied(false);
    if (pageContextRef.current !== contextKey) { pageContextRef.current = contextKey; pageRef.current = undefined; setPage(undefined); setPageStale(false); setPageRefreshedAt(undefined); }
    if (listFirst) { setDetail(undefined); if (!preferredId) setSelectedId(""); }
    if (personalOnly && temporaryPhase === "overdue" && overdueCalendar.status !== "ready") {
      pageRef.current = undefined; setPage(undefined); setLoading(overdueCalendar.status === "loading");
      if (overdueCalendar.status === "unavailable") setError("The Overdue calendar or count is unavailable. Retry the card or clear its selection.");
      return;
    }
    try {
      // `scope` is the request scope and honours personalOnly; `activeScopeOption`
      // only mirrors the visible tab, which for My Work reads "mine". Sending the
      // tab value would ask the API for the wrong queue.
      const query = new URLSearchParams({ scope, offset: String(requestedOffset), limit: "50" });
      for (const [key, value] of Object.entries(queueFilters)) {
        if (key === "dateBasis" && !queueFilters.dateFrom && !queueFilters.dateTo) continue;
        if (value.trim()) query.set(key, value.trim());
      }
      const [nextSetup, nextPage] = await Promise.all([
        fetch(`${ROOT}/setup`, { credentials: "include", cache: "no-store" }).then((response) => json<Setup>(response)),
        fetch(`${ROOT}?${query.toString()}`, { credentials: "include", cache: "no-store" }).then((response) => json<TaskPage>(response))
      ]);
      if (request !== requestId.current) return;
      setSetup(nextSetup); pageRef.current = nextPage; setPage(nextPage); pageContextRef.current = contextKey; setPageStale(false); setPageRefreshedAt(Date.now());
      const id = preferredId || (listFirst ? "" : nextPage.items[0]?.id || "");
      setSelectedId(id);
      if (id) {
        readingDetail = true;
        const value = await fetch(`${ROOT}/${encodeURIComponent(id)}`, { credentials: "include", cache: "no-store" }).then((response) => json<Detail>(response));
        if (projectContext && value.task.projectId !== projectContext.id) throw Object.assign(new Error("Task is outside this project"), { status: 404 });
        if (request === requestId.current) { detailDraftDirtyRef.current = false; setDetail(value); }
      } else if (request === requestId.current) setDetail(undefined);
    } catch (cause) {
      if (request === requestId.current) {
        setDetail(undefined); setSelectedId("");
        const status = statusOf(cause);
        if (status === 401 || status === 403 || readingDetail && status === 404) {
          setSetup(undefined); pageRef.current = undefined; setPage(undefined); setPageStale(false); setPageRefreshedAt(undefined); setDenied(true);
          if (status === 401) onSessionExpired?.();
        } else if (pageContextRef.current === contextKey && pageRef.current) { setPageStale(true); setError("Tasks could not be refreshed. The displayed page is a stale snapshot."); }
        else { pageRef.current = undefined; setPage(undefined); setPageStale(false); setPageRefreshedAt(undefined); setError("Tasks could not be loaded. Try again."); }
      }
    } finally { if (request === requestId.current) { setLoading(false); deepLinkInitialized.current = true; } }
  }, [scope, queueFilters, offset, listFirst, onSessionExpired, personalOnly, temporaryPhase, overdueCalendar.status, projectContext?.id]);

  useEffect(() => { void load(listFirst ? urlTaskId : deepLinkInitialized.current ? "" : initialUrlState.taskId); return () => { requestId.current += 1; }; }, [load, urlTaskId, listFirst, initialUrlState.taskId]);
  useEffect(() => {
    if (listFirst) writeTaskUrlState({ taskId: urlTaskId, scope, filters, offset, view, temporaryPhase, personalOnly }, projectContext);
  }, [listFirst, urlTaskId, scope, filters, offset, view, temporaryPhase, personalOnly, projectContext?.id]);
  useEffect(() => {
    if (!listFirst) return;
    const onPopState = (): void => {
      if (projectContext && new URLSearchParams(window.location.search).get("projectId") !== projectContext.id) return;
      const next = readTaskUrlState(personalOnly, owner, listFirst, projectContext);
      const currentDrawer = drawerHistoryRef.current;
      if ((personalOnly || projectContext || registerMode) && currentDrawer.taskId && (next.taskId !== currentDrawer.taskId || window.location.href !== currentDrawer.url) && !currentDrawer.canLeave()) {
        window.history.pushState(currentDrawer.state, "", currentDrawer.url);
        return;
      }
      setScope(next.scope); setFilters(next.filters); setDraftFilters(next.filters); setOffset(next.offset); setView(next.view); setUrlTaskId(next.taskId); setTemporaryPhase(next.temporaryPhase);
      setWaitReason(""); setDelayCause(""); setResponsibleParty(""); setResumeReason("");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [listFirst, personalOnly, owner, projectContext?.id]);
  useEffect(() => {
    const update = (): void => {
      const nextDesktop = window.matchMedia?.("(min-width: 1024px)").matches ?? window.innerWidth >= 1024;
      setDesktop(nextDesktop);
      setMobileLayout(window.innerWidth <= 700);
      if (!nextDesktop) setCompact(false);
    };
    update(); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    if (!detail?.capabilities.manageDependencies) { setDependencyCandidates([]); return; }
    let active = true;
    const query = dependencySearch.trim();
    void fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}/dependency-candidates${query ? `?q=${encodeURIComponent(query)}` : ""}`, { credentials: "include", cache: "no-store" })
      .then((response) => json<{ items: DependencySummary[] }>(response)).then((value) => { if (active) setDependencyCandidates(value.items); })
      .catch(() => { if (active) setDependencyCandidates([]); });
    return () => { active = false; };
  }, [detail?.task?.id, detail?.task?.version, detail?.capabilities?.manageDependencies, dependencySearch]);
  useEffect(() => {
    if (!detail?.capabilities.requestExtension) { setExtensionApprovers([]); setExtensionApproversLoading(false); setExtensionApproversError(""); return; }
    let active = true;
    setExtensionApproversLoading(true); setExtensionApproversError("");
    void fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}/extension-approvers`, { credentials: "include", cache: "no-store" })
      .then((response) => json<{ items: ExtensionApprover[] }>(response)).then((value) => { if (active) setExtensionApprovers(value.items); })
      .catch(() => { if (active) { setExtensionApprovers([]); setExtensionApproversError("Eligible approvers could not be loaded."); } })
      .finally(() => { if (active) setExtensionApproversLoading(false); });
    return () => { active = false; };
  }, [detail?.task?.id, detail?.task?.version, detail?.capabilities?.requestExtension, extensionApproverRetry]);
  useEffect(() => {
    if (detail?.task.type !== "RECURRING") { setRecurrence(undefined); setRecurrenceError(""); setRecurrenceLoading(false); return; }
    let active = true;
    setRecurrenceLoading(true); setRecurrenceError("");
    void fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}/recurrence`, { credentials: "include", cache: "no-store" })
      .then((response) => json<RecurrenceData>(response)).then((value) => { if (active) { setRecurrence(value); setRecurrenceFrequency(value.rule?.frequency ?? "WEEKLY"); setRecurrenceDate(""); setRecurrenceReason(""); setRecurrenceActionReason(""); } })
      .catch(() => { if (active) { setRecurrence(undefined); setRecurrenceError("Recurrence details could not be loaded."); } })
      .finally(() => { if (active) setRecurrenceLoading(false); });
    return () => { active = false; };
  }, [detail?.task?.id, detail?.task?.type, detail?.task?.version, recurrenceRetry]);
  const refresh = () => { setSummaryRevision((revision) => revision + 1); void load(selectedId); if (detail?.task.type === "RECURRING") setRecurrenceRetry((count) => count + 1); };
  const validateDescription = (): boolean => {
    if (description.trim().length <= TASK_DESCRIPTION_MAX_LENGTH) return true;
    setError(`Description must be ${TASK_DESCRIPTION_MAX_LENGTH} characters or fewer.`);
    return false;
  };
  const performCreation = async (body: Record<string, unknown>, parentId?: string): Promise<void> => {
    if (busy || creationPending.current) return;
    creationPending.current = true;
    setBusy(true); setError(""); setNotice("");
    const fingerprint = JSON.stringify({ parentId: parentId ?? null, body });
    if (!creationAttempt.current || creationAttempt.current.fingerprint !== fingerprint) creationAttempt.current = { fingerprint, key: crypto.randomUUID() };
    const command = { ...body, idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : creationAttempt.current.key };
    try {
      const result = await fetch(parentId ? `${ROOT}/${encodeURIComponent(parentId)}/subtasks` : ROOT, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(command) }).then((response) => json<{ id?: string; task?: { id?: string } }>(response));
      const created = parentId ? result?.task : result;
      if (!created || typeof created.id !== "string" || !created.id) throw new Error("Unconfirmed task result");
      const wasRecovery = !!uncertainCreation;
      if (parentId) setCreatedSubtask({ id: created.id, parentId });
      setUncertainCreation(undefined); creationAttempt.current = undefined; setOverloadPrompt(undefined); createDraftDirtyRef.current = false;
      setTitle(""); setDescription(""); setReason(""); setTargetDate(""); setStartDate(""); setEstimatedHours(""); setProjectId(""); setPlanItemId(""); setTagsText(""); setChecklistText(""); setAssignTo(false); setShowForm(false); setShowSubtaskForm(false); setCollaboratorIds([]); setCollaboratorHours({});
      setNotice(parentId ? wasRecovery ? "Subtask creation confirmed." : body.acknowledgeOverload ? "Subtask created after overload acknowledgement." : "Subtask created." : wasRecovery ? "Task creation confirmed." : body.acknowledgeOverload ? "Task created after overload acknowledgement." : "Task created."); setSummaryRevision((revision) => revision + 1);
      if (parentId) { await load(parentId); setSubtasksRetry(count => count + 1); }
      else if (listFirst) { const url = new URL(window.location.href); url.searchParams.set(taskUrlKey("taskId", projectContext), created.id); window.history.pushState({ taskWorkspaceSelection: true, taskWorkspaceView: view }, "", url); setUrlTaskId(created.id); }
      else await load(created.id);
    } catch (cause) {
      const status = statusOf(cause), message = cause instanceof Error ? cause.message : "";
      if (status === 409 && message.includes("Overload warning")) {
        setUncertainCreation(undefined);
        setOverloadPrompt({ kind: "create", body: command, message, ...(parentId ? { parentId, expectedParentVersion: Number(body.expectedParentVersion) } : {}) });
      } else {
        if (status === undefined || status >= 500) {
          setUncertainCreation({ body: command, ...(parentId ? { parentId } : {}) });
          setOverloadPrompt(undefined);
          setError(`We could not confirm whether the ${parentId ? "subtask" : "task"} was created. Your submitted details are preserved. Use Check creation result to recover this same request.`);
        } else setError(status === 403 ? "You do not have permission to create or recover this task." : status === 409 ? "The task or retry details changed. Review the latest details before continuing." : "Task could not be created. Check the fields and try again.");
      }
    }
    finally { creationPending.current = false; setBusy(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || creationPending.current || uncertainCreation || !setup || !validateCreation()) return;
    await performCreation(taskCreateBody(composerDraft, creation.options!));
  };
  const submitSubtask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const parent = detail?.task;
    const projection = selectedSubtasks;
    if (!parent || !projection?.canCreate || projection.isSubtask || projection.taskVersion !== parent.version || busy || creationPending.current || uncertainCreation || !setup) {
      if (parent && projection && projection.taskVersion !== parent.version) { setSubtasksError("This task changed while its subtasks loaded. Refresh before creating a subtask."); setShowSubtaskForm(false); }
      return;
    }
    if (!validateCreation()) return;
    const body = { ...taskCreateBody(composerDraft, creation.options!), expectedParentVersion: projection.taskVersion };
    await performCreation(body, parent.id);
  };
  const acknowledgeOverload = async (): Promise<void> => {
    if (!overloadPrompt || busy || creationPending.current) return;
    const pending = overloadPrompt;
    if (pending.kind === "create" && (!validateCreation() || pending.parentId && (detail?.task.id !== pending.parentId || subtasks?.taskVersion !== pending.expectedParentVersion))) {
      setOverloadPrompt(undefined); return;
    }
    if (pending.kind === "reassign" && pending.taskId !== detail?.task.id) {
      setOverloadPrompt(undefined); setError("Review the selected task's assignment before acknowledging its capacity warning."); return;
    }
    if (pending.kind === "create") { await performCreation({ ...pending.body, acknowledgeOverload: true }, pending.parentId); return; }
    creationPending.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      if (detail) {
        await fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}/reassign`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ ...pending.body, acknowledgeOverload: true }) }).then(response => json(response));
        setReason(""); setReassignId(""); setOverloadPrompt(undefined); setNotice("Task owner reassigned after overload acknowledgement."); setSummaryRevision((revision) => revision + 1); await load(detail.task.id);
      }
    } catch (cause) {
      const status = statusOf(cause);
      setError(status === 403 ? "You do not have permission to make this assignment." : status === 409 ? "Capacity or task state changed. Review the latest details and retry." : "The task could not be assigned.");
      if (status === 409) {
        setOverloadPrompt(undefined);
      }
    }
    finally { creationPending.current = false; setBusy(false); }
  };
  const editTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail || busy || reason.trim().length < 3 || !validateDescription()) return;
    setBusy(true); setError("");
    const body = { expectedVersion: detail.task.version, reason: reason.trim(), title: title.trim(), targetDate, priority, ...(description.trim() ? { description: description.trim() } : {}), ...(startDate ? { startDate } : {}), ...(estimatedHours ? { estimatedHours: Number(estimatedHours) } : {}), planItemId: planItemId || null, tags: tagsText.split(",").map((tag) => tag.trim()).filter(Boolean), checklist: checklistText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => ({ label: line.replace(/^\[x\]\s*/i, "").replace(/^\[ \]\s*/, ""), checked: /^\[x\]\s*/i.test(line) })) };
    try {
      await fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }).then((response) => json(response));
      setEditing(false); setNotice("Task details updated."); setSummaryRevision((revision) => revision + 1); await load(detail.task.id);
    } catch (cause) { setError(statusOf(cause) === 409 ? "This task changed elsewhere. Reloaded the latest details." : statusOf(cause) === 403 ? "You do not have permission to edit this task." : "Task details could not be updated. Try again."); if (statusOf(cause) === 409) await load(detail.task.id); }
    finally { setBusy(false); }
  };
  const createCloseout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !projectId || !ownerId || reason.trim().length < 3) return;
    setBusy(true); setError("");
    try {
      await fetch(`${ROOT}/closeout`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ projectId, ownerEmployeeId: ownerId, title: title.trim(), workScope: workScope.trim(), targetDate, priority, reason: reason.trim() }) }).then((response) => json(response));
      setShowCloseoutForm(false); setNotice("Approved closeout task created."); setTitle(""); setWorkScope(""); setTargetDate(""); setProjectId(""); setOwnerId(""); setReason(""); setSummaryRevision((revision) => revision + 1); await load("");
    } catch (cause) { setError(statusOf(cause) === 403 ? "You are not authorized to approve closeout work for this project." : statusOf(cause) === 409 ? "The project changed or is no longer eligible for closeout." : "Closeout task could not be created. Check the fields and try again."); }
    finally { setBusy(false); }
  };
  const revokeCloseout = () => { if (!detail) return; void mutate("/closeout/revoke", { reason: reason.trim() }, "Closeout approval revoked."); };
  const mutate = async (path: string, body: unknown, success: string) => {
    if (!detail || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }).then((response) => json(response));
      setReason("");
      if (path.includes("/dependencies")) { setDependencyReason(""); setPredecessorId(""); }
      if (path === "/state") setConfirmEarlyStart(false);
      if (path === "/committed-date") setCommittedDateReason("");
      if (path.includes("/extension-requests")) { setExtensionReason(""); setExtensionDecisionReason(""); setExtensionApproverId(""); setExtensionDate(""); }
      if (path === "/wait" || path === "/resume") clearWaitingForm();
      setNotice(success); setSummaryRevision((revision) => revision + 1); await load(detail.task.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (path === "/reassign" && statusOf(cause) === 409 && message.includes("Overload warning")) setOverloadPrompt({ kind: "reassign", taskId: detail.task.id, body: body as Record<string, unknown>, message });
      else if (statusOf(cause) === 409) { await load(detail.task.id); setError("This task changed elsewhere. The latest details are now loaded."); }
      else setError(statusOf(cause) === 403 ? "You do not have permission to make this change." : "The task could not be updated. Try again.");
    } finally { setBusy(false); }
  };
  const transition = (toState: "IN_PROGRESS" | "COMPLETED", acknowledgeUnfinishedDependencies = false) => {
    if (!detail) return;
    void mutate("/state", { toState, expectedVersion: detail.task.version, reason: reason.trim(), ...(acknowledgeUnfinishedDependencies ? { acknowledgeUnfinishedDependencies: true } : {}) }, `Task marked ${stateLabel(toState).toLowerCase()}.`);
  };
  const mutateRecurrence = async (method: "PUT" | "POST", suffix: string, reasonText: string, frequency?: RecurrenceFrequency, firstOccurrenceDate?: string) => {
    if (!detail || !recurrence || busy) return;
    setBusy(true); setRecurrenceError(""); setNotice("");
    const body = method === "PUT"
      ? { expectedTaskVersion: detail.task.version, expectedVersion: recurrence.rule?.version ?? 0, frequency, firstOccurrenceDate, reason: reasonText.trim() }
      : { expectedTaskVersion: detail.task.version, expectedVersion: recurrence.rule!.version, reason: reasonText.trim() };
    try {
      await fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}/recurrence${suffix}`, { method, credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }).then((response) => json(response));
      setRecurrenceReason(""); setRecurrenceActionReason(""); setRecurrenceDate("");
      const current = await fetch(`${ROOT}/${encodeURIComponent(detail.task.id)}/recurrence`, { credentials: "include", cache: "no-store" }).then((response) => json<RecurrenceData>(response));
      setRecurrence(current); setNotice(suffix === "/pause" ? "Recurrence paused." : suffix === "/resume" ? "Recurrence resumed." : "Recurrence rule saved.");
    } catch (cause) {
      setRecurrenceError(statusOf(cause) === 409 ? "The task or recurrence changed elsewhere. Refresh and review the latest rule." : statusOf(cause) === 403 ? "You do not have permission to change this recurrence." : "The recurrence could not be updated. Try again.");
      if (statusOf(cause) === 409) { void load(detail.task.id); setRecurrenceRetry((count) => count + 1); }
    } finally { setBusy(false); }
  };
  const clearWaitingForm = () => { setWaitReason(""); setDelayCause(""); setResponsibleParty(""); setResumeReason(""); };
  const leaveDrawerTask = (): boolean => {
    if (busy) return false;
    if (uncertainCreation) {
      if (!window.confirm("Creation is unconfirmed. Leaving loses this recovery request; the task may already exist. Leave without recovery?")) return false;
      setUncertainCreation(undefined); creationAttempt.current = undefined;
    }
    if (detailDraftDirtyRef.current && !window.confirm("Discard unsaved task changes?")) return false;
    detailDraftDirtyRef.current = false;
    setOverloadPrompt(current => current?.kind === "reassign" || current?.kind === "create" && current.parentId ? undefined : current);
    setShowSubtaskForm(false);
    if (showSubtaskForm) { setTitle(""); setDescription(""); setTargetDate(""); setStartDate(""); setEstimatedHours(""); setOwnerId(""); setPlanItemId(""); setTagsText(""); setChecklistText(""); setCollaboratorIds([]); setCollaboratorHours({}); }
    clearWaitingForm(); setEditing(false); setReason(""); setReassignId("");
    setCommittedDate(""); setCommittedDateReason(""); setExtensionDate(""); setExtensionReason(""); setExtensionDecisionReason("");
    setDependencyReason(""); setConfirmEarlyStart(false); setRecurrenceReason(""); setRecurrenceActionReason("");
    return true;
  };
  const closeTaskDrawer = (): void => {
    if (!leaveDrawerTask()) return;
    if (window.history.state?.taskWorkspaceSelection) window.history.back();
    else {
      const url = new URL(window.location.href); url.searchParams.delete(taskUrlKey("taskId", projectContext));
      window.history.replaceState(window.history.state, "", url);
    }
    setUrlTaskId(""); setSelectedId(""); setDetail(undefined);
  };
  const navigateDrawerTask = (taskId: string): void => {
    if (!visiblePage?.items.some(task => task.id === taskId) || !leaveDrawerTask()) return;
    const url = new URL(window.location.href); url.searchParams.set(taskUrlKey("taskId", projectContext), taskId);
    window.history.replaceState(window.history.state, "", url);
    setUrlTaskId(taskId); setDetail(undefined);
  };
  const openRelatedTask = (taskId: string): void => {
    if ((personalOnly || projectContext || registerMode) && !leaveDrawerTask()) return;
    if (listFirst) {
      const url = new URL(window.location.href); url.searchParams.set(taskUrlKey("taskId", projectContext), taskId);
      window.history.pushState({ taskWorkspaceSelection: true, taskWorkspaceView: view }, "", url);
      setUrlTaskId(taskId); setDetail(undefined);
    } else void load(taskId);
  };
  // Undefined setup also represents loading or denied setup; only a successful
  // authoritative response can establish that this Owner has no employee identity.
  const employeeLessOwnerPersonal = personalOnly && scope === "personal" && owner && setup !== undefined && setup.actorEmployeeId === null;
  const requiresExplicitOwner = setup !== undefined && setup.actorEmployeeId === null;
  const canCreate = !!setup && (setup.canAssign || !!setup.actorEmployeeId) && (!projectContext || ["DRAFT", "ACTIVE"].includes(projectContext.status));
  const createIntent = useRef(!projectContext && new URL(window.location.href).searchParams.get("create") === "1");
  useEffect(() => {
    if (!canCreate || !createIntent.current) return;
    createIntent.current = false;
    const url = new URL(window.location.href); url.searchParams.delete("create");
    window.history.replaceState(window.history.state, "", url);
    setShowForm(true);
  }, [canCreate]);
  const selected = detail?.task;
  const selectedSubtasks = selected && subtasksTaskId === selected.id ? subtasks : undefined;
  const profile = setup?.creationProfile;
  const profileIsValid = profile?.version === 1 && (profile.variant === "OWNER" || profile.variant === "EMPLOYEE" || profile.variant === "LEADER" || profile.variant === "SITE");
  const creationVariant: CreationProfile["variant"] = owner ? "OWNER" : profileIsValid && profile.variant !== "OWNER" ? profile.variant : "EMPLOYEE";
  const siteSummaryPresentation = !owner && !!setup?.actorEmployeeId && profileIsValid && profile.variant === "SITE" && profile.resolution === "CONFIGURED_ROLE";
  const creationHeading = creationVariant === "OWNER" ? "Create or assign a task" : creationVariant === "LEADER" ? "Assign work" : creationVariant === "SITE" ? "Create site work" : "Create my task";
  const compactOptionalPlanning = creationVariant === "EMPLOYEE" || creationVariant === "SITE";
  const hasTaskCommands = !!detail && (Object.values(detail.capabilities ?? {}).some(Boolean) || !!detail.extensions?.some(item => item.canDecide || item.canWithdraw) || !!recurrence && Object.values(recurrence.capabilities ?? {}).some(Boolean));
  const taskListTitle = projectContext ? "Project tasks" : personalOnly ? scope === "all" ? "Team and employee tasks" : "My tasks" : !listFirst ? owner ? "Organization tasks" : scope === "mine" ? "My tasks" : "Assigned tasks" : owner && (scope === "mine" || scope === "assigned") ? registerMode ? "All organization tasks" : "Organization tasks (legacy scope)" : scope === "mine" ? "My primary tasks" : scope === "assigned" ? "Collaborating or managed tasks" : scope === "owned" ? "Owned by me" : scope === "created" ? "Created by me" : scope === "collaborating" ? "Collaborating" : owner ? "All organization tasks" : "All visible tasks";
  /**
   * Scope tabs follow the server-derived presentation role, matching the
   * demo's role-dependent scope bar. Every value here is an existing
   * backend scope, so authorization is unchanged — this only decides which
   * of the already-authorized views a person is offered:
   *  - Owner          → My Work, Organization
   *  - Team Leader    → My Work, My Team
   *  - Site employee  → My Work, Site work
   *  - Other staff    → My Work only
   * "My Team" reuses `assigned`, which the backend already restricts to the
   * manager's reporting tree. "Site work" reuses `all` with a SITE type
   * filter rather than a new scope value.
   */
  const visibleScopeOptions = (() => {
    if (projectContext) return [{ scope: "all" as Scope, label: "Project tasks" }];
    const mine = { scope: "mine" as Scope, label: registerMode ? "Assigned to me" : "My Work" };
    if (owner) return registerMode ? [{ scope: "all" as Scope, label: "Organization" }] : [mine, { scope: "all" as Scope, label: "Organization" }];
    if (creationVariant === "LEADER") return [mine, { scope: "assigned" as Scope, label: "My Team" }];
    if (creationVariant === "SITE") return [mine, { scope: "all" as Scope, label: "Site work" }];
    return [mine];
  })();
  /**
   * A shared or bookmarked URL can name a scope this role is not offered
   * (for example `?scope=owned` after the role-aware scope bar landed).
   * Fall back to the first available scope so the active tab and the data
   * never disagree. Every branch above starts with the "mine" option, so the
   * list is never empty and the fallback is always a real scope.
   */
  const activeScopeOption = visibleScopeOptions.some(option => option.scope === scope) ? scope : visibleScopeOptions[0]?.scope ?? "mine";
  const managementWork = personalOnly && scope === "all";
  useEffect(() => {
    if (!managementWork) return;
    let current = true; setManagementToday(undefined);
    void fetch("/api/v1/dashboard/sources/tasks", { credentials: "include", cache: "no-store" })
      .then(response => json<{ today: string }>(response))
      .then(calendar => { previousCalendarDay(calendar.today); if (current) setManagementToday(calendar.today); })
      .catch(() => { if (current) setManagementToday(undefined); });
    return () => { current = false; };
  }, [managementWork, summaryRevision]);
  const canOverseeWork = owner || creationVariant === "LEADER" || setup?.canAssign === true;
  const managementTeams = [...new Map((setup?.employees ?? []).filter(employee => employee.homeTeamId).map(employee => [employee.homeTeamId!, { id: employee.homeTeamId!, name: employee.homeTeamName ?? "Team", branchId: employee.homeBranchId }])).values()];
  const managementEmployees = (setup?.employees ?? []).filter(employee => !filters.teamId || employee.homeTeamId === filters.teamId);
  useEffect(() => {
    if (personalOnly && setup && !canOverseeWork && scope !== "personal") { setScope("personal"); setTemporaryPhase(""); }
  }, [personalOnly, setup, canOverseeWork, scope]);
  const switchWorkScope = (next: "personal" | "all"): void => {
    if (!leaveDrawerTask()) return;
    clearWaitingForm(); setUrlTaskId(""); setSelectedId(""); setDetail(undefined); setOffset(0); setTemporaryPhase(""); setSourceRequest(undefined);
    const nextFilters = { ...defaultFilters, phase: "active" };
    setFilters(nextFilters); setDraftFilters(nextFilters); setScope(next);
  };
  const drillDown = (next: Partial<TaskFilters>): void => {
    if (!leaveDrawerTask()) return;
    const updated = { ...filters, ...next }; clearWaitingForm(); setUrlTaskId(""); setSelectedId(""); setDetail(undefined); setOffset(0); setFilters(updated); setDraftFilters(updated);
  };
  const secondaryFilterCount = FILTER_KEYS.filter(key => key !== "q" && key !== "dateBasis" && !!filters[key] && !(key === "phase" && filters.phase === defaultFilters.phase)).length + (filters.sort !== "created_desc" ? 1 : 0);
  const filterError = taskRefinementError(draftFilters) || ((draftFilters.dateFrom || draftFilters.dateTo) && !draftFilters.dateBasis
    ? "Choose Target date or Committed date before filtering by date."
    : draftFilters.dateFrom && draftFilters.dateTo && draftFilters.dateFrom > draftFilters.dateTo
      ? "The start date must be on or before the end date."
      : "");
  const pageRange = loading ? (visiblePage ? "Refreshing current page…" : "Loading current page…") : !visiblePage ? "Current page unavailable" : pageStale ? `Stale snapshot · last successfully refreshed ${pageRefreshedAt ? new Date(pageRefreshedAt).toLocaleString() : "time unavailable"} · ${visiblePage.total === 0 ? "0 filtered tasks" : `${offset + 1}–${Math.min(offset + visiblePage.items.length, visiblePage.total)} of ${visiblePage.total}`}` : visiblePage.total === 0 ? "0 filtered tasks" : `${offset + 1}–${Math.min(offset + visiblePage.items.length, visiblePage.total)} of ${visiblePage.total}`;
  const compactOwnerEmpty = employeeLessOwnerPersonal && !loading && !denied && !!visiblePage && visiblePage.total === 0 && !selectedId;
  const closeFilterPanel = (restoreFocus = false): void => {
    setFilterOpen(false);
    if (restoreFocus) filterDisclosureRef.current?.querySelector("summary")?.focus();
  };
  const toggleFilterPanel = (): void => {
    const rect = filterDisclosureRef.current?.querySelector("summary")?.getBoundingClientRect();
    if (rect && window.innerWidth > 700) {
      const top = Math.max(80, Math.min(rect.bottom + 8, window.innerHeight - 180));
      setFilterPosition({ top, right: Math.max(16, Math.min(window.innerWidth - rect.right, window.innerWidth - 336)), maxHeight: Math.min(620, window.innerHeight - top - 16) });
    }
    setFilterOpen(value => !value);
  };
  useEffect(() => {
    if (!filterOpen || !personalOnly) return;
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !filterDisclosureRef.current?.contains(event.target)) setFilterOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); setFilterOpen(false); filterDisclosureRef.current?.querySelector("summary")?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [filterOpen, personalOnly]);
  const applyFilters = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (filterError || registerMode && !leaveDrawerTask()) return;
    setDetail(undefined); setOffset(0); setFilters({ ...draftFilters, q: draftFilters.q.trim() });
    closeFilterPanel(true);
  };
  const resetFilters = (): void => {
    if (registerMode && !leaveDrawerTask()) return;
    const reset = { ...defaultFilters };
    setDetail(undefined); setDraftFilters(reset); setFilters(reset); setOffset(0); setSearchExpanded(false);
    closeFilterPanel(true);
  };
  const appliedFilterItems: AppliedTaskFilter[] = [];
  const addFilter = (key: keyof TaskFilters, label: string, value = filters[key]): void => {
    if (filters[key]) appliedFilterItems.push({ key, label, value });
  };
  addFilter("priorities", "Priority", selectionValues(filters.priorities).map(stateLabel).join(", "));
  addFilter("collaboratorEmployeeIds", "Collaborators", selectionValues(filters.collaboratorEmployeeIds).map(id => setup?.employees.find(employee => employee.id === id)?.name ?? "Selected employee unavailable").join(", "));
  addFilter("q", "Search");
  addFilter("projectId", "Project", setup?.projects?.find(project => project.id === filters.projectId)?.title ?? "Selected project");
  addFilter("planItemId", "Stage or milestone", setup?.planItems?.find(item => item.id === filters.planItemId)?.label ?? "Selected stage or milestone");
  addFilter("teamId", "Team", managementTeams.find(team => team.id === filters.teamId)?.name ?? "Selected team");
  addFilter("ownerEmployeeId", "Owner", setup?.employees?.find(employee => employee.id === filters.ownerEmployeeId)?.name ?? "Selected owner");
  addFilter("status", "Status", stateLabel(filters.status));
  if (filters.phase !== defaultFilters.phase) appliedFilterItems.push({ key: "phase", label: "Phase", value: filters.phase ? stateLabel(filters.phase) : "All phases" });
  if (filters.sort !== "created_desc") addFilter("sort", personalOnly && temporaryPhase === "attention" ? "Task list sort (paused)" : "Sort", { target_asc: "Nearest Target", title_asc: "Task name", owner_asc: "Primary owner", priority_desc: "Highest priority, then Target" }[filters.sort]);
  addFilter("dateFrom", `${filters.dateBasis === "committed" ? "Committed" : "Target"} from`);
  addFilter("dateTo", `${filters.dateBasis === "committed" ? "Committed" : "Target"} through`);
  const removeAppliedFilter = (key: string): void => {
    if (registerMode && !leaveDrawerTask()) return;
    if (![...FILTER_KEYS, "sort"].includes(key as keyof TaskFilters)) return;
    const remove = (current: TaskFilters): TaskFilters => {
      const next = { ...current, [key]: defaultFilters[key as keyof TaskFilters] };
      if (key === "projectId") next.planItemId = "";
      if (key === "teamId") next.ownerEmployeeId = "";
      if ((key === "dateFrom" || key === "dateTo") && !next.dateFrom && !next.dateTo) next.dateBasis = "";
      return next;
    };
    clearWaitingForm(); setDetail(undefined); setUrlTaskId(""); setOffset(0);
    filterDisclosureRef.current?.querySelector("summary")?.focus();
    setFilters(remove); setDraftFilters(remove);
  };
  const queueSnapshot = useMemo<MyWorkSnapshot>(() => ({ filters, view, compact, temporaryPhase: temporaryPhase as MyWorkSnapshot["temporaryPhase"] }), [filters, view, compact, temporaryPhase]);
  const applyQueuePreferences = (snapshot: MyWorkSnapshot): void => {
    clearWaitingForm(); setDetail(undefined); setUrlTaskId(""); setOffset(0);
    setFilters({ priorities: "", collaboratorEmployeeIds: "", teamId: "", ...snapshot.filters }); setDraftFilters({ priorities: "", collaboratorEmployeeIds: "", teamId: "", ...snapshot.filters });
    setView(snapshot.view); setCompact(snapshot.compact); setTemporaryPhase(snapshot.temporaryPhase);
  };
  const requestCreateClose = (): boolean => {
    if (busy || (uncertainCreation ? !window.confirm("Creation is unconfirmed. Leaving loses this recovery request; the task may already exist. Leave without recovery?") : createDraftDirtyRef.current && !window.confirm("Discard unsaved new task details?"))) return false;
    setUncertainCreation(undefined); creationAttempt.current = undefined;
    createDraftDirtyRef.current = false; setShowForm(false);
    if (overloadPrompt?.kind === "create") setOverloadPrompt(undefined);
    return true;
  };
  const createTaskControl = <button type="button" className={`task-primary${personalOnly ? " my-work-create-task" : ""}`} aria-label="Create task" onClick={() => { if (showForm) requestCreateClose(); else { createDraftDirtyRef.current = false; setTitle(""); setDescription(""); setReason(""); setTargetDate(""); setStartDate(""); setEstimatedHours(""); setProjectId(""); setPlanItemId(""); setTagsText(""); setChecklistText(""); setType(projectContext ? "PROJECT" : "NON_PROJECT"); setProjectId(projectContext?.id ?? ""); setReviewRequirement("NONE"); setPriority("MEDIUM"); setAssignTo(false); setOwnerId(""); setCollaboratorIds([]); setCollaboratorHours({}); setShowForm(true); } }} disabled={!canCreate}>{personalOnly && <span aria-hidden="true" className="my-work-create-symbol">{"＋"}</span>}<span className="my-work-create-label">{"Create task"}</span></button>;
  const filterActions = <div className="task-filter-actions"><button type="submit" className="task-primary" disabled={!!filterError || loading}>Apply filters</button><button type="button" onClick={resetFilters} disabled={loading}>Reset filters</button></div>;
  const paging = <div className="task-list-paging" data-single-page={registerMode && offset === 0 && !!visiblePage && visiblePage.total <= 50 || undefined}><span>{loading || !visiblePage || visiblePage.total === 0 || pageStale ? pageRange : <>Showing <span>{pageRange}</span> filtered tasks</>}</span><div><button type="button" onClick={() => setOffset(Math.max(0, offset - 50))} disabled={loading || pageStale || offset === 0}>Previous</button><button type="button" onClick={() => setOffset(offset + 50)} disabled={loading || pageStale || !visiblePage || offset + visiblePage.items.length >= visiblePage.total}>Next</button></div></div>;
  const toolbar = <div className="task-toolbar">{!personalOnly && !registerMode && <><div role="group" aria-label="Task list scope" className="task-tabs task-scope-buttons">{listFirst ? visibleScopeOptions.map((option) => <button key={option.scope} type="button" aria-pressed={activeScopeOption === option.scope} onClick={() => { clearWaitingForm(); setOffset(0); setScope(option.scope); }}>{option.label}</button>) : owner ? <span>Organization tasks</span> : <><button type="button" aria-pressed={scope === "mine"} onClick={() => { clearWaitingForm(); setOffset(0); setScope("mine"); }}>My tasks</button><button type="button" aria-pressed={scope === "assigned"} onClick={() => { clearWaitingForm(); setOffset(0); setScope("assigned"); }}>Assigned tasks</button></>}</div>{listFirst && <label className="task-mobile-control task-mobile-scope">Scope<select aria-label="Task scope" value={activeScopeOption} onChange={(event) => { clearWaitingForm(); setOffset(0); setScope(event.target.value as Scope); }}>{visibleScopeOptions.map((option) => <option key={option.scope} value={option.scope}>{option.label}</option>)}</select></label>}</>}{listFirst && <><div role="group" aria-label="Task display" className="task-tabs task-view-buttons"><button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button><button type="button" aria-pressed={view === "cards"} onClick={() => setView("cards")}>Cards</button><button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}>Kanban</button><button type="button" aria-pressed={view === "timeline"} onClick={() => setView("timeline")}>Timeline</button></div><label className="task-mobile-control">Display<select aria-label="Task display mode" value={view} onChange={(event) => setView(event.target.value as TaskView)}><option value="list">List</option><option value="cards">Cards</option><option value="board">Kanban</option><option value="timeline">Timeline</option></select></label></>}{listFirst && desktop && <label className="task-compact-toggle"><input type="checkbox" checked={compact} onChange={(event) => setCompact(event.target.checked)} /> Compact</label>}<button type="button" onClick={refresh}>Refresh</button></div>;
  const primaryOwnerLabel = useCallback((task: Task): string => {
    const employee = setup?.employees.find((candidate) => candidate.id === task.primaryOwnerEmployeeId);
    if (employee) return employee.name;
    const email = task.primaryOwner?.account?.normalizedEmail;
    if (email) return email;
    return task.primaryOwnerEmployeeId === setup?.actorEmployeeId ? "You" : "Task owner";
  }, [setup]);
  /**
   * Presentation mapping for the My Work demo-parity row renderer. Reads the
   * same fields the legacy `.task-queue-row` markup already renders; the
   * parity renderer only changes how they are shown, never which rows are
   * visible (that stays the server's authorization decision).
   *
   * `nextAction` is a *label for the same open action* the legacy row offers.
   * It is deliberately derived from status only, so it can never widen what
   * the user is permitted to do.
   */
  const parityRows = useMemo<MyWorkParityRow[]>(() => {
    if (!personalOnly) return [];
    return (visiblePage?.items ?? []).map((task) => {
      const project = setup?.projects.find((item) => item.id === task.projectId)?.title ?? "No project";
      const planItem = setup?.planItems.find((item) => item.id === task.planItemId)?.label;
      return {
        id: task.id,
        title: task.title,
        context: [project, planItem].filter(Boolean).join(" · "),
        project,
        stage: planItem ?? setup?.projects.find((item) => item.id === task.projectId)?.status ?? "—",
        people: primaryOwnerLabel(task),
        dueDate: task.targetDate.slice(0, 10),
        status: task.status,
        priority: task.priority,
        nextAction: parityNextAction(task),
        ...(task.isSubtask ? { isSubtask: true as const } : {}),
        ...(task.requiresReassignment ? { requiresReassignment: true } : {}),
      };
    });
  }, [personalOnly, visiblePage, setup, primaryOwnerLabel]);
  const renderTaskButton = (task: Task, extraClass = ""): React.JSX.Element => {
    const primaryOwner = primaryOwnerLabel(task);
    const queueRow = view === "list" && !extraClass && (listFirst === true || owner);
    const project = setup?.projects.find((item) => item.id === task.projectId)?.title ?? "No project";
    const planItem = setup?.planItems.find((item) => item.id === task.planItemId)?.label;
    const openTask = (): void => { if ((personalOnly || projectContext || registerMode) && task.id !== selectedId && !leaveDrawerTask()) return; if (task.id !== selectedId) clearWaitingForm(); if (listFirst) { const url = new URL(window.location.href); url.searchParams.set(taskUrlKey("taskId", projectContext), task.id); window.history.pushState({ taskWorkspaceSelection: true, taskWorkspaceView: view }, "", url); setUrlTaskId(task.id); setDetail(undefined); } else void load(task.id); };
    if (queueRow) return <div key={task.id} className={`task-list-item task-queue-row task-row-state-${task.status.toLowerCase()}${task.id === selectedId ? " is-selected" : ""}`}>
        <button type="button" className="task-queue-open-main" aria-label={`Open task: ${task.title}`} aria-describedby={`task-queue-description-${task.id}`} aria-current={task.id === selectedId ? "true" : undefined} onClick={openTask}>
        <span className="task-queue-cell task-queue-primary"><span className="task-queue-value-label">Task</span>{personalOnly && <span className="task-queue-type">{stateLabel(task.type)}</span>}{task.isSubtask && <span className="task-subtask-marker">Subtask</span>}<strong>{task.title}</strong><span className="task-queue-context">{project}{planItem ? ` · ${planItem}` : ""}</span>{task.requiresReassignment && <span className="task-reassignment-alert">Needs reassignment after employee exit</span>}{personalOnly && <><span className="my-work-mobile-state" data-state={task.status.toLowerCase()}>{stateLabel(task.status)}</span><span className={`my-work-mobile-due${rowIsOverdue(task.targetDate, overdueCalendar.before) ? " overdue" : ""}`}>{task.targetDate.slice(0, 10)}</span></>}</span>
        <span className="task-queue-cell task-queue-priority"><span className="task-queue-value-label">Priority</span>{personalOnly ? <span className={`priority-pill ${parityPriorityClass(task.priority)}`} data-priority={parityPriorityClass(task.priority).replace("pr-", "")} title={`${parityPriorityLabel(task.priority)} priority`}>{parityPriorityLabel(task.priority)}</span> : <strong className={`task-priority task-priority-${task.priority.toLowerCase()}`}>{registerMode ? stateLabel(task.priority) : task.priority}</strong>}</span>
        <span className="task-queue-cell task-queue-status"><span className="task-queue-value-label">Status</span><span className={`task-state task-state-${task.status.toLowerCase()}`}>{stateLabel(task.status)}</span></span>
        <span className="task-queue-cell task-queue-target"><span className="task-queue-value-label">Target</span><strong>{registerMode ? registerDate(task.targetDate) : task.targetDate.slice(0, 10)}</strong></span>
        <span className="task-queue-cell task-queue-committed"><span className="task-queue-value-label">Committed</span><strong>{registerMode ? task.committedDueDate ? registerDate(task.committedDueDate) : "—" : task.committedDueDate?.slice(0, 10) ?? "Not committed"}</strong></span>
        <span className="task-queue-open">{personalOnly && <span className="task-next-action">Next: Open task</span>}<span className="task-open-label">Open task <span aria-hidden="true">→</span></span></span>
        </button>
        <span className="task-queue-cell task-queue-owner"><span className="task-queue-value-label">{registerMode ? "Primary owner" : "People · Primary owner"}</span><TaskPeople task={task} primaryOwnerLabel={primaryOwner} refreshVersion={summaryRevision} onOpenTask={openTask} {...(onSessionExpired ? { onSessionExpired } : {})} /></span>
        <span className="task-sr-only" id={`task-queue-description-${task.id}`}>Primary owner: {primaryOwner}. Priority: {task.priority}. Status: {stateLabel(task.status)}. Target date: {task.targetDate.slice(0, 10)}. Committed date: {task.committedDueDate?.slice(0, 10) ?? "Not committed"}.{task.requiresReassignment ? " Needs reassignment after employee exit." : ""}</span>
    </div>;
    return <button type="button" key={task.id} className={`task-list-item${extraClass}${task.id === selectedId ? " is-selected" : ""}`} aria-label={`Open task: ${task.title}`} aria-current={task.id === selectedId ? "true" : undefined} onClick={openTask}>{task.isSubtask && <span className="task-subtask-marker">Subtask</span>}<strong>{task.title}</strong><span>{project} · {primaryOwner}</span><span>{stateLabel(task.status)} · {stateLabel(task.priority)}</span>{task.requiresReassignment && <span className="task-reassignment-alert">Needs reassignment after employee exit</span>}<small>Target date: {task.targetDate.slice(0, 10)}</small><small>Committed date: {task.committedDueDate?.slice(0, 10) ?? "Not committed"}</small></button>;
  };
  useEffect(() => {
    setCommittedDate(selected?.committedDueDate?.slice(0, 10) ?? "");
    setCommittedDateReason("");
    setConfirmEarlyStart(false);
  }, [selectedId, selected?.committedDueDate]);

  const selectWorkPhase = (phase: string): boolean => {
    if (!leaveDrawerTask()) return false;
    clearWaitingForm(); setTemporaryPhase(phase); setOffset(0); setDetail(undefined); setSelectedId(""); setUrlTaskId("");
    setFilterOpen(false);
    if (displayOptionsRef.current) displayOptionsRef.current.open = false;
    setQueueReveal(value => value + 1);
    return true;
  };
  const openWorkSources = (source: "actions" | "reviews"): void => {
    if (!selectWorkPhase(temporaryPhase === "attention" ? "" : "attention")) return;
    setSourceRequest(current => ({ source, version: (current?.version ?? 0) + 1 }));
  };
  const taskChecklistContent = selected ? <section aria-label="Task checklist">
    {!!selected.checklist.length && <><h4>Checklist <span className="task-checklist-count">{selected.checklist.filter((item) => item.checked).length}/{selected.checklist.length}</span></h4><ul className="task-checklist">{selected.checklist.map((item, index) => <li key={`${item.label}-${index}`}><input type="checkbox" checked={item.checked} disabled aria-label={item.label} /><span>{item.label}</span></li>)}</ul><p className="task-decision-help">Checklist progress does not complete the task automatically.</p></>}
    {!selected.checklist.length && <><h3>Checklist</h3><p>No checklist items are recorded for this task.</p></>}
    {selected.checklist.length > 0 && <p>Update checklist items through Edit task in Overview.</p>}
  </section> : null;
  const taskActivityContent = selected && detail ? <section aria-label="Task activity">
    {(detail.history.statusChanges.length > 0 || detail.history.ownerChanges.length > 0 || (detail.history.committedDateChanges?.length ?? 0) > 0) && <><h4>Task history</h4><ol className="task-history">{[...detail.history.statusChanges.map((event) => ({ ...event, kind: "status" as const })), ...detail.history.ownerChanges.map((event) => ({ ...event, kind: "owner" as const })), ...(detail.history.committedDateChanges ?? []).map((event) => ({ ...event, kind: "committed-date" as const }))].sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "")).map((event, index) => <li key={event.id ?? index}><span>{event.kind === "committed-date" ? `Committed due date ${event.oldDate ? `changed from ${event.oldDate.slice(0, 10)}` : "set"} to ${event.newDate.slice(0, 10)}: ${event.reason}` : event.reason ?? (event.toStatus ? `${stateLabel(event.fromStatus ?? "Created")} → ${stateLabel(event.toStatus)}` : event.kind === "owner" ? `Owner reassigned: ${setup?.employees.find((employee) => employee.id === event.oldOwnerEmployeeId)?.name ?? "Previous owner"} → ${setup?.employees.find((employee) => employee.id === event.newOwnerEmployeeId)?.name ?? "New owner"}` : event.action ?? "Task updated")}{event.occurredAt ? ` · ${new Date(event.occurredAt).toLocaleString()}` : ""}</span>{"delayCause" in event && event.delayCause && <span className="task-history-waiting">Delay cause: {event.delayCause}{event.responsibleParty ? ` · Responsible party: ${event.responsibleParty}` : ""}</span>}</li>)}</ol></>}
    {!detail.history.statusChanges.length && !detail.history.ownerChanges.length && !(detail.history.committedDateChanges?.length ?? 0) && <><h3>Activity</h3><p>No task changes are recorded yet.</p></>}
  </section> : null;
  const taskEvidenceContent = selected ? <section aria-label="Task evidence"><h3>Evidence</h3>
    {selected.projectId ? <><p>Open this task's internal review to see or submit its evidence.</p><a className="task-review-link" href={`/reviews?taskId=${encodeURIComponent(detail?.linkedReviewTaskId || selected.id)}`} onClick={event => { if (!leaveDrawerTask()) event.preventDefault(); }}>{detail?.linkedReviewTaskId ? "Open correction instructions in internal review" : "Open internal review"}</a></> : <p>No review evidence workflow is linked to this task.</p>}
  </section> : null;
  const creationRecovery = uncertainCreation ? <section className="task-capacity-warning task-create-recovery" aria-label="Unconfirmed creation"><p>The submitted details are locked while this result is unconfirmed. Checking uses the same request and cannot create a second copy.</p><button type="button" data-task-creation-recovery disabled={busy} onClick={() => void performCreation(uncertainCreation.body, uncertainCreation.parentId)}>{busy ? "Checking…" : "Check creation result"}</button></section> : null;
  const taskDetailView = <article className="task-detail" aria-label="Task details" onClickCapture={event => { if ((personalOnly || projectContext || registerMode) && event.target instanceof Element && event.target.closest("a[href]") instanceof HTMLAnchorElement && !isInPageAnchor(event.target.closest("a[href]") as HTMLAnchorElement) && !leaveDrawerTask()) event.preventDefault(); }}>{creationRecovery}{selected ? <>{!personalOnly && <div className="task-detail-heading"><div>{listFirst && <button type="button" className="task-back" onClick={() => { if (!leaveDrawerTask()) return; clearWaitingForm(); if (window.history.state?.taskWorkspaceSelection) window.history.back(); else { const url = new URL(window.location.href); url.searchParams.delete(taskUrlKey("taskId", projectContext)); window.history.replaceState(null, "", url); setUrlTaskId(""); } }}>Back to task list</button>}<p className="task-eyebrow">{stateLabel(selected.type)}{selected.projectId ? " · Project task" : " · No project"}</p><h3>{selected.title}</h3></div><span className={`task-state task-state-${selected.status.toLowerCase()}`}>{stateLabel(selected.status)}</span></div>}

      {registerMode && <section className="task-register-next" aria-label="Next step"><h4>Next step</h4><p>{selected.requiresReassignment ? "A manager must reassign this task before work can continue." : selected.status === "COMPLETED" ? "This task is complete. Its history remains available below." : selected.status.includes("INTERNAL_REVIEW") ? "Open internal review to see the submitted evidence and review progress." : selected.status.includes("CLIENT_REVIEW") ? "Waiting for client review. Open client reviews for the current request." : selected.status === "CORRECTIONS_REQUIRED" || selected.status === "CLIENT_REVISION_REQUIRED" ? "Read the review feedback and submit corrected evidence through the required review workflow." : selected.status === "INTERNAL_APPROVED" ? "Internal approval is recorded. Check the review workspace for client routing or the authorized completion step." : selected.status === "CLIENT_APPROVED" ? "Client approval is recorded. Use client reviews for the authorized final-approval and completion workflow." : selected.status === "WAITING" ? "Work is waiting. Review the waiting details and resume when the blocker is resolved." : selected.status === "STOPPED_DUE_TO_PROJECT_CANCELLATION" ? "This task is stopped because its project was cancelled." : selected.status === "IN_PROGRESS" ? "Continue the work, then submit required evidence for review or complete the task when permitted." : "Start the task when you are ready. Available actions follow your current permissions."}</p>
{(detail.capabilities.transition && !selected.requiresReassignment && ["NOT_STARTED", "IN_PROGRESS"].includes(selected.status)) && <label>Reason for change<input aria-label="Reason for change" value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} /></label>}
{detail.capabilities.resume && selected.status === "WAITING" && !selected.requiresReassignment && <form className="task-wait-form" aria-label="Resume task" onSubmit={(event) => { event.preventDefault(); void mutate("/resume", { expectedVersion: selected.version, reason: resumeReason.trim() }, "Task resumed."); }}><h4>Resume work</h4><p>The task will return to In progress.</p><label>Reason for resuming<input value={resumeReason} onChange={(event) => setResumeReason(event.target.value)} minLength={3} maxLength={1000} required /></label><button type="submit" disabled={busy || resumeReason.trim().length < 3}>{busy ? "Saving…" : "Resume task"}</button></form>}
{detail.capabilities.transition && selected.status === "IN_PROGRESS" && (selectedSubtasks?.completionBlocked || selected.reviewRequirement !== "NONE") && <p className="task-completion-help" role="status">{selectedSubtasks?.completionBlocked ? "Complete all subtasks before completing this task." : "Finish the required review before completing this task. Use the review link below."}</p>}
{detail.capabilities.transition && !selected.requiresReassignment && <div className="task-actions">{selected.status === "NOT_STARTED" && (detail.dependencies?.hasUnfinished ? <>{!confirmEarlyStart ? <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => setConfirmEarlyStart(true)}>Review early start</button> : <><p className="task-dependency-warning">Linked predecessor work is unfinished. Your start will be recorded as an early start.</p><button type="button" disabled={busy || reason.trim().length < 3} onClick={() => transition("IN_PROGRESS", true)}>Start anyway</button><button type="button" onClick={() => setConfirmEarlyStart(false)}>Cancel</button></>}</> : <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => transition("IN_PROGRESS")}>Start task</button>)}{selected.status === "IN_PROGRESS" && (selectedSubtasks?.completionBlocked ? <button type="button" disabled title="Complete this task after its subtasks are complete">Complete task</button> : <button type="button" disabled={busy || reason.trim().length < 3 || selected.reviewRequirement !== "NONE"} title={selected.reviewRequirement !== "NONE" ? "Complete this task through its required review workflow. Open internal review above." : undefined} onClick={() => transition("COMPLETED")}>Complete task</button>)}</div>}
        {(detail.capabilities.transition && !selected.requiresReassignment && ["NOT_STARTED", "IN_PROGRESS"].includes(selected.status)) && reason.trim().length < 3 && <p className="task-register-action-help">Enter a reason of at least 3 characters to enable the applicable action.</p>}
        {selected.projectId && (detail.linkedReviewTaskId || (selected.reviewRequirement !== "NONE" && selected.status !== "NOT_STARTED")) && <a className="task-review-link" href={`/reviews?taskId=${encodeURIComponent(detail.linkedReviewTaskId || selected.id)}`}>{detail.linkedReviewTaskId ? "Open correction instructions in internal review" : selected.status === "IN_PROGRESS" ? "Submit work for review" : "Open internal review"}</a>}
        {selected.projectId && ["SUBMITTED_CLIENT_REVIEW", "IN_CLIENT_REVIEW", "CLIENT_REVISION_REQUIRED", "CLIENT_APPROVED"].includes(selected.status) && <a href={`/client-reviews?projectId=${encodeURIComponent(selected.projectId)}`}>Open client reviews</a>}
      </section>}
      {!registerMode && selected.projectId && detail.linkedReviewTaskId && <p><a className="task-review-link" href={`/reviews?taskId=${encodeURIComponent(detail.linkedReviewTaskId)}`}>Open correction instructions in internal review</a></p>}
      {!registerMode && selected.projectId && !detail.linkedReviewTaskId && <p><a className="task-review-link" href={`/reviews?taskId=${encodeURIComponent(selected.id)}`}>Open internal review</a></p>}
        {registerMode && selected.description && !editing && <><h4>Description</h4><p className="task-description">{selected.description}</p></>}
        {selected.requiresReassignment && <p className="task-reassignment-alert" role="status">Needs reassignment after employee exit. A manager must reassign this task before it can resume.</p>}
        {selected.status === "WAITING" && !selected.requiresReassignment && <section className="task-waiting-details" aria-label="Waiting details"><h4>Waiting details</h4><dl><div><dt>Reason</dt><dd>{selected.waitingReason || "Not recorded"}</dd></div><div><dt>Delay cause</dt><dd>{selected.waitingDelayCause || "Not recorded"}</dd></div><div><dt>Responsible party</dt><dd>{selected.waitingResponsibleParty || "Not specified"}</dd></div></dl></section>}
        {(subtasksLoading || selectedSubtasks || subtasksError) && <section className="task-subtasks" aria-label="Subtasks"><h4>Subtasks</h4>
          {createdSubtask?.parentId === selected.id && <p role="status">Created subtask: <button type="button" onClick={() => openRelatedTask(createdSubtask.id)}>{createdSubtask.id}</button></p>}
          {subtasksLoading && <p role="status">Loading subtasks…</p>}
          {subtasksError && <p role="status">{subtasksError} <button type="button" onClick={() => setSubtasksRetry((count) => count + 1)}>Refresh</button></p>}
          {selectedSubtasks?.parent && <p>Part of <button type="button" className="task-related-link" onClick={() => openRelatedTask(selectedSubtasks.parent!.id)}>{selectedSubtasks.parent.title}</button></p>}
          {selectedSubtasks && (selectedSubtasks.items.length ? <ul>{selectedSubtasks.items.map((child) => <li key={child.id}><button type="button" className="task-related-link" onClick={() => openRelatedTask(child.id)}>{child.title}</button><span>{stateLabel(child.status)} · Target {child.targetDate.slice(0, 10)} · {child.primaryOwnerName}</span></li>)}</ul> : <p>No subtasks.</p>)}
          {selectedSubtasks?.completionBlocked && <p className="task-dependency-warning" role="status">This task cannot be completed until its subtasks are complete.</p>}
          {selectedSubtasks?.canCreate && !selectedSubtasks.isSubtask && <button type="button" disabled={busy || subtasksLoading || selectedSubtasks.taskVersion !== selected.version} onClick={() => { if (showSubtaskForm) { if (!leaveDrawerTask()) return; setShowSubtaskForm(false); } else { setShowForm(false); setTitle(""); setDescription(""); setReason(""); setTargetDate(""); setStartDate(""); setEstimatedHours(""); setPlanItemId(""); setTagsText(""); setChecklistText(""); setOwnerId(""); setAssignTo(false); setCollaboratorIds([]); setCollaboratorHours({}); setType(selected.projectId ? "PROJECT" : "NON_PROJECT"); setReviewRequirement("NONE"); setShowSubtaskForm(true); setError(""); } }}>{showSubtaskForm ? "Close subtask form" : "Create subtask"}</button>}
          {selectedSubtasks?.canCreate && selectedSubtasks.taskVersion !== selected.version && <p role="alert">Task details changed while subtasks loaded. <button type="button" onClick={() => refresh()}>Refresh</button></p>}
          {showSubtaskForm && selectedSubtasks?.canCreate && !selectedSubtasks.isSubtask && selectedSubtasks.taskVersion === selected.version && <form noValidate className="task-form task-subtask-form" aria-label="Create subtask" onSubmit={(event) => void submitSubtask(event)}>
            <h4>{creationHeading} · subtask</h4><p>This work stays in the same project as its parent task.</p>
            <TaskComposerFields validationAttempt={validationAttempt} draft={composerDraft} onChange={changeComposer} projects={setup?.projects ?? []} planItems={setup?.planItems ?? []} options={creation.options} optionsError={creation.error} retryOptions={creation.retry} compact={compactOptionalPlanning} busy={busy || !!uncertainCreation} subtask fixedProject={{ id: selected.projectId ?? "", title: setup?.projects.find(project => project.id === selected.projectId)?.title ?? (selected.projectId ? "Project" : "No project") }} />
            <button type="submit" className="task-primary" disabled={busy || !!uncertainCreation || creationBlocked || selectedSubtasks.taskVersion !== selected.version}>{busy ? "Creating…" : "Create subtask"}</button>
          </form>}
        </section>}
        <dl className="task-facts"><div><dt>Priority</dt><dd>{stateLabel(selected.priority)}</dd></div><div><dt>Target date</dt><dd>{registerMode ? registerDate(selected.targetDate) : selected.targetDate.slice(0, 10)}</dd></div><div><dt>Committed due date</dt><dd>{registerMode ? selected.committedDueDate ? registerDate(selected.committedDueDate) : "Not set" : selected.committedDueDate?.slice(0, 10) ?? "Not set"}</dd></div><div><dt>Owner</dt><dd>{setup?.employees.find((employee) => employee.id === selected.primaryOwnerEmployeeId)?.name ?? (selected.primaryOwnerEmployeeId === setup?.actorEmployeeId ? "You" : "Task owner")}</dd></div>{!registerMode && <div><dt>Version</dt><dd>{selected.version}</dd></div>}</dl>
        <TaskRegisterDisclosure enabled={registerMode} label="Dependencies">{selected.projectId && <section className="task-dependencies" aria-label="Task dependencies"><h4>Finish-to-start dependencies</h4>{detail.dependencies?.predecessors.length ? <ul>{detail.dependencies.predecessors.map((predecessor) => <li key={predecessor.id}><span>{predecessor.title} · {stateLabel(predecessor.status)}</span>{detail.capabilities.manageDependencies && <button type="button" disabled={busy || dependencyReason.trim().length < 3} onClick={() => void mutate(`/dependencies/${encodeURIComponent(predecessor.id)}/remove`, { expectedVersion: selected.version, reason: dependencyReason.trim() }, "Dependency removed.")}>Remove</button>}</li>)}</ul> : <p>No visible predecessor tasks linked.</p>}{(detail.dependencies?.hiddenCount ?? 0) > 0 && <p>Additional linked tasks are unavailable under your current access.</p>}{detail.dependencies?.hasUnfinished && <p className="task-dependency-warning" role="status">At least one predecessor is unfinished. Starting this task early requires an explicit acknowledgement.</p>}{detail.capabilities.manageDependencies && <form onSubmit={(event) => { event.preventDefault(); if (predecessorId) void mutate("/dependencies", { predecessorTaskId: predecessorId, expectedVersion: selected.version, reason: dependencyReason.trim() }, "Dependency added."); }}><label>Search predecessor tasks<input value={dependencySearch} onChange={(event) => { setDependencySearch(event.target.value); setPredecessorId(""); }} maxLength={160} /></label><label>Link an accessible predecessor<select value={predecessorId} onChange={(event) => setPredecessorId(event.target.value)}><option value="">Choose a task</option>{dependencyCandidates.filter((candidate) => !detail.dependencies?.predecessors.some((linked) => linked.id === candidate.id)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title} · {stateLabel(candidate.status)}</option>)}</select></label><label>Reason for dependency change<input value={dependencyReason} onChange={(event) => setDependencyReason(event.target.value)} minLength={3} maxLength={1000} required /></label><button type="submit" disabled={busy || !predecessorId || dependencyReason.trim().length < 3}>Add dependency</button></form>}</section>}</TaskRegisterDisclosure>
        {selected.planItemId && <p className="task-linked-plan">Linked plan item: {setup?.planItems.find((item) => item.id === selected.planItemId)?.label ?? "Project plan item"}</p>}
        {!!selected.tags.length && <><h4>Tags</h4><ul className="task-tags">{selected.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul></>}
        {!personalOnly && <>{!!selected.checklist.length && <><h4>Checklist <span className="task-checklist-count">{selected.checklist.filter((item) => item.checked).length}/{selected.checklist.length}</span></h4><ul className="task-checklist">{selected.checklist.map((item, index) => <li key={`${item.label}-${index}`}><input type="checkbox" checked={item.checked} disabled aria-label={item.label} /><span>{item.label}</span></li>)}</ul><p className="task-decision-help">Checklist progress does not complete the task automatically.</p></>}</>}
        {personalOnly && hasTaskCommands && <h4 data-task-drawer-commands tabIndex={-1}>Task actions</h4>}
        {detail.capabilities.edit && !editing && <button type="button" onClick={() => { setTitle(selected.title); setDescription(selected.description ?? ""); setTargetDate(selected.targetDate.slice(0, 10)); setPriority(selected.priority); setStartDate(selected.startDate?.slice(0, 10) ?? ""); setEstimatedHours(selected.estimatedHours == null ? "" : String(selected.estimatedHours)); setPlanItemId(selected.planItemId ?? ""); setTagsText(selected.tags.join(", ")); setChecklistText(selected.checklist.map((item) => `${item.checked ? "[x]" : "[ ]"} ${item.label}`).join("\n")); setEditing(true); }}>Edit task</button>}
        {editing && <form className="task-edit-form" onSubmit={(event) => void editTask(event)}><h4>Edit task</h4><label>Task name<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={160} required /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={TASK_DESCRIPTION_MAX_LENGTH} rows={3} /></label><div className="task-form-grid"><label>Target date<input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} required /></label><label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value)}>{PRIORITIES.map((item) => <option key={item} value={item}>{stateLabel(item)}</option>)}</select></label><label>Start date<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>Estimated hours<input type="number" min="0" step="0.25" value={estimatedHours} onChange={(event) => setEstimatedHours(event.target.value)} /></label></div><label>Stage or milestone<select aria-label="Edit plan item" value={planItemId} onChange={(event) => setPlanItemId(event.target.value)} disabled={!selected.projectId}><option value="">No plan item</option>{setup?.planItems.filter((item) => item.projectId === selected.projectId).map((item) => <option key={item.id} value={item.id}>{item.kind === "STAGE" ? "Stage" : "Milestone"} · {item.label}</option>)}</select></label><label>Tags (comma separated)<input aria-label="Edit tags" value={tagsText} onChange={(event) => setTagsText(event.target.value)} /></label><label>Checklist (one item per line; prefix with [x] when checked)<textarea aria-label="Edit checklist" value={checklistText} onChange={(event) => setChecklistText(event.target.value)} rows={3} /></label><label>Reason<input aria-label="Edit reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} required /></label><div className="task-edit-actions"><button type="submit" disabled={busy || reason.trim().length < 3}>{busy ? "Saving…" : "Save task"}</button><button type="button" onClick={() => setEditing(false)}>Cancel edit</button></div></form>}
        {!registerMode && selected.description && !editing && <><h4>Description</h4><p className="task-description">{selected.description}</p></>}
        {detail.collaborators.length > 0 && <><h4>Collaborators</h4><ul>{detail.collaborators.map((person) => <li key={person.employeeId}>{person.name}{person.estimatedHours !== undefined ? ` · ${person.estimatedHours} estimated hours` : ""}</li>)}</ul></>}
        <TaskRegisterDisclosure enabled={registerMode} label="Set or change committed date">{detail.capabilities.changeCommittedDate && selected.type !== "CLOSEOUT" && <form className="task-committed-date" aria-label="Set committed due date" onSubmit={(event) => { event.preventDefault(); void mutate("/committed-date", { expectedVersion: selected.version, committedDueDate: committedDate, reason: committedDateReason.trim() }, selected.committedDueDate ? "Committed due date updated." : "Committed due date set."); }}><h4>{selected.committedDueDate ? "Change committed due date" : "Set committed due date"}</h4><p>This commitment is separate from the operational target date.</p><label>Committed due date<input type="date" value={committedDate} onChange={(event) => setCommittedDate(event.target.value)} required /></label><label>Reason<input value={committedDateReason} onChange={(event) => setCommittedDateReason(event.target.value)} minLength={3} maxLength={1000} required /></label><button type="submit" disabled={busy || !committedDate || committedDateReason.trim().length < 3}>{busy ? "Saving…" : selected.committedDueDate ? "Change committed date" : "Set committed date"}</button></form>}</TaskRegisterDisclosure>
        {selected.type === "RECURRING" && <section className="task-recurrence" aria-label="Recurrence schedule"><h4>Recurrence schedule</h4>
          {recurrenceLoading && <p role="status">Loading recurrence…</p>}{recurrenceError && <p role="alert">{recurrenceError} <button type="button" onClick={() => setRecurrenceRetry((count) => count + 1)}>Retry</button></p>}
          {recurrence && <><p>Organization timezone: <strong>{recurrence.timezone}</strong></p>
            {recurrence.rule ? <dl className="task-recurrence-facts"><div><dt>Frequency</dt><dd>{stateLabel(recurrence.rule.frequency)}</dd></div><div><dt>Anchor date</dt><dd>{recurrence.rule.anchorDate.slice(0, 10)}</dd></div><div><dt>Effective first date</dt><dd>{recurrence.rule.effectiveFromDate.slice(0, 10)}</dd></div><div><dt>Schedule status</dt><dd>{recurrence.rule.paused ? "Paused" : "Active"}</dd></div><div><dt>Rule version</dt><dd>{recurrence.rule.version}</dd></div></dl> : <p>No recurrence rule has been configured.</p>}
            {recurrence.capabilities.configure && <form className="task-recurrence-form" aria-label="Configure recurrence" onSubmit={(event) => { event.preventDefault(); void mutateRecurrence("PUT", "", recurrenceReason, recurrenceFrequency, recurrenceDate); }}><h5>{recurrence.rule ? "Change schedule" : "Configure schedule"}</h5><p>Choose a future first occurrence date in the organization timezone. Missed dates are skipped.</p><label>Frequency<select value={recurrenceFrequency} onChange={(event) => setRecurrenceFrequency(event.target.value as RecurrenceFrequency)}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></label><label>First occurrence date<input type="date" value={recurrenceDate} onChange={(event) => setRecurrenceDate(event.target.value)} required /></label><label>Reason<input value={recurrenceReason} onChange={(event) => setRecurrenceReason(event.target.value)} minLength={3} maxLength={1000} required /></label><button type="submit" disabled={busy || recurrenceLoading || !recurrenceDate || recurrenceReason.trim().length < 3}>{busy ? "Saving…" : "Save recurrence rule"}</button></form>}
            {(recurrence.capabilities.pause || recurrence.capabilities.resume) && <div className="task-recurrence-control"><h5>{recurrence.rule?.paused ? "Resume schedule" : "Pause schedule"}</h5><label>{recurrence.rule?.paused ? "Reason for resuming" : "Reason for pausing"}<input value={recurrenceActionReason} onChange={(event) => setRecurrenceActionReason(event.target.value)} minLength={3} maxLength={1000} required /></label><button type="button" disabled={busy || recurrenceActionReason.trim().length < 3} onClick={() => void mutateRecurrence("POST", recurrence.rule?.paused ? "/resume" : "/pause", recurrenceActionReason)}>{busy ? "Saving…" : recurrence.rule?.paused ? "Resume recurrence" : "Pause recurrence"}</button></div>}
            {recurrence.history.length > 0 && <div className="task-recurrence-history"><h5>Schedule history</h5><ol>{recurrence.history.map((entry) => <li key={entry.id}><p><strong>{stateLabel(entry.action)}</strong> · {entry.reason}{entry.occurredAt ? ` · ${new Date(entry.occurredAt).toLocaleString()}` : ""}</p><details><summary>Recorded rule details</summary><dl><div><dt>Before</dt><dd><code>{entry.before === null ? "No prior rule" : JSON.stringify(entry.before)}</code></dd></div><div><dt>After</dt><dd><code>{JSON.stringify(entry.after)}</code></dd></div></dl></details></li>)}</ol></div>}
          </>}
        </section>}
        {(detail.capabilities.requestExtension || (detail.extensions?.length ?? 0) > 0) && <section className="task-extensions" aria-label="Deadline extensions"><h4>Deadline extension requests</h4>
          {detail.capabilities.requestExtension && <form onSubmit={(event) => { event.preventDefault(); void mutate("/extension-requests", { expectedVersion: selected.version, proposedDate: extensionDate, approverAccountId: extensionApproverId, reason: extensionReason.trim() }, "Deadline extension requested."); }}><p>The current primary owner can ask a scoped manager or Owner to approve a later committed date.</p>{extensionApproversLoading && <p role="status">Loading eligible approvers…</p>}{extensionApproversError && <p role="alert">{extensionApproversError} <button type="button" onClick={() => setExtensionApproverRetry((count) => count + 1)}>Retry</button></p>}<label>Proposed new date<input type="date" min={selected.committedDueDate?.slice(0, 10)} value={extensionDate} onChange={(event) => setExtensionDate(event.target.value)} required /></label><label>Approver<select value={extensionApproverId} onChange={(event) => setExtensionApproverId(event.target.value)} required disabled={extensionApproversLoading || !!extensionApproversError || extensionApprovers.length === 0}><option value="">Choose an approver</option>{extensionApprovers.map((item) => <option key={item.accountId} value={item.accountId}>{item.name} · {item.kind === "OWNER" ? "Owner" : "Scoped manager"}</option>)}</select></label><label>Reason<input value={extensionReason} onChange={(event) => setExtensionReason(event.target.value)} minLength={3} maxLength={1000} required /></label><button type="submit" disabled={busy || extensionApproversLoading || !!extensionApproversError || extensionApprovers.length === 0 || !extensionDate || extensionDate <= (selected.committedDueDate?.slice(0, 10) ?? "") || !extensionApproverId || extensionReason.trim().length < 3}>Request extension</button></form>}
          {detail.extensions?.length ? <ol className="task-extension-list">{detail.extensions.map((item) => <li key={item.id}><p><strong>{stateLabel(item.state)}</strong> · {item.previousDate} → {item.proposedDate}</p><p>{item.reason}</p>{item.decision && <p>{stateLabel(item.decision.outcome)}: {item.decision.reason}</p>}{(item.canDecide || item.canWithdraw) && <div><label>{item.canDecide ? "Decision reason" : "Reason for withdrawing request"}<input value={extensionDecisionReason} onChange={(event) => setExtensionDecisionReason(event.target.value)} minLength={3} maxLength={1000} /></label><div className="task-actions">{item.canDecide && <><button type="button" disabled={busy || extensionDecisionReason.trim().length < 3} onClick={() => void mutate(`/extension-requests/${encodeURIComponent(item.id)}/decision`, { outcome: "APPROVED", reason: extensionDecisionReason.trim() }, "Deadline extension approved.")}>Approve extension</button><button type="button" disabled={busy || extensionDecisionReason.trim().length < 3} onClick={() => void mutate(`/extension-requests/${encodeURIComponent(item.id)}/decision`, { outcome: "REJECTED", reason: extensionDecisionReason.trim() }, "Deadline extension rejected.")}>Reject extension</button></>}{item.canWithdraw && <button type="button" disabled={busy || extensionDecisionReason.trim().length < 3} onClick={() => void mutate(`/extension-requests/${encodeURIComponent(item.id)}/withdraw`, { reason: extensionDecisionReason.trim() }, "Deadline extension request withdrawn.")}>Withdraw extension request</button>}</div></div>}</li>)}</ol> : <p>No extension requests yet.</p>}
        </section>}
        {selected.type === "CLOSEOUT" && detail.closeoutApproval && <section className="task-approval" aria-label="Closeout approval"><h4>Closeout approval</h4><p>{detail.closeoutApproval.revokedAt ? `Revoked · ${detail.closeoutApproval.revocationReason ?? "No reason provided"}` : `Approved · ${new Date(detail.closeoutApproval.approvedAt).toLocaleString()}`}</p><p><strong>Approved scope:</strong> {detail.closeoutApproval.workScope}</p>{detail.capabilities.revokeCloseout && !detail.closeoutApproval.revokedAt && <><label>Revocation reason<input aria-label="Revocation reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} /></label><button type="button" disabled={busy || reason.trim().length < 3} onClick={revokeCloseout}>Revoke closeout approval</button></>}</section>}
        {!registerMode && <>{(detail.capabilities.reassign || detail.capabilities.transition) && <label>Reason for change<input aria-label="Reason for change" value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} /></label>}</>}
        <TaskRegisterDisclosure enabled={registerMode} label="Pause work / record a blocker">{detail.capabilities.wait && selected.status === "IN_PROGRESS" && !selected.requiresReassignment && <form className="task-wait-form" aria-label="Wait on task" onSubmit={(event) => { event.preventDefault(); void mutate("/wait", { expectedVersion: selected.version, reason: waitReason.trim(), delayCause: delayCause.trim(), ...(responsibleParty.trim() ? { responsibleParty: responsibleParty.trim() } : {}) }, "Task moved to waiting."); }}><h4>Wait on this task</h4><label>Reason for waiting<input value={waitReason} onChange={(event) => setWaitReason(event.target.value)} minLength={3} maxLength={1000} required /></label><label>Delay cause<input value={delayCause} onChange={(event) => setDelayCause(event.target.value)} minLength={3} maxLength={1000} required /></label><label>Known responsible party (optional)<input list="task-responsible-parties" value={responsibleParty} onChange={(event) => setResponsibleParty(event.target.value)} maxLength={160} /><datalist id="task-responsible-parties">{setup?.employees.map((employee) => <option key={employee.id} value={employee.name} />)}</datalist></label><button type="submit" disabled={busy || waitReason.trim().length < 3 || delayCause.trim().length < 3 || responsibleParty.trim().length > 160}>{busy ? "Saving…" : "Move to waiting"}</button></form>}</TaskRegisterDisclosure>
        {!registerMode && <>{detail.capabilities.resume && selected.status === "WAITING" && !selected.requiresReassignment && <form className="task-wait-form" aria-label="Resume task" onSubmit={(event) => { event.preventDefault(); void mutate("/resume", { expectedVersion: selected.version, reason: resumeReason.trim() }, "Task resumed."); }}><h4>Resume work</h4><p>The task will return to In progress.</p><label>Reason for resuming<input value={resumeReason} onChange={(event) => setResumeReason(event.target.value)} minLength={3} maxLength={1000} required /></label><button type="submit" disabled={busy || resumeReason.trim().length < 3}>{busy ? "Saving…" : "Resume task"}</button></form>}</>}
        <TaskRegisterDisclosure enabled={registerMode} label="Reassign owner">{detail.capabilities.reassign && setup?.canAssign && <div className="task-change-owner"><h4>Reassign owner</h4>{registerMode && <label>Reason for reassignment<input value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={1000} /><span className="task-register-action-help">Enter at least 3 characters and choose a new owner.</span></label>}<label>New owner<select aria-label="New owner" value={reassignId} onChange={(event) => setReassignId(event.target.value)}><option value="">Choose an employee</option>{setup.employees.filter((employee) => employee.id !== selected.primaryOwnerEmployeeId).map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><button type="button" disabled={!reassignId || busy || reason.trim().length < 3} onClick={() => void mutate("/reassign", { newOwnerEmployeeId: reassignId, expectedVersion: selected.version, reason: reason.trim() }, "Task owner reassigned.")}>Reassign</button></div>}</TaskRegisterDisclosure>
        {!registerMode && <>{detail.capabilities.transition && selected.status === "IN_PROGRESS" && (selectedSubtasks?.completionBlocked || selected.reviewRequirement !== "NONE") && <p className="task-completion-help" role="status">{selectedSubtasks?.completionBlocked ? "Complete all subtasks before completing this task." : "Finish the required review before completing this task. Use the review actions above."}</p>}</>}
        {!registerMode && <>{detail.capabilities.transition && !selected.requiresReassignment && <div className="task-actions">{selected.status === "NOT_STARTED" && (detail.dependencies?.hasUnfinished ? <>{!confirmEarlyStart ? <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => setConfirmEarlyStart(true)}>Review early start</button> : <><p className="task-dependency-warning">Linked predecessor work is unfinished. Your start will be recorded as an early start.</p><button type="button" disabled={busy || reason.trim().length < 3} onClick={() => transition("IN_PROGRESS", true)}>Start anyway</button><button type="button" onClick={() => setConfirmEarlyStart(false)}>Cancel</button></>}</> : <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => transition("IN_PROGRESS")}>Start task</button>)}{selected.status === "IN_PROGRESS" && (selectedSubtasks?.completionBlocked ? <button type="button" disabled title="Complete this task after its subtasks are complete">Complete task</button> : <button type="button" disabled={busy || reason.trim().length < 3 || selected.reviewRequirement !== "NONE"} title={selected.reviewRequirement !== "NONE" ? "Complete this task through its required review workflow. Open internal review above." : undefined} onClick={() => transition("COMPLETED")}>Complete task</button>)}</div>}</>}
        {registerMode && <details className="task-register-technical"><summary>Technical details</summary><p>Task version {selected.version}</p></details>}
        {!personalOnly && <>{(detail.history.statusChanges.length > 0 || detail.history.ownerChanges.length > 0 || (detail.history.committedDateChanges?.length ?? 0) > 0) && <><h4>Task history</h4><ol className="task-history">{[...detail.history.statusChanges.map((event) => ({ ...event, kind: "status" as const })), ...detail.history.ownerChanges.map((event) => ({ ...event, kind: "owner" as const })), ...(detail.history.committedDateChanges ?? []).map((event) => ({ ...event, kind: "committed-date" as const }))].sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "")).map((event, index) => <li key={event.id ?? index}><span>{event.kind === "committed-date" ? `Committed due date ${event.oldDate ? `changed from ${event.oldDate.slice(0, 10)}` : "set"} to ${event.newDate.slice(0, 10)}: ${event.reason}` : event.reason ?? (event.toStatus ? `${stateLabel(event.fromStatus ?? "Created")} → ${stateLabel(event.toStatus)}` : event.kind === "owner" ? `Owner reassigned: ${setup?.employees.find((employee) => employee.id === event.oldOwnerEmployeeId)?.name ?? "Previous owner"} → ${setup?.employees.find((employee) => employee.id === event.newOwnerEmployeeId)?.name ?? "New owner"}` : event.action ?? "Task updated")}{event.occurredAt ? ` · ${new Date(event.occurredAt).toLocaleString()}` : ""}</span>{"delayCause" in event && event.delayCause && <span className="task-history-waiting">Delay cause: {event.delayCause}{event.responsibleParty ? ` · Responsible party: ${event.responsibleParty}` : ""}</span>}</li>)}</ol></>}</>}
      </> : <TaskEmptyState message="Select a task to see its details." showClearFilters={false} onClearFilters={() => {}} />}</article>;
  const leaveProjectTasks = (): boolean => {
    if (busy || creationPending.current) return false;
    if (showForm && !requestCreateClose()) return false;
    if (detailDraftDirtyRef.current && !window.confirm("Discard unsaved task changes?")) return false;
    createDraftDirtyRef.current = false; detailDraftDirtyRef.current = false; setShowForm(false);
    return leaveDrawerTask();
  };
  const leaveProjectRef = useRef(leaveProjectTasks);
  leaveProjectRef.current = leaveProjectTasks;
  useLayoutEffect(() => { if (!onLeaveGuard) return; onLeaveGuard(() => leaveProjectRef.current()); return () => onLeaveGuard(null); });
  useEffect(() => {
    if (!projectContext && !registerMode && !showForm && !uncertainCreation) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (busy || creationPending.current || uncertainCreation || showForm && createDraftDirtyRef.current || detailDraftDirtyRef.current) { event.preventDefault(); event.returnValue = ""; }
    };
    const navigate = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download") || isInPageAnchor(anchor)) return;
      if (!leaveProjectRef.current()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", navigate, true); };
  }, [projectContext?.id, registerMode, busy, showForm, uncertainCreation]);
  const drawerTaskId = selectedId || urlTaskId;
  const drawerIndex = visiblePage?.items.findIndex(task => task.id === drawerTaskId) ?? -1;
  const drawerItems = visiblePage?.items ?? [];
  const previousDrawerTask = drawerIndex >= 0 && drawerItems.length > 1 ? drawerItems[(drawerIndex - 1 + drawerItems.length) % drawerItems.length] : undefined;
  const nextDrawerTask = drawerIndex >= 0 && drawerItems.length > 1 ? drawerItems[(drawerIndex + 1) % drawerItems.length] : undefined;
  const drawerContext = selected?.projectId ? setup?.projects.find(project => project.id === selected.projectId)?.title ?? "Project task" : "No project";
  const drawerPlan = setup?.planItems.find(item => item.id === selected?.planItemId)?.label;
  const capacityWarning = overloadPrompt && <section className="task-overload-warning" role="alert" aria-label="Capacity warning"><h3>Capacity warning</h3><p>{overloadPrompt.message}</p><p>Assignment remains unchanged unless you acknowledge this warning.</p><button type="button" className="task-primary" disabled={busy} onClick={() => void acknowledgeOverload()}>Acknowledge and {overloadPrompt.kind === "create" ? overloadPrompt.parentId ? "create subtask" : "create task" : "reassign owner"}</button><button type="button" disabled={busy} onClick={() => setOverloadPrompt(undefined)}>Cancel assignment</button></section>;
  useLayoutEffect(() => {
    drawerHistoryRef.current = { taskId: drawerTaskId, url: window.location.href, state: window.history.state, canLeave: leaveDrawerTask };
  });
  /**
   * Organization-calendar "today" for the parity list. Uses the Overdue
   * metric's resolved cutoff, which the server derives from the organization
   * timezone — never the browser clock. If the cutoff has not resolved yet the
   * earliest target date on the page stands in so rows still group; the
   * `my-work-parity-page-note` line keeps the page boundary honest.
   */
  const parityToday = managementWork ? managementToday ?? "" : overdueCalendar.before ?? (visiblePage?.items ?? []).map((task) => task.targetDate.slice(0, 10)).sort()[0] ?? "";
  /** Open a parity row through the same guarded path the legacy rows use. */
  const openParityTask = useCallback((taskId: string) => {
    if ((personalOnly || projectContext || registerMode) && taskId !== selectedId && !leaveDrawerTask()) return;
    clearWaitingForm();
    if (listFirst) {
      const url = new URL(window.location.href); url.searchParams.set(taskUrlKey("taskId", projectContext), taskId);
      window.history.pushState({ taskWorkspaceSelection: true, taskWorkspaceView: view }, "", url);
      setUrlTaskId(taskId); setDetail(undefined);
    } else void load(taskId);
  }, [clearWaitingForm, leaveDrawerTask, listFirst, personalOnly, selectedId, view, projectContext?.id]);
  return <section ref={workspaceRef} onChangeCapture={event => { if (event.target instanceof HTMLElement && event.target.closest(".task-detail")) detailDraftDirtyRef.current = true; }} className={`task-workspace${registerMode ? " task-register" : ""}${listFirst ? " task-workspace-list-first" : ""}${personalOnly ? " task-workspace-personal" : ""}${listFirst && selectedId && !personalOnly ? " task-workspace-detail-active" : ""}${listFirst && selectedId && !personalOnly && view !== "list" ? " task-workspace-detail-with-view" : ""}${compact && desktop ? " is-compact" : ""}`} aria-labelledby="task-workspace-title">
    <header className="task-header"><div>{personalOnly ? <p className="my-work-kicker">Workspace / Tasks</p> : <p className="task-eyebrow">Work management</p>}{projectContext ? <h2 id="task-workspace-title">Tasks</h2> : <h1 id="task-workspace-title">{personalOnly ? "My work" : "Tasks"}</h1>}{!personalOnly && <p>{registerMode ? "Browse tasks across your authorized scope. Use My Work for your daily actions." : "Track your work, collaborators and progress."}</p>}</div><div className="task-header-actions">{!projectContext && setup?.projects.some((project) => project.status === "CANCELLED" && project.canApproveCloseout) && <button type="button" onClick={() => { setShowCloseoutForm((open) => !open); setShowForm(false); }}>{showCloseoutForm ? "Close closeout form" : "Approve closeout task"}</button>}{!personalOnly && createTaskControl}</div></header>
    {personalOnly && canOverseeWork && <section className="my-work-management" aria-label="Work scope">
      <div className="my-work-context-tabs" role="group" aria-label="My Work scope"><button type="button" aria-pressed={!managementWork} onClick={() => switchWorkScope("personal")}>My Work</button><button type="button" aria-pressed={managementWork} onClick={() => switchWorkScope("all")}>All teams</button></div>
      {managementWork && <><p>{owner ? "Organization work across all teams." : "All teams within your authorized reporting and project scope."} Select a team, then an employee to inspect their tasks.</p><div className="my-work-drilldown"><label>Team<select aria-label="Work team" value={filters.teamId} onChange={event => drillDown({ teamId: event.target.value, ownerEmployeeId: "" })}><option value="">All teams</option>{managementTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>Employee<select aria-label="Work employee" value={filters.ownerEmployeeId} onChange={event => drillDown({ ownerEmployeeId: event.target.value })}><option value="">All employees</option>{managementEmployees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label>Work phase<select aria-label="Management work phase" value={filters.phase} onChange={event => drillDown({ phase: event.target.value, status: "" })}><option value="active">Active</option><option value="waiting">Waiting</option><option value="review">In review / corrections</option><option value="completed">Completed</option><option value="">All phases</option></select></label></div><small>Task visibility and available actions follow current permissions. Team membership is the primary owner's current home team.</small></>}
    </section>}
    {personalOnly && !managementWork && <MyWorkTopCards filters={filters} actionCounts={actionCounts} selectedMetric={temporaryPhase} refreshVersion={summaryRevision} queueStale={pageStale} queueRefreshedAt={pageRefreshedAt} onSelect={selectWorkPhase} onOpenSources={openWorkSources} onOverdueCalendar={updateOverdueCalendar} onSessionExpired={onSessionExpired} showSelection={false} sitePresentation={siteSummaryPresentation} accountId={accountId} />}
    {personalOnly && !managementWork && personalObligations && <div className="my-work-obligations-first">{personalObligations({ employeeLessOwner: compactOwnerEmpty, onActionCounts: updateActionCounts, ...(sourceRequest ? { sourceRequest } : {}) })}</div>}
    {!personalOnly && !compactOwnerEmpty && (registerMode ? <div className="task-register-toolbar"><label>Task scope<select aria-label="Task scope" value={activeScopeOption} onChange={event => { if (!leaveDrawerTask()) return; clearWaitingForm(); setOffset(0); setScope(event.target.value as Scope); }}>{visibleScopeOptions.map(option => <option key={option.scope} value={option.scope}>{option.label}</option>)}</select></label><details className="task-register-display"><summary>View options</summary>{toolbar}</details></div> : toolbar)}
    {registerMode && <nav className="task-register-phases" aria-label="Task phase">{[["", "All tasks"], ["active", "Active"], ["waiting", "Waiting"], ["review", "In review"], ["completed", "Completed"]].map(([phase, label]) => <button key={label} type="button" aria-pressed={filters.phase === phase && !filters.status} onClick={() => { if (!leaveDrawerTask()) return; clearWaitingForm(); setDetail(undefined); setUrlTaskId(""); setOffset(0); const next = { ...filters, phase: phase!, status: "" }; setFilters(next); setDraftFilters(previous => ({ ...previous, phase: phase!, status: "" })); }}>{label}</button>)}</nav>}
    {listFirst && <>
      {personalOnly && <div className="my-work-queue-heading"><div><h3 ref={queueHeadingRef} tabIndex={-1}>Work queue</h3>{visiblePage && <p>{temporaryPhase === "attention" ? "Authorized tasks, reviews and decisions" : `${visiblePage.total} ${visiblePage.total === 1 ? "task" : "tasks"} · ${managementWork ? owner ? "Organization queue" : "Authorized team queue" : "Personal queue"}`}{pageStale ? " · Stale snapshot" : ""}</p>}</div><div className="my-work-queue-heading-actions">{createTaskControl}{!managementWork && <button type="button" className="my-work-customize" onClick={() => setPreferenceMode("customize")}><span aria-hidden="true">⚙</span> Customize</button>}</div></div>}
      <form className={`task-list-filters${personalOnly && searchExpanded ? " has-expanded-search" : ""}${FILTER_KEYS.some(key => draftFilters[key] !== filters[key]) || draftFilters.sort !== filters.sort ? " has-pending-filters" : ""}`} aria-label="Task filters" onSubmit={applyFilters}>
        <label className="task-search-control"><span className="task-search-label">Search tasks</span><svg className="task-search-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.2 4.2" /></svg><input aria-label="Search tasks" placeholder="Search tasks or projects" value={draftFilters.q} onFocus={() => setSearchExpanded(true)} onChange={(event) => setDraftFilters({ ...draftFilters, q: event.target.value })} maxLength={160} /></label>
        <details ref={filterDisclosureRef} className="task-secondary-filters" open={personalOnly ? filterOpen : undefined}><summary aria-label="Filters and sort" aria-expanded={personalOnly ? filterOpen : undefined} onClick={personalOnly ? event => { event.preventDefault(); toggleFilterPanel(); } : undefined}><svg className="task-filter-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10m-7 6h4" /></svg><span>Filters</span>{secondaryFilterCount > 0 && <span className="task-filter-count">{secondaryFilterCount} applied</span>}</summary><div className={personalOnly ? "task-filter-popover" : undefined} style={personalOnly ? filterPosition as CSSProperties : undefined} role={personalOnly ? "region" : undefined} aria-label={personalOnly ? "Filter My Work" : undefined}>{personalOnly && <header><h3>Filter My Work</h3><button type="button" aria-label="Close filters" onClick={() => closeFilterPanel(true)}>×</button></header>}<div className="task-secondary-filter-grid">
        <label>Project<select disabled={!!projectContext} aria-label="Filter by project" value={draftFilters.projectId} onChange={(event) => setDraftFilters({ ...draftFilters, projectId: event.target.value, planItemId: "" })}><option value="">All projects</option>{setup?.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label>Stage or milestone<select aria-label="Filter by stage or milestone" value={draftFilters.planItemId} onChange={(event) => setDraftFilters({ ...draftFilters, planItemId: event.target.value })}><option value="">All plan items</option>{(setup?.planItems ?? []).filter((item) => !draftFilters.projectId || item.projectId === draftFilters.projectId).map((item) => <option key={item.id} value={item.id}>{item.kind === "STAGE" ? "Stage" : "Milestone"} · {item.label}</option>)}</select></label>
        <TaskRefinementFields priorities={draftFilters.priorities} collaboratorEmployeeIds={draftFilters.collaboratorEmployeeIds} employees={setup?.employees ?? []} onChange={patch => setDraftFilters({ ...draftFilters, ...patch })} />
        <label>Primary owner<select aria-label="Filter by primary owner" value={draftFilters.ownerEmployeeId} onChange={(event) => setDraftFilters({ ...draftFilters, ownerEmployeeId: event.target.value })}><option value="">All owners</option>{(managementWork ? managementEmployees : setup?.employees)?.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
        <label>Status<select aria-label="Filter by status" value={draftFilters.status} onChange={(event) => setDraftFilters({ ...draftFilters, status: event.target.value })}><option value="">All statuses</option>{TASK_STATUSES.map((status) => <option key={status} value={status}>{stateLabel(status)}</option>)}</select></label>
        <label>{registerMode ? "Work phase" : "Phase"}<select aria-label="Filter by phase" value={draftFilters.phase} onChange={(event) => setDraftFilters({ ...draftFilters, phase: event.target.value })}><option value="">All phases</option><option value="active">Active</option><option value="waiting">Waiting</option><option value="review">Review</option><option value="completed">Completed</option></select></label>
        <label>Sort by<select aria-label="Sort tasks" disabled={personalOnly && temporaryPhase === "attention"} value={draftFilters.sort} onChange={(event) => setDraftFilters({ ...draftFilters, sort: event.target.value as TaskFilters["sort"] })}><option value="created_desc">Recently created</option><option value="target_asc">Target date · earliest first</option><option value="title_asc">Title · A to Z</option><option value="owner_asc">Primary owner · A to Z</option><option value="priority_desc">Priority · highest first, then Target</option></select></label>
        <label>Date basis<select aria-label="Filter date basis" value={draftFilters.dateBasis} onChange={(event) => setDraftFilters({ ...draftFilters, dateBasis: event.target.value })}><option value="">Choose date basis</option><option value="target">Target date</option><option value="committed">Committed date</option></select></label>
        <label>Date from<input aria-label="Filter date from" type="date" value={draftFilters.dateFrom} onChange={(event) => setDraftFilters({ ...draftFilters, dateFrom: event.target.value })} /></label>
        <label>Date through<input aria-label="Filter date through" type="date" value={draftFilters.dateTo} onChange={(event) => setDraftFilters({ ...draftFilters, dateTo: event.target.value })} /></label>
        </div>{personalOnly && filterOpen && <>{filterError && <p className="task-filter-error" role="alert">{filterError}</p>}{filterActions}</>}</div></details>
        {managementWork && <details className="task-display-options"><summary>Display and refresh</summary>{toolbar}</details>}{personalOnly && !managementWork && <><MyWorkQueuePreferences accountId={accountId} snapshot={queueSnapshot} defaults={{ filters: defaultFilters, view: "list", compact: false, temporaryPhase: "" }} mode={preferenceMode} onMode={setPreferenceMode} onApply={applyQueuePreferences} /><details ref={displayOptionsRef} className="task-display-options"><summary>More<span className="task-sr-only"> display and refresh options</span></summary><button type="button" className="my-work-mobile-customize" onClick={() => setPreferenceMode("customize")}>Customize view</button>{toolbar}<MyWorkPhaseSummary filters={filters} selectedPhase={temporaryPhase} refreshVersion={summaryRevision} queueStale={pageStale} queueRefreshedAt={pageRefreshedAt} onSelect={selectWorkPhase} onSessionExpired={onSessionExpired} includeAbout={false} /></details></>}
        {!filterOpen && filterError && <p className="task-filter-error" role="alert">{filterError}</p>}
        {(!personalOnly || !filterOpen) && filterActions}
        {registerMode && (FILTER_KEYS.some(key => draftFilters[key] !== filters[key]) || draftFilters.sort !== filters.sort) && <p className="task-register-filter-note" role="status">Filters changed. Choose Apply filters to update the list.</p>}
      </form>
      {(personalOnly || registerMode) && <MyWorkFilterChips items={appliedFilterItems} onRemove={removeAppliedFilter} onClear={resetFilters} />}
      {!personalOnly && paging}
      {personalOnly && <div className="my-work-queue-layoutbar"><span>{temporaryPhase === "attention" ? "Ordered by deadline, then priority" : visiblePage ? `${visiblePage.total} tasks` : "Tasks loading"}</span><label>Sort: <select aria-label="Queue sort" disabled={temporaryPhase === "attention"} value={filters.sort} onChange={event => { const sort = event.target.value as TaskFilters["sort"]; clearWaitingForm(); setOffset(0); setDetail(undefined); setFilters({ ...filters, sort }); setDraftFilters({ ...draftFilters, sort }); }}><option value="created_desc">Recently created</option><option value="target_asc">Nearest Target</option><option value="title_asc">Task name</option><option value="owner_asc">Primary owner</option><option value="priority_desc">Highest priority, then Target</option></select></label></div>}
      {personalOnly && <div className="my-work-status-legend" role="group" aria-label="Filter by task status colour"><strong>Status colours</strong><div>{["NOT_STARTED", "IN_PROGRESS", "IN_INTERNAL_REVIEW", "CORRECTIONS_REQUIRED", "WAITING", "COMPLETED"].map(status => <button type="button" key={status} className={`my-work-status-shortcut task-row-state-${status.toLowerCase()}`} aria-label={`Filter tasks: ${stateLabel(status)}`} aria-pressed={filters.status === status} onClick={() => { const next = { ...filters, status: filters.status === status ? "" : status, phase: "" }; clearWaitingForm(); if (temporaryPhase !== "attention") setTemporaryPhase(""); setDetail(undefined); setUrlTaskId(""); setOffset(0); setFilters(next); setDraftFilters(next); }}><i aria-hidden="true" />{stateLabel(status)}</button>)}</div><span>All statuses in Filters</span></div>}
    </>}
    {personalOnly && <MyWorkMetricFocus metric={temporaryPhase} total={visiblePage?.total} loading={loading} stale={pageStale} denied={denied} error={error} refreshedAt={pageRefreshedAt} overdueBefore={overdueCalendar.before} dateRangePaused={!!(filters.dateFrom || filters.dateTo)} onClear={() => selectWorkPhase("")} />}
    {notice && <p className="task-notice" role="status">{notice}</p>}{error && <p className="task-error" role="alert">{error}{pageStale && pageRefreshedAt ? ` Last successful refresh: ${new Date(pageRefreshedAt).toLocaleString()}.` : ""} <button type="button" onClick={refresh}>Reload</button></p>}
    {!showForm && (!personalOnly || !drawerTaskId) && capacityWarning}
    {showForm && <TaskCreateDialog title={creationHeading} variant={creationVariant} busy={busy} onRequestClose={requestCreateClose} footer={<><button type="button" disabled={busy} onClick={requestCreateClose}>Cancel</button><button type="submit" form="task-create-form" className="task-primary" disabled={busy || !!uncertainCreation || creationBlocked || !setup}>{busy ? "Creating…" : "Create task"}</button></>}>{error && <p role="alert" className="task-error">{error}</p>}{capacityWarning}{creationRecovery}<form noValidate id="task-create-form" className="task-form" onChangeCapture={() => { createDraftDirtyRef.current = true; }} onSubmit={(event) => void submit(event)} aria-label="Create task"><p>{requiresExplicitOwner ? "Choose the employee responsible for this task." : "This task is assigned to you unless you choose an authorized assignment."}</p>
      <TaskComposerFields validationAttempt={validationAttempt} draft={composerDraft} onChange={changeComposer} projects={setup?.projects ?? []} planItems={setup?.planItems ?? []} options={creation.options} optionsError={creation.error} retryOptions={creation.retry} compact={compactOptionalPlanning} busy={busy || !!uncertainCreation} {...(projectContext ? { fixedProject: projectContext } : {})} />
    </form></TaskCreateDialog>}
    {showCloseoutForm && <form className="task-form task-closeout-form" onSubmit={(event) => void createCloseout(event)} aria-label="Approve closeout task"><h3>Approve closeout task</h3><p>This creates separately identified work on a cancelled project and records your approval.</p><label>Cancelled project<select value={projectId} onChange={(event) => setProjectId(event.target.value)} required><option value="">Choose an eligible project</option>{setup?.projects.filter((project) => project.status === "CANCELLED" && project.canApproveCloseout).map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><label>Task name<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={160} required /></label><label>Approved work scope<textarea value={workScope} onChange={(event) => setWorkScope(event.target.value)} minLength={3} maxLength={2000} required rows={3} /></label><div className="task-form-grid"><label>Primary owner<select value={ownerId} onChange={(event) => setOwnerId(event.target.value)} required><option value="">Choose an eligible employee</option>{setup?.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value)}>{PRIORITIES.map((item) => <option key={item} value={item}>{stateLabel(item)}</option>)}</select></label><label>Target date<input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} required /></label></div><label>Reason for approval<input value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} required /></label><button type="submit" className="task-primary" disabled={busy || !projectId || !ownerId || workScope.trim().length < 3 || reason.trim().length < 3}>Create approved closeout task</button></form>}
    {personalOnly && !managementWork && <ActionableWork key={`attention-${accountId}`} accountId={accountId ?? ""} enabled={temporaryPhase === "attention"} filters={filters} refreshVersion={summaryRevision} onActionCounts={updateActionCounts} onSessionExpired={onSessionExpired} onOpenTask={openRelatedTask} onClear={() => selectWorkPhase("")} onClearTaskFilters={() => { const next = { ...defaultFilters, q: filters.q, projectId: filters.projectId }; setFilters(next); setDraftFilters(next); setOffset(0); }} />}
    {personalOnly && temporaryPhase === "attention" ? null : compactOwnerEmpty ? <section className="task-owner-empty"><h3>No personal tasks</h3><p>This Owner account is not linked to an employee. Open organization work to manage tasks.</p><a className="task-owner-empty-link" href="/tasks">Open organization work</a></section> : loading && (!personalOnly || !visiblePage) ? <p role="status">{visiblePage ? "Refreshing tasks…" : "Loading tasks…"}</p> : denied ? <p role="alert">You do not have access to these tasks.</p> : !visiblePage ? null : <>
    <div className={listFirst && view !== "list" ? `task-work-context${selected && !personalOnly ? " has-detail" : ""}` : undefined}>
    {listFirst && view === "cards" && <section className="task-cards" aria-label="Task cards"><h3>{taskListTitle} <span>Cards show the same filtered page.</span></h3>{visiblePage.items.length === 0 ? <TaskEmptyState message="No tasks match this scope and filters." showClearFilters={true} onClearFilters={resetFilters} /> : <ul className="task-card-grid">{visiblePage.items.map(task => <li key={task.id}>{renderTaskButton(task, " task-card-choice")}</li>)}</ul>}</section>}
    {listFirst && view === "board" && <section className="task-board" aria-label="Tasks grouped by status"><h3>Kanban <span>Counts show tasks on this page only.</span></h3><div className="task-board-columns">{TASK_STATUSES.map((status) => { const tasks = visiblePage.items.filter((task) => task.status === status); return <section className="task-board-column" key={status}><h4>{stateLabel(status)} <span>{tasks.length}</span></h4>{tasks.length ? tasks.map((task) => renderTaskButton(task, " task-board-card")) : <TaskEmptyState message="No tasks on this page." showClearFilters={true} onClearFilters={resetFilters} />}</section>; })}</div></section>}
    {listFirst && view === "timeline" && <section className="task-timeline" aria-label="Task dates timeline"><h3>Timeline <span>Recorded dates are shown separately; duration is not calculated.</span></h3>{visiblePage.items.length === 0 ? <TaskEmptyState message="No tasks on this page." showClearFilters={true} onClearFilters={resetFilters} /> : <ol>{visiblePage.items.map((task) => <li key={task.id}>{renderTaskButton(task, " task-timeline-task")}<dl><div><dt>Start date</dt><dd>{task.startDate?.slice(0, 10) ?? "Not set"}</dd></div><div><dt>Target date</dt><dd>{task.targetDate.slice(0, 10)}</dd></div><div><dt>Committed date</dt><dd>{task.committedDueDate?.slice(0, 10) ?? "Not committed"}</dd></div></dl></li>)}</ol>}</section>}
    {parityEnabled && view === "list" && visiblePage.items.length > 0 && <div className="my-work-parity-queue">
      <MyWorkParityList rows={parityRows} today={parityToday} groupBy={managementWork && !managementToday ? "priority" : "due"} selectedId={selectedId} loading={loading} {...(denied ? { error: "You do not have access to these tasks." } : {})} onOpenTask={openParityTask} />
      {managementWork && !managementToday && <p className="my-work-parity-page-note">Organization calendar unavailable or loading. Grouped by priority; overdue comparison is unavailable.</p>}
      <p className="my-work-parity-page-note">Grouping and &ldquo;Show more&rdquo; apply to this page only.</p>
    </div>}
    {(!listFirst || view === "list" || !!selected && !personalOnly) && <div className={`task-columns${listFirst && view === "list" && (!selected || personalOnly) ? " task-queue-no-selection" : ""}`}><nav className={`task-list${listFirst && view === "list" ? " task-queue-list" : ""}`} aria-label={taskListTitle}>{!(parityEnabled && view === "list") && <><h3>{taskListTitle}<span>{visiblePage.total}</span></h3>{listFirst && view === "list" && <div className="task-queue-header" aria-hidden="true"><span>Task</span><span>People · Primary owner</span><span>Priority</span><span>Status</span><span>Target</span><span>Committed</span><span>Next action</span></div>}</>}{visiblePage.items.length === 0 ? <TaskEmptyState message={managementWork ? "No authorized tasks match this team, employee and filters." : personalOnly ? employeeLessOwnerPersonal ? "This Owner account is not linked to an employee. Open organization work to manage tasks." : "No tasks are assigned to you or include you as a collaborator." : owner && scope !== "owned" && scope !== "created" && scope !== "collaborating" ? "No organization tasks match these filters." : scope === "mine" ? "No primary tasks match these filters." : scope === "owned" ? "No tasks are owned by you." : scope === "created" ? "No tasks were created by you that match these filters." : scope === "collaborating" ? "No tasks include you as a collaborator." : scope === "assigned" ? "No collaborating or managed tasks match these filters." : "No visible tasks match these filters."} showClearFilters={!employeeLessOwnerPersonal} onClearFilters={resetFilters} /> : !(parityEnabled && view === "list") && visiblePage.items.map((task) => renderTaskButton(task))}</nav>
      {!personalOnly && (!listFirst || selected) && taskDetailView}
    </div>}
    </div>
    </>}
    {personalOnly && !compactOwnerEmpty && temporaryPhase !== "attention" && <>
      {paging}
      {managementWork ? <p className="my-work-parity-page-note">Totals reflect authorized tasks matching these filters. Grouping applies to the current page; personal reviews and decisions remain in My Work.</p> : <MyWorkTaskCountInformation />}<a className="my-work-review-inbox-link" href="/reviews?scope=mine&queue=waiting">Assigned reviewer inbox</a><a className="my-work-decisions-link" href="/decisions">Authorized decisions</a>
    </>}
    {personalOnly && listFirst && drawerTaskId && !denied && <TaskDetailDrawer
      enabled taskId={drawerTaskId} title={selected?.title ?? "Task unavailable"} taskType={selected ? stateLabel(selected.type) : "Task"}
      contextLabel={selected ? `${drawerContext}${drawerPlan ? ` / ${drawerPlan}` : ""}` : ""}
      statusLabel={selected ? stateLabel(selected.status) : ""} priorityLabel={selected ? stateLabel(selected.priority) : ""}
      targetLabel={selected ? `Target ${selected.targetDate.slice(0, 10)}` : ""}
      waitingLabel={selected?.status === "WAITING" ? selected.waitingResponsibleParty ? `Waiting on ${selected.waitingResponsibleParty}` : "Waiting" : undefined}
      checklistCompleted={selected?.checklist.filter(item => item.checked).length ?? 0} checklistTotal={selected?.checklist.length ?? 0}
      overview={taskDetailView} checklist={taskChecklistContent} evidence={taskEvidenceContent} activity={taskActivityContent}
      onClose={closeTaskDrawer} busy={busy} loading={loading && !selected} hasActions={hasTaskCommands} hasData={!!selected}
      onPrevious={previousDrawerTask ? () => navigateDrawerTask(previousDrawerTask.id) : undefined}
      onNext={nextDrawerTask ? () => navigateDrawerTask(nextDrawerTask.id) : undefined}
      errors={error || capacityWarning ? <>{error && <>{error} <button type="button" onClick={refresh}>Reload</button></>}{capacityWarning}</> : undefined}
      feedback={notice ? <p className="task-notice" role="status">{notice}</p> : undefined}
      actions={<button type="button" className="task-detail-drawer__close-footer" onClick={closeTaskDrawer}>Back to task list</button>}
    />}
  </section>;
}

function TaskRegisterDisclosure({ enabled, label, children }: { enabled: boolean; label: string; children: ReactNode }): React.JSX.Element {
  if (!children) return <></>;
  return enabled ? <details className="task-register-manage"><summary>{label}</summary>{children}</details> : <>{children}</>;
}
function registerDate(value: string): string {
  const day = value.slice(0, 10);
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}
