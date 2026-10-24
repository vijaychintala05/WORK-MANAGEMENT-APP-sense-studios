import { TASK_LIST_SORT_VALUES, type TaskListSort } from "@sense/contracts";
import { taskRefinementError } from "./task-query-refinements.js";
export type MyWorkSnapshot = {
  filters: { priorities?: string; collaboratorEmployeeIds?: string; teamId?: string; q: string; projectId: string; planItemId: string; ownerEmployeeId: string; status: string; phase: string; dateBasis: string; dateFrom: string; dateTo: string; sort: TaskListSort };
  view: "list" | "cards" | "board" | "timeline";
  compact: boolean;
  temporaryPhase: "" | "active" | "waiting" | "review" | "completed" | "overdue" | "reviews" | "attention";
};
export type MyWorkSavedView = { id: string; name: string; snapshot: MyWorkSnapshot };
export type ViewStorage = Pick<Storage, "getItem" | "setItem">;
export type SavedViewsResult = { status: "ready"; views: MyWorkSavedView[] } | { status: "unavailable" | "invalid"; message: string };
const statuses = ["", "NOT_STARTED", "IN_PROGRESS", "WAITING", "SUBMITTED_INTERNAL_REVIEW", "IN_INTERNAL_REVIEW", "CORRECTIONS_REQUIRED", "INTERNAL_APPROVED", "SUBMITTED_CLIENT_REVIEW", "IN_CLIENT_REVIEW", "CLIENT_REVISION_REQUIRED", "CLIENT_APPROVED", "COMPLETED", "STOPPED_DUE_TO_PROJECT_CANCELLATION"];
const phases = ["", "active", "waiting", "review", "completed"];
const filterKeys = ["q", "projectId", "planItemId", "ownerEmployeeId", "status", "phase", "dateBasis", "dateFrom", "dateTo", "sort"];
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function date(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function isMyWorkSnapshot(value: unknown): value is MyWorkSnapshot {
  if (!object(value) || !exact(value, ["filters", "view", "compact", "temporaryPhase"]) || !object(value.filters) || !filterKeys.every(key => Object.hasOwn(value.filters as object, key)) || !Object.keys(value.filters).every(key => [...filterKeys, "priorities", "collaboratorEmployeeIds", "teamId"].includes(key))) return false;
  const f = value.filters;
  if (f.teamId !== undefined && f.teamId !== "" && !uuid(f.teamId)) return false;
  if (!filterKeys.every(key => typeof f[key] === "string") || ["priorities", "collaboratorEmployeeIds"].some(key => f[key] !== undefined && typeof f[key] !== "string") || taskRefinementError(f as { priorities?: string; collaboratorEmployeeIds?: string })) return false;
  const strings = f as Record<string, string>;
  return strings.q!.length <= 160 && ["projectId", "planItemId", "ownerEmployeeId"].every(key => strings[key] === "" || uuid(strings[key]))
    && statuses.includes(strings.status!) && phases.includes(strings.phase!) && ["", "target", "committed"].includes(strings.dateBasis!)
    && date(strings.dateFrom!) && date(strings.dateTo!) && (!(strings.dateFrom || strings.dateTo) || strings.dateBasis !== "")
    && (!strings.dateFrom || !strings.dateTo || strings.dateFrom <= strings.dateTo)
    && TASK_LIST_SORT_VALUES.some(sort => sort === strings.sort)
    && typeof value.view === "string" && ["list", "cards", "board", "timeline"].includes(value.view)
    && typeof value.compact === "boolean" && typeof value.temporaryPhase === "string" && [...phases, "overdue", "reviews", "attention"].includes(value.temporaryPhase);
}
function validViews(value: unknown): value is MyWorkSavedView[] {
  return Array.isArray(value) && value.length <= 20 && value.every(item => object(item) && exact(item, ["id", "name", "snapshot"])
    && uuid(item.id) && typeof item.name === "string" && item.name.trim() === item.name && item.name.length > 0 && item.name.length <= 40 && isMyWorkSnapshot(item.snapshot))
    && new Set(value.map(item => item.id)).size === value.length;
}
function key(accountId: string): string | undefined { return uuid(accountId) ? `sense:my-work:personal:saved-views:v1:${accountId}` : undefined; }
const invalid = (): SavedViewsResult => ({ status: "invalid", message: "Saved views are invalid or use an unsupported format. They were not changed." });
const unavailable = (): SavedViewsResult => ({ status: "unavailable", message: "Browser saved views are unavailable. No save was confirmed." });
function storageOrDefault(storage?: ViewStorage): ViewStorage { return storage ?? window.localStorage; }
// Browser preferences are not encrypted/private. Query text may contain sensitive
// words; no task records, identity authority, sessions, offsets or secrets persist.
export function loadMyWorkSavedViews(accountId: string, storage?: ViewStorage): SavedViewsResult {
  const storageKey = key(accountId);
  if (!storageKey) return unavailable();
  let raw: string | null;
  try { raw = storageOrDefault(storage).getItem(storageKey); } catch { return unavailable(); }
  if (raw === null) return { status: "ready", views: [] };
  try {
    const body: unknown = JSON.parse(raw);
    if (!object(body) || !exact(body, ["version", "views"]) || body.version !== 1 || !validViews(body.views)) return invalid();
    return { status: "ready", views: body.views };
  } catch { return invalid(); }
}
export function saveMyWorkSavedViews(accountId: string, views: MyWorkSavedView[], storage?: ViewStorage): SavedViewsResult {
  const storageKey = key(accountId);
  if (!storageKey) return unavailable();
  if (!validViews(views)) return invalid();
  const existing = loadMyWorkSavedViews(accountId, storage);
  if (existing.status !== "ready") return existing;
  try {
    const target = storageOrDefault(storage);
    const serialized = JSON.stringify({ version: 1, views });
    target.setItem(storageKey, serialized);
    if (target.getItem(storageKey) !== serialized) return unavailable();
    return { status: "ready", views: JSON.parse(serialized).views as MyWorkSavedView[] };
  } catch { return unavailable(); }
}
