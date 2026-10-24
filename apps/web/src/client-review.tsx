import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PortalSession } from "./client-portal-auth.js";
import { ClientProjectGallery, StaffProjectGallery } from "./gallery.js";
import { loadBranchProjects } from "./client-review-project-loader.js";
import "./client-review.css";

const PORTAL = "/api/v1/client-portal";
const STAFF = "/api/v1/client-reviews";
type Project = { id: string; title: string; status: string; primary?: boolean; expiresAt?: string | null; grantId?: string; version?: number };
type Annotation = { page: number; x: number; y: number; text: string };
type Comment = { id: string; authorEmail: string; text: string; annotations: Annotation[]; referenceId: string | null; createdAt: string };
type Item = {
  workEvidence?: { kind: "DRAWING" | "FILE" | "LINK"; fileId: string | null; url: string | null };
  id: string; label: string; status: string; version: number; taskId?: string; taskStatus?: string;
  task: { id: string; title: string; status: string } | null;
  revision: { id: string; label: string; mimeType: string } | null;
  decision?: { kind: string; comment: string; createdAt: string } | null;
  ownDecision?: { kind: string; comment?: string; createdAt: string } | null;
  comments?: Comment[];
  permissions?: { view: boolean; comment: boolean; review: boolean; approve: boolean; download: boolean };
  classification?: { category: "PREFERENCE_NEW_REQUIREMENT" | "EMPLOYEE_WORK_ERROR"; version: number } | null;
  correctionTaskId?: string | null;
};
type Package = { id: string; title: string; status: string; version: number; items: Item[] };
type ApprovalHistoryRow = { id: string; packageId: string; signatureName: string; createdAt: string; closedAt?: string | null; kind?: string };
type ProjectReviews = { project: { id: string; title: string; status: string }; packages: Package[]; ownApprovalHistory?: { itemDecisions?: ApprovalHistoryRow[]; finalApprovals?: ApprovalHistoryRow[] }; eligibleTasks?: Array<TaskOption & { description?: string; reviewRequirement?: string; targetDate?: string | null; primaryOwnerEmployeeId?: string | null; approvedWork?: { submissionId: string; revisionId: string | null; kind: string } | null; revisions: Array<RevisionOption & { state: string; drawingId: string }> }>; correctionOwners?: Array<{ employeeId: string; name: string }>; capabilities?: { manage?: boolean; classify?: boolean; assignCorrection?: boolean } };
type PortalProjectList = { projects: Project[] };
type ClientAccessUser = { id: string; accountId: string; email: string; primary: boolean; expiresAt: string | null; revokedAt: string | null; version: number; items: Array<{ itemId: string; version: number; view: boolean; comment: boolean; review: boolean; approve: boolean; download: boolean }> };
type ProjectAccess = { users: ClientAccessUser[] };
type OwnerGrant = { id: string; accountId: string; primary: boolean; expiresAt: string | null; revokedAt: string | null; version: number; email?: string };
type OwnerProjectAccess = { projectVersion: number; grants: OwnerGrant[] };
type HandoverIssue = { id: string; purpose: string; issuedAt: string; items: Array<{ itemId: string; revisionId: string; label: string; sha256: string; mime: string; superseded: boolean }>; acknowledgementRequired: boolean; acknowledgedAt: string | null; canAcknowledge: boolean };
type ProjectHandover = { issues: HandoverIssue[] };
type InternalProjectList = { items: Project[] };
type TaskOption = { id: string; title: string; version: number; status: string };
type RevisionOption = { id: string; label: string; mimeType: string; taskId?: string };

async function request<T>(url: string, csrfToken?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, headers });
  if (!response.ok) throw Object.assign(new Error("request-failed"), { status: response.status });
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function bodyInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function errorText(error: unknown, fallback: string): string {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: number }).status : undefined;
  if (status === 401) return "Your session expired or access was revoked. Sign in again.";
  if (status === 403) return "This action is not available for your current access.";
  if (status === 409) return "This review changed. Refresh it and check the latest status.";
  return fallback;
}

function dateText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

export function ClientReviewPortal({ session, requestedProjectId, requestedItemId }: { session: PortalSession; requestedProjectId?: string; requestedItemId?: string }): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [reviews, setReviews] = useState<ProjectReviews>();
  const [item, setItem] = useState<Item>();
  const [selectedItemId, setSelectedItemId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [comment, setComment] = useState("");
  const [annotationPage, setAnnotationPage] = useState("1");
  const [annotationX, setAnnotationX] = useState("0.5");
  const [annotationY, setAnnotationY] = useState("0.5");
  const [annotationText, setAnnotationText] = useState("");
  const [reason, setReason] = useState("");
  const [signatureName, setSignatureName] = useState("");
  const [consent, setConsent] = useState(false);
  const [proofBusy, setProofBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteReason, setInviteReason] = useState("");
  const [accessUsers, setAccessUsers] = useState<ClientAccessUser[]>([]);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantItemId, setGrantItemId] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [grantFlags, setGrantFlags] = useState({ view: true, comment: false, review: false, approve: false, download: false });
  const [handover, setHandover] = useState<ProjectHandover>();

  const refresh = async (id = projectId): Promise<void> => {
    if (!id) return;
    setError("");
    try {
      const result = await request<ProjectReviews>(`${PORTAL}/reviews/projects/${encodeURIComponent(id)}`);
      setReviews(result);
      try { setHandover(await request<ProjectHandover>(`${PORTAL}/projects/${encodeURIComponent(id)}/handover`)); } catch { setHandover(undefined); }
      if (currentProject?.primary) {
        try { const access = await request<ProjectAccess>(`${PORTAL}/projects/${encodeURIComponent(id)}/access`); setAccessUsers(access.users); }
        catch { setAccessUsers([]); }
      }
      const stillVisible = result.packages.flatMap((pack) => pack.items).some((value) => value.id === selectedItemId);
      if (selectedItemId && stillVisible) await loadItem(id, selectedItemId);
      else { setSelectedItemId(""); setItem(undefined); }
    } catch (cause) { setError(errorText(cause, "Client reviews could not be loaded. Try again.")); setReviews(undefined); }
  };

  const loadItem = async (project: string, id: string): Promise<void> => {
    setError(""); setSelectedItemId(id); setItem(undefined);
    try { setItem(await request<Item>(`${PORTAL}/reviews/items/${encodeURIComponent(id)}`)); }
    catch (cause) { setError(errorText(cause, "This review item could not be opened.")); }
  };

  useEffect(() => {
    let live = true;
    void request<PortalProjectList>(`${PORTAL}/projects`).then((result) => {
      if (!live) return;
      setProjects(result.projects);
      const first = requestedProjectId ?? result.projects[0]?.id ?? "";
      if (requestedProjectId && !result.projects.some(project => project.id === requestedProjectId)) { setError("This project is not available under your current access."); return; }
      setProjectId(first);
      if (first) void request<ProjectReviews>(`${PORTAL}/reviews/projects/${encodeURIComponent(first)}`).then((value) => {
        if (!live) return;
        setReviews(value);
        if (requestedItemId) {
          if (!value.packages.some(pack => pack.items.some(entry => entry.id === requestedItemId))) { setError("This item is not available in the selected project."); return; }
          setSelectedItemId(requestedItemId);
          void request<Item>(`${PORTAL}/reviews/items/${encodeURIComponent(requestedItemId)}`).then(item => { if (live) setItem(item); }).catch(cause => { if (live) setError(errorText(cause, "This review item could not be opened.")); });
        }
      }).catch((cause) => { if (live) setError(errorText(cause, "Client reviews could not be loaded. Try again.")); });
      if (first) void request<ProjectHandover>(`${PORTAL}/projects/${encodeURIComponent(first)}/handover`).then((value) => { if (live) setHandover(value); }).catch(() => { if (live) setHandover(undefined); });
      if (result.projects.find(project => project.id === first)?.primary) void request<ProjectAccess>(`${PORTAL}/projects/${encodeURIComponent(first)}/access`).then((value) => { if (live) setAccessUsers(value.users); }).catch(() => { if (live) setAccessUsers([]); });
    }).catch((cause) => { if (live) setError(errorText(cause, "Your client projects could not be loaded. Try again.")); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const allItems = useMemo(() => reviews?.packages.flatMap((pack) => pack.items.map((entry) => ({ ...entry, packageId: pack.id, packageTitle: pack.title, packageStatus: pack.status, packageVersion: pack.version }))) ?? [], [reviews]);
  const selectedSummary = allItems.find((entry) => entry.id === selectedItemId);
  const selected = selectedSummary && item?.id === selectedItemId ? { ...selectedSummary, ...item } : selectedSummary;
  const currentProject = projects.find((project) => project.id === projectId);
  const canComment = Boolean(selected && reviews?.project.status !== "CANCELLED" && (currentProject?.primary || selected.permissions?.comment) && !["WITHDRAWN", "APPROVED", "REVISION_REQUIRED", "REJECTED"].includes(selected.status));
  const canReview = Boolean(selected && reviews?.project.status !== "CANCELLED" && (currentProject?.primary || selected.permissions?.review));
  const canApproveItem = Boolean(selected && reviews?.project.status !== "CANCELLED" && (currentProject?.primary || selected.permissions?.approve));
  const canFinalApprove = Boolean(currentProject?.primary && reviews?.project.status !== "CANCELLED" && selected && selected.packageStatus === "OPEN" && allItems.filter((entry) => entry.packageId === selected.packageId).length > 0 && allItems.filter((entry) => entry.packageId === selected.packageId).every((entry) => entry.status === "APPROVED"));

  const changeProject = async (nextId: string): Promise<void> => {
    setProjectId(nextId); setReviews(undefined); setItem(undefined); setSelectedItemId(""); setNotice(""); setError(""); setAccessUsers([]); setHandover(undefined);
    if (!nextId) return;
    setLoading(true);
    try {
      const result = await request<ProjectReviews>(`${PORTAL}/reviews/projects/${encodeURIComponent(nextId)}`);
      setReviews(result);
      try { setHandover(await request<ProjectHandover>(`${PORTAL}/projects/${encodeURIComponent(nextId)}/handover`)); } catch { setHandover(undefined); }
      if (projects.find((project) => project.id === nextId)?.primary) {
        try { const access = await request<ProjectAccess>(`${PORTAL}/projects/${encodeURIComponent(nextId)}/access`); setAccessUsers(access.users); } catch { setAccessUsers([]); }
      }
    }
    catch (cause) { setError(errorText(cause, "Client reviews could not be loaded. Try again.")); }
    finally { setLoading(false); }
  };

  const submit = async (url: string, payload: unknown, success: string): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await request<Item>(url, session.csrfToken, bodyInit("POST", payload));
      setItem(updated); setNotice(success); await refresh();
    } catch (cause) { setError(errorText(cause, "We couldn’t save that review action. Try again.")); }
    finally { setBusy(false); }
  };

  const startReview = async (): Promise<void> => {
    if (!selected || (!currentProject?.primary && !selected.permissions?.review) || reviews?.project.status === "CANCELLED") return;
    await submit(`${PORTAL}/reviews/items/${encodeURIComponent(selected.id)}/start`, { expectedVersion: selected.version, reason: "Client opened review" }, "Review started.");
  };

  const postComment = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selected || comment.trim().length < 1) return;
    const annotations: Annotation[] = annotationText.trim() ? [{ page: Number(annotationPage), x: Number(annotationX), y: Number(annotationY), text: annotationText.trim() }] : [];
    await submit(`${PORTAL}/reviews/items/${encodeURIComponent(selected.id)}/comments`, { text: comment.trim(), ...(annotations.length ? { annotations } : {}), reason: reason.trim() || "Client review comment" }, "Comment saved.");
    setComment(""); setAnnotationText(""); setReason("");
  };

  const uploadReference = async (file?: File): Promise<void> => {
    if (!selected || !file) return;
    if (!/^application\/pdf$|^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) { setError("Choose a PDF or image no larger than 8 MB."); return; }
    setBusy(true); setError("");
    try {
      await request(`${PORTAL}/items/${encodeURIComponent(selected.id)}/references`, session.csrfToken, {
        method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": file.name, "X-File-Mime": file.type, "X-Reason": reason.trim() || "Client review reference" }, body: file
      });
      setNotice("Reference uploaded securely."); setReason(""); await refresh();
    } catch (cause) { setError(errorText(cause, "Reference upload failed. Try again.")); }
    finally { setBusy(false); }
  };

  const decide = async (kind: "REVISION_REQUIRED" | "REJECTED" | "APPROVED"): Promise<void> => {
    if (!selected) return;
    const approval = kind === "APPROVED";
    if (approval && (!(currentProject?.primary || selected.permissions?.approve) || reviews?.project.status === "CANCELLED" || !session.activePasskeyCount || !signatureName.trim() || !consent)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      let proof: { ceremonyId: string; response: unknown } | undefined;
      if (approval) {
        setProofBusy(true);
        const ceremony = await request<{ ceremonyId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(`${PORTAL}/reviews/items/${encodeURIComponent(selected.id)}/approval-options`, session.csrfToken, bodyInit("POST", { expectedVersion: selected.version, signatureName: signatureName.trim(), consent: true, comment: comment.trim() }));
        proof = { ceremonyId: ceremony.ceremonyId, response: await startAuthentication({ optionsJSON: ceremony.options }) };
      }
      const updated = await request<Item>(`${PORTAL}/reviews/items/${encodeURIComponent(selected.id)}/decision`, session.csrfToken, bodyInit("POST", { kind, expectedVersion: selected.version, comment: comment.trim(), reason: reason.trim() || "Client review decision", ...(approval ? { signatureName: signatureName.trim(), consent: true, ...proof } : {}) }));
      setItem(updated); setNotice(approval ? "Item approved with passkey verification." : kind === "REJECTED" ? "Item rejected." : "Revision requested.");
      setComment(""); setReason(""); await refresh();
    } catch (cause) { setError(errorText(cause, cause instanceof Error && cause.name === "NotAllowedError" ? "Passkey verification was cancelled." : "We couldn’t record that decision.")); }
    finally { setBusy(false); setProofBusy(false); }
  };

  const finalApprove = async (packageId: string): Promise<void> => {
    if (!selected || !canFinalApprove || !signatureName.trim() || !consent || !session.activePasskeyCount) return;
    setBusy(true); setProofBusy(true); setError(""); setNotice("");
    try {
      const currentPackage = reviews?.packages.find((pack) => pack.id === packageId);
      if (!currentPackage) throw new Error("Package missing");
      const options = await request<{ ceremonyId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(`${PORTAL}/reviews/packages/${encodeURIComponent(packageId)}/approval-options`, session.csrfToken, bodyInit("POST", { expectedVersion: currentPackage.version, signatureName: signatureName.trim(), consent: true, comment: comment.trim() }));
      const response = await startAuthentication({ optionsJSON: options.options });
      await request(`${PORTAL}/reviews/packages/${encodeURIComponent(packageId)}/final-approval`, session.csrfToken, bodyInit("POST", { expectedVersion: currentPackage.version, signatureName: signatureName.trim(), consent: true, comment: comment.trim(), reason: reason.trim() || "Final client approval", ceremonyId: options.ceremonyId, response }));
      setNotice("Final package approval recorded with passkey verification."); setComment(""); setReason(""); setConsent(false); await refresh();
    } catch (cause) { setError(errorText(cause, cause instanceof Error && cause.name === "NotAllowedError" ? "Passkey verification was cancelled." : "Final approval could not be recorded.")); }
    finally { setBusy(false); setProofBusy(false); }
  };

  const invite = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!currentProject?.primary) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`${PORTAL}/projects/${encodeURIComponent(currentProject.id)}/invitations`, session.csrfToken, bodyInit("POST", { email: inviteEmail.trim(), reason: inviteReason.trim() }));
      setInviteEmail(""); setInviteReason(""); setNotice("Invitation saved. Delivery status is managed separately.");
    } catch (cause) { setError(errorText(cause, "Invitation could not be saved.")); }
    finally { setBusy(false); }
  };

  const saveItemGrant = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!currentProject?.primary || !grantUserId || !grantItemId) return;
    const targetUser = accessUsers.find((user) => user.id === grantUserId);
    const existing = targetUser?.items.find((grant) => grant.itemId === grantItemId);
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`${PORTAL}/item-grants`, session.csrfToken, bodyInit("POST", {
        itemId: grantItemId, portalGrantId: grantUserId, ...grantFlags,
        expectedVersion: existing?.version ?? 0, reason: grantReason.trim()
      }));
      setNotice("Item access updated."); setGrantReason("");
      const access = await request<ProjectAccess>(`${PORTAL}/projects/${encodeURIComponent(currentProject.id)}/access`); setAccessUsers(access.users);
    } catch (cause) { setError(errorText(cause, "Item access could not be updated.")); }
    finally { setBusy(false); }
  };

  const acknowledgeHandover = async (issueId: string): Promise<void> => {
    if (!projectId || !reason.trim() || reviews?.project.status === "CANCELLED") return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`${PORTAL}/handover/${encodeURIComponent(issueId)}/acknowledge`, session.csrfToken, bodyInit("POST", { note: comment.trim(), reason: reason.trim() }));
      setNotice("Handover acknowledged."); setComment(""); setReason(""); setHandover(await request<ProjectHandover>(`${PORTAL}/projects/${encodeURIComponent(projectId)}/handover`));
    } catch (cause) { setError(errorText(cause, "Handover acknowledgement could not be saved.")); }
    finally { setBusy(false); }
  };

  return <section className="client-review-workspace" aria-labelledby="client-review-heading">
    <header className="client-review-header"><div><p className="client-review-eyebrow">PROJECT REVIEWS</p><h2 id="client-review-heading">Client review</h2><p>Review only the items and files shared with this client account.</p></div><label>Project<select aria-label="Client project" value={projectId} onChange={(event) => void changeProject(event.target.value)} disabled={loading || projects.length === 0}><option value="">Choose a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title} · {project.status}</option>)}</select></label></header>
    {loading && <p className="client-review-muted" role="status">Loading client projects…</p>}
    {error && <div className="client-review-error"><p role="alert">{error}</p><button type="button" onClick={() => void refresh()}>Try again</button></div>}
    {notice && <p className="client-review-notice" role="status">{notice}</p>}
    {!loading && !error && projects.length === 0 && <p className="client-review-empty" role="status">No client projects are currently available to this account.</p>}
    {currentProject?.expiresAt && <p className="client-review-expiry" role="note">Project access expires {dateText(currentProject.expiresAt)}.</p>}
    {currentProject && !loading && <ClientProjectGallery projectId={projectId} session={session} />}
    {handover?.issues?.map((issue) => <section className="client-review-panel" key={issue.id} aria-label={`Issued handover ${issue.purpose}`}><div><h3>Issued handover · {issue.purpose}</h3><p>Issued {dateText(issue.issuedAt)}{issue.acknowledgedAt ? ` · acknowledged ${dateText(issue.acknowledgedAt)}` : ""}</p></div><div className="client-review-file">{issue.items.filter((file) => !file.superseded).map((file) => <div className="client-review-gallery-item" key={file.itemId}><a href={`${PORTAL}/items/${encodeURIComponent(file.itemId)}/stream`} target="_blank" rel="noreferrer">{file.label} · {file.mime}</a>{file.mime.startsWith("image/") && <img src={`${PORTAL}/items/${encodeURIComponent(file.itemId)}/stream`} alt={`Issued image: ${file.label}`} loading="lazy" />}</div>)}</div>{issue.acknowledgementRequired && issue.canAcknowledge && !issue.acknowledgedAt && <><label>Handover note<textarea maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value)} /></label><label>Reason<input minLength={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void acknowledgeHandover(issue.id)}>Acknowledge handover</button></>}</section>)}
    {currentProject?.primary && reviews?.project.status !== "CANCELLED" && <section className="client-review-panel" aria-labelledby="client-invite-heading"><h3 id="client-invite-heading">Invite and configure client access</h3><p>Additional clients receive only the project and exact-item capabilities you grant.</p><form className="client-review-form client-review-invite" onSubmit={(event) => void invite(event)}><label>Email<input type="email" required maxLength={320} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /></label><label>Reason<input required minLength={3} maxLength={1000} value={inviteReason} onChange={(event) => setInviteReason(event.target.value)} /></label><button disabled={busy || !inviteEmail.trim() || inviteReason.trim().length < 3}>{busy ? "Saving…" : "Invite client"}</button></form>{accessUsers.length > 0 && <><ul className="client-review-access-list">{accessUsers.map((user) => <li key={user.id}><strong>{user.email}</strong><span>Access expires {user.expiresAt ? dateText(user.expiresAt) : "as currently configured"}</span><small>{user.items.length} item grant{user.items.length === 1 ? "" : "s"}</small></li>)}</ul><form className="client-review-form client-review-grant" onSubmit={(event) => void saveItemGrant(event)}><h4>Set item capabilities</h4><label>Additional client<select required value={grantUserId} onChange={(event) => setGrantUserId(event.target.value)}><option value="">Choose client</option>{accessUsers.filter((user) => !user.primary && !user.revokedAt).map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}</select></label><label>Review item<select required value={grantItemId} onChange={(event) => setGrantItemId(event.target.value)}><option value="">Choose item</option>{allItems.map((entry) => <option key={entry.id} value={entry.id}>{entry.label || entry.task?.title || "Issued revision"}</option>)}</select></label><div className="client-review-capabilities">{(["view", "comment", "review", "approve", "download"] as const).map((flag) => <label key={flag}><input type="checkbox" checked={grantFlags[flag]} onChange={(event) => setGrantFlags((current) => ({ ...current, [flag]: event.target.checked }))} />{flag[0]?.toUpperCase()}{flag.slice(1)}</label>)}</div><label>Reason<input minLength={3} maxLength={1000} required value={grantReason} onChange={(event) => setGrantReason(event.target.value)} /></label><button disabled={busy || !grantUserId || !grantItemId || grantReason.trim().length < 3}>Save item access</button></form></>}</section>}
    {!loading && reviews && <>{((reviews.ownApprovalHistory?.itemDecisions?.length ?? 0) + (reviews.ownApprovalHistory?.finalApprovals?.length ?? 0)) > 0 && <section className="client-review-panel" aria-label="Your approval history"><h3>Your approval history</h3><ul>{[...(reviews.ownApprovalHistory?.itemDecisions ?? []), ...(reviews.ownApprovalHistory?.finalApprovals ?? [])].map((entry) => <li key={entry.id}>{entry.kind ?? "Approval"}{entry.signatureName ? ` · ${entry.signatureName}` : ""} · {dateText(entry.createdAt)}{entry.closedAt ? ` · closed ${dateText(entry.closedAt)}` : ""}</li>)}</ul></section>}<div className="client-review-layout"><section className="client-review-panel" aria-labelledby="client-items-heading"><div className="client-review-section-head"><h3 id="client-items-heading">Shared review items</h3><button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>{allItems.length === 0 ? <p className="client-review-empty" role="status">There are no review items for this project.</p> : <ul className="client-review-item-list">{allItems.map((entry) => <li key={entry.id}><button type="button" aria-current={entry.id === selectedItemId} onClick={() => void loadItem(projectId, entry.id)}><strong>{entry.label || entry.task?.title || "Issued revision"}</strong>{entry.task && <span>{entry.task.title}</span>}<small>{entry.status.replaceAll("_", " ")} · {entry.packageTitle}</small></button></li>)}</ul>}</section>
      <section className="client-review-panel" aria-labelledby="client-item-detail-heading">{!selected && <p className="client-review-muted" role="status">Choose a shared review item to see its details.</p>}{selected && <><div className="client-review-detail-head"><div><p className="client-review-eyebrow">{selected.packageTitle}</p><h3 id="client-item-detail-heading">{selected.label || selected.task?.title || "Issued revision"}</h3>{selected.task && <p>{selected.task.title} · {selected.status.replaceAll("_", " ")}</p>}</div><button type="button" onClick={() => void loadItem(projectId, selected.id)}>Refresh item</button></div>{selected.workEvidence?.kind === "LINK" && <div className="client-review-file"><a href={selected.workEvidence.url!} target="_blank" rel="noopener noreferrer">Open submitted review link</a><small>The submitted URL is preserved. External content may change.</small></div>}{selected.workEvidence?.kind === "FILE" && <div className="client-review-file"><a href={`${PORTAL}/items/${encodeURIComponent(selected.id)}/stream`} target="_blank" rel="noopener noreferrer">View submitted file</a>{selected.permissions?.download && <a href={`${PORTAL}/items/${encodeURIComponent(selected.id)}/stream?download=1`}>Download submitted file</a>}</div>}{selected.revision && <div className="client-review-file"><span>{selected.revision.label} · {selected.revision.mimeType}</span>{(currentProject?.primary || selected.permissions?.view) && <a href={`${PORTAL}/items/${encodeURIComponent(selected.id)}/stream`} target="_blank" rel="noreferrer">View issued file</a>}{(currentProject?.primary || selected.permissions?.download) && <a href={`${PORTAL}/items/${encodeURIComponent(selected.id)}/stream?download=1`}>Download if permitted</a>}</div>}{(selected.decision ?? selected.ownDecision) && <p className="client-review-decision" role="status">Recorded: {(selected.decision ?? selected.ownDecision)?.kind.replaceAll("_", " ")} · {dateText((selected.decision ?? selected.ownDecision)!.createdAt)}{(selected.decision ?? selected.ownDecision)?.comment ? ` — ${(selected.decision ?? selected.ownDecision)?.comment}` : ""}</p>}
        {reviews?.project.status !== "CANCELLED" && <><h4>Comments and annotations</h4>{(selected.comments ?? []).length === 0 ? <p className="client-review-muted">No comments yet.</p> : <ol className="client-review-comments">{selected.comments?.map((entry) => <li key={entry.id}><strong>{entry.authorEmail}</strong><time>{dateText(entry.createdAt)}</time><p>{entry.text}</p>{entry.annotations.map((mark, index) => <p className="client-review-annotation" key={`${entry.id}-${index}`}>Page {mark.page} · x {mark.x.toFixed(3)}, y {mark.y.toFixed(3)} — {mark.text}</p>)}{entry.referenceId && <a href={`${PORTAL}/references/${encodeURIComponent(entry.referenceId)}/stream`} target="_blank" rel="noreferrer">View attached reference</a>}</li>)}</ol>}</>}
        {canComment && <><form className="client-review-form" onSubmit={(event) => void postComment(event)}><label>Comment<textarea maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} /></label><fieldset><legend>Add annotation</legend><div className="client-review-grid"><label>Page<input type="number" min="1" value={annotationPage} onChange={(event) => setAnnotationPage(event.target.value)} /></label><label>X (0–1)<input type="number" min="0" max="1" step="0.001" value={annotationX} onChange={(event) => setAnnotationX(event.target.value)} /></label><label>Y (0–1)<input type="number" min="0" max="1" step="0.001" value={annotationY} onChange={(event) => setAnnotationY(event.target.value)} /></label></div><label>Annotation text<input maxLength={1000} value={annotationText} onChange={(event) => setAnnotationText(event.target.value)} /></label></fieldset><label>Reason<input minLength={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button type="submit" disabled={busy || !comment.trim()}>{busy ? "Saving…" : "Send comment"}</button></form><label className="client-review-upload">Upload a private PDF or image reference<input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => void uploadReference(event.currentTarget.files?.[0])} disabled={busy} /></label></>}
        {selected.status === "PENDING" && canReview && <button type="button" disabled={busy} onClick={() => void startReview()}>Start review</button>}
        {selected.status === "IN_REVIEW" && canReview && <div className="client-review-actions"><button type="button" className="client-review-secondary" disabled={busy} onClick={() => void submit(`${PORTAL}/reviews/items/${encodeURIComponent(selected.id)}/decision`, { kind: "REVISION_REQUIRED", expectedVersion: selected.version, comment: comment.trim(), reason: reason.trim() || "Revision requested" }, "Revision requested.")}>Request revision</button><button type="button" className="client-review-secondary" disabled={busy} onClick={() => void submit(`${PORTAL}/reviews/items/${encodeURIComponent(selected.id)}/decision`, { kind: "REJECTED", expectedVersion: selected.version, comment: comment.trim(), reason: reason.trim() || "Review rejected" }, "Item rejected.")}>Reject item</button></div>}
        {canApproveItem && selected.status === "IN_REVIEW" && <section className="client-review-approval"><h4>Approve this item</h4>{!currentProject?.primary && <p>Item approval is delegated to this account for this review item.</p>}<label>Typed signature<input autoComplete="name" maxLength={200} value={signatureName} onChange={(event) => setSignatureName(event.target.value)} /></label><label className="client-review-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />I consent to record this as my electronic approval.</label><button type="button" disabled={busy || proofBusy || !session.activePasskeyCount || !signatureName.trim() || !consent} onClick={() => void decide("APPROVED")}>{proofBusy ? "Verifying passkey…" : "Approve with passkey"}</button>{!session.activePasskeyCount && <p role="note">Register a passkey in Account security before approving.</p>}</section>}
        {canFinalApprove && currentProject?.primary && <section className="client-review-approval"><h4>Final overall approval</h4><p>All items in this package are approved. Only the Primary Client can record final overall approval.</p><label>Typed signature<input autoComplete="name" maxLength={200} value={signatureName} onChange={(event) => setSignatureName(event.target.value)} /></label><label className="client-review-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />I consent to record this as my final electronic approval.</label><button type="button" disabled={busy || proofBusy || !session.activePasskeyCount || !signatureName.trim() || !consent} onClick={() => void finalApprove(selected.packageId)}>{proofBusy ? "Verifying passkey…" : "Record final approval"}</button></section>}
      </>}</section></div></>}
  </section>;
}

export function StaffClientReviewWorkspace({ csrfToken, owner }: { csrfToken: string; owner: boolean }): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [requestedProjectId, setRequestedProjectId] = useState(() => new URLSearchParams(window.location.search).get("projectId") ?? "");
  const [unavailableProjectId, setUnavailableProjectId] = useState("");
  const [reviews, setReviews] = useState<ProjectReviews>();
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [revisions, setRevisions] = useState<RevisionOption[]>([]);
  const [selectedTask, setSelectedTask] = useState("");
  const [selectedRevision, setSelectedRevision] = useState("");
  const [label, setLabel] = useState("");
  const [packageTitle, setPackageTitle] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ownerAccess, setOwnerAccess] = useState<OwnerProjectAccess>();
  const projectLoad = useRef(0);
  const [correctionOwnerByItem, setCorrectionOwnerByItem] = useState<Record<string, string>>({});
  const [primaryEmail, setPrimaryEmail] = useState("");
  const [ownerReason, setOwnerReason] = useState("");
  const [grantExpiry, setGrantExpiry] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const setup = await request<{ branches: { id: string }[] }>("/api/v1/projects/setup");
        const items = await loadBranchProjects<Project>(setup.branches, (branchId, offset, limit) =>
          request<InternalProjectList>(`/api/v1/projects?branchId=${encodeURIComponent(branchId)}&offset=${offset}&limit=${limit}`),
          () => live,
        );
        if (!live) return;
        setProjects(items.filter((project) => project.status === "ACTIVE"));
        const active = items.filter((project) => project.status === "ACTIVE");
        const requested = new URLSearchParams(window.location.search).get("projectId") ?? "";
        setRequestedProjectId(requested);
        setProjectId(requested ? (active.some((project) => project.id === requested) ? requested : "") : active[0]?.id ?? "");
      } catch (cause) { if (live) setError(errorText(cause, "Internal project list could not be loaded.")); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, []);

  const loadProject = async (id: string): Promise<void> => {
    const generation = ++projectLoad.current;
    setReviews(undefined); setTasks([]); setRevisions([]); setOwnerAccess(undefined); setError("");
    setSelectedTask(""); setSelectedRevision("");
    if (!id) return;
    setLoading(true);
    try {
      const data = await request<ProjectReviews>(`${STAFF}/projects/${encodeURIComponent(id)}`);
      const access = owner ? await request<OwnerProjectAccess>(`/api/v1/client-access/projects/${encodeURIComponent(id)}`) : undefined;
      if (generation !== projectLoad.current) return;
      setReviews(data); setTasks(data.eligibleTasks ?? []);
      setRevisions((data.eligibleTasks ?? []).flatMap((task) => task.revisions.filter((revision) => ["INTERNAL_APPROVED", "APPROVED", "ISSUED"].includes(revision.state)).map((revision) => ({ ...revision, taskId: task.id }))));
      setOwnerAccess(access);
    } catch (cause) {
      if (generation === projectLoad.current) {
        const status = typeof cause === "object" && cause !== null && "status" in cause ? (cause as { status?: number }).status : undefined;
        if (status === 403 || status === 404) { setUnavailableProjectId(id); setProjectId(""); setError(""); }
        else setError(errorText(cause, "Project review details could not be loaded."));
      }
    }
    finally { if (generation === projectLoad.current) setLoading(false); }
  };
  useEffect(() => {
    const onPopState = (): void => {
      const requested = new URLSearchParams(window.location.search).get("projectId") ?? "";
      setRequestedProjectId(requested);
      setUnavailableProjectId("");
      const activeProjects = projects.filter((project) => project.status === "ACTIVE");
      setProjectId(requested ? (activeProjects.some((project) => project.id === requested) ? requested : "") : activeProjects[0]?.id ?? "");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [projects]);
  useEffect(() => {
    if (projectId && projects.some((project) => project.id === projectId && project.status === "ACTIVE")) void loadProject(projectId);
    else {
      projectLoad.current += 1;
      setReviews(undefined); setTasks([]); setRevisions([]); setOwnerAccess(undefined);
      setSelectedTask(""); setSelectedRevision("");
    }
  }, [projectId, projects]);

  const selectProject = (id: string): void => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("projectId", id); else url.searchParams.delete("projectId");
    window.history.pushState({ clientReviewProjectSelection: true }, "", url);
    setRequestedProjectId(id);
    setUnavailableProjectId("");
    setProjectId(id);
  };

  const createPackage = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); if (!projectId || !selectedTask || !selectedRevision || !packageTitle.trim()) return;
    const work = reviews?.eligibleTasks?.find(task => task.id === selectedTask)?.approvedWork;
    if (selectedRevision === "approved-work" && !work) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`${STAFF}/projects/${encodeURIComponent(projectId)}/packages`, csrfToken, bodyInit("POST", { title: packageTitle.trim(), reason: reason.trim(), items: [{ taskId: selectedTask, expectedTaskVersion: tasks.find((task) => task.id === selectedTask)?.version, ...(selectedRevision === "approved-work" && work ? { workSubmissionId: work.submissionId, ...(work.revisionId ? { revisionId: work.revisionId } : {}) } : { revisionId: selectedRevision }), label: label.trim() || tasks.find((task) => task.id === selectedTask)?.title }] }));
      setNotice("Client review package sent."); setPackageTitle(""); setLabel(""); setReason(""); await loadProject(projectId);
    } catch (cause) { setError(errorText(cause, "Client review package could not be sent.")); }
    finally { setBusy(false); }
  };

  const classify = async (itemId: string, version: number, category: "PREFERENCE_NEW_REQUIREMENT" | "EMPLOYEE_WORK_ERROR"): Promise<void> => {
    if (!reviews?.capabilities?.classify || !reason.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try { await request(`${STAFF}/items/${encodeURIComponent(itemId)}/classification`, csrfToken, bodyInit("POST", { category, expectedVersion: version, reason: reason.trim() })); setNotice("Revision classification saved."); await loadProject(projectId); }
    catch (cause) { setError(errorText(cause, "Classification could not be saved.")); }
    finally { setBusy(false); }
  };

  const assignCorrection = async (itemId: string): Promise<void> => {
    const ownerEmployeeId = correctionOwnerByItem[itemId];
    if (!reviews?.capabilities?.assignCorrection || !ownerEmployeeId || reason.trim().length < 3) return;
    setBusy(true); setError(""); setNotice("");
    try { await request(`${STAFF}/items/${encodeURIComponent(itemId)}/correction`, csrfToken, bodyInit("POST", { ownerEmployeeId, reason: reason.trim() })); setNotice("Correction task assigned."); setReason(""); await loadProject(projectId); }
    catch (cause) { setError(errorText(cause, "Correction could not be assigned.")); }
    finally { setBusy(false); }
  };

  const resumeCorrection = async (itemId: string, taskId: string): Promise<void> => {
    if (!reviews?.capabilities?.assignCorrection || reason.trim().length < 3) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { task } = await request<{ task: TaskOption }>(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
      await request(`${STAFF}/items/${encodeURIComponent(itemId)}/resume`, csrfToken, bodyInit("POST", { expectedTaskVersion: task.version, reason: reason.trim() }));
      setNotice("Completed correction resumed for internal review."); setReason(""); await loadProject(projectId);
    } catch (cause) { setError(errorText(cause, "Correction could not be resumed.")); }
    finally { setBusy(false); }
  };

  const completeCorrection = async (taskId: string): Promise<void> => {
    if (!reviews?.capabilities?.assignCorrection || reason.trim().length < 3) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { task } = await request<{ task: TaskOption }>(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
      if (task.status === "NOT_STARTED") {
        const started = await request<TaskOption>(`/api/v1/tasks/${encodeURIComponent(taskId)}/state`, csrfToken, bodyInit("POST", { toState: "IN_PROGRESS", expectedVersion: task.version, reason: reason.trim() }));
        task.version = started.version;
        task.status = started.status;
      }
      await request(`/api/v1/tasks/${encodeURIComponent(taskId)}/state`, csrfToken, bodyInit("POST", { toState: "COMPLETED", expectedVersion: task.version, reason: reason.trim() }));
      setNotice("Correction task completed."); setReason(""); await loadProject(projectId);
    } catch (cause) { setError(errorText(cause, "Correction task could not be completed.")); }
    finally { setBusy(false); }
  };

  const completeApprovedTask = async (taskId: string): Promise<void> => {
    if (!reviews?.capabilities?.manage || reason.trim().length < 3) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { task } = await request<{ task: TaskOption }>(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
      await request(`${STAFF}/tasks/${encodeURIComponent(taskId)}/complete`, csrfToken, bodyInit("POST", { expectedVersion: task.version, reason: reason.trim() }));
      setNotice("Approved task completed."); setReason(""); await loadProject(projectId);
    } catch (cause) { setError(errorText(cause, "Approved task could not be completed.")); }
    finally { setBusy(false); }
  };
  const setPrimary = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!owner || !projectId || !ownerAccess || !primaryEmail.trim() || ownerReason.trim().length < 3) return;
    const currentPrimary = ownerAccess.grants.find((grant) => grant.primary && !grant.revokedAt);
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/v1/client-access/projects/${encodeURIComponent(projectId)}/primary`, csrfToken, bodyInit("POST", { email: primaryEmail.trim(), expectedProjectVersion: ownerAccess.projectVersion, expectedPrimaryGrantId: currentPrimary?.id ?? null, ...(currentPrimary ? { expectedPrimaryGrantVersion: currentPrimary.version } : {}), reason: ownerReason.trim() }));
      setNotice("Primary Client appointment updated."); setPrimaryEmail(""); setOwnerReason(""); await loadProject(projectId);
    } catch (cause) { setError(errorText(cause, "Primary Client appointment could not be updated.")); }
    finally { setBusy(false); }
  };

  const updateOwnerGrant = async (grant: OwnerGrant, action: "SET_EXPIRY" | "REVOKE"): Promise<void> => {
    if (!owner || !projectId || ownerReason.trim().length < 3) return;
    const date = grantExpiry[grant.id];
    if (action === "SET_EXPIRY" && !date) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/v1/client-access/grants/${encodeURIComponent(grant.id)}`, csrfToken, bodyInit("POST", { action, expectedVersion: grant.version, reason: ownerReason.trim(), ...(action === "SET_EXPIRY" ? { expiresAt: new Date(`${date}T23:59:59.000Z`).toISOString() } : {}) }));
      setNotice(action === "REVOKE" ? "Client access revoked." : "Client access expiry updated."); setOwnerReason(""); await loadProject(projectId);
    } catch (cause) { setError(errorText(cause, "Client access could not be updated.")); }
    finally { setBusy(false); }
  };

  return <section className="client-review-workspace" aria-labelledby="staff-client-review-heading"><header className="client-review-header"><div><p className="client-review-eyebrow">INTERNAL WORKSPACE</p><h2 id="staff-client-review-heading">Client reviews</h2><p>Publish exact task and revision snapshots, then track client outcomes.</p></div><label>Active project<select disabled={busy} value={projectId} onChange={(event) => selectProject(event.target.value)}><option value="">Choose a project</option>{projects.filter((project) => project.status === "ACTIVE").map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label></header>
    {requestedProjectId && !loading && !error && (unavailableProjectId === requestedProjectId || !projects.some((project) => project.id === requestedProjectId && project.status === "ACTIVE")) && <p className="client-review-muted" role="status">The requested project is unavailable or your access has changed. Choose an authorized project.</p>}
    {loading && <p role="status">Loading projects and review details…</p>}{error && <p className="client-review-error" role="alert">{error}</p>}{notice && <p className="client-review-notice" role="status">{notice}</p>}
    {owner && projectId && ownerAccess && <section className="client-review-panel" aria-labelledby="owner-client-access-heading"><h3 id="owner-client-access-heading">Owner client access</h3><form className="client-review-form" onSubmit={(event) => void setPrimary(event)}><label>Primary Client email<input type="email" required maxLength={320} value={primaryEmail} onChange={(event) => setPrimaryEmail(event.target.value)} /></label><label>Reason for appointment or replacement<input required minLength={3} maxLength={1000} value={ownerReason} onChange={(event) => setOwnerReason(event.target.value)} /></label><button disabled={busy || ownerReason.trim().length < 3}>{busy ? "Saving…" : "Set Primary Client"}</button></form><ul className="client-review-access-list">{ownerAccess.grants.map((grant) => <li key={grant.id}><strong>{grant.email ?? grant.accountId}{grant.primary ? " · Primary" : " · Additional"}</strong><span>{grant.revokedAt ? "Revoked" : `Expires ${grant.expiresAt ? dateText(grant.expiresAt) : "not set"}`}</span>{!grant.revokedAt && <div className="client-review-owner-actions"><label>New expiry<input type="date" value={grantExpiry[grant.id] ?? ""} onChange={(event) => setGrantExpiry((value) => ({ ...value, [grant.id]: event.target.value }))} /></label><button type="button" disabled={busy || !grantExpiry[grant.id] || ownerReason.trim().length < 3} onClick={() => void updateOwnerGrant(grant, "SET_EXPIRY")}>Set expiry</button><button type="button" className="client-review-secondary" disabled={busy || ownerReason.trim().length < 3} onClick={() => void updateOwnerGrant(grant, "REVOKE")}>Revoke</button></div>}</li>)}</ul><p className="client-review-muted">Set future expiry for each active client grant before project cancellation.</p></section>}
    {projectId && reviews && <form className="client-review-form client-review-publish" onSubmit={(event) => void createPackage(event)}><h3>Send a task for client review</h3><label>Package title<input required maxLength={200} value={packageTitle} onChange={(event) => setPackageTitle(event.target.value)} /></label><label>Task<select aria-label="Task" required value={selectedTask} onChange={(event) => { setSelectedTask(event.target.value); setSelectedRevision(""); }}><option value="">Choose internally approved work</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title} · {task.status}</option>)}</select></label><label>Approved evidence<select required value={selectedRevision} onChange={(event) => setSelectedRevision(event.target.value)}><option value="">Choose an approved file, drawing or link</option>{reviews.eligibleTasks?.find(task => task.id === selectedTask)?.approvedWork && <option value="approved-work">Exact internally approved {reviews.eligibleTasks.find(task => task.id === selectedTask)?.approvedWork?.kind.toLowerCase()}</option>}{revisions.filter((revision) => revision.taskId === selectedTask).map((revision) => <option key={revision.id} value={revision.id}>{revision.label}</option>)}</select></label><label>Client label<input maxLength={200} value={label} onChange={(event) => setLabel(event.target.value)} /></label><label>Reason<input minLength={3} maxLength={1000} required value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={busy || !selectedTask || !selectedRevision || !packageTitle.trim() || reason.trim().length < 3}>{busy ? "Sending…" : "Send for client review"}</button></form>}
    {owner && projectId && <StaffProjectGallery projectId={projectId} csrfToken={csrfToken} owner={owner} />}
    {reviews && <section className="client-review-panel"><h3>Packages and outcomes</h3>{reviews.packages.length === 0 ? <p role="status">No client review packages have been sent.</p> : <ul className="client-review-staff-list">{reviews.packages.flatMap((pack) => pack.items.map((entry) => <li key={entry.id}><div><strong>{entry.label}</strong><span>{pack.title} · {entry.status.replaceAll("_", " ")}</span>{entry.classification && <small>{entry.classification.category.replaceAll("_", " ")}</small>}{entry.correctionTaskId && <small>Correction task: {entry.correctionTaskId}</small>}</div>{entry.status === "APPROVED" && pack.status === "APPROVED" && entry.taskId && entry.taskStatus !== "COMPLETED" && reviews.capabilities?.manage && <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void completeApprovedTask(entry.taskId!)}>Complete approved task</button>}{(entry.status === "REVISION_REQUIRED" || entry.status === "REJECTED" || entry.revision?.label.startsWith("CR")) && entry.status !== "WITHDRAWN" && reviews.capabilities?.classify && <label>Classify CR outcome<select aria-label={`Classification for ${entry.label}`} value={entry.classification?.category ?? ""} onChange={(event) => void classify(entry.id, entry.version, event.target.value as "PREFERENCE_NEW_REQUIREMENT" | "EMPLOYEE_WORK_ERROR")} disabled={busy || !reason.trim()}><option value="">Choose category</option><option value="PREFERENCE_NEW_REQUIREMENT">Preference / New Requirement</option><option value="EMPLOYEE_WORK_ERROR">Employee Work Error</option></select></label>}{entry.status === "REVISION_REQUIRED" && reviews.capabilities?.assignCorrection && <div className="client-review-correction-actions"><label>Correction owner<select aria-label={`Correction owner for ${entry.label}`} value={correctionOwnerByItem[entry.id] ?? ""} onChange={(event) => setCorrectionOwnerByItem((value) => ({ ...value, [entry.id]: event.target.value }))}><option value="">Choose eligible owner</option>{(reviews.correctionOwners ?? []).map((candidate) => <option key={candidate.employeeId} value={candidate.employeeId}>{candidate.name}</option>)}</select></label><button type="button" disabled={busy || !correctionOwnerByItem[entry.id] || reason.trim().length < 3} onClick={() => void assignCorrection(entry.id)}>Assign correction</button>{entry.correctionTaskId && <button type="button" className="client-review-secondary" disabled={busy || reason.trim().length < 3} onClick={() => void completeCorrection(entry.correctionTaskId!)}>Complete correction</button>}</div>}{entry.correctionTaskId && entry.taskId && entry.status === "REVISION_REQUIRED" && reviews.capabilities?.assignCorrection && <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void resumeCorrection(entry.id, entry.taskId!)}>Resume after completion</button>}</li>))}</ul>}</section>}
    {reviews && (!reviews.capabilities?.classify || !reviews.capabilities?.assignCorrection) && <p className="client-review-muted" role="note">Some workflow actions require additional project authority.</p>}
  </section>;
}



