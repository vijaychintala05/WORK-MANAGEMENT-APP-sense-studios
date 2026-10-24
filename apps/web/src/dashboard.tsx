import { workDate, workState } from "./work-labels";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, useDroppable, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import "./dashboard.css";
import "./dashboard-widgets.css";
import "./dashboard-data.css";
import { DashboardDataIcon, DashboardTaskMix, DashboardProjectOverview } from "./dashboard-data-visuals.js";
import {
  WIDGET_INFO,
  type WidgetId, type DashboardLayout, type LayoutMode,
  loadLayout, saveLayout, defaultLayoutFor,
} from "./dashboard-widgets.js";

import { DashboardTimeWidget } from "./dashboard-time-widget.js";
import { DashboardPerformanceWidget, type DashboardPerformanceContext } from "./dashboard-performance-widget.js";

const API = "/api/v1";
class DashboardReadError extends Error { constructor(message: string, readonly status: number) { super(message); } }
type Cell = string | number | null;
type DashRow = { id: string; label: string; status?: string; date?: string; value?: string | number; route?: string; score?: number | null; scoreScale?: { min: number; max: number } };
type Section = { key: string; label: string; rows: DashRow[]; unavailable?: string };
type Dash = { today: string | null; role: string };
type DashboardSource = "tasks" | "decisions" | "health" | "performance" | "workload" | "site" | "training";
type DashboardSourceResult = { source: DashboardSource; today: string; readCompletedAt: string; sections: Section[]; decisions?: { items: unknown[]; nextCursor: string | null } };
type DashboardSourceState = { readCompletedAt: string | null; sections: Section[]; decisions?: { items: unknown[]; nextCursor?: string | null }; error?: string; loading?: boolean; denied?: boolean };
const dashboardSourceNames: DashboardSource[] = ["tasks", "decisions", "health", "performance", "workload", "site", "training"];
const sourceLabels: Record<DashboardSource, string> = { tasks: "Tasks and attention", decisions: "Decision center", health: "Project health and risks", performance: "Employee and Team Leader performance", workload: "Workload and leave", site: "Project site", training: "Training and improvement" };
type Category = { key: string; label: string };
type Context = { categories: Category[]; eventNames?: Category[]; owner: boolean };
type Preview = { title: string; category: string; from: string; to: string; generatedAt: string; columns: Array<{ key: string; label: string }>; rows: Array<Record<string, Cell>>; unavailable: string[] };
type ReportTable = Omit<Preview, "generatedAt"> & { generatedAt?: string };
type Snapshot = { id: string; category?: string; from?: string; to?: string; title?: string; createdAt?: string; correctedById?: string | null; correctsId?: string | null; reason?: string; [key: string]: unknown };
type Schedules = { rules: Array<Record<string, unknown> & { id?: string; kind?: string; enabled?: boolean }> };
type Reminders = { reminders: Array<Record<string, unknown> & { id?: string; title?: string; dueAt?: string; reason?: string }> };
type SummarySection = { key: string; label: string; rows: DashRow[]; unavailable?: string };
type ScheduledSummary = { id: string; createdAt: string; sourceId: string; slot: string; summary: { kind: string; from?: string; to?: string; generatedAt: string; sections: SummarySection[] } };
type Summaries = { summaries: ScheduledSummary[] };
const cmd = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

async function request<T>(path: string, csrf: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) { headers.set("Content-Type", "application/json"); headers.set("X-CSRF-Token", csrf); }
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: "include", cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { message?: string; error?: { message?: string } };
  if (!response.ok) throw new DashboardReadError(body.error?.message ?? body.message ?? `Request failed (${response.status})`, response.status);
  return body as T;
}
const format = (v: unknown) => v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
const dateLabel = (v: string | undefined) => v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v ?? "";
const dateRangeOkay = (from: string, to: string) => Boolean(from && to && from <= to);

function HealthScore({ row }: { row: DashRow }): React.JSX.Element {
  const scale = row.scoreScale;
  const hasScale = scale && Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.max > scale.min;
  return <span className="dashboard-health-meter">Health score {row.score} · {hasScale ? `Scale ${scale.min}–${scale.max}` : "Scale unavailable"}</span>;
}

/* V10 widget eligibility — computed from the live authorized source
   catalog, not from a demo capability array. A widget is permitted
   when its backing source is authorized and readable (loaded or
   intentionally empty), not when the account is hard-denied. Saved
   layout IDs are always re-checked against this catalog before use
   (V10 §I.8). */
function permittedWidgetIds(
  sourceData: Partial<Record<DashboardSource, DashboardSourceState>>,
  canSeePerformance: boolean,
): WidgetId[] {
  const permitted: WidgetId[] = ["time", "projects", "nextAction"];
  const d = sourceData.decisions;
  if (d && !d.denied) permitted.push("decisions");
  if (canSeePerformance && !sourceData.performance?.denied) permitted.push("performance");
  if (sourceData.site && !sourceData.site.denied) permitted.push("site");
  if (sourceData.workload && !sourceData.workload.denied) permitted.push("workload");
  if (sourceData.training && !sourceData.training.denied) permitted.push("training");
  if (sourceData.health && !sourceData.health.denied) permitted.push("health");
  if (sourceData.tasks && !sourceData.tasks.denied) permitted.push("signals", "shortcuts");
  return permitted;
}

/* Draggable widget wrapper: dnd-kit sortable behaviour plus the V10
   edit-mode chrome (hide, drag handle, keyboard move controls). */
function SortableWidget({
  id, editing, onHide, onMoveUp, onMoveDown, onMoveAcross, canMoveUp, canMoveDown, canMoveAcross, children,
}: {
  id: string; editing: boolean;
  onHide: (id: string) => void; onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void; onMoveAcross: (id: string) => void;
  canMoveUp: boolean; canMoveDown: boolean; canMoveAcross: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { transform, transition, isDragging, attributes, listeners, setNodeRef, setActivatorNodeRef } = useSortable({ id, disabled: !editing });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const info = WIDGET_INFO[id as WidgetId];
  return (
    <section ref={setNodeRef} data-widget-id={id} data-widget={id} className={`dv-widget${isDragging ? " is-dragging" : ""}${editing ? " is-editing" : ""}`} style={style}>
      <div className="dv-widget-head">
        <div className="dv-widget-heading"><span className="dv-widget-mark"><DashboardDataIcon name={id} /></span><div><h3>{info?.label ?? id}</h3><p>{info?.desc ?? ""}</p></div></div>
        {editing && (
          <div className="dv-widget-tools">
            <button type="button" className="dv-edit-hbtn" title="Hide widget" aria-label={`Hide ${info?.label ?? id} widget`} onClick={() => onHide(id)}>−</button>
            <button ref={setActivatorNodeRef} type="button" className="dv-drag-handle" {...attributes} aria-label={`Drag to move ${info?.label ?? id}`} title="Drag to rearrange" {...listeners}>
              <span className="dv-drag-dots" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
              <span>{info?.label ?? id}</span>
            </button>
            <button type="button" className="dv-edit-hbtn" title="Move up" aria-label={`Move ${info?.label ?? id} up`} disabled={!canMoveUp} onClick={() => onMoveUp(id)}>↑</button>
            <button type="button" className="dv-edit-hbtn" title="Move down" aria-label={`Move ${info?.label ?? id} down`} disabled={!canMoveDown} onClick={() => onMoveDown(id)}>↓</button>
            {canMoveAcross && <button type="button" className="dv-edit-hbtn" title="Move to other column" aria-label={`Move ${info?.label ?? id} to other column`} onClick={() => onMoveAcross(id)}>⇄</button>}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

function WidgetLane({ id, droppable, children }: { id: string; droppable: boolean; children: React.ReactNode }): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  return <div ref={setNodeRef} className={`dv-widget-col${droppable && isOver ? " is-over" : ""}`}>{children}</div>;
}

export function DashboardWorkspace({ csrfToken, accountId, owner, initialTab = "dashboard", focused = false }: { csrfToken: string; accountId: string; owner: boolean; initialTab?: "dashboard" | "summaries" | "reports" | "schedules"; focused?: boolean }): React.JSX.Element {
  const [tab, setTab] = useState<"dashboard" | "summaries" | "reports" | "schedules">(initialTab);
  const [dash, setDash] = useState<Dash>({ today: null, role: owner ? "Owner account" : "Staff account" });
  const [sourceData, setSourceData] = useState<Partial<Record<DashboardSource, DashboardSourceState>>>({});
  const [context, setContext] = useState<Context | null>(null);
  const [schedules, setSchedules] = useState<Schedules | null>(null);
  const [reminders, setReminders] = useState<Reminders | null>(null);
  const [summaries, setSummaries] = useState<ScheduledSummary[]>([]);
  const [selectedSummaryId, setSelectedSummaryId] = useState("");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Snapshot | null>(null);
  const [selectedTable, setSelectedTable] = useState<ReportTable | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("");
  const [correctsId, setCorrectsId] = useState("");
  const commandRef = useRef<{ signature: string; id: string } | null>(null);
  const sourceRequestIds = useRef(new Map<DashboardSource, number>());
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDue, setReminderDue] = useState("");
  const [reminderReason, setReminderReason] = useState("");
  const [ruleKind, setRuleKind] = useState<"TASK_REMINDER" | "SUMMARY" | "EVENT_NOTICE">("TASK_REMINDER");
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [ruleTime, setRuleTime] = useState("");
  const [timezone, setTimezone] = useState("");
  const [audience, setAudience] = useState<"SELF" | "OWNER" | "EMPLOYEE" | "MANAGER">("SELF");
  const [ruleReason, setRuleReason] = useState("");
  const [summaryKind, setSummaryKind] = useState("MORNING");
  const [weekdays, setWeekdays] = useState("");
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [offsetDays, setOffsetDays] = useState("");
  const [priority, setPriority] = useState("");
  const [projectId, setProjectId] = useState("");
  const [critical, setCritical] = useState(false);
  const [mandatory, setMandatory] = useState(false);
  const [eventNamesText, setEventNamesText] = useState("");
  const [editingRule, setEditingRule] = useState<{ id: string; version: number } | null>(null);

  const loadSource = useCallback(async (source: DashboardSource): Promise<void> => {
    const requestId = (sourceRequestIds.current.get(source) ?? 0) + 1;
    sourceRequestIds.current.set(source, requestId);
    setSourceData(current => ({ ...current, [source]: { readCompletedAt: null, sections: [], ...(source === "decisions" ? { decisions: { items: [], nextCursor: null } } : {}), loading: true } }));
    try {
      const result = await request<DashboardSourceResult>(`/dashboard/sources/${source}`, csrfToken);
      if (result.source !== source || !Array.isArray(result.sections) || typeof result.readCompletedAt !== "string" || typeof result.today !== "string" || source === "decisions" && !result.decisions) throw new Error("The source response was incomplete.");
      if (sourceRequestIds.current.get(source) !== requestId) return;
      setSourceData(current => ({ ...current, [source]: { readCompletedAt: result.readCompletedAt, sections: result.sections, ...(result.decisions ? { decisions: result.decisions } : {}), loading: false } }));
      setDash(current => ({ ...current, today: result.today }));
    } catch (cause) {
      if (sourceRequestIds.current.get(source) === requestId) setSourceData(current => ({ ...current, [source]: { readCompletedAt: null, sections: [], ...(source === "decisions" ? { decisions: { items: [], nextCursor: null } } : {}), loading: false, denied: cause instanceof DashboardReadError && [401, 403].includes(cause.status), error: cause instanceof Error ? cause.message : "This source could not be read." } }));
    }
  }, [csrfToken]);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setError("");
    for (const source of dashboardSourceNames) void loadSource(source);
    try {
      const [c, s, r, scheduled, h] = await Promise.all([
        request<Context>("/reports/context", csrfToken),
        owner ? request<Schedules>("/dashboard/schedules", csrfToken) : Promise.resolve({ rules: [] }), request<Reminders>("/dashboard/reminders", csrfToken), request<Summaries>("/dashboard/summaries", csrfToken),
        request<{ snapshots?: Snapshot[]; items?: Snapshot[] }>("/reports/snapshots", csrfToken),
      ]);
      setContext(c); setSchedules(s); setReminders(r); setSummaries(scheduled.summaries); setSelectedSummaryId(current => current && scheduled.summaries.some(item => item.id === current) ? current : scheduled.summaries[0]?.id ?? ""); setSnapshots(h.snapshots ?? h.items ?? []);
      setCategory(current => current || c.categories[0]?.key || "");
    } catch (cause) { setSummaries([]); setSelectedSummaryId(""); setError(cause instanceof Error ? cause.message : "Dashboard supporting data could not be loaded."); }
    finally { if (initial) setLoading(false); }
  }, [csrfToken, loadSource, owner]);
  useEffect(() => { void load(true); }, [load]);

  const mutate = async (path: string, payload: Record<string, unknown>, refresh = true): Promise<void> => {
    setBusy(true); setError(""); setNotice("");
    try {
      const signature = `${path}:${JSON.stringify(payload)}`;
      if (commandRef.current?.signature !== signature) commandRef.current = { signature, id: cmd() };
      await request(path, csrfToken, { method: "POST", body: JSON.stringify({ ...payload, commandId: commandRef.current.id }) });
      commandRef.current = null;
      if (refresh) await load();
      setNotice("Saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The action could not be completed."); }
    finally { setBusy(false); }
  };
  const makePreview = async () => {
    setBusy(true); setError(""); setNotice("");
    try { const result = await request<Preview>("/reports/preview", csrfToken, { method: "POST", body: JSON.stringify({ category, from, to }) }); setPreview(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The report preview could not be created."); }
    finally { setBusy(false); }
  };
  const saveSnapshot = async () => {
    if (!preview || !reason.trim()) return;
    await mutate("/reports/snapshots", { category: preview.category, from: preview.from, to: preview.to, reason: reason.trim(), ...(correctsId ? { correctsId } : {}) });
    setReason(""); setCorrectsId("");
    const history = await request<{ snapshots?: Snapshot[]; items?: Snapshot[] }>("/reports/snapshots", csrfToken).catch((): { snapshots?: Snapshot[]; items?: Snapshot[] } => ({}));
    setSnapshots(history.snapshots ?? history.items ?? []);
  };
  const openSnapshot = async (id: string) => {
    setBusy(true); setError("");
    try { const result = await request<{ snapshot: Snapshot; table: ReportTable }>(`/reports/snapshots/${encodeURIComponent(id)}`, csrfToken); setSelectedSnapshot(result.snapshot); setSelectedTable(result.table); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The frozen report could not be loaded."); }
    finally { setBusy(false); }
  };
  const download = (url: string) => { window.location.assign(url); };

  const isOwner = owner && Boolean(context?.owner);
  const selectedSummary = summaries.find(item => item.id === selectedSummaryId) ?? null;
  const weekdayValues = weekdays.trim() ? weekdays.split(",").map(day => Number(day.trim())) : [];
  const eventNames = eventNamesText.split(",").map(name => name.trim()).filter(Boolean);
  const validEventNames = !context?.eventNames || eventNames.every(name => context.eventNames!.some(item => item.key === name));
  const organizationDateLabel = dash.today ?? (dashboardSourceNames.every(source => sourceData[source] && !sourceData[source]?.loading) ? "Unavailable" : "Loading…");
  const scheduleValid = Boolean(ruleTime && timezone.trim() && ruleReason.trim().length >= 3
    && (!weekdays.trim() || weekdayValues.every(day => Number.isInteger(day) && day >= 0 && day <= 6))
    && (!dayOfMonth || Number.isInteger(Number(dayOfMonth)) && Number(dayOfMonth) >= 1 && Number(dayOfMonth) <= 31)
    && (ruleKind !== "TASK_REMINDER" || !offsetDays || Number.isInteger(Number(offsetDays)) && Number(offsetDays) >= -366 && Number(offsetDays) <= 366)
    && (ruleKind !== "TASK_REMINDER" || offsetDays.trim())
    && (ruleKind !== "SUMMARY" || summaryKind !== "WEEKLY" || weekdayValues.length > 0)
    && (ruleKind !== "SUMMARY" || summaryKind !== "MONTHLY" || dayOfMonth.trim())
    && (ruleKind !== "EVENT_NOTICE" || eventNames.length > 0 && validEventNames));

  // Counts belong to their exact authorized source and section. Overlapping
  // sections are not a unique work total; unavailable reads are not empty.
  const healthRows = useMemo(() => {
    const state = sourceData.health;
    if (!state || state.loading || state.error) return [];
    return state.sections.filter(section => !section.unavailable).flatMap(s => s.rows);
  }, [sourceData.health]);
  const tasksState = sourceData.tasks;
  const healthState = sourceData.health;
  const decisionsState = sourceData.decisions;
  const taskSectionNote = (key: string): string | null => !tasksState || tasksState.loading ? "Reading task source…"
    : tasksState.error ? "Task source unavailable."
      : tasksState.sections.find(section => section.key === key)?.unavailable
        ?? (tasksState.sections.some(section => section.key === key) ? null : "This task summary is unavailable.");
  const taskSectionCount = (key: string): string => !tasksState || tasksState.loading ? "Loading…"
    : taskSectionNote(key) ? "Unavailable" : String(tasksState.sections.find(section => section.key === key)!.rows.length);
  const taskAttentionRows = tasksState?.sections.find(s => s.key === "attention")?.rows ?? [];

  const kpiTiles = [
    { key: "overdue", label: "Overdue", value: taskSectionCount("overdue"), route: "/tasks", sub: "Past due and incomplete" },
    { key: "today", label: "Due today", value: taskSectionCount("today"), route: "/tasks", sub: "Committed date when present, otherwise Target" },
    { key: "priority", label: "High priority", value: taskSectionCount("priority"), route: "/tasks", sub: "High and critical priority" },
    { key: "waiting", label: "Waiting / blocked", value: taskSectionCount("waiting"), route: "/tasks", sub: "Waiting state and blockers" },
    { key: "reviews", label: "Review / corrections", value: taskSectionCount("reviews"), route: "/tasks", sub: "Task states only" },
  ];

  const kind: "OWNER" | "STAFF" = owner ? "OWNER" : "STAFF";
  const [perfContext, setPerfContext] = useState<DashboardPerformanceContext | null>(null);
  const [accessRefresh, setAccessRefresh] = useState(0);
  useEffect(() => {
    let active = true; setPerfContext(null);
    void request<DashboardPerformanceContext>("/performance/context", csrfToken)
      .then(value => { if (active && Array.isArray(value.employees)) setPerfContext(value); }).catch(() => { if (active) setPerfContext(null); });
    return () => { active = false; };
  }, [csrfToken, accessRefresh]);
  const canSeePerformance = Boolean(perfContext && ((owner && perfContext.owner) || perfContext.employees.some(employee => employee.canManage && employee.id !== perfContext.employeeId)));
  const canSeeSite = Boolean(sourceData.site && !sourceData.site.denied && sourceData.site.sections.some(section => section.rows.length));
  const permitted = useMemo(() => permittedWidgetIds(sourceData, canSeePerformance), [sourceData, canSeePerformance]);
  const [mode, setMode] = useState<LayoutMode>(() => window.innerWidth <= 760 ? "mobile" : "desktop");
  useEffect(() => { const resize = () => setMode(window.innerWidth <= 760 ? "mobile" : "desktop"); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const [layout, setLayout] = useState<DashboardLayout>(() => loadLayout(accountId, kind, permitted, canSeePerformance, canSeeSite, mode));
  const [editing, setEditing] = useState(false), [galleryOpen, setGalleryOpen] = useState(false), [queueExpanded, setQueueExpanded] = useState(false);
  const [layoutNotice, setLayoutNotice] = useState("");
  const visitLayouts = useRef(new Map<string, DashboardLayout>());
  const visitLayoutKey = `${accountId}:${mode}`;
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setLayout(visitLayouts.current.get(visitLayoutKey) ?? loadLayout(accountId, kind, permitted, canSeePerformance, canSeeSite, mode)); }, [accountId, kind, permitted, canSeePerformance, canSeeSite, mode, visitLayoutKey]);
  const [reviewInbox, setReviewInbox] = useState<{ total: number; items: Array<{ roundId: string; taskId: string; taskTitle: string; projectTitle: string; roundNumber: number; status: string; dueDate: string; revisionLabel?: string }> } | null>(null);
  const [reviewError, setReviewError] = useState("");
  useEffect(() => { let active = true; setReviewInbox(null); setReviewError("");
    void request<NonNullable<typeof reviewInbox>>("/reviews/inbox?limit=5", csrfToken).then(value => { if (active && Array.isArray(value.items)) setReviewInbox(value); }).catch(cause => { if (active) setReviewError(cause instanceof Error ? cause.message : "Review source unavailable"); });
    return () => { active = false; };
  }, [csrfToken, accessRefresh]);
  const cancelLongPress = () => { if (longPress.current) clearTimeout(longPress.current); longPress.current = null; };
  useEffect(() => () => { if (longPress.current) clearTimeout(longPress.current); }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const updateLayout = (next: DashboardLayout): void => {
    // Resolve the device key from the current window size (not the render-time
    // `mode` closure) so a resize between drag-end and the layout write cannot
    // persist this layout under the wrong device preset.
    const currentMode: LayoutMode = window.innerWidth <= 760 ? "mobile" : "desktop";
    visitLayouts.current.set(`${accountId}:${currentMode}`, next);
    setLayout(next);
    setLayoutNotice(saveLayout(accountId, next, currentMode) ? "Layout saved on this device." : "Layout changed for this visit; browser storage is unavailable.");
  };
  const hideWidget = (id: string): void => {
    const wid = id as WidgetId;
    updateLayout({ ...layout, hidden: [...layout.hidden, wid], leftOrder: layout.leftOrder.filter(w => w !== wid), rightOrder: layout.rightOrder.filter(w => w !== wid) });
  };
  const addWidget = (id: string): void => {
    const wid = id as WidgetId;
    updateLayout({ ...layout, hidden: layout.hidden.filter(w => w !== wid), leftOrder: [...layout.leftOrder, wid] });
  };
  const resetToDefaults = (): void => { updateLayout(defaultLayoutFor(kind, permitted, canSeePerformance, canSeeSite, mode)); setGalleryOpen(false); };
  const moveWithin = (id: string, direction: "up" | "down" | "across"): void => {
    const wid = id as WidgetId;
    const lane: "leftOrder" | "rightOrder" = layout.leftOrder.includes(wid) ? "leftOrder" : "rightOrder";
    if (direction === "across") {
      const target = lane === "leftOrder" ? "rightOrder" : "leftOrder";
      updateLayout({ ...layout, [lane]: layout[lane].filter(w => w !== wid), [target]: [...layout[target], wid] });
      return;
    }
    const current = layout[lane];
    const idx = current.indexOf(wid);
    if (idx === -1) return;
    updateLayout({ ...layout, [lane]: arrayMove(current, idx, direction === "up" ? idx - 1 : idx + 1) });
  };
  const visibleLeft = layout.leftOrder.filter(id => !layout.hidden.includes(id as WidgetId) && permitted.includes(id as WidgetId));
  const visibleRight = layout.rightOrder.filter(id => !layout.hidden.includes(id as WidgetId) && permitted.includes(id as WidgetId));
  const availableGallery = permitted.filter(id => !visibleLeft.includes(id) && !visibleRight.includes(id));

  /* Attention queue: one row per unique task across the overlapping
     task buckets (overdue, waiting, priority, attention, today). A
     task may appear in several buckets — intentional; rows are
     de-duplicated by task id. Show 2 initially, expandable. */
  const attentionBaseRows = useMemo(() => {
    if (!tasksState || tasksState.loading || tasksState.error) return [];
    const seen = new Set<string>();
    const rows: DashRow[] = [];
    for (const key of ["overdue", "waiting", "priority", "attention", "reviews", "today"]) {
      const section = tasksState.sections.find(s => s.key === key);
      for (const row of section?.unavailable ? [] : section?.rows ?? []) {
        if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
      }
    }
    return rows;
  }, [tasksState]);
  const attentionRows = queueExpanded ? attentionBaseRows : attentionBaseRows.slice(0, 2);
  const queueIncomplete = Boolean(tasksState && !tasksState.loading && !tasksState.error && ["overdue", "waiting", "priority", "attention", "reviews", "today"].some(key => !tasksState.sections.some(section => section.key === key && !section.unavailable)));

  // Commit once on drop. Updating lane order during collision measurement can
  // move the collision target beneath the pointer and recursively reorder it.
  const commitDrag = (event: DragEndEvent): void => {
    const from = String(event.active.id), to = event.over ? String(event.over.id) : undefined;
    if (!to || from === to) return;
    if (mode === "mobile" && to === "lane-right") return;
    const fromId = from as WidgetId, toId = to as WidgetId;
    if (to === "lane-left" || to === "lane-right") {
      const source = layout.leftOrder.includes(fromId) ? "leftOrder" : "rightOrder";
      const target = to === "lane-left" ? "leftOrder" : "rightOrder";
      if (source !== target && layout[source].includes(fromId)) updateLayout({ ...layout, [source]: layout[source].filter(id => id !== fromId), [target]: [...layout[target], fromId] });
      return;
    }
    const fLane: "leftOrder" | "rightOrder" = visibleLeft.includes(fromId) ? "leftOrder" : "rightOrder";
    const tLane: "leftOrder" | "rightOrder" = visibleRight.includes(toId) ? "rightOrder" : "leftOrder";
    if (fLane !== tLane) {
      const fItems = [...layout[fLane]], tItems = [...layout[tLane]];
      const fi = fItems.indexOf(fromId), ti = tItems.indexOf(toId);
      if (fi === -1 || ti === -1) return;
      const [moved] = fItems.splice(fi, 1);
      if (!moved) return;
      tItems.splice(ti, 0, moved);
      updateLayout({ ...layout, [fLane]: fItems, [tLane]: tItems });
      return;
    }
    const items = [...layout[fLane]];
    const fi = items.indexOf(fromId), ti = items.indexOf(toId);
    if (fi === -1 || ti === -1) return;
    updateLayout({ ...layout, [fLane]: arrayMove(items, fi, ti) });
  };

  const renderSourceWidget = (source: DashboardSource): React.JSX.Element => {
    const state = sourceData[source];
    return <div className="dv-widget-body">{!state || state.loading ? <p role="status">Reading {sourceLabels[source].toLowerCase()}…</p> : state.error ? <div className="dv-source-error" role="alert"><strong>{state.error}</strong><button type="button" onClick={() => void loadSource(source)}>Retry {sourceLabels[source].toLowerCase()}</button></div> : <>{state.sections.map(section => <div key={section.key}><h4>{section.label}</h4>{section.unavailable ? <p>{section.unavailable}</p> : section.rows.length ? section.rows.slice(0, 5).map(row => <div className="dv-site-row" key={row.id}><div className="dv-site-main"><strong>{row.label}</strong><small>{[row.status, row.date, row.value].filter(v => v !== undefined && v !== null).join(" · ")}</small>{typeof row.score === "number" && Number.isFinite(row.score) && <HealthScore row={row} />}{row.route && <Link to={row.route}>Open →</Link>}</div></div>) : <p>No current items.</p>}</div>)}{!state.sections.length && <p>No current items.</p>}<div className="dv-widget-foot">Read at {state.readCompletedAt ? new Date(state.readCompletedAt).toLocaleString() : "Unavailable"}</div></>}</div>;
  };
  const renderWidget = (id: WidgetId): React.JSX.Element | null => {
    switch (id) {
      case "time": return <DashboardTimeWidget csrfToken={csrfToken} refreshVersion={accessRefresh} />;
      case "decisions":
        return (
          <div className="dv-widget-body">
            {decisionsState?.loading ? <div className="dv-source-loading">Reading decisions…</div>
              : decisionsState?.error ? <div className="dv-source-error"><strong>Decision source unavailable</strong><button type="button" onClick={() => void loadSource("decisions")}>Retry</button></div>
              : (
                <>
                  <div className="dv-decisions-summary">
                    <div className="dv-decisions-chip"><strong>{(sourceData.decisions?.decisions?.items ?? []).length}</strong><span className="dv-decisions-chip-label">Approval requests</span></div>
                    <div className="dv-decisions-chip review"><strong>{taskSectionCount("reviews")}</strong><span className="dv-decisions-chip-label">Task reviews</span></div>
                  </div>
                  <div className="dv-decisions-section-label">Approval obligations</div>
                  {(sourceData.decisions?.decisions?.items ?? []).slice(0, 3).map((item, i) => {
                    const row = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
                    const route = typeof row.route === "string" ? row.route : "/decisions";
                    return (
                      <Link key={String(row.id ?? i)} to={route} className="dv-attention-row">
                        <span className="dv-attention-stripe default" aria-hidden="true"></span>
                        <div className="dv-attention-main">
                          <div className="dv-attention-title">{String(row.title ?? row.label ?? "Decision")}</div>
                          <div className="dv-attention-meta">{[row.requesterLabel, row.levelLabel].filter(Boolean).join(" · ")}</div>
                        </div>
                      </Link>
                    );
                  })}
                  {(sourceData.decisions?.decisions?.items ?? []).length === 0 && <div className="dv-source-loading">No approval obligations in this source.</div>}
                  {reviewInbox ? (
                    <div className="dv-review-rounds">
                      <div className="dv-review-rounds-head">
                        <strong>Assigned review rounds</strong>
                        <span>{reviewInbox.total} total</span>
                      </div>
                      {reviewInbox.items.length > 0 ? reviewInbox.items.map(round => (
                        <Link key={round.roundId} to={`/reviews?taskId=${encodeURIComponent(round.taskId)}&roundId=${encodeURIComponent(round.roundId)}`} className="dv-attention-row">
                          <span className="dv-attention-stripe review" aria-hidden="true"></span>
                          <div className="dv-attention-main">
                            <div className="dv-attention-title">{round.taskTitle}{round.revisionLabel ? ` · ${round.revisionLabel}` : ""}</div>
                            <div className="dv-attention-meta">{[round.projectTitle, `Round ${round.roundNumber}`, workState(round.status), round.dueDate ? workDate(round.dueDate) : ""].filter(Boolean).join(" · ")}</div>
                          </div>
                        </Link>
                      )) : <div className="dv-source-loading">No assigned review rounds in the authorized review source.</div>}
                    </div>
                  ) : <div className="dv-review-rounds"><div className="dv-review-rounds-head"><strong>Assigned review rounds</strong></div><div className="dv-source-loading">{reviewError || "Reading review source…"}<button type="button" onClick={() => setAccessRefresh(value => value + 1)}>Retry reviews</button></div></div>}
                </>
              )}
          </div>
        );
      case "projects":
        return (
          <div className="dv-widget-body">
            {!healthState || healthState.loading ? <div className="dv-source-loading">Reading projects…</div>
              : healthState?.error ? <div className="dv-source-error"><strong>Project source unavailable</strong><button type="button" onClick={() => void loadSource("health")}>Retry</button></div>
              : (
                <>
                <DashboardProjectOverview available={healthState.sections.some(section => section.key === "health" && !section.unavailable)} rows={healthRows} />
                <div className="dv-projects-grid">
                  {healthRows.slice(0, 4).map(row => (
                    <Link key={row.id} to={row.route ?? "/projects"} className="dv-project-card">
                      <div className="dv-project-top">
                        <span className="dv-project-name">{row.label}</span>
                        {typeof row.score === "number" && Number.isFinite(row.score)
                          ? <span className="dv-project-signal other">{row.status ?? "Recorded score"}</span>
                          : <span className="dv-project-signal other">{row.status === "UNAVAILABLE" ? "Evidence needed" : row.status?.replace(/_/g, " ") ?? "Unrated"}</span>}
                      </div>
                      <div className="dv-project-meta">{[row.status, row.value].filter(v => v && v !== "—").join(" · ")}</div>{typeof row.score === "number" && Number.isFinite(row.score) && <HealthScore row={row} />}
                      <span className="dv-project-link">Open workspace →</span>
                    </Link>
                  ))}
                  {healthState?.sections.filter(section => section.unavailable).map(section => <p key={section.key}>{section.unavailable}</p>)}
                  {healthRows.length === 0 && !healthState?.sections.some(section => section.unavailable) && <div className="dv-source-loading">No authorized project snapshots yet.</div>}
                </div></>
              )}
          </div>
        );
      case "performance": return perfContext && canSeePerformance ? <DashboardPerformanceWidget context={perfContext} csrfToken={csrfToken} owner={owner} /> : null;
      case "nextAction":
        return (
          <div className="dv-widget-body">
            {!tasksState || tasksState.loading ? <p role="status">Reading task source…</p> : taskSectionNote("attention") ? <div className="dv-source-error" role="alert"><strong>{taskSectionNote("attention")}</strong><button type="button" onClick={() => void loadSource("tasks")}>Retry tasks</button></div> : taskAttentionRows[0] ? (
              <Link to={taskAttentionRows[0].route ?? "/my-work"} className="dv-nextaction">
                <div className="dv-nextaction-icon" aria-hidden="true">→</div>
                <div className="dv-nextaction-main">
                  <div className="dv-nextaction-title">{taskAttentionRows[0].label}</div>
                  <div className="dv-nextaction-meta">{[taskAttentionRows[0].status, taskAttentionRows[0].date].filter(Boolean).join(" · ")}</div>
                </div>
              </Link>
            ) : <div className="dv-source-loading">No next action in the authorized task source.</div>}
          </div>
        );
      case "site": return renderSourceWidget("site");
      case "workload": return renderSourceWidget("workload");
      case "training": return renderSourceWidget("training");
      case "health": return renderSourceWidget("health");
      case "signals": return renderSourceWidget("tasks");
      case "shortcuts": return <div className="dv-widget-body"><Link to="/my-work">My Work</Link> · <Link to="/projects">Projects</Link> · <Link to="/decisions">Decisions</Link></div>;
      default:
        return null;
    }
  };

  return <section className="identity-section dashboard-workspace" aria-labelledby="dashboard-heading">
    <div className="dashboard-heading"><div><div className="eyebrow">{initialTab === "reports" ? "INSIGHTS" : "WORKSPACE OVERVIEW"}</div><h1 id="dashboard-heading">{initialTab === "reports" ? "Reports" : "Dashboard"}</h1><p>{initialTab === "reports" ? "Preview current report data or open a saved report." : "A current view of decisions, tasks and project updates available to your account."}</p></div><button type="button" className="secondary-action" onClick={() => { void load(true); setAccessRefresh(value => value + 1); }} disabled={busy}>Refresh</button></div>
    {!focused && <nav className="dashboard-tabs" aria-label="Dashboard sections">{([['dashboard', 'Overview'], ['summaries', 'Scheduled summaries'], ['reports', 'Reports'], ['schedules', 'Reminders & schedules']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</nav>}
    {error && <p className="auth-error" role="alert">{error} <button type="button" className="secondary-action" onClick={() => void load(true)}>Retry supporting data</button></p>}{notice && <p className="notice" role="status">{notice}</p>}
    {loading && tab !== "dashboard" && <p role="status">Loading reports, summaries, reminders, and schedules…</p>}
    {tab === "dashboard" && <>
      <div className="dashboard-summary" aria-label="Dashboard source context"><span><small>Organization date</small><strong>{organizationDateLabel}</strong></span><span><small>Account type</small><strong>{dash.role}</strong></span></div>

      {/* V10 fixed summary strip — non-draggable, non-hidable.
          Five independent task summaries; counts overlap and must not
          be summed into a total (V10 §G.1). */}
      <div className="dv-section-heading"><h3>Today at a glance</h3><span>Independent task summaries</span></div>
      <div className="dv-summary-strip" aria-label="Five independent task summaries; counts overlap and must not be summed">
        {kpiTiles.map(tile => {
          const loading = !tasksState || tasksState.loading;
          const unavailable = tile.value === "Unavailable";
          return (
            <Link
              key={tile.label}
              to={tile.route}
              className={`dv-summary-card dv-summary-${tile.key}${loading ? " is-loading" : ""}`}
              data-summary={tile.label.toLowerCase().replace(/\s+/g, "-")}
              aria-label={`${tile.label} · ${loading ? "source loading" : unavailable ? "source unavailable" : tile.value + " matching tasks"}`}
              aria-describedby={!loading && !unavailable ? `dashboard-task-mix-${tile.key}` : undefined}
            >
              <div className="dv-summary-top">
                <strong>{tile.label}</strong>
                <span className="dv-summary-icon"><DashboardDataIcon name={tile.key} /></span>
              </div>
              {loading
                ? <><div className="dv-summary-skeleton"></div><div className="dv-summary-cue">Loading…</div></>
                : unavailable
                  ? <div className="dv-summary-unavailable">Unavailable</div>
                  : <><div className="dv-summary-count" data-summary={tile.label.toLowerCase().replace(/\s+/g, "-")}>{tile.value}</div><div className="dv-summary-cue">{tile.sub}</div></>}
              {!loading && !unavailable && <DashboardTaskMix descriptionId={`dashboard-task-mix-${tile.key}`} rows={tasksState?.sections.find(section => section.key === tile.key)?.rows ?? []} />}
              <span className="dv-summary-arrow" aria-hidden="true">→</span>
            </Link>
          );
        })}
      </div>

      <div className="dv-summary-freshness"><span>{tasksState?.readCompletedAt ? `Task source read at ${new Date(tasksState.readCompletedAt).toLocaleString()}` : "Task summaries have not been read."} Counts overlap.</span>{tasksState && !tasksState.loading && (tasksState.error || kpiTiles.some(tile => tile.value === "Unavailable")) && <button type="button" onClick={() => void loadSource("tasks")}>Retry task summaries</button>}</div>

      <div className="dv-essentials-heading"><div><h3>Your essentials</h3><p>Only selected widgets appear here · long-press to edit on mobile.</p></div><button type="button" className="secondary-action" onClick={() => setEditing(true)}>Edit widgets</button></div>{layoutNotice && <p role="status">{layoutNotice}</p>}
      {/* V10 widget grid — two natural-height columns, dnd-kit
          sortable in edit mode. The entry to edit mode is the
          "Edit widgets" button below; when editing, each widget
          exposes a drag handle, hide button and keyboard move
          controls (V10 §G.3, §I). */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={commitDrag}
      >
        <div className={`dv-widget-grid${editing ? " is-editing" : ""}`} onPointerDown={event => { if (event.pointerType === "touch" && !editing && !(event.target as HTMLElement).closest("button, input, select, textarea, a")) longPress.current = setTimeout(() => setEditing(true), 600); }} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerMove={cancelLongPress}>
          <WidgetLane id="lane-left" droppable>
            {editing && (
              <div className="dv-edit-toolbar">
                <p><strong>Customize widgets.</strong> Drag to reposition, hide optional widgets, or add from the gallery. Top summary cards and the bottom Attention Queue stay fixed.</p>
                <div className="dv-edit-actions">
                  <button type="button" onClick={() => setGalleryOpen(previous => !previous)}>{galleryOpen ? "Hide gallery" : "Add widgets"}</button>
                  <button type="button" onClick={resetToDefaults}>Reset layout</button>
                  <button type="button" className="primary" onClick={() => { setEditing(false); setGalleryOpen(false); }}>Done</button>
                </div>
              </div>
            )}
            <SortableContext items={visibleLeft}>
              {visibleLeft.map(id => (
                <SortableWidget
                  key={id}
                  id={id}
                  editing={editing}
                  onHide={hideWidget}
                  onMoveUp={wid => moveWithin(wid, "up")}
                  onMoveDown={wid => moveWithin(wid, "down")}
                  onMoveAcross={wid => moveWithin(wid, "across")}
                  canMoveUp={visibleLeft.indexOf(id) > 0}
                  canMoveDown={visibleLeft.indexOf(id) < visibleLeft.length - 1}
                  canMoveAcross={mode === "desktop"}
                >
                  {renderWidget(id as WidgetId)}
                </SortableWidget>
              ))}
            </SortableContext>
            {editing && galleryOpen && availableGallery.length > 0 && (
              <div className="dv-widget-gallery" role="region" aria-label="Add widgets">
                <h4>Add widgets ({availableGallery.length} available)</h4>
                <div className="dv-gallery-grid">
                  {availableGallery.map(id => (
                    <button key={id} type="button" className="dv-gallery-item" onClick={() => addWidget(id)}>
                      <div><strong>{WIDGET_INFO[id as WidgetId]?.label ?? id}</strong><small>{WIDGET_INFO[id as WidgetId]?.desc ?? ""}</small></div>
                      <span className="dv-gallery-add">+ Add</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </WidgetLane>
          <WidgetLane id="lane-right" droppable={mode === "desktop"}>
            <SortableContext items={visibleRight}>
              {visibleRight.map(id => (
                <SortableWidget
                  key={id}
                  id={id}
                  editing={editing}
                  onHide={hideWidget}
                  onMoveUp={wid => moveWithin(wid, "up")}
                  onMoveDown={wid => moveWithin(wid, "down")}
                  onMoveAcross={wid => moveWithin(wid, "across")}
                  canMoveUp={visibleRight.indexOf(id) > 0}
                  canMoveDown={visibleRight.indexOf(id) < visibleRight.length - 1}
                  canMoveAcross={mode === "desktop"}
                >
                  {renderWidget(id as WidgetId)}
                </SortableWidget>
              ))}
            </SortableContext>
          </WidgetLane>
        </div>

      </DndContext>

      {/* V10 fixed attention queue — always at the very bottom,
          non-draggable, max 2 rows initially, expandable (V10 §G.9). */}
      <section className="dv-attention-queue" aria-label="Attention queue — fixed, not movable">
        <div className="dv-attention-head">
          <div>
            <h3>Attention queue</h3>
            <p>Authorized task preview · one row per task, even with multiple reasons</p>
          </div>
          <span className="dv-attention-locked" aria-hidden="true">Fixed</span>
        </div>
        {queueIncomplete && <div className="dv-source-error" role="status"><strong>Some task sections are unavailable. This preview may be incomplete.</strong><button type="button" onClick={() => void loadSource("tasks")}>Retry attention source</button></div>}
        <div className="dv-attention-body">
          {!tasksState || tasksState.loading ? (
            <div className="dv-source-loading">Reading attention items…</div>
          ) : tasksState.error ? (
            <div className="dv-source-error"><strong>Task source unavailable.</strong><button type="button" onClick={() => void loadSource("tasks")}>Retry</button></div>
          ) : attentionRows.length > 0 ? attentionRows.map(row => (
            <Link key={row.id} to={row.route ?? "/my-work"} className="dv-attention-row">
              <span className={`dv-attention-stripe ${row.status?.includes("WAITING") ? "waiting" : row.date && dash.today && row.date < dash.today ? "overdue" : "default"}`} aria-hidden="true"></span>
              <div className="dv-attention-main">
                <div className="dv-attention-title">{row.label}</div>
                <div className="dv-attention-meta">{[row.status, row.date].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="dv-attention-right">
                <span className={`dv-attention-due${row.date && dash.today && row.date < dash.today ? " overdue" : ""}`}>{row.date ? workDate(row.date) : ""}</span>
                <span className={`dv-attention-chip ${row.status?.includes("WAITING") ? "waiting" : ""}`}>{row.status ? workState(row.status) : ""}</span>
              </div>
            </Link>
          )) : (
            <div className="dv-source-loading">{queueIncomplete ? "No complete task preview is available." : "No tasks in this scope."}</div>
          )}
        </div>
        {attentionBaseRows.length > 2 && (
          <div className="dv-attention-foot">
            <span>Read at {tasksState?.readCompletedAt ? new Date(tasksState.readCompletedAt).toLocaleString() : "—"} · {attentionBaseRows.length} tasks</span>
            <div className="dv-attention-actions">
              <button type="button" onClick={() => setQueueExpanded(previous => !previous)}>
                {queueExpanded ? "Show less" : `Show more · ${attentionBaseRows.length - 2} tasks`}
              </button>
              <Link to="/tasks">Open Tasks workspace →</Link>
            </div>
          </div>
        )}
      </section>

    </>}
    {tab === "summaries" && !loading && <div className="dashboard-report-layout">
      <article className="dashboard-panel"><h3>Scheduled summaries</h3><p>Only summaries available under your current source access appear here.</p>{summaries.length === 0 ? <p className="identity-note" role="status">No generated summaries are available.</p> : <ul>{summaries.map(item => <li key={item.id} data-summary-id={item.id}><div><strong>{item.summary.kind} summary</strong><small>{item.summary.from ?? ""}{item.summary.from ? " — " : ""}{item.summary.to ?? ""} · {new Date(item.summary.generatedAt || item.createdAt).toLocaleString()}</small></div><button type="button" className="secondary-action" aria-pressed={selectedSummaryId === item.id} onClick={() => setSelectedSummaryId(item.id)}>{selectedSummaryId === item.id ? "Selected" : "View summary"}</button></li>)}</ul>}</article>
      {selectedSummary && <article className="dashboard-panel" aria-labelledby="scheduled-summary-heading"><div className="eyebrow">SCHEDULED SUMMARY</div><h3 id="scheduled-summary-heading">{selectedSummary.summary.kind}{selectedSummary.summary.from ? ` · ${selectedSummary.summary.from}` : ""}{selectedSummary.summary.to && selectedSummary.summary.to !== selectedSummary.summary.from ? ` — ${selectedSummary.summary.to}` : ""}</h3><p>Generated {new Date(selectedSummary.summary.generatedAt || selectedSummary.createdAt).toLocaleString()}</p><div className="dashboard-sections">{selectedSummary.summary.sections.map(section => <article className="dashboard-panel" key={section.key}><h3>{section.label}</h3>{section.unavailable && <p className="dashboard-unavailable">{section.unavailable}</p>}{section.rows.length ? <ul>{section.rows.map((row, index) => <li key={row.id ?? `${section.key}-${index}`}><div><strong>{row.label}</strong><small>{[row.status, row.date].filter(Boolean).join(" · ")}</small></div><span>{format(row.value)}</span></li>)}</ul> : !section.unavailable && <p className="identity-note">No factual items for this section.</p>}</article>)}</div></article>}
    </div>}
    {tab === "reports" && !loading && <div className="dashboard-report-layout"><article className="dashboard-panel"><h3>Build report preview</h3><p>Preview source records that your account is currently permitted to read.</p><div className="dashboard-form-grid"><label>Report category<select value={category} onChange={e => setCategory(e.target.value)} required><option value="">Choose category</option>{(context?.categories ?? []).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} required /></label><label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} required /></label></div><button type="button" disabled={busy || !category || !dateRangeOkay(from, to)} onClick={() => void makePreview()}>Preview report</button>
      {preview && <div className="dashboard-preview"><div className="dashboard-heading"><div><h4>{preview.title}</h4><small>{dateLabel(preview.from)} — {dateLabel(preview.to)} · Generated {new Date(preview.generatedAt).toLocaleString()}</small></div><div className="dashboard-export-actions">{(["csv", "xlsx", "pdf", "print"] as const).map(fmt => <button type="button" className="secondary-action" key={fmt} onClick={() => download(`/api/v1/reports/export?category=${encodeURIComponent(preview.category)}&from=${encodeURIComponent(preview.from)}&to=${encodeURIComponent(preview.to)}&format=${fmt}`)}>{fmt === "xlsx" ? "Excel" : fmt.toUpperCase()}</button>)}</div></div>
        {preview.unavailable.length > 0 && <ul className="dashboard-unavailable">{preview.unavailable.map((value, i) => <li key={i}>{value}</li>)}</ul>}
        {preview.rows.length === 0 ? <p className="identity-note">No permitted source rows are available for this period.</p> : <div className="dashboard-table-wrap"><table><thead><tr>{preview.columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{preview.rows.map((row, i) => <tr key={`${String(row.sourceId ?? row.id ?? "report-row")}:${String(row.field ?? row.key ?? "")}:${i}`}>{preview.columns.map(column => <td key={column.key}>{format(row[column.key])}</td>)}</tr>)}</tbody></table></div>}
        {isOwner && <div className="dashboard-freeze"><label>Reason for frozen report (required)<textarea value={reason} onChange={e => setReason(e.target.value)} minLength={3} maxLength={1000} /></label><label>Correct an earlier snapshot (optional)<select value={correctsId} onChange={e => setCorrectsId(e.target.value)}><option value="">New frozen report</option>{snapshots.filter(s => s.category === preview.category).map(s => <option key={s.id} value={s.id}>{s.title ?? `${s.category} ${s.from ?? ""}–${s.to ?? ""}`} · {s.id.slice(0, 8)}</option>)}</select></label><button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void saveSnapshot()}>{correctsId ? "Freeze correction" : "Freeze report"}</button></div>}
      </div>}</article>
      <article className="dashboard-panel"><h3>Frozen report history</h3>{snapshots.length === 0 ? <p className="identity-note">No frozen reports yet.</p> : <ul>{snapshots.map(snapshot => <li key={snapshot.id} data-snapshot-id={snapshot.id}><div><strong>{snapshot.title ?? snapshot.category ?? "Frozen report"}</strong><small>{dateLabel(snapshot.from)} {snapshot.from ? "—" : ""} {dateLabel(snapshot.to)} · {snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : snapshot.id}</small></div><div className="dashboard-export-actions"><button className="secondary-action" type="button" onClick={() => void openSnapshot(snapshot.id)} disabled={busy}>Read</button>{(["csv", "xlsx", "pdf", "print"] as const).map(fmt => <button className="secondary-action" type="button" key={fmt} onClick={() => download(`/api/v1/reports/snapshots/${encodeURIComponent(snapshot.id)}/export?format=${fmt}`)}>{fmt === "xlsx" ? "Excel" : fmt.toUpperCase()}</button>)}</div></li>)}</ul>}{selectedSnapshot && <div className="dashboard-snapshot"><h4>{selectedSnapshot.title ?? selectedTable?.title ?? "Frozen report"}</h4>{selectedTable ? <><div className="dashboard-table-wrap"><table><thead><tr>{selectedTable.columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{selectedTable.rows.map((row, i) => <tr key={`${String(row.sourceId ?? row.id ?? "report-row")}:${String(row.field ?? row.key ?? "")}:${i}`}>{selectedTable.columns.map(column => <td key={column.key}>{format(row[column.key])}</td>)}</tr>)}</tbody></table></div><pre>Reason: {selectedSnapshot.reason ?? "—"}{selectedSnapshot.correctsId ? `\nCorrects snapshot: ${selectedSnapshot.correctsId}` : ""}</pre></> : <p role="status">Loading frozen report…</p>}</div>}</article>
    </div>}
    {tab === "schedules" && !loading && <div className="dashboard-report-layout">
      <article className="dashboard-panel"><h3>Personal reminder</h3><p>Reminders stay private to the employee who creates them.</p><div className="dashboard-form-grid"><label>Reminder title<input value={reminderTitle} onChange={e => setReminderTitle(e.target.value)} maxLength={160} required /></label><label>Due date and time<input type="datetime-local" value={reminderDue} onChange={e => setReminderDue(e.target.value)} required /></label><label className="dashboard-span">Reason<textarea value={reminderReason} onChange={e => setReminderReason(e.target.value)} minLength={3} maxLength={1000} required /></label></div><button type="button" disabled={busy || !reminderTitle.trim() || !reminderDue || reminderReason.trim().length < 3} onClick={() => void mutate("/dashboard/reminders", { title: reminderTitle.trim(), dueAt: new Date(reminderDue).toISOString(), reason: reminderReason.trim() }).then(() => { setReminderTitle(""); setReminderDue(""); setReminderReason(""); })}>Save reminder</button>
        <h4>Your reminders</h4>{!reminders?.reminders.length ? <p className="identity-note">No reminders yet.</p> : <ul>{reminders.reminders.map((item, i) => <li key={String(item.id ?? i)}><div><strong>{format(item.title)}</strong><small>{item.dueAt ? new Date(item.dueAt).toLocaleString() : ""}</small></div><span>{format(item.reason)}</span></li>)}</ul>}</article>
      <article className="dashboard-panel"><h3>{isOwner ? "Organization schedules" : "Schedule rules"}</h3><p>Set explicit times and audiences. No numeric work policy is prefilled or implied.</p>{schedules?.rules.length ? <ul>{schedules.rules.map((item, i) => <li key={String(item.id ?? i)} data-schedule-id={String(item.id ?? "")}><div><strong>{format(item.kind ?? "Schedule")}</strong><small>{format(item.localTime)} · {format(item.timezone)} · {format(item.audience)}</small></div><span>{item.enabled ? "Enabled" : "Disabled"}</span>{isOwner && item.id && <button className="secondary-action" type="button" onClick={() => { setEditingRule({ id: item.id!, version: typeof item.version === "number" ? item.version : 1 }); setRuleKind(item.kind === "SUMMARY" || item.kind === "EVENT_NOTICE" ? item.kind : "TASK_REMINDER"); setRuleEnabled(Boolean(item.enabled)); setRuleTime(typeof item.localTime === "string" ? item.localTime : ""); setTimezone(typeof item.timezone === "string" ? item.timezone : ""); setAudience(item.audience === "OWNER" || item.audience === "EMPLOYEE" || item.audience === "MANAGER" ? item.audience : "SELF"); setSummaryKind(typeof item.summaryKind === "string" ? item.summaryKind : "MORNING"); setWeekdays(Array.isArray(item.weekdays) ? item.weekdays.join(", ") : ""); setDayOfMonth(typeof item.dayOfMonth === "number" ? String(item.dayOfMonth) : ""); setOffsetDays(typeof item.offsetDays === "number" ? String(item.offsetDays) : ""); setPriority(typeof item.priority === "string" ? item.priority : ""); setProjectId(typeof item.projectId === "string" ? item.projectId : ""); setEventNamesText(Array.isArray(item.eventNames) ? item.eventNames.join(", ") : ""); setCritical(Boolean(item.critical)); setMandatory(Boolean(item.mandatory)); setRuleReason(""); }}>{"Edit"}</button>}</li>)}</ul> : <p className="identity-note">{isOwner ? "No organization schedules configured." : "Organization schedules are managed by the Owner."}</p>}
        {isOwner && <div className="dashboard-freeze"><h4>{editingRule ? "Edit schedule rule" : "Add schedule rule"}</h4><div className="dashboard-form-grid"><label>Rule kind<select value={ruleKind} onChange={e => { setRuleKind(e.target.value as typeof ruleKind); setSummaryKind("MORNING"); setWeekdays(""); setDayOfMonth(""); setOffsetDays(""); setPriority(""); setProjectId(""); setEventNamesText(""); }}><option value="TASK_REMINDER">Task reminder</option><option value="SUMMARY">Summary</option><option value="EVENT_NOTICE">Event notice</option></select></label><label>Local time<input type="time" value={ruleTime} onChange={e => setRuleTime(e.target.value)} required /></label><label>Timezone<input value={timezone} onChange={e => setTimezone(e.target.value)} required placeholder="e.g. Asia/Kolkata" /></label><label>Audience<select value={audience} onChange={e => setAudience(e.target.value as typeof audience)}><option value="SELF">Self</option><option value="OWNER">Owner</option><option value="EMPLOYEE">Employee</option><option value="MANAGER">Manager</option></select></label>{ruleKind === "SUMMARY" && <label>Summary period<select value={summaryKind} onChange={e => setSummaryKind(e.target.value)}><option>MORNING</option><option>EVENING</option><option>WEEKLY</option><option>MONTHLY</option></select></label>}{ruleKind === "EVENT_NOTICE" && <label>Event names (comma separated, required)<input value={eventNamesText} onChange={e => setEventNamesText(e.target.value)} placeholder="Enter explicitly configured event names" /></label>}<label>Weekdays (0=Sun, 6=Sat){ruleKind === "SUMMARY" && summaryKind === "WEEKLY" ? " · required" : ""}<input value={weekdays} onChange={e => setWeekdays(e.target.value)} placeholder="Optional, comma separated" /></label><label>Day of month{ruleKind === "SUMMARY" && summaryKind === "MONTHLY" ? " · required" : ""}<input type="number" min="1" max="31" value={dayOfMonth} onChange={e => setDayOfMonth(e.target.value)} placeholder="Optional" /></label>{ruleKind === "TASK_REMINDER" && <label>Task reminder offset (days) · required<input type="number" min="-366" max="366" step="1" value={offsetDays} onChange={e => setOffsetDays(e.target.value)} placeholder="Enter day offset" /></label>}{ruleKind !== "SUMMARY" && <><label>Priority<select value={priority} onChange={e => setPriority(e.target.value)}><option value="">No priority filter</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="CRITICAL">Critical</option></select></label><label>Project ID (optional)<input value={projectId} onChange={e => setProjectId(e.target.value)} /></label></>}<label className="dashboard-check"><input type="checkbox" checked={ruleEnabled} onChange={e => setRuleEnabled(e.target.checked)} /> Enabled</label><label className="dashboard-check"><input type="checkbox" checked={critical} onChange={e => setCritical(e.target.checked)} /> Critical</label><label className="dashboard-check"><input type="checkbox" checked={mandatory} onChange={e => setMandatory(e.target.checked)} /> Mandatory</label><label className="dashboard-span">Reason<textarea value={ruleReason} onChange={e => setRuleReason(e.target.value)} minLength={3} maxLength={1000} required /></label></div><p>Optional schedule policies stay unset until you enter them. Recipients are rechecked against current access when notices are generated.</p><button type="button" disabled={busy || !scheduleValid} onClick={() => {
          const payload: Record<string, unknown> = { kind: ruleKind, enabled: ruleEnabled, localTime: ruleTime, timezone: timezone.trim(), audience, critical, mandatory, reason: ruleReason.trim(), ...(ruleKind === "SUMMARY" ? { summaryKind } : {}), ...(ruleKind === "EVENT_NOTICE" ? { eventNames } : {}), ...(weekdays.trim() ? { weekdays: weekdayValues } : {}), ...(dayOfMonth.trim() ? { dayOfMonth: Number(dayOfMonth) } : {}), ...(ruleKind === "TASK_REMINDER" && offsetDays.trim() ? { offsetDays: Number(offsetDays) } : {}), ...(ruleKind !== "SUMMARY" && priority ? { priority } : {}), ...(ruleKind !== "SUMMARY" && projectId.trim() ? { projectId: projectId.trim() } : {}), ...(editingRule ? { expectedVersion: editingRule.version } : {}) };
          void mutate(editingRule ? `/dashboard/schedules/${encodeURIComponent(editingRule.id)}` : "/dashboard/schedules", payload).then(() => { setRuleReason(""); setEditingRule(null); });
        }}>{editingRule ? "Save schedule changes" : "Save schedule rule"}</button></div>}
      </article>
    </div>}
  </section>;
}
