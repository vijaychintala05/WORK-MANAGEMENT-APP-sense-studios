import { TASK_DESCRIPTION_MAX_LENGTH, type TaskCreationOptions } from "@sense/contracts";
import { useEffect, useId, useRef, useState } from "react";

export type TaskComposerDraft = {
  title: string; type: string; priority: string; targetDate: string; description: string; projectId: string;
  ownerId: string; startDate: string; estimatedHours: string; collaboratorIds: string[]; collaboratorHours: Record<string, string>;
  planItemId: string; tagsText: string; checklistText: string; reason: string; assignTo: boolean; reviewRequirement: string;
};
export function taskDraftError(draft: TaskComposerDraft): string | undefined {
  return Object.values(taskDraftErrors(draft))[0];
}

/** One validation pass supplies both the command guard and field-level errors. */
export function taskDraftErrors(draft: TaskComposerDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.title.trim().length < 2 || draft.title.trim().length > 160) errors.title = "Task name must be between 2 and 160 characters.";
  const validDate = (value: string): boolean => { const date = new Date(`${value}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };
  if (!validDate(draft.targetDate)) errors.targetDate = "Choose a valid Target date.";
  if (draft.description.trim().length > TASK_DESCRIPTION_MAX_LENGTH) errors.description = `Description must be ${TASK_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
  if (draft.startDate && (!validDate(draft.startDate) || draft.startDate > draft.targetDate)) errors.startDate = "Start date must be valid and on or before the Target date.";
  const invalidHours = (value: string): boolean => value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100_000);
  if (invalidHours(draft.estimatedHours)) errors.estimatedHours = "Estimated hours must be a number between 0 and 100,000.";
  if (draft.collaboratorIds.some(id => invalidHours(draft.collaboratorHours[id] ?? ""))) errors.collaboratorIds = "Collaborator estimated hours must be a number between 0 and 100,000.";
  const tags = draft.tagsText.split(",").map(value => value.trim()).filter(Boolean);
  if (tags.length > 10 || tags.some(value => value.length > 30) || new Set(tags).size !== tags.length) errors.tagsText = "Use up to 10 distinct tags, each 30 characters or fewer.";
  const checklist = draft.checklistText.split("\n").map(value => value.trim()).filter(Boolean).map(value => value.replace(/^\[(?:x| )\]\s*/i, ""));
  if (checklist.length > 10 || checklist.some(value => !value.length || value.length > 120)) errors.checklistText = "Use up to 10 checklist items, each between 1 and 120 characters.";
  if (draft.reason.trim().length < 3 || draft.reason.trim().length > 1000) errors.reason = "Reason must be between 3 and 1,000 characters.";
  if (draft.type === "NON_PROJECT" && draft.projectId) errors.type = "Non project tasks cannot use a project. Choose a project task type for this context.";
  if (["PROJECT", "CORRECTION", "SITE"].includes(draft.type) && !draft.projectId) errors.projectId = "Choose a project for this task type, or use Non project for work without a project.";
  if (draft.collaboratorIds.length > 30 || new Set(draft.collaboratorIds).size !== draft.collaboratorIds.length) errors.collaboratorIds = "Choose up to 30 distinct collaborators.";
  return errors;
}

export function taskCreateBody(d: TaskComposerDraft, options: TaskCreationOptions): Record<string, unknown> {
  return { title: d.title.trim(), type: d.type, priority: d.priority, targetDate: d.targetDate,
    ...(d.description.trim() ? { description: d.description.trim() } : {}), ...(d.startDate ? { startDate: d.startDate } : {}),
    ...(d.estimatedHours ? { estimatedHours: Number(d.estimatedHours) } : {}), ...(d.projectId ? { projectId: d.projectId } : {}),
    ...(d.planItemId ? { planItemId: d.planItemId } : {}),
    ...(d.tagsText.trim() ? { tags: d.tagsText.split(",").map(value => value.trim()).filter(Boolean) } : {}),
    ...(d.checklistText.trim() ? { checklist: d.checklistText.split("\n").map(value => value.trim()).filter(Boolean).map(value => ({ label: value.replace(/^\[(?:x| )\]\s*/i, ""), checked: /^\[x\]\s*/i.test(value) })) } : {}),
    ...((d.assignTo || options.actorEmployeeId === null) && options.canAssign && d.ownerId ? { ownerEmployeeId: d.ownerId } : {}),
    ...(d.collaboratorIds.length ? { collaborators: d.collaboratorIds.map(employeeId => ({ employeeId, ...(d.collaboratorHours[employeeId] ? { estimatedHours: Number(d.collaboratorHours[employeeId]) } : {}) })) } : {}),
    ...(d.reviewRequirement !== "NONE" ? { reviewRequirement: d.reviewRequirement === "CLIENT" ? "BOTH" : d.reviewRequirement } : {}), reason: d.reason.trim() };
}

type Props = {
  draft: TaskComposerDraft; onChange: (patch: Partial<TaskComposerDraft>) => void;
  projects: Array<{ id: string; title: string; status: string }>;
  planItems: Array<{ id: string; projectId: string; kind: string; label: string }>;
  options: TaskCreationOptions | undefined; optionsError: string | undefined; retryOptions: () => void;
  compact: boolean; busy: boolean; subtask?: boolean; fixedProject?: { id: string; title: string }; validationAttempt?: number;
};
const label = (value: string): string => value.toLowerCase().replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
const PRIORITIES: string[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const TASK_TYPES = ["PROJECT", "NON_PROJECT", "RECURRING", "CORRECTION", "SITE", "TRAINING_PRACTICAL"] as const;
const PRIORITY_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/**
 * Shared fields for ordinary and child tasks. Domain commands stay with TaskWorkspace.
 * When `compact` is true the optional planning and collaborator sections are hidden so
 * the form stays fast for non-owner variants (EMPLOYEE/SITE).
 */
export function TaskComposerFields({ draft: d, onChange: change, projects, planItems, options, optionsError, retryOptions, busy, subtask = false, fixedProject, compact = false, validationAttempt = 0 }: Props): React.JSX.Element {
  const prefix = useId();
  const summary = useRef<HTMLDivElement>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [ownerSearch, setOwnerSearch] = useState("");
  const [collaboratorSearch, setCollaboratorSearch] = useState("");
  const [contextNotice, setContextNotice] = useState("");
  const explicit = options?.actorEmployeeId === null || !!options?.canAssign && d.assignTo;
  const errors = taskDraftErrors(d);
  if (options?.canCreate && explicit && !options.owners.some(person => person.id === d.ownerId)) errors.ownerId = "Choose an eligible primary owner.";
  const visible = (field: string): string | undefined => validationAttempt > 0 || touched[field] ? errors[field] : undefined;
  const attrs = (field: string) => ({ id: `${prefix}-${field}`, name: field, "aria-invalid": visible(field) ? true : undefined, "aria-describedby": visible(field) ? `${prefix}-${field}-error` : undefined });
  const error = (field: string) => visible(field) ? <p className="task-field-error" id={`${prefix}-${field}-error`}>{visible(field)}</p> : null;
  useEffect(() => { if (validationAttempt > 0) summary.current?.focus(); }, [validationAttempt]);
  const chooseProject = (projectId: string): void => {
    setOwnerSearch(""); setCollaboratorSearch(""); setContextNotice("Project changed. Available people and planning choices are being updated; previous selections were cleared.");
    change({ projectId, planItemId: "", ownerId: "", collaboratorIds: [], collaboratorHours: {}, reviewRequirement: projectId ? d.reviewRequirement : "NONE",
      type: projectId && d.type === "NON_PROJECT" ? "PROJECT" : !projectId && ["PROJECT", "CORRECTION", "SITE"].includes(d.type) ? "NON_PROJECT" : d.type });
  };
  const planning = <>
    <label>Stage or milestone (optional)<select aria-label={subtask ? "Subtask stage or milestone" : "Stage or milestone"} value={d.planItemId} onChange={event => change({ planItemId: event.target.value })} disabled={!d.projectId}><option value="">No plan item</option>{planItems.filter(item => item.projectId === d.projectId).map(item => <option key={item.id} value={item.id}>{item.kind === "STAGE" ? "Stage" : "Milestone"} · {item.label}</option>)}</select></label>
    <label>Tags (optional, comma separated)<input {...attrs("tagsText")} aria-label={subtask ? "Subtask tags" : "Tags"} value={d.tagsText} onChange={event => change({ tagsText: event.target.value })} placeholder="Concept, client feedback" /></label>{error("tagsText")}
    <label>Checklist (optional, one item per line)<textarea {...attrs("checklistText")} aria-label={subtask ? "Subtask checklist" : "Checklist"} value={d.checklistText} onChange={event => change({ checklistText: event.target.value })} placeholder={"[ ] Confirm brief\n[x] Collect references"} rows={3} /></label>{error("checklistText")}
    <div className="task-form-grid"><label>Start date (optional)<input {...attrs("startDate")} type="date" value={d.startDate} onChange={event => change({ startDate: event.target.value })} />{error("startDate")}</label><label>Estimated hours (optional)<input {...attrs("estimatedHours")} type="number" min="0" max="100000" step="0.25" value={d.estimatedHours} onChange={event => change({ estimatedHours: event.target.value })} />{error("estimatedHours")}</label></div>
  </>;
  /**
   * Quick-capture row: the five decisions that matter on the first pass.
   * Priority cycles LOW → MEDIUM → HIGH → CRITICAL with a single click; the
   * native select is kept inline for screen readers and direct selection.
   */
  const cyclePriority = (): void => {
    const next = ((PRIORITY_RANK[d.priority] ?? 1) + 1) % PRIORITIES.length;
    change({ priority: PRIORITIES[next] ?? "MEDIUM" });
  };
  const projectTypes = ["PROJECT", "CORRECTION", "SITE"];
  const todayISO = new Date().toISOString().slice(0, 10);
  const projectField = fixedProject
    ? <input {...attrs("projectId")} aria-label={subtask ? "Parent project" : "Task project"} readOnly value={fixedProject.title} disabled />
    : <select {...attrs("projectId")} aria-label="Project" required={projectTypes.includes(d.type)} value={d.projectId} onChange={event => chooseProject(event.target.value)} disabled={busy}>
        <option value="">{projectTypes.includes(d.type) ? "Choose a project" : "No project"}</option>
        {projects.filter(project => project.status === "DRAFT" || project.status === "ACTIVE").map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>;
  const ownerValue = options?.canAssign && explicit
    ? <select {...attrs("ownerId")} aria-label="Primary owner" value={d.ownerId}
        onChange={event => change({ ownerId: event.target.value, collaboratorIds: d.collaboratorIds.filter(id => id !== event.target.value) })}
        required disabled={busy || !options.canCreate}>
        <option value="">Choose an employee</option>
        {options.owners.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
      </select>
    : <span className="task-chip__value">{options?.canAssign && !explicit ? "You" : "Choose an owner"}</span>;
  const quickCapture = <div className="task-quick-capture">
    <label className="task-field task-field--title">Task name *<input {...attrs("title")} aria-label="Task name" value={d.title} onChange={event => change({ title: event.target.value })} minLength={2} maxLength={160} required placeholder="What needs to happen?" /></label>{error("title")}
    <div className="task-quick-capture__row" role="group" aria-label="Task essentials">
      <div className="task-chip"><span className="task-chip__label">Priority</span>
        <div className="task-priority-toggle">
          <button type="button" className={`task-priority-toggle__button${errors.priority ? " task-priority-toggle__button--error" : ""}`} aria-label={`Priority ${label(d.priority)}. Press to change.`} onClick={cyclePriority} disabled={busy}>
            <span className={`task-priority-dot task-priority-dot--${d.priority.toLowerCase()}`} aria-hidden="true" />{label(d.priority)}
          </button>
          <select className="task-priority-select" aria-label="Priority select" value={d.priority} onChange={event => change({ priority: event.target.value })} disabled={busy}>{PRIORITIES.map(value => <option key={value} value={value}>{label(value)}</option>)}</select>
        </div>
      </div>
      <label className="task-field">Type *<select {...attrs("type")} aria-label="Type" value={d.type} onChange={event => change({ type: event.target.value })} disabled={busy}>{TASK_TYPES.map(type => <option key={type} value={type}>{label(type)}</option>)}</select>{error("type")}</label>
      <label className="task-field">Target date *<input {...attrs("targetDate")} aria-label="Target date" type="date" value={d.targetDate} onChange={event => change({ targetDate: event.target.value })} required disabled={busy} min={todayISO} />{error("targetDate")}</label>
      <div className="task-chip"><span className="task-chip__label">Project</span>{projectField}{error("projectId")}</div>
      <div className="task-chip task-chip--owner"><span className="task-chip__label">Owner</span>{ownerValue}{error("ownerId")}</div>
    </div>
  </div>;
  return <fieldset disabled={busy} className="task-composer-lock" onBlur={event => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) { const name = event.target.name; setTouched(value => ({ ...value, [name]: true })); } }}><legend className="task-sr-only">Task details</legend>
    {validationAttempt > 0 && Object.keys(errors).length > 0 && <div ref={summary} tabIndex={-1} role="alert" className="task-error-summary"><strong>Check these details</strong><ul>{Object.entries(errors).map(([field, message]) => <li key={field}><a href={`#${prefix}-${field}`} onClick={event => { event.preventDefault(); const control = document.getElementById(`${prefix}-${field}`); const disclosure = control?.closest("details"); if (disclosure) disclosure.open = true; control?.focus(); }}>{message}</a></li>)}</ul></div>}
    {quickCapture}
    <label>Description (optional)<textarea {...attrs("description")} value={d.description} onChange={event => change({ description: event.target.value })} maxLength={TASK_DESCRIPTION_MAX_LENGTH} rows={2} placeholder="Add any detail that helps the person doing this." /></label>{error("description")}
    {contextNotice && <p role="status" className="task-form-note">{contextNotice}</p>}
    {optionsError ? <div role="alert"><p>{optionsError}</p><button type="button" onClick={retryOptions} disabled={busy}>Retry participants</button></div> : !options ? <p role="status">Loading eligible task participants…</p> : !options.canCreate ? <p role="status">No eligible primary owner is available in this context. Review employee membership and project assignments.</p> : <>
      <fieldset className="task-assignment"><legend>Ownership</legend>{options.canAssign && options.actorEmployeeId && <label className="task-inline"><input type="checkbox" checked={d.assignTo} onChange={event => change({ assignTo: event.target.checked, ownerId: "", collaboratorIds: [], collaboratorHours: {} })} /> Assign to an employee</label>}{explicit ? <>{ownerSearch && <label>Find primary owner<input type="search" value={ownerSearch} onChange={event => setOwnerSearch(event.target.value)} placeholder="Search eligible people" /></label>}<p role="status" className="task-owner-summary">Primary owner: {options.owners.find(person => person.id === d.ownerId)?.name ?? "Not set yet — choose in the owner field above."}</p>{ownerSearch && !options.owners.some(person => person.name.toLowerCase().includes(ownerSearch.toLowerCase())) && <p role="status">No eligible people match this search.</p>}</> : <p>Assigned to you.</p>}</fieldset>
    </>}
    {d.projectId && <fieldset className="task-review-requirements" aria-describedby={`${prefix}-review-help`}><legend>Review requirements</legend><label><input type="checkbox" checked={d.reviewRequirement !== "NONE"} disabled={d.reviewRequirement === "BOTH" || d.reviewRequirement === "CLIENT"} onChange={event => change({ reviewRequirement: event.target.checked ? "INTERNAL" : "NONE" })} />Internal review required</label><label><input type="checkbox" checked={d.reviewRequirement === "BOTH" || d.reviewRequirement === "CLIENT"} onChange={event => change({ reviewRequirement: event.target.checked ? "BOTH" : "INTERNAL" })} />Client review required</label><small id={`${prefix}-review-help`}>Client review also requires internal approval. Submit a file or link when the work is ready. An authorized publisher must enable client review.</small></fieldset>}
    <label>Why is this task needed? *<input {...attrs("reason")} aria-label="Reason" value={d.reason} onChange={event => change({ reason: event.target.value })} minLength={3} maxLength={1000} required placeholder="One short sentence — recorded in the task history." /><small>Recorded in the task history.</small>{error("reason")}</label>
    {!compact && <details className="task-optional-planning"><summary>Optional planning</summary>{planning}</details>}
    {options?.canAssign && !compact && <details className="task-optional-planning"><summary>Collaborators (optional) · {d.collaboratorIds.length} selected</summary><label>Find collaborators<input type="search" value={collaboratorSearch} onChange={event => setCollaboratorSearch(event.target.value)} placeholder="Search eligible people" /></label><fieldset {...attrs("collaboratorIds")} tabIndex={-1} className="task-assignment"><legend>Collaborators (optional)</legend>{options.collaborators.filter(person => person.id !== (explicit ? d.ownerId : options.actorEmployeeId) && (d.collaboratorIds.includes(person.id) || person.name.toLowerCase().includes(collaboratorSearch.toLowerCase()))).map(employee => <div className="task-collaborator-choice" key={employee.id}><label className="task-inline"><input type="checkbox" checked={d.collaboratorIds.includes(employee.id)} onChange={event => change({ collaboratorIds: event.target.checked ? [...d.collaboratorIds, employee.id] : d.collaboratorIds.filter(id => id !== employee.id) })} /> {employee.name}</label>{d.collaboratorIds.includes(employee.id) && <label>Estimated hours<input aria-label={`${employee.name} estimated hours`} type="number" min="0" max="100000" step="0.25" value={d.collaboratorHours[employee.id] ?? ""} onChange={event => change({ collaboratorHours: { ...d.collaboratorHours, [employee.id]: event.target.value } })} /></label>}</div>)}{!options.collaborators.some(person => person.id !== (explicit ? d.ownerId : options.actorEmployeeId) && person.name.toLowerCase().includes(collaboratorSearch.toLowerCase())) && <p role="status">No eligible collaborators match this search.</p>}{error("collaboratorIds")}</fieldset></details>}
  </fieldset>;
}
