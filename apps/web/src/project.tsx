import { ConfirmedDrawings } from "./confirmed-drawings.js";
import { ProjectRelationships } from "./project-relationships.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./project.css";
import { TaskWorkspace } from "./task.js";
import { ProjectPlan, ProjectTemplatePanel, type TemplateVersion } from "./project-template.js";
import { ProjectResourceSummary } from "./project-resources.js";

const API = "/api/v1/projects";
type Branch = { id: string; name: string };
type Scope = { id: string; name: string; normalizedName: string; baseline: boolean };
type Project = { id: string; title: string; status: string; deliveryType: "DESIGN" | "TURNKEY"; version: number; client?: { id: string; name: string } | null; branch: Branch; scopes: Scope[]; createdAt: string; currentLeadName?: string | null; appliedStageKeys?: string[]; nextMilestone?: { key: string; label: string; targetAt: string } | null; statusChanges?: Array<{ id: string; fromStatus?: string; toStatus: string; reason: string }> };
type Employee = { id: string; accountId: string; name: string; homeBranchId: string };
type ProjectSetup = { branches: Branch[]; employees?: Employee[]; owner?: boolean; ownerAccountId?: string };
type ProjectPage = { total: number; stageKeys?: string[]; items: Project[] };
type ProjectSection = "overview" | "plan" | "tasks" | "people" | "documents" | "reviews" | "delivery" | "activity";
const projectSections: ProjectSection[] = ["overview", "plan", "tasks", "people", "documents", "reviews", "delivery", "activity"];
function readProjectSection(): ProjectSection {
  const queryValue = new URLSearchParams(window.location.search).get("projectSection");
  if (projectSections.includes(queryValue as ProjectSection)) return queryValue as ProjectSection;
  return window.location.hash === "#project-plan" ? "plan" : "overview";
}
type ProjectDetail = { project: Project & { currentLeadEmployeeId?: string | null; currentLeadName?: string | null; scopeApproverAccountId?: string | null }; capabilities?: Record<string, boolean>; currentLeadEmployeeId?: string | null; currentLeadName?: string | null; scopeApproverAccountId?: string | null; assignments?: Array<{ employeeId: string; employee?: Employee; name?: string }>; leadChanges?: Array<{ employeeName?: string; reason: string; createdAt?: string }>; transfers?: Array<{ fromBranchName?: string; toBranchName?: string; reason: string; createdAt?: string }>; scopeChanges?: Array<{ approvalId?: string | null; approval?: { state?: string } | null; name: string; status: string; reason: string }>; cancellationRequests?: Array<{ status: string; reason: string }>; wonLeadProvenance?: { leadId: string; stageChangeId: string; occurredAt: string; actorId: string; fromStage: string; toStage: string; leadVersion: number } };

async function json(response: Response): Promise<unknown> { if (!response.ok) throw Object.assign(new Error(response.status === 403 ? "denied" : response.status === 409 ? "conflict" : "request"), { status: response.status }); return response.json() as Promise<unknown>; }
type ProjectListContext = { branchId: string; q: string; stageKey: string; sort: "created" | "name" | "milestone"; direction: "asc" | "desc"; offset: number; projectId: string };
function directoryContextKey(branchId: string, context: Pick<ProjectListContext, "q" | "stageKey" | "sort" | "direction">): string {
  return JSON.stringify([branchId, context.q, context.stageKey, context.sort, context.direction]);
}
function readProjectListContext(): ProjectListContext {
  const query = new URLSearchParams(window.location.search); const rawOffset = Number(query.get("offset") ?? 0);
  const sort = query.get("sort"); const direction = query.get("direction");
  return { branchId: query.get("branchId") ?? "", q: query.get("q") ?? "", stageKey: query.get("stageKey") ?? "", sort: sort === "name" || sort === "milestone" ? sort : "created", direction: direction === "asc" ? "asc" : "desc", offset: Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0, projectId: query.get("projectId") ?? "" };
}
function writeProjectListContext(changes: Partial<ProjectListContext>): void {
  const current = readProjectListContext(); const next = { ...current, ...changes }; const query = new URLSearchParams(window.location.search);
  const changedProject = changes.projectId !== undefined && changes.projectId !== current.projectId;
  if (changedProject) { query.delete("projectSection"); for (const key of [...query.keys()]) if (key.startsWith("projectTask")) query.delete(key); }
  for (const key of ["branchId", "q", "stageKey", "sort", "direction", "offset", "projectId"]) query.delete(key);
  if (next.branchId) query.set("branchId", next.branchId); if (next.q) query.set("q", next.q); if (next.stageKey) query.set("stageKey", next.stageKey);
  if (next.sort !== "created") query.set("sort", next.sort); if (next.direction !== "desc") query.set("direction", next.direction);
  if (next.offset > 0) query.set("offset", String(next.offset)); if (next.projectId) query.set("projectId", next.projectId);
  window.history.pushState(null, "", `${window.location.pathname}${query.toString() ? `?${query}` : ""}${changedProject ? "" : window.location.hash}`);
}
function writeProjectSection(section: ProjectSection, projectId: string): void {
  const query = new URLSearchParams(window.location.search);
  if (projectId) query.set("projectId", projectId);
  if (section === "overview") query.delete("projectSection"); else query.set("projectSection", section);
  window.history.pushState(null, "", `${window.location.pathname}${query.toString() ? `?${query}` : ""}${section === "plan" ? "#project-plan" : ""}`);
}

export function ProjectWorkspace({ csrfToken, owner, listFirst = false, initialProjectId = "" }: { csrfToken: string; owner: boolean; listFirst?: boolean; initialProjectId?: string }): React.JSX.Element | null {
  const initialListContext = readProjectListContext();
  const [setup, setSetup] = useState<ProjectSetup>();
  const [branchId, setBranchId] = useState(initialListContext.branchId);
  const [items, setItems] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(initialListContext.offset);
  const [search, setSearch] = useState(initialListContext.q);
  const [searchDraft, setSearchDraft] = useState(initialListContext.q);
  const [stageKey, setStageKey] = useState(initialListContext.stageKey);
  const [sort, setSort] = useState<ProjectListContext["sort"]>(initialListContext.sort);
  const [direction, setDirection] = useState<ProjectListContext["direction"]>(initialListContext.direction);
  const [stageKeys, setStageKeys] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [projectSection, setProjectSection] = useState<ProjectSection>(readProjectSection);
  const [detail, setDetail] = useState<ProjectDetail>();
  const [setupLoading, setSetupLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState("");
  const [deliveryType, setDeliveryType] = useState<"DESIGN" | "TURNKEY">("DESIGN");
  const [scopes, setScopes] = useState("");
  const [clientId, setClientId] = useState("");
  const [wonLeadId, setWonLeadId] = useState("");
  const [reason, setReason] = useState("");
  const [success, setSuccess] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [actionEmployee, setActionEmployee] = useState("");
  const [actionBranch, setActionBranch] = useState("");
  const [actionAccount, setActionAccount] = useState("");
  const [actionScope, setActionScope] = useState("");
  const [templateVersion, setTemplateVersion] = useState<TemplateVersion>();
  const [templateReset, setTemplateReset] = useState(0);
  const [overrideMilestones, setOverrideMilestones] = useState(false);
  const [confirmCancellation, setConfirmCancellation] = useState(false);
  const listRequest = useRef(0);
  const initialProjectHandled = useRef(false);
  const detailRequest = useRef(0);
  const creationRequest = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const creationPending = useRef(false);
  const [uncertainCreation, setUncertainCreation] = useState<{ body: Record<string, unknown>; retryable: boolean }>();
  const [confirmedCreationId, setConfirmedCreationId] = useState("");
  const recoveryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (uncertainCreation) recoveryButton.current?.focus(); }, [uncertainCreation]);
  useEffect(() => {
    if (!uncertainCreation && !pending) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [uncertainCreation, pending]);
  const activeProjectId = useRef("");
  const loadedProjectId = useRef("");
  const skipListEffect = useRef(false);
  const firstListRead = useRef(true);
  const loadedDirectoryContext = useRef("");
  const requestedDirectoryOffset = useRef(initialListContext.offset);
  const taskLeaveGuard = useRef<(() => boolean) | null>(null);
  const projectHistory = useRef({ url: window.location.href, state: window.history.state });
  const sectionNavigation = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    sectionNavigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [projectSection, detail?.project.id]);
  const registerTaskGuard = useCallback((guard: (() => boolean) | null) => { taskLeaveGuard.current = guard; if (guard) projectHistory.current = { url: window.location.href, state: window.history.state }; }, []);
  const leaveTaskContext = (): boolean => taskLeaveGuard.current?.() ?? true;
  const taskSessionExpired = useCallback(() => window.dispatchEvent(new Event("sense-session-ended")), []);
  useLayoutEffect(() => { projectHistory.current = { url: window.location.href, state: window.history.state }; });
  const resetProjectDrafts = (): void => {
    setReason(""); setActionStatus(""); setActionEmployee(""); setActionBranch(""); setActionAccount(""); setActionScope("");
    setOverrideMilestones(false); setConfirmCancellation(false);
  };
  const applyTemplateVersion = useCallback((version: TemplateVersion | undefined) => {
    setTemplateVersion(version);
    if (version) { setDeliveryType(version.definition.deliveryType); setScopes(version.definition.scopes.join("\n")); }
  }, []);
  const clearProjectFilters = (): void => {
    if (!leaveTaskContext()) return;
    setSearch(""); setSearchDraft(""); setStageKey(""); setSort("created"); setDirection("desc"); setOffset(0);
    writeProjectListContext({ q: "", stageKey: "", sort: "created", direction: "desc", offset: 0, projectId: "" });
    setSelectedId(""); setDetail(undefined);
    void loadList(branchId, false, 0, { q: "", stageKey: "", sort: "created", direction: "desc" });
  };

  const request = useCallback(async (url: string, init?: RequestInit) => json(await fetch(url, { credentials: "include", cache: "no-store", ...init })), []);
  const loadSetup = useCallback(async () => {
    setSetupLoading(true); setError("");
    try { const result = await request(`${API}/setup`) as ProjectSetup; setSetup(result); const requestedBranch = readProjectListContext().branchId; setBranchId((current) => result.branches.some((b) => b.id === (current || requestedBranch)) ? current || requestedBranch : ""); }
    catch (cause) { setError(cause instanceof Error && cause.message === "denied" && owner ? "You need Owner access to manage projects." : "Project access could not be loaded. Check your connection and try again."); }
    finally { setSetupLoading(false); }
  }, [request]);
  const loadList = useCallback(async (currentBranch: string, preserveSelection = false, pageOffset = 0, context = { q: search, stageKey, sort, direction }) => {
    const requestId = ++listRequest.current;
    loadedDirectoryContext.current = directoryContextKey(currentBranch, context); requestedDirectoryOffset.current = pageOffset;
    setLoading(true); setError("");
    if (!preserveSelection) { ++detailRequest.current; activeProjectId.current = ""; loadedProjectId.current = ""; setSelectedId(""); setDetail(undefined); setDetailLoading(false); setDetailError(""); }
    try { const query = new URLSearchParams({ offset: String(pageOffset), limit: "50", sort: context.sort, direction: context.direction }); if (currentBranch) query.set("branchId", currentBranch); if (context.q) query.set("q", context.q); if (context.stageKey) query.set("stageKey", context.stageKey); const result = await request(`${API}?${query}`) as ProjectPage; if (requestId === listRequest.current) { setItems(result.items); setTotal(result.total); setOffset(pageOffset); setStageKeys(result.stageKeys ?? []); } }
    catch (cause) { if (requestId === listRequest.current) { setItems([]); setTotal(0); setOffset(0); setError(cause instanceof Error && cause.message === "denied" ? "You do not have access to these projects." : "Projects could not be loaded. Try again."); } }
    finally { if (requestId === listRequest.current) setLoading(false); }
  }, [request, search, stageKey, sort, direction]);
  useEffect(() => { void loadSetup(); }, [loadSetup]);
  useEffect(() => {
    if (skipListEffect.current) { skipListEffect.current = false; return; }
    if (!setupLoading && setup) {
      const sameContext = loadedDirectoryContext.current === directoryContextKey(branchId, { q: search, stageKey, sort, direction });
      const first = firstListRead.current; firstListRead.current = false;
      const pageOffset = first ? initialListContext.offset : sameContext ? requestedDirectoryOffset.current : 0;
      void loadList(branchId, sameContext || first && !!initialProjectId, pageOffset);
    }
  }, [branchId, setupLoading, setup, loadList, search, stageKey, sort, direction, initialProjectId]);
  const selectProject = async (id: string) => {
    if (activeProjectId.current !== id) { resetProjectDrafts(); activeProjectId.current = id; }
    loadedProjectId.current = "";
    const requestId = ++detailRequest.current;
    setSelectedId(id); setDetail(undefined); setOverrideMilestones(false); setDetailError(""); setDetailLoading(true);
    try { const result = await request(`${API}/${encodeURIComponent(id)}`) as ProjectDetail; if (!result?.project || result.project.id !== id) throw new Error("Unconfirmed project detail"); if (requestId === detailRequest.current) { loadedProjectId.current = id; setDetail(result); } }
    catch (cause) { if (requestId === detailRequest.current) setDetailError(cause instanceof Error && cause.message === "denied" ? "You do not have access to this project." : "Project details could not be loaded. Try again."); }
    finally { if (requestId === detailRequest.current) setDetailLoading(false); }
  };
  useEffect(() => {
    const onPopState = (): void => {
      const context = readProjectListContext();
      const nextSection = readProjectSection();
      const leavesTasks = context.projectId !== activeProjectId.current || nextSection !== projectSection || context.branchId !== branchId || context.q !== search || context.stageKey !== stageKey || context.sort !== sort || context.direction !== direction || context.offset !== offset;
      if (leavesTasks && !leaveTaskContext()) { window.history.pushState(projectHistory.current.state, "", projectHistory.current.url); return; }
      skipListEffect.current = context.branchId !== branchId || context.q !== search || context.stageKey !== stageKey || context.sort !== sort || context.direction !== direction;
      setProjectSection(readProjectSection());
      setBranchId(context.branchId); setSearch(context.q); setSearchDraft(context.q); setStageKey(context.stageKey); setSort(context.sort); setDirection(context.direction); setOffset(context.offset);
      void loadList(context.branchId, true, context.offset, context);
      if (context.projectId) {
        if (activeProjectId.current !== context.projectId || loadedProjectId.current !== context.projectId) void selectProject(context.projectId);
        else setSelectedId(context.projectId);
      } else { ++detailRequest.current; activeProjectId.current = ""; loadedProjectId.current = ""; setSelectedId(""); setDetail(undefined); setDetailError(""); setDetailLoading(false); }
    };
    const onHashChange = (): void => { if (window.location.hash === "#project-plan") { if (!leaveTaskContext()) { window.history.replaceState(projectHistory.current.state, "", projectHistory.current.url); return; } setProjectSection("plan"); } };
    window.addEventListener("popstate", onPopState); window.addEventListener("hashchange", onHashChange);
    return () => { window.removeEventListener("popstate", onPopState); window.removeEventListener("hashchange", onHashChange); };
  }, [branchId, direction, loadList, search, sort, stageKey, projectSection, offset]);
  useEffect(() => { if (!setupLoading && !initialProjectHandled.current && initialProjectId) { initialProjectHandled.current = true; void selectProject(initialProjectId); } }, [setupLoading, initialProjectId]);
  const changePage = (pageOffset: number): void => {
    if (loading || pageOffset < 0 || pageOffset >= total) return;
    setSelectedId(""); setDetail(undefined); setDetailError(""); activeProjectId.current = ""; loadedProjectId.current = ""; ++detailRequest.current;
    void loadList(branchId, false, pageOffset);
  };
  const performCreation = async (body: Record<string, unknown>): Promise<void> => {
    if (pending || creationPending.current) return;
    creationPending.current = true;
    setPending(true); setError(""); setSuccess(""); setConfirmedCreationId("");
    try {
      const result = await request(API, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }) as { project?: { id?: string } };
      const id = result?.project?.id;
      if (typeof id !== "string" || !id) throw new Error("Unconfirmed project result");
      setConfirmedCreationId(id); setUncertainCreation(undefined);
      setTitle(""); setScopes(""); setClientId(""); setWonLeadId(""); setReason(""); setTemplateVersion(undefined); setTemplateReset((value) => value + 1); creationRequest.current = undefined; setSuccess("Draft project created.");
      await loadList(branchId, true, offset);
      setProjectSection("overview"); writeProjectListContext({ projectId: id });
      await selectProject(id);
    } catch (cause) {
      const status = cause instanceof Error && "status" in cause ? Number(cause.status) : undefined;
      if (status === undefined || status >= 500) {
        setUncertainCreation({ body, retryable: typeof body.idempotencyKey === "string" });
        setError("We could not confirm whether the project was created. The submitted details are preserved; do not submit another copy.");
      } else setError(status === 409 ? "This Won lead was already converted or the project details conflict. Review the values and try again." : status === 403 ? "You need Owner access to create or recover a project." : "The project could not be created. Check the details and try again.");
    } finally { creationPending.current = false; setPending(false); }
  };
  const createProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (pending || creationPending.current || uncertainCreation || !branchId) return;
    const scopeNames = scopes.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
    const payload = { branchId, title: title.trim(), deliveryType, scopes: scopeNames, ...(clientId.trim() ? { clientId: clientId.trim() } : {}), ...(wonLeadId.trim() ? { wonLeadId: wonLeadId.trim() } : {}), reason: reason.trim(), ...(templateVersion ? { templateVersionId: templateVersion.id } : {}) };
    const fingerprint = JSON.stringify(payload);
    if (!creationRequest.current || creationRequest.current.fingerprint !== fingerprint) creationRequest.current = { fingerprint, key: crypto.randomUUID() };
    await performCreation({ ...payload, ...(templateVersion ? { idempotencyKey: creationRequest.current.key } : {}) });
  };
  const discardUnconfirmedCreation = (): void => {
    if (pending || !window.confirm("The project may already exist. Discard this recovery request and check the directory before creating another project?")) return;
    setUncertainCreation(undefined); creationRequest.current = undefined; setError("");
  };

  const sendAction = async (path: string, payload: Record<string, unknown>): Promise<void> => {
    if (!detail || pending) return;
    setPending(true); setDetailError(""); setSuccess("");
    try {
      await request(`${API}/${encodeURIComponent(detail.project.id)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ ...payload, ...(path === "/status" && overrideMilestones ? { overrideMilestones: true } : {}), expectedVersion: detail.project.version, reason: reason.trim() }) });
      setReason(""); setOverrideMilestones(false); setConfirmCancellation(false); setSuccess(path === "/cancel" ? "Project cancelled. Unfinished delivery tasks stopped; completed work is retained." : "Action saved."); await selectProject(detail.project.id); await loadList(branchId, true);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "conflict") { await selectProject(detail.project.id); setDetailError("This project changed. The latest details are loaded; review them before retrying."); }
      else setDetailError(cause instanceof Error && cause.message === "denied" ? "You do not have permission for that action." : "The action could not be saved. Try again.");
    } finally { setPending(false); }
  };

  const sendCancellationRequest = async (): Promise<void> => {
    if (!detail || pending) return;
    setPending(true); setDetailError(""); setSuccess("");
    try { await request(`${API}/${encodeURIComponent(detail.project.id)}/cancellation-requests`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ reason: reason.trim() }) }); setReason(""); setSuccess("Cancellation request submitted and pending Owner review."); await selectProject(detail.project.id); }
    catch (cause) { setDetailError(cause instanceof Error && cause.message === "denied" ? "You cannot request cancellation for this project." : "Cancellation request could not be saved. Try again."); }
    finally { setPending(false); }
  };

  const decideScope = async (approvalId: string, outcome: "APPROVED" | "REJECTED"): Promise<void> => {
    if (!detail || pending || reason.trim().length < 3) return;
    setPending(true); setDetailError(""); setSuccess("");
    try {
      await request(`${API}/${encodeURIComponent(detail.project.id)}/scope-requests/${encodeURIComponent(approvalId)}/decision`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ outcome, reason: reason.trim() }) });
      setReason(""); setSuccess(outcome === "APPROVED" ? "Scope change approved." : "Scope change rejected."); await selectProject(detail.project.id);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "conflict") { await selectProject(detail.project.id); setDetailError("This approval changed. The latest project details are loaded."); }
      else setDetailError(cause instanceof Error && cause.message === "denied" ? "You are not the current scope approver." : "The scope decision could not be saved. Try again.");
    } finally { setPending(false); }
  };

  const withdrawScope = async (approvalId: string): Promise<void> => {
    if (!detail || !owner || pending || reason.trim().length < 3) return;
    setPending(true); setDetailError(""); setSuccess("");
    try {
      await request(`${API}/${encodeURIComponent(detail.project.id)}/scope-requests/${encodeURIComponent(approvalId)}/withdraw`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ reason: reason.trim() }) });
      setReason(""); setSuccess("Pending scope request withdrawn. The Owner can change the approver, then the requester may submit again."); await selectProject(detail.project.id);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "conflict") { await selectProject(detail.project.id); setDetailError("This scope request changed. The latest project details are loaded."); }
      else setDetailError(cause instanceof Error && cause.message === "denied" ? "Only the Owner can withdraw a pending scope request." : "The scope request could not be withdrawn. Try again.");
    } finally { setPending(false); }
  };

  const removeContributor = async (employeeId: string): Promise<void> => {
    if (!detail || pending) return;
    setPending(true); setDetailError("");
    try {
      await request(`${API}/${encodeURIComponent(detail.project.id)}/assignments/${encodeURIComponent(employeeId)}`, { method: "DELETE", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ expectedVersion: detail.project.version, reason: reason.trim() }) });
      setSuccess("Contributor assignment removed."); await selectProject(detail.project.id);
    } catch (cause) { if (cause instanceof Error && cause.message === "conflict") { await selectProject(detail.project.id); setDetailError("This project changed. The latest details are loaded; review them before retrying."); } else setDetailError("Contributor assignment could not be removed."); }
    finally { setPending(false); }
  };

  const focusedProject = listFirst && !!selectedId;
  const backToProjects = (): void => {
    if (pending || !leaveTaskContext()) return;
    ++detailRequest.current; activeProjectId.current = ""; loadedProjectId.current = ""; setSelectedId(""); setDetail(undefined); setDetailError(""); setDetailLoading(false); resetProjectDrafts(); writeProjectListContext({ projectId: "" });
  };
  return <section className={`project-workspace${listFirst ? " project-workspace-list-first" : ""}${focusedProject ? " is-project-open" : ""}`} aria-labelledby="projects-heading">
    <header className="project-heading"><div><div className="eyebrow">DELIVERY</div><h1 id="projects-heading">Projects</h1><p>{owner ? "Create Draft projects and review their delivery scopes and history." : "Review projects available to you, including delivery scopes and history."}</p></div><div className="project-heading-actions"><span className="project-count">{total} total</span>{owner && !focusedProject && <button type="button" onClick={() => { const heading = document.getElementById("create-project-heading"); heading?.scrollIntoView?.({ block: "start" }); heading?.focus(); }}>New project</button>}</div></header>
    {error && <div className="project-alert" role="alert"><span>{error}</span><button type="button" onClick={() => branchId || setup ? void loadList(branchId) : void loadSetup()}>Try again</button></div>}
    {success && <p className="project-success" role="status">{success}</p>}
    {confirmedCreationId && <p className="project-success">Created project: <button type="button" disabled={pending} onClick={() => { if (!leaveTaskContext()) return; setProjectSection("overview"); writeProjectListContext({ projectId: confirmedCreationId }); void selectProject(confirmedCreationId); }}>{confirmedCreationId}</button></p>}
    {uncertainCreation && <section className="project-alert project-create-recovery" aria-label="Unconfirmed project creation"><p>{uncertainCreation.retryable ? "Check the same template creation request to recover its result. Submitted details are locked." : "This creation has no retry receipt. Check the project directory and its filters. A matching title does not confirm this request."}</p>{uncertainCreation.retryable && <button ref={recoveryButton} type="button" disabled={pending} onClick={() => void performCreation(uncertainCreation.body)}>Check creation result</button>}<button ref={uncertainCreation.retryable ? undefined : recoveryButton} type="button" disabled={pending || loading} onClick={() => void loadList(branchId, true, offset)}>Check project directory</button><button type="button" disabled={pending} onClick={discardUnconfirmedCreation}>Discard recovery request</button></section>}
    {setupLoading ? <p className="project-status" role="status">Loading project setup…</p> : <>
      {setup && !focusedProject && <label className="project-branch">Project directory<select aria-label="Project branch" disabled={pending} value={branchId} onChange={(event) => { if (!leaveTaskContext()) return; const nextBranch = event.target.value; ++listRequest.current; ++detailRequest.current; setItems([]); setTotal(0); setOffset(0); setBranchId(nextBranch); setSelectedId(""); setDetail(undefined); setDetailError(""); writeProjectListContext({ branchId: nextBranch, offset: 0, projectId: "" }); }}><option value="">All projects available to me</option>{setup.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
      {setup && <div className="project-columns">
        <section className="project-panel" aria-label={focusedProject ? "Selected project" : "Project directory"}>{focusedProject && <button type="button" className="project-quiet-button" disabled={pending} onClick={backToProjects}>← Back to projects</button>}<div hidden={focusedProject}><div className="project-panel-heading"><div><h3 id="project-list-heading">Projects</h3><span className="project-count">Showing {total ? `${offset + 1}–${Math.min(offset + items.length, total)} of ${total}` : "0"}</span></div><button className="project-quiet-button" type="button" onClick={() => { if (leaveTaskContext()) void loadList(branchId, false, offset); }} disabled={loading}>Refresh</button></div>
          <form className="project-list-filters" onSubmit={(event) => { event.preventDefault(); if (!leaveTaskContext()) return; const q = searchDraft.trim(); setSearch(q); setSearchDraft(q); setOffset(0); writeProjectListContext({ q, stageKey, sort, direction, offset: 0, projectId: "" }); setSelectedId(""); setDetail(undefined); }}><label>Search title, delivery type, or current lead<input aria-label="Search projects" maxLength={160} value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} /></label><label>Applied stage key<select aria-label="Applied stage key" value={stageKey} onChange={(event) => { if (!leaveTaskContext()) return; setStageKey(event.target.value); setOffset(0); writeProjectListContext({ stageKey: event.target.value, offset: 0, projectId: "" }); setSelectedId(""); setDetail(undefined); }}><option value="">All applied stages</option>{stageKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select></label><label>Sort projects<select aria-label="Sort projects" value={sort} onChange={(event) => { if (!leaveTaskContext()) return; const nextSort = event.target.value as ProjectListContext["sort"]; setSort(nextSort); setOffset(0); writeProjectListContext({ sort: nextSort, offset: 0 }); }}><option value="created">Created</option><option value="name">Name</option><option value="milestone">Next milestone</option></select></label><label>Direction<select aria-label="Sort direction" value={direction} onChange={(event) => { if (!leaveTaskContext()) return; const nextDirection = event.target.value as ProjectListContext["direction"]; setDirection(nextDirection); setOffset(0); writeProjectListContext({ direction: nextDirection, offset: 0 }); }}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label><button type="submit">Search</button></form>
          {loading ? <p className="project-status" role="status">Loading projects…</p> : items.length === 0 ? <div className="task-empty-state" role="status"><svg className="task-empty-state__icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10m-7 6h4"/></svg><p className="task-empty-state__title">No projects match these filters.</p><button type="button" className="task-empty-state__action" onClick={clearProjectFilters}>Clear filters</button></div> : <ul className="project-list">{items.map((item) => { const scopes = item.scopes ?? []; return <li key={item.id}><button type="button" className={`project-list-item${selectedId === item.id ? " is-selected" : ""}`} disabled={pending} onClick={() => { if (!leaveTaskContext()) return; if (activeProjectId.current !== item.id) setProjectSection("overview"); writeProjectListContext({ projectId: item.id }); void selectProject(item.id); }} aria-pressed={selectedId === item.id}><span><strong>{item.title}</strong><small>{item.deliveryType === "DESIGN" ? "Design" : "Turnkey"} · Lead: {item.currentLeadName ?? "Unassigned"} · {scopes.length} baseline {scopes.length === 1 ? "scope" : "scopes"}{item.appliedStageKeys?.length ? ` · Applied plan stages ${item.appliedStageKeys.join(", ")}` : " · No applied plan stage keys"}{item.nextMilestone ? ` · Next: ${item.nextMilestone.label} (${new Date(item.nextMilestone.targetAt).toLocaleDateString()})` : " · No dated incomplete milestone"}</small></span><span className="project-status-pill">{item.status}</span></button></li>; })}</ul>}
          <nav className="project-pagination" aria-label="Project list pages"><button type="button" onClick={() => { if (!leaveTaskContext()) return; const next = offset - 50; writeProjectListContext({ offset: next, projectId: "" }); changePage(next); }} disabled={loading || total === 0 || offset === 0}>Previous</button><span>{total ? `Page ${Math.floor(offset / 50) + 1} of ${Math.ceil(total / 50)}` : "No pages"}</span><button type="button" onClick={() => { if (!leaveTaskContext()) return; const next = offset + 50; writeProjectListContext({ offset: next, projectId: "" }); changePage(next); }} disabled={loading || offset + 50 >= total}>Next</button></nav>
          </div>{detailLoading && <p className="project-status" role="status">Loading project details…</p>}{detailError && <p role="alert" className="project-inline-error">{detailError}</p>}
          {detail && <article className="project-detail"><div className="project-detail-heading"><div><div className="eyebrow">PROJECT DETAIL</div><h3>{detail.project.title}</h3></div><span className="project-status-pill">{detail.project.status}</span></div><nav ref={sectionNavigation} className="project-section-nav" aria-label={`${detail.project.title} sections`}>{projectSections.map((section) => <button key={section} type="button" disabled={pending} aria-current={projectSection === section ? "page" : undefined} onClick={() => { if (section !== projectSection && !leaveTaskContext()) return; setProjectSection(section); writeProjectSection(section, detail.project.id); }}>{section === "overview" ? "Overview" : section === "plan" ? "Plan" : section === "tasks" ? "Tasks" : section === "people" ? "People" : section === "documents" ? "Documents" : section === "reviews" ? "Reviews" : section === "delivery" ? "Delivery" : "Activity"}</button>)}</nav><h4 className="project-active-section">{projectSection === "overview" ? "Overview" : projectSection === "plan" ? "Plan" : projectSection === "tasks" ? "Tasks" : projectSection === "people" ? "People" : projectSection === "documents" ? "Documents" : projectSection === "reviews" ? "Reviews" : projectSection === "delivery" ? "Delivery" : "Activity"}</h4>{["overview", "people", "activity"].includes(projectSection) && <label className="project-shared-reason">Reason for project action<input aria-label="Project action reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} /></label>}<section className="project-section-panel" hidden={projectSection !== "overview"}><dl><div><dt>Branch</dt><dd>{detail.project.branch.name}</dd></div><div><dt>Delivery type</dt><dd>{detail.project.deliveryType === "DESIGN" ? "Design" : "Turnkey"}</dd></div><div><dt>Client</dt><dd>{detail.project.client?.name ?? "Not linked"}</dd></div></dl><h4>Baseline scopes</h4><ul className="project-scope-list">{detail.project.scopes.map((scope) => <li key={scope.id}>{scope.name}</li>)}</ul>{detail.wonLeadProvenance && <p className="project-provenance">Converted from Won lead · recorded {new Date(detail.wonLeadProvenance.occurredAt).toLocaleString()}</p>}</section><section className="project-section-panel" hidden={projectSection !== "activity"}><h4>History and requests</h4><ul className="project-history">{(detail.project.statusChanges ?? []).map((row) => <li key={row.id}>{row.fromStatus ?? "Created"} → {row.toStatus} · {row.reason}</li>)}{(detail.transfers ?? []).map((row, index) => <li key={`transfer-${index}`}>Branch transfer · {row.reason}. Contributors whose home branch differs from the new owning branch need an explicit Owner regrant.</li>)}{(detail.leadChanges ?? []).map((row, index) => <li key={`lead-${index}`}>Lead change · {row.reason}</li>)}{(detail.scopeChanges ?? []).map((row, index) => <li key={`scope-${index}`}>Scope change: {row.name} · {row.status} · {row.reason}{row.approvalId && (row.approval?.state === "PENDING" || row.status === "PENDING") && <span className="project-scope-decision">{detail.capabilities?.decideScope && <><button type="button" disabled={pending || reason.trim().length < 3} onClick={() => void decideScope(row.approvalId!, "APPROVED")}>Approve</button><button type="button" disabled={pending || reason.trim().length < 3} onClick={() => void decideScope(row.approvalId!, "REJECTED")}>Reject</button></>}{owner && <button type="button" disabled={pending || reason.trim().length < 3} onClick={() => void withdrawScope(row.approvalId!)}>Withdraw</button>}</span>}</li>)}{(detail.cancellationRequests ?? []).map((row, index) => <li key={`cancel-${index}`}>Cancellation request · {row.status} · {row.reason}</li>)}</ul>
            {detail.scopeChanges?.some((row) => detail.capabilities?.decideScope && row.approvalId && (row.approval?.state === "PENDING" || row.status === "PENDING")) && <p className="project-decision-help">Enter a decision reason above before approving or rejecting a pending scope change. The requester cannot approve their own request.</p>}
            {owner && detail.scopeChanges?.some((row) => row.approvalId && (row.approval?.state === "PENDING" || row.status === "PENDING")) && <p className="project-decision-help">If the named approver is unavailable, withdraw the request with a reason, change the approver above, then the requester may submit again.</p>}</section><section className="project-section-panel" hidden={projectSection !== "people"}><h4>Project Lead</h4><p>{detail.currentLeadName ?? detail.project.currentLeadName ?? setup?.employees?.find((employee) => employee.id === (detail.currentLeadEmployeeId ?? detail.project.currentLeadEmployeeId))?.name ?? "No Project Lead assigned"}</p>
            <h4>Assigned contributors</h4>{(detail.assignments ?? []).length ? <ul className="project-history">{detail.assignments?.map((row) => <li key={row.employeeId}>{row.employee?.name ?? row.name ?? row.employeeId}{owner && !["CANCELLED", "ARCHIVED"].includes(detail.project.status) && <button type="button" disabled={pending || reason.trim().length < 3} onClick={() => void removeContributor(row.employeeId)}>Remove</button>}</li>)}</ul> : <p>No additional contributors</p>}
            <div className="project-actions">              {owner && !["CANCELLED", "ARCHIVED"].includes(detail.project.status) && <div className="project-action-row"><select aria-label="Project lead" value={actionEmployee} onChange={(event) => setActionEmployee(event.target.value)}><option value="">Choose active employee</option>{setup?.employees?.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select><button disabled={pending || !actionEmployee || reason.trim().length < 3} onClick={() => void sendAction("/lead", { employeeId: actionEmployee })}>Set lead</button></div>}              {owner && !["CANCELLED", "ARCHIVED"].includes(detail.project.status) && <div className="project-action-row"><select aria-label="Contributor" value={actionEmployee} onChange={(event) => setActionEmployee(event.target.value)}><option value="">Choose employee</option>{setup?.employees?.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select><button disabled={pending || !actionEmployee || reason.trim().length < 3} onClick={() => void sendAction("/assignments", { employeeId: actionEmployee })}>Assign contributor</button></div>}</div></section><section className="project-section-panel" hidden={projectSection !== "plan"}><h4>Plan</h4><div id="project-plan"><ProjectPlan projectId={detail.project.id} projectVersion={detail.project.version} csrfToken={csrfToken} onSaved={() => void selectProject(detail.project.id)} /></div></section><section className="project-section-panel project-task-panel" hidden={projectSection !== "tasks"}>{projectSection === "tasks" && <TaskWorkspace key={detail.project.id} csrfToken={csrfToken} owner={owner} listFirst projectContext={{ id: detail.project.id, title: detail.project.title, status: detail.project.status }} onLeaveGuard={registerTaskGuard} onSessionExpired={taskSessionExpired} />}</section><section className="project-section-panel" hidden={projectSection !== "documents"}><p>Files available to you in this project. Open Documents for folders, uploads and file access; revision records have their own workspace.</p>{projectSection === "documents" && <><ConfirmedDrawings key={`confirmed:${detail.project.id}`} projectId={detail.project.id} onSessionExpired={taskSessionExpired} /><ProjectResourceSummary key={`documents:${detail.project.id}`} projectId={detail.project.id} kind="documents" onSessionExpired={taskSessionExpired} /></>}<div className="project-section-links"><a href={`/documents?projectId=${encodeURIComponent(detail.project.id)}`}>Open documents</a><a href={`/revisions?projectId=${encodeURIComponent(detail.project.id)}`}>Open design / revisions</a></div></section><section className="project-section-panel" hidden={projectSection !== "reviews"}><p>Waiting internal rounds you can currently access, ordered by due date. Client review uses its separate workspace.</p>{projectSection === "reviews" && <ProjectResourceSummary key={`reviews:${detail.project.id}`} projectId={detail.project.id} kind="reviews" onSessionExpired={taskSessionExpired} />}<div className="project-section-links"><a href={`/reviews?projectId=${encodeURIComponent(detail.project.id)}`}>Open internal reviews</a><a href={`/client-reviews?projectId=${encodeURIComponent(detail.project.id)}`}>Open client reviews</a></div></section><section className="project-section-panel" hidden={projectSection !== "delivery"}>{detail.project.deliveryType === "TURNKEY" ? <div className="project-section-links"><a href={`/turnkey?projectId=${encodeURIComponent(detail.project.id)}`}>Open Turnkey operations</a>{detail.project.status === "ACTIVE" ? <a href={`/site?projectId=${encodeURIComponent(detail.project.id)}`}>Open Site delivery</a> : <p>Site delivery currently lists active projects only.</p>}</div> : <div><p>Design delivery follows this project’s Plan, revisions and review workflows. Current project state: {detail.project.status.replaceAll("_", " ").toLowerCase()}.</p><div className="project-section-links"><a href={`/projects?projectId=${encodeURIComponent(detail.project.id)}&projectSection=plan#project-plan`}>Open delivery plan</a><a href={`/revisions?projectId=${encodeURIComponent(detail.project.id)}`}>Open design / revisions</a><a href={`/reviews?projectId=${encodeURIComponent(detail.project.id)}`}>Open internal reviews</a><a href={`/client-reviews?projectId=${encodeURIComponent(detail.project.id)}`}>Open client reviews</a></div></div>}</section><section className="project-section-panel" hidden={projectSection !== "overview"}><div className="project-actions">
              {["CANCELLED", "ARCHIVED"].includes(detail.project.status) ? <p>This project is closed. Its delivery history is retained. Approved closeout work is managed in Tasks.</p> : <>


              {((detail.capabilities?.changeStatus ?? owner) || detail.capabilities?.manageLifecycle) && <div className="project-action-row"><select aria-label="New project status" value={actionStatus} onChange={(event) => { setActionStatus(event.target.value); setOverrideMilestones(false); }}><option value="">Choose status</option>{["ACTIVE", "ON_HOLD", "COMPLETED", "ARCHIVED"].map((status) => <option key={status}>{status}</option>)}</select><button disabled={pending || !actionStatus || reason.trim().length < 3 || (actionStatus === "COMPLETED" && !owner && !detail.capabilities?.override)} onClick={() => void sendAction("/status", { toStatus: actionStatus })}>Change status</button><small>Project gates apply before completion.</small>{actionStatus === "COMPLETED" && detail.capabilities?.override && <label className="project-override-option"><input type="checkbox" checked={overrideMilestones} onChange={(event) => setOverrideMilestones(event.target.checked)} />Override incomplete required milestones with this reason</label>}</div>}
              {owner && ["DRAFT", "ACTIVE", "ON_HOLD"].includes(detail.project.status) && <div className="project-action-row"><label><input type="checkbox" checked={confirmCancellation} onChange={(event) => setConfirmCancellation(event.target.checked)} />Stop unfinished delivery work and retain completed work and history</label><button disabled={pending || !confirmCancellation || reason.trim().length < 3} onClick={() => void sendAction("/cancel", {})}>Cancel project</button></div>}
              {owner && <><div className="project-action-row"><select aria-label="Transfer owning branch" value={actionBranch} onChange={(event) => setActionBranch(event.target.value)}><option value="">Choose branch</option>{setup?.branches.filter((branch) => branch.id !== branchId).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><button disabled={pending || !actionBranch || reason.trim().length < 3} onClick={() => void sendAction("/transfer", { toBranchId: actionBranch })}>Transfer branch</button></div><div className="project-action-row"><select aria-label="Scope approver" value={actionAccount} onChange={(event) => setActionAccount(event.target.value)}><option value="">Choose scope approver</option>{setup?.ownerAccountId && <option value={setup.ownerAccountId}>Owner</option>}{setup?.employees?.map((employee) => <option key={employee.accountId} value={employee.accountId}>{employee.name}</option>)}</select><button disabled={pending || !actionAccount || reason.trim().length < 3} onClick={() => void sendAction("/scope-approver", { accountId: actionAccount })}>Set scope approver</button></div></>}
              {((detail.capabilities?.requestScopeChange ?? owner) || detail.capabilities?.requestScope) && <div className="project-action-row"><input aria-label="Proposed scope" placeholder="Proposed service scope" value={actionScope} onChange={(event) => setActionScope(event.target.value)} /><button disabled={pending || !actionScope.trim() || reason.trim().length < 3} onClick={() => void sendAction("/scope-requests", { name: actionScope.trim() })}>Request scope change</button></div>}
              {!owner && detail.capabilities?.requestCancellation && <button disabled={pending || reason.trim().length < 3} onClick={() => void sendCancellationRequest()}>Request cancellation</button>}
              </>}
            </div></section></article>}
        </section>
        {owner && !focusedProject && <section className="project-panel project-create-panel" aria-labelledby="create-project-heading"><div className="project-panel-heading"><h3 id="create-project-heading" tabIndex={-1}>Create Draft project</h3><span className="project-status-pill">Draft</span></div><details className="project-template-disclosure"><summary>Project template (optional)</summary><fieldset className="project-create-fields" disabled={pending || !!uncertainCreation}><legend className="task-sr-only">Project template</legend><ProjectTemplatePanel owner={owner} csrfToken={csrfToken} onTemplateChange={applyTemplateVersion} resetKey={templateReset} /></fieldset></details><form className="project-form" aria-label="Create project" onSubmit={(event) => void createProject(event)}><fieldset className="project-create-fields" disabled={pending || !!uncertainCreation}><legend className="task-sr-only">Project details</legend>
          <label>Project title<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={160} required /></label>
          <label>Delivery type<select value={deliveryType} disabled={!!templateVersion} onChange={(event) => setDeliveryType(event.target.value as "DESIGN" | "TURNKEY")}><option value="DESIGN">Design</option><option value="TURNKEY">Turnkey</option></select></label>
          <label>Initial service scopes<textarea aria-label="Initial service scopes" value={scopes} readOnly={!!templateVersion} onChange={(event) => setScopes(event.target.value)} placeholder={"Architecture\nInterior design"} required rows={3} /><small>{templateVersion ? "Scopes come from the selected template version. Choose current project setup to enter different scopes." : "Enter 1–12 scopes, one per line or separated by commas."}</small></label>
          <ProjectRelationships branchId={branchId} clientId={clientId} wonLeadId={wonLeadId} onClient={setClientId} onLead={setWonLeadId} disabled={pending || !!uncertainCreation} />
          <label>Creation reason<input value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
          <button className="project-primary-button" type="submit" disabled={pending || !branchId}>{pending ? "Creating Draft…" : "Create Draft project"}</button>
        </fieldset></form></section>}
      </div>}
      {!owner && !focusedProject && <details className="project-template-disclosure"><summary>Project template reference</summary><ProjectTemplatePanel owner={false} csrfToken={csrfToken} onTemplateChange={applyTemplateVersion} resetKey={templateReset} /></details>}
    </>}
  </section>;
}
