// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TaskWorkspace, type Detail, type Task } from "./task.js";
import { MemoryRouter } from "react-router-dom";

const setup = { actorEmployeeId: "employee-1", projects: [{ id: "project-1", title: "Studio", status: "ACTIVE", branchId: "branch-1" }], planItems: [{ id: "plan-1", projectId: "project-1", kind: "STAGE" as const, label: "Concept" }], employees: [{ id: "employee-1", name: "Asha", homeBranchId: "branch-1" }, { id: "employee-2", name: "Dev", homeBranchId: "branch-1" }], canAssign: true };
const task: Task = { id: "task-1", title: "Prepare concept", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-10-12T00:00:00.000Z", description: "Draft the concept", projectId: "project-1", planItemId: "plan-1", tags: ["Design"], checklist: [{ label: "Confirm brief", checked: true }], primaryOwnerEmployeeId: "employee-1", status: "NOT_STARTED", version: 1, reviewRequirement: "NONE", createdAt: "2026-09-28T00:00:00.000Z" };
const detail: Detail = { task, collaborators: [], history: { statusChanges: [], ownerChanges: [] }, capabilities: { edit: false, transition: true, reassign: false } };


function creationOptionsForSetup(value: { actorEmployeeId: string | null; canAssign: boolean; employees: typeof setup.employees; projects: typeof setup.projects; creationProfile?: unknown }, input: string) {
  const projectId = new URL(input, "http://localhost").searchParams.get("projectId");
  const owners = value.canAssign ? value.employees : value.employees.filter(person => person.id === value.actorEmployeeId);
  return { actorEmployeeId: value.actorEmployeeId, project: value.projects.find(project => project.id === projectId) ?? null, canAssign: value.canAssign, canCreate: owners.length > 0, owners, collaborators: value.canAssign ? value.employees : [], readAt: "2026-10-15T00:00:00Z" };
}
function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const originalTaskShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalTaskDialogClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  if (originalTaskShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalTaskShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalTaskDialogClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalTaskDialogClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); } });
});

describe("TaskWorkspace", () => {
  it.each([
    ["configured Site employee", false, "employee-1", "SITE", "CONFIGURED_ROLE", true],
    ["ambiguous Site hint", false, "employee-1", "SITE", "AMBIGUOUS", false],
    ["generic employee", false, "employee-1", "EMPLOYEE", "GENERIC_FALLBACK", false],
    ["Site hint without employee", false, null, "SITE", "CONFIGURED_ROLE", false],
    ["Owner with Site hint", true, null, "SITE", "CONFIGURED_ROLE", false],
  ] as const)("selects Site summary presentation only from the %s server context", async (_label, owner, actorEmployeeId, variant, resolution, siteExpected) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/setup")) return response({ ...setup, actorEmployeeId, creationProfile: { version: 1, variant, resolution } });
      if (url.endsWith("/dashboard/sources/site")) return response({ source: "site", readCompletedAt: "2026-10-21T06:00:00.000Z", sections: [] });
      if (url.endsWith("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-21" });
      return response({ total: 0, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={owner} accountId="current-account" listFirst personalOnly />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled());
    if (siteExpected) expect(await screen.findByRole("link", { name: "Site snags: 0" })).toHaveAttribute("href", "/site");
    else {
      expect(screen.queryByText("Site snags")).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/dashboard/sources/site"))).toBe(false);
    }
  });

  it("removes applied filters independently, clears project dependencies and unused date basis, and preserves personal scope", async () => {
    window.history.replaceState(null, "", "/my-work?projectId=project-1&planItemId=plan-1&ownerEmployeeId=employee-2&status=IN_PROGRESS&q=concept&dateBasis=target&dateFrom=2026-10-01&dateTo=2026-10-31&offset=50");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("/creation-options") ? response(creationOptionsForSetup(setup, String(input))) : String(input).endsWith("/setup") ? response(setup) : response({ total: 1, items: [task] })));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    await screen.findByRole("button", { name: "Open task: Prepare concept" });
    expect(screen.getByRole("region", { name: "Applied task filters" })).toHaveTextContent("Project: Studio");
    fireEvent.click(screen.getByRole("button", { name: "Remove Status filter" }));
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("status")).toBe(false));
    let query = new URL(window.location.href).searchParams;
    expect(query.get("scope")).toBe("personal");
    expect(query.get("projectId")).toBe("project-1");
    expect(query.get("q")).toBe("concept");
    expect(query.get("ownerEmployeeId")).toBe("employee-2");
    expect(query.has("offset")).toBe(false);
    expect(screen.getByLabelText("Filters and sort")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove Project filter" }));
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("projectId")).toBe(false));
    expect(new URL(window.location.href).searchParams.has("planItemId")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove Target from filter" }));
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("dateFrom")).toBe(false));
    expect(new URL(window.location.href).searchParams.get("dateBasis")).toBe("target");
    fireEvent.click(screen.getByRole("button", { name: "Remove Target through filter" }));
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("dateBasis")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Applied task filters" })).not.toBeInTheDocument());
    query = new URL(window.location.href).searchParams;
    expect(query.get("scope")).toBe("personal");
    expect(query.get("phase")).toBe("active");
    expect(query.has("ownerEmployeeId")).toBe(false);
  });

  it("does not advertise draft edits as applied chips or erase an unrelated draft when removing a chip", async () => {
    window.history.replaceState(null, "", "/my-work?status=IN_PROGRESS");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("/creation-options") ? response(creationOptionsForSetup(setup, String(input))) : String(input).endsWith("/setup") ? response(setup) : response({ total: 1, items: [task] })));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    await screen.findByRole("button", { name: "Open task: Prepare concept" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "Unapplied search" } });
    expect(screen.queryByRole("button", { name: "Remove Search filter" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Status filter" }));
    expect(screen.getByRole("textbox", { name: "Search tasks" })).toHaveValue("Unapplied search");
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("status")).toBe(false));
    expect(new URL(window.location.href).searchParams.has("q")).toBe(false);
  });
  it("opens the real filter disclosure, applies canonical filters, and restores keyboard focus on Escape", async () => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost"); requests.push(url);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.pathname.endsWith("/setup")) return response(setup);
      if (url.pathname.includes("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      return response({ total: 1, items: [task] });
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    await screen.findByRole("button", { name: "Open task: Prepare concept" });
    const trigger = screen.getByLabelText("Filters and sort");
    const disclosure = trigger.closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(trigger);
    expect(disclosure).toHaveAttribute("open");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "Filter My Work" });
    expect(within(panel).getByLabelText("Filter by status").querySelectorAll("option")).toHaveLength(14);
    fireEvent.change(within(panel).getByLabelText("Filter by status"), { target: { value: "WAITING" } });
    expect(screen.getAllByRole("button", { name: "Apply filters" })).toHaveLength(1);
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Apply filters" })).toBeEnabled());
    fireEvent.click(within(panel).getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(requests.some(url => url.pathname === "/api/v1/tasks" && url.searchParams.get("scope") === "personal" && url.searchParams.get("status") === "WAITING")).toBe(true));
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(disclosure).not.toHaveAttribute("open");
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reset filters" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("status")).toBeNull());
  });

  it("keeps the People trigger independent of task navigation without nested buttons or eager detail reads", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.endsWith("/task-1")) return response({ ...detail, collaborators: [{ employeeId: "employee-2", name: "Dev" }] });
      return response({ total: 1, items: [task] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    try {
      render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
      const openTask = await screen.findByRole("button", { name: "Open task: Prepare concept" });
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/task-1"))).toBe(false);
      const row = openTask.closest<HTMLElement>(".task-queue-row")!;
      expect(row.querySelector("button button")).toBeNull();
      fireEvent.click(within(row).getByRole("button", { name: "People on Prepare concept: responsible worker Asha" }));
      const people = await screen.findByRole("dialog", { name: "People · Prepare concept" });
      expect(await within(people).findByText("Dev")).toBeInTheDocument();
      expect(new URL(window.location.href).searchParams.has("taskId")).toBe(false);
      fireEvent.click(within(people).getByRole("button", { name: "Open task details" }));
      expect(await screen.findByRole("heading", { name: "Prepare concept" })).toBeInTheDocument();
      expect(new URL(window.location.href).searchParams.get("taskId")).toBe("task-1");
    } finally {
      if (original) Object.defineProperty(HTMLDialogElement.prototype, "showModal", original);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    }
  });

  it("uses canonical status colour shortcuts without overriding authorization or inventing demo states", async () => {
    window.history.replaceState(null, "", "/my-work?workPhase=waiting");
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost"); requests.push(url);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.pathname.endsWith("/setup")) return response(setup);
      if (url.pathname.includes("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      return response({ total: 1, items: [task] });
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    await screen.findByRole("button", { name: "Open task: Prepare concept" });
    const shortcut = screen.getByRole("button", { name: "Filter tasks: In internal review" });
    fireEvent.click(shortcut);
    await waitFor(() => expect(requests.some(url => url.pathname === "/api/v1/tasks" && url.searchParams.get("scope") === "personal" && url.searchParams.get("status") === "IN_INTERNAL_REVIEW" && !url.searchParams.has("phase"))).toBe(true));
    expect(shortcut).toHaveAttribute("aria-pressed", "true");
    expect(new URL(window.location.href).searchParams.has("workPhase")).toBe(false);
    expect(screen.getByLabelText("Filter by status")).toHaveValue("IN_INTERNAL_REVIEW");
    expect(screen.getByLabelText("Filter by status").querySelectorAll("option")).toHaveLength(14);
    fireEvent.click(shortcut);
    await waitFor(() => expect(shortcut).toHaveAttribute("aria-pressed", "false"));
  });
  it("requires an explicit employee owner instead of an invalid self-task for an employee-less Owner", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup({ ...setup, actorEmployeeId: null }, String(input)));
      if (url.endsWith("/setup")) return response({ ...setup, actorEmployeeId: null });
      if (url.includes("?scope=")) return response({ total: 0, items: [] });
      if (url === "/api/v1/tasks" && init?.method === "POST") return response(task);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="owner-csrf" owner listFirst />);
    const open = await screen.findByRole("button", { name: "Create task" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const form = screen.getByRole("form", { name: "Create task" });
    await waitFor(() => expect(within(form).queryByText("Loading eligible task participants…")).not.toBeInTheDocument());
    expect(within(form).queryByText("Assigned to you.")).not.toBeInTheDocument();
    const ownerField = await within(form).findByLabelText("Primary owner");
    expect(ownerField).toBeRequired();
    fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: "Coordinate test delivery" } });
    fireEvent.change(within(form).getByLabelText("Target date"), { target: { value: "2026-10-20" } });
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Assign to the existing active employee" } });
    const create = within(screen.getByRole("dialog")).getByRole("button", { name: "Create task" });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(ownerField).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.change(ownerField, { target: { value: "employee-2" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(await screen.findByText("Task created.")).toBeInTheDocument();
    const command = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/v1/tasks" && init?.method === "POST")!;
    expect(JSON.parse(String(command[1]?.body))).toMatchObject({ ownerEmployeeId: "employee-2", title: "Coordinate test delivery" });
    expect(new Headers(command[1]?.headers).get("X-CSRF-Token")).toBe("owner-csrf");
  });
  it.each(["EMPLOYEE", "LEADER"] as const)("preserves an oversized %s description draft without posting it, then accepts the API boundary", async (variant) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup({ ...setup, canAssign: false, creationProfile: { version: 1, variant, resolution: "CONFIGURED_ROLE" } }, String(input)));
      if (url.endsWith("/setup")) return response({ ...setup, canAssign: false, creationProfile: { version: 1, variant, resolution: "CONFIGURED_ROLE" } });
      if (url === "/api/v1/tasks" && init?.method === "POST") return response(task);
      return response({ total: 0, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst />);
    const trigger = await screen.findByRole("button", { name: "Create task" });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    const form = screen.getByRole("form", { name: "Create task" });
    await waitFor(() => expect(within(form).queryByText("Loading eligible task participants…")).not.toBeInTheDocument());
    const descriptionInput = within(form).getByLabelText("Description (optional)");
    fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: "Call supplier" } });
    fireEvent.change(within(form).getByLabelText("Target date"), { target: { value: "2026-10-15" } });
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Prepare the project" } });
    const oversized = "x".repeat(2001);
    fireEvent.change(descriptionInput, { target: { value: oversized } });
    fireEvent.submit(form);
    await waitFor(() => expect(descriptionInput).toHaveAccessibleDescription("Description must be 2000 characters or fewer."));
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === "/api/v1/tasks" && init?.method === "POST")).toHaveLength(0);
    expect(descriptionInput).toHaveValue(oversized);
    expect(descriptionInput).toHaveAttribute("maxlength", "2000");

    const accepted = "x".repeat(2000);
    fireEvent.change(descriptionInput, { target: { value: accepted } });
    fireEvent.submit(form);
    await screen.findByText("Task created.");
    const commands = fetchMock.mock.calls.filter(([url, init]) => String(url) === "/api/v1/tasks" && init?.method === "POST");
    expect(commands).toHaveLength(1);
    expect(JSON.parse(String(commands[0]?.[1]?.body))).toMatchObject({ description: accepted });
  });

  it.each(["edit", "subtask"] as const)("preserves an oversized %s description draft and accepts the same boundary", async (mode) => {
    const projection = { items: [], parent: null, isSubtask: false, completionBlocked: false, canCreate: true, taskVersion: 1 };
    const commandPath = `/api/v1/tasks/task-1${mode === "subtask" ? "/subtasks" : ""}`;
    const method = mode === "subtask" ? "POST" : "PUT";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup({ ...setup, canAssign: false }, String(input)));
      if (url.endsWith("/setup")) return response({ ...setup, canAssign: false });
      if (url === commandPath && init?.method === method) return response(mode === "subtask" ? { task: { ...task, id: "child-boundary" }, parentVersion: 2 } : task);
      if (url.endsWith("/task-1/subtasks")) return response(projection);
      if (url.endsWith("/task-1")) return response({ ...detail, capabilities: { ...detail.capabilities, edit: true } });
      return response({ total: 1, items: [task] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    const dialog = await screen.findByRole("dialog", { name: /Prepare concept/ });
    fireEvent.click(await within(dialog).findByRole("button", { name: mode === "subtask" ? "Create subtask" : "Edit task" }));
    const form = mode === "subtask"
      ? within(dialog).getByRole("form", { name: "Create subtask" })
      : within(dialog).getByRole("button", { name: "Save task" }).closest("form")!;
    await waitFor(() => expect(within(form).queryByText("Loading eligible task participants…")).not.toBeInTheDocument());
    const input = within(form).getByLabelText(mode === "subtask" ? "Description (optional)" : "Description");
    fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: "Prepare elevations" } });
    fireEvent.change(within(form).getByLabelText("Target date"), { target: { value: "2026-10-18" } });
    fireEvent.change(within(form).getByLabelText(mode === "subtask" ? "Reason" : "Edit reason"), { target: { value: "Prepare the elevations" } });
    const oversized = "x".repeat(2001);
    fireEvent.change(input, { target: { value: oversized } });
    fireEvent.submit(form);
    if (mode === "subtask") await waitFor(() => expect(input).toHaveAccessibleDescription("Description must be 2000 characters or fewer."));
    else await within(dialog).findByText("Description must be 2000 characters or fewer.");
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === commandPath && init?.method === method)).toHaveLength(0);
    expect(input).toHaveValue(oversized);
    expect(input).toHaveAttribute("maxlength", "2000");

    const accepted = "x".repeat(2000);
    fireEvent.change(input, { target: { value: accepted } });
    fireEvent.submit(form);
    await within(dialog).findByText(mode === "subtask" ? "Subtask created." : "Task details updated.");
    const commands = fetchMock.mock.calls.filter(([url, init]) => String(url) === commandPath && init?.method === method);
    expect(commands).toHaveLength(1);
    expect(JSON.parse(String(commands[0]?.[1]?.body))).toMatchObject({ description: accepted });
  });

  it.each([
    ["OWNER", { version: 1, variant: "OWNER", resolution: "ACCOUNT_KIND" }, "Create or assign a task"],
    ["EMPLOYEE", { version: 1, variant: "EMPLOYEE", resolution: "GENERIC_FALLBACK" }, "Create my task"],
    ["LEADER", { version: 1, variant: "LEADER", resolution: "CONFIGURED_ROLE" }, "Assign work"],
    ["SITE", { version: 1, variant: "SITE", resolution: "CONFIGURED_ROLE" }, "Create site work"],
    ["non-Owner with Owner hint", { version: 1, variant: "OWNER", resolution: "ACCOUNT_KIND" }, "Create my task"],
    ["missing profile", undefined, "Create my task"],
    ["unknown variant", { version: 1, variant: "DESIGNER", resolution: "CONFIGURED_ROLE" }, "Create my task"],
    ["unsupported profile version", { version: 2, variant: "LEADER", resolution: "CONFIGURED_ROLE" }, "Create my task"],
  ] as const)("keeps %s as presentation only and preserves the canonical create form", async (_label, creationProfile, heading) => {
    const canAssign = _label === "LEADER" || _label === "SITE" ? false : setup.canAssign;
    const nextSetup = { ...setup, canAssign, ...(creationProfile ? { creationProfile } : {}) };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("/creation-options") ? response(creationOptionsForSetup(nextSetup, String(input))) : String(input).endsWith("/setup") ? response(nextSetup) : response({ total: 1, items: [task] })));
    render(<TaskWorkspace csrfToken="csrf" owner={_label === "OWNER"} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
    const form = screen.getByRole("form", { name: "Create task" });
    await waitFor(() => expect(within(form).queryByText("Loading eligible task participants…")).not.toBeInTheDocument());
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(within(form).getByLabelText("Task name")).toBeRequired();
    expect(within(form).getByLabelText("Target date")).toBeRequired();
    expect(within(form).getByLabelText("Reason")).toBeRequired();
    // compactOptionalPlanning = creationVariant === "EMPLOYEE" || === "SITE".
    // "non-Owner with Owner hint", "missing profile", "unknown variant" and
    // "unsupported profile version" all fall through to creationVariant "EMPLOYEE"
    // because owner=false and the profile doesn't resolve to OWNER/LEADER.
    const optionalPlanning = within(form).queryByText("Optional planning", { selector: "summary" });
    const expectsPlanning = _label === "OWNER" || _label === "LEADER";
    if (expectsPlanning) {
      expect(optionalPlanning).toBeInTheDocument();
      expect(optionalPlanning!.closest("details")).not.toHaveAttribute("open");
      expect(optionalPlanning!.closest("details")!.querySelectorAll("[required]")).toHaveLength(0);
    } else {
      expect(optionalPlanning).toBeNull();
    }
    if (_label === "LEADER") {
      expect(within(form).queryByLabelText("Primary owner")).not.toBeInTheDocument();
      expect(within(form).queryByText("Assign to an employee")).not.toBeInTheDocument();
      expect(within(form).queryAllByText("Collaborators (optional)")).toHaveLength(0);
    }
    if (_label === "SITE") {
      expect(within(form).getByLabelText("Type").querySelectorAll("option")).toHaveLength(6);
      expect(within(form).getByLabelText("Type")).toHaveValue("NON_PROJECT");
      expect(within(form).queryByLabelText("Primary owner")).toBeNull();
      expect(within(form).queryAllByText("Collaborators (optional)")).toHaveLength(0);
    }
  });
  it("shows only authorized subtask summaries, blocks parent completion generically, and creates on the parent with its projection version", async () => {
    const projection = { items: [{ id: "child-1", title: "Prepare elevations", status: "IN_PROGRESS", targetDate: "2026-10-18T00:00:00.000Z", primaryOwnerEmployeeId: "employee-2", primaryOwnerName: "Dev", version: 2 }], parent: null, isSubtask: false, completionBlocked: true, canCreate: true, taskVersion: 1 };
    const parentDetail = { ...detail, task: { ...task, status: "IN_PROGRESS" } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup({ ...setup, creationProfile: { version: 1, variant: "LEADER", resolution: "CONFIGURED_ROLE" } }, String(input)));
      if (url.endsWith("/setup")) return response({ ...setup, creationProfile: { version: 1, variant: "LEADER", resolution: "CONFIGURED_ROLE" } });
      if (url.includes("/api/v1/tasks?") || url.includes("/api/v1/tasks?")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1/subtasks") && method === "GET") return response(projection);
      if (url.endsWith("/task-1") && method === "GET") return response(parentDetail);
      if (url.endsWith("/task-1/subtasks") && method === "POST") return response({ task: { ...task, id: "child-new", isSubtask: true }, parentVersion: 2 });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="subtask-csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    const dialog = await screen.findByRole("dialog", { name: /Prepare concept/ });
    expect(await within(dialog).findByRole("region", { name: "Subtasks" })).toHaveTextContent("Prepare elevations");
    expect(within(dialog).getByText("This task cannot be completed until its subtasks are complete.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Complete task" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create subtask" }));
    const form = within(dialog).getByRole("form", { name: "Create subtask" });
    await waitFor(() => expect(within(form).queryByText("Loading eligible task participants…")).not.toBeInTheDocument());
    expect(within(form).getByRole("heading", { name: "Assign work · subtask" })).toBeInTheDocument();
    expect(within(form).getByLabelText("Parent project")).toHaveValue("Studio");
    fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: "Prepare elevations" } });
    fireEvent.change(within(form).getByLabelText("Target date"), { target: { value: "2026-10-18" } });
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Break out the elevation drawing work" } });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare elevations" }));
    expect(new URL(window.location.href).searchParams.get("taskId")).toBe("task-1");
    confirmSpy.mockRestore();
    fireEvent.click(within(form).getByRole("button", { name: "Create subtask" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/task-1/subtasks") && init?.method === "POST")).toBe(true));
    const command = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/task-1/subtasks") && init?.method === "POST")!;
    expect(JSON.parse(String(command[1]?.body))).toMatchObject({ title: "Prepare elevations", type: "PROJECT", projectId: "project-1", expectedParentVersion: 1, reason: "Break out the elevation drawing work" });
    expect(new Headers(command[1]?.headers).get("X-CSRF-Token")).toBe("subtask-csrf");
    expect(await within(dialog).findByText("Subtask created.")).toBeInTheDocument();
  });

  it("keeps parent links hidden when unauthorized and disables creation when the subtask projection is stale or denied", async () => {
    const projection = { items: [], parent: null, isSubtask: false, completionBlocked: false, canCreate: true, taskVersion: 2 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("/api/v1/tasks?")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1/subtasks")) return response(projection);
      if (url.endsWith("/task-1")) return response(detail);
      return response({});
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    const dialog = await screen.findByRole("dialog", { name: /Prepare concept/ });
    await within(dialog).findByText(/Task details changed while subtasks loaded/);
    expect(within(dialog).getByRole("button", { name: "Create subtask" })).toBeDisabled();
    expect(within(dialog).queryByText(/Part of/)).not.toBeInTheDocument();
  });
  it("does not expose create controls when the server denies subtask creation", async () => {
    const projection = { items: [], parent: null, isSubtask: true, completionBlocked: false, canCreate: false, taskVersion: 1 };
    const childTask = { ...task, id: "child-1", isSubtask: true as const };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("/api/v1/tasks?")) return response({ total: 1, items: [childTask] });
      if (url.endsWith("/child-1/subtasks")) return response(projection);
      if (url.endsWith("/child-1")) return response({ ...detail, task: childTask });
      return response({});
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    expect(await screen.findByText(/^Subtask/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open task: Prepare concept" }));
    const dialog = await screen.findByRole("dialog", { name: /Prepare concept/ });
    await within(dialog).findByRole("region", { name: "Subtasks" });
    expect(within(dialog).queryByRole("button", { name: "Create subtask" })).not.toBeInTheDocument();
  });
  it("fails closed when a subtask projection contains an invalid child summary", async () => {
    const projection = { items: [{ id: "child-1", title: "Broken child", status: "IN_PROGRESS", targetDate: "not-a-date", primaryOwnerEmployeeId: "employee-2", primaryOwnerName: "Dev", version: 1 }], parent: null, isSubtask: false, completionBlocked: false, canCreate: true, taskVersion: 1 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("/api/v1/tasks?")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1/subtasks")) return response(projection);
      if (url.endsWith("/task-1")) return response(detail);
      return response({});
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    const dialog = await screen.findByRole("dialog", { name: /Prepare concept/ });
    expect(await within(dialog).findByText("Subtasks could not be loaded.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Create subtask" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Broken child")).not.toBeInTheDocument();
  });
  it("opens an authorized parent through canonical task navigation", async () => {
    window.history.replaceState(null, "", "/my-work?taskId=child-1");
    const childTask = { ...task, id: "child-1", title: "Prepare elevations", isSubtask: true as const };
    const projection = { items: [], parent: { id: "task-1", title: "Prepare concept" }, isSubtask: true, completionBlocked: false, canCreate: false, taskVersion: 1 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("/api/v1/tasks?")) return response({ total: 1, items: [childTask] });
      if (url.endsWith("/child-1/subtasks")) return response(projection);
      if (url.endsWith("/child-1")) return response({ ...detail, task: childTask });
      if (url.endsWith("/task-1/subtasks")) return response({ ...projection, parent: null, isSubtask: false });
      if (url.endsWith("/task-1")) return response(detail);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    const dialog = await screen.findByRole("dialog", { name: /Prepare elevations/ });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Prepare concept" }));
    expect(await screen.findByRole("dialog", { name: /Prepare concept/ })).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("taskId")).toBe("task-1");
  });
  it("hides the previous task's children immediately while a newly selected task projection is pending", async () => {
    window.history.replaceState(null, "", "/my-work?taskId=task-1");
    let resolveNextProjection: ((value: Response) => void) | undefined;
    const firstProjection = { items: [{ id: "child-a", title: "A child", status: "IN_PROGRESS", targetDate: "2026-10-18T00:00:00.000Z", primaryOwnerEmployeeId: "employee-2", primaryOwnerName: "Dev", version: 1 }], parent: null, isSubtask: false, completionBlocked: false, canCreate: true, taskVersion: 1 };
    const secondTask = { ...task, id: "task-2", title: "Second task", version: 2 };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/setup")) return Promise.resolve(response(setup));
      if (url.includes("/api/v1/tasks?")) return Promise.resolve(response({ total: 2, items: [task, secondTask] }));
      if (url.endsWith("/task-1/subtasks")) return Promise.resolve(response(firstProjection));
      if (url.endsWith("/task-2/subtasks")) return new Promise<Response>((resolve) => { resolveNextProjection = resolve; });
      if (url.endsWith("/task-1")) return Promise.resolve(response(detail));
      if (url.endsWith("/task-2")) return Promise.resolve(response({ ...detail, task: secondTask }));
      return Promise.resolve(response({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    const dialog = await screen.findByRole("dialog", { name: /Prepare concept/ });
    expect(await within(dialog).findByText("A child")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Second task" }));
    const nextDialog = await screen.findByRole("dialog", { name: /Second task/ });
    expect(within(nextDialog).queryByText("A child")).not.toBeInTheDocument();
    expect(within(nextDialog).queryByRole("button", { name: "A child" })).not.toBeInTheDocument();
    await waitFor(() => expect(resolveNextProjection).toBeTypeOf("function"));
    await act(async () => { resolveNextProjection!(response({ items: [], parent: null, isSubtask: false, completionBlocked: false, canCreate: false, taskVersion: 2 })); });
    await within(nextDialog).findByText("No subtasks.");
  });
  it("acknowledges a child capacity warning through the same parent subtask command", async () => {
    const projection = { items: [], parent: null, isSubtask: false, completionBlocked: false, canCreate: true, taskVersion: 1 };
    let acknowledged = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("/api/v1/tasks?")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1/subtasks") && method === "GET") return response(projection);
      if (url.endsWith("/task-1") && method === "GET") return response(detail);
      if (url.endsWith("/task-1/subtasks") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.acknowledgeOverload) { acknowledged = true; return response({ task: { ...task, id: "child-new" }, parentVersion: 2 }); }
        return response({ message: "Overload warning: review employee capacity and acknowledge before assigning work" }, 409);
      }
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    const dialog = await screen.findByRole("dialog", { name: /Prepare concept/ });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Create subtask" }));
    const form = within(dialog).getByRole("form", { name: "Create subtask" });
    await waitFor(() => expect(within(form).queryByText("Loading eligible task participants…")).not.toBeInTheDocument());
    fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: "Check capacity" } });
    fireEvent.change(within(form).getByLabelText("Target date"), { target: { value: "2026-10-18" } });
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Review capacity for this assignment" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create subtask" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Acknowledge and create subtask" }));
    await waitFor(() => expect(acknowledged).toBe(true));
    const ack = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/task-1/subtasks") && init?.method === "POST" && JSON.parse(String(init.body)).acknowledgeOverload)!;
    expect(JSON.parse(String(ack[1]?.body))).toMatchObject({ expectedParentVersion: 1, acknowledgeOverload: true });
    expect(new Headers(ack[1]?.headers).get("X-CSRF-Token")).toBe("csrf");
  });
  it.each([false, true])("clears a discarded child draft and its parent capacity warning on accepted navigation (warning=%s)", async (warning) => {
    const secondTask = { ...task, id: "task-2", title: "Second parent" };
    const projection = { items: [], parent: null, isSubtask: false, completionBlocked: false, canCreate: true, taskVersion: 1 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("/api/v1/tasks?")) return response({ total: 2, items: [task, secondTask] });
      if (url.endsWith("/subtasks") && init?.method === "POST") return response({ message: "Overload warning: review employee capacity and acknowledge before assigning work" }, 409);
      if (url.endsWith("/subtasks")) return response(projection);
      if (url.endsWith("/task-1")) return response(detail);
      if (url.endsWith("/task-2")) return response({ ...detail, task: secondTask });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    const first = await screen.findByRole("dialog", { name: /Prepare concept/ });
    fireEvent.click(await within(first).findByRole("button", { name: "Create subtask" }));
    const form = within(first).getByRole("form", { name: "Create subtask" });
    await waitFor(() => expect(within(form).queryByText("Loading eligible task participants…")).not.toBeInTheDocument());
    fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: "Parent one private draft" } });
    fireEvent.change(within(form).getByLabelText("Target date"), { target: { value: "2026-10-18" } });
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Create child under parent one" } });
    if (warning) {
      fireEvent.click(within(form).getByRole("button", { name: "Create subtask" }));
      await within(first).findByRole("button", { name: "Acknowledge and create subtask" });
    }
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(first).getByRole("button", { name: "Next task" }));
    const second = await screen.findByRole("dialog", { name: /Second parent/ });
    expect(within(second).queryByRole("form", { name: "Create subtask" })).not.toBeInTheDocument();
    expect(within(second).queryByRole("button", { name: "Acknowledge and create subtask" })).not.toBeInTheDocument();
    fireEvent.click(await within(second).findByRole("button", { name: "Create subtask" }));
    const nextForm = within(second).getByRole("form", { name: "Create subtask" });
    expect(within(nextForm).getByLabelText("Task name")).toHaveValue("");
    expect(within(nextForm).getByLabelText("Target date")).toHaveValue("");
    expect(within(nextForm).getByLabelText("Reason")).toHaveValue("");
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/task-2/subtasks") && init?.method === "POST")).toBe(false);
    confirmSpy.mockRestore();
  });
  it("keeps metric-card selection and the task drawer unchanged while a command is pending", async () => {
    let finishCommand: ((value: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/setup")) return Promise.resolve(response(setup));
      if (url.endsWith("/task-1/state") && init?.method === "POST") return new Promise<Response>(resolve => { finishCommand = resolve; });
      if (url.includes("/api/v1/tasks?")) return Promise.resolve(response({ total: 1, items: [task] }));
      if (url.endsWith("/task-1")) return Promise.resolve(response(detail));
      return Promise.resolve(response({ total: 0, items: [] }));
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    const dialog = await screen.findByRole("dialog", { name: /Prepare concept/ });
    fireEvent.change(within(dialog).getByLabelText("Reason for change"), { target: { value: "Begin scheduled work" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(finishCommand).toBeDefined());
    const before = window.location.href;
    // jsdom does not implement native dialog inertness; test the handler guard directly.
    fireEvent.click(screen.getByRole("button", { name: /Needs action: filter authorized/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reviews: 1" }));
    expect(window.location.href).toBe(before);
    expect(screen.getByRole("dialog", { name: /Prepare concept/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs your attention" })).not.toBeInTheDocument();
    finishCommand!(response({}, 409));
    await within(dialog).findByText(/changed elsewhere/);
  });
  it("opens the mixed attention filter even while the personal task queue is still loading", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/setup")) return new Promise<Response>(() => undefined);
      if (url.includes("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      if (url.includes("/my-work/attention?")) return response({ status: "ready", source: "all", sourceCounts: { task: { status: "ready", total: 0 }, review: { status: "ready", total: 0 }, approval: { status: "ready", total: 0 } }, items: [], totalItems: 0, offset: 0, limit: 25, hasMore: false, readAt: "2026-10-13T12:00:00Z", timezone: "Asia/Kolkata" });
      return response({ total: 3, items: [] });
    }));
    render(<MemoryRouter><TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: /Needs action: filter authorized/ }));
    expect(await screen.findByRole("region", { name: "Needs your attention" })).toBeInTheDocument();
    expect(screen.getByLabelText("Attention work type")).toHaveValue("all");
    expect(screen.getByRole("button", { name: /Needs action: filter authorized/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(await screen.findByRole("button", { name: "Reviews: 3" }));
    expect(new URL(window.location.href).searchParams.get("workPhase")).toBe("reviews");
    expect(screen.queryByRole("region", { name: "Needs your attention" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open task:/ })).not.toBeInTheDocument();
  });
  it("prioritizes separately authorized obligations for a confirmed employee-less Owner with an empty queue", async () => {
    const noEmployeeSetup = { ...setup, actorEmployeeId: null };
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(noEmployeeSetup, String(input)));
      if (url.endsWith("/setup")) return response(noEmployeeSetup);
      if (url.includes("/api/v1/tasks")) return response({ total: 0, items: [] });
      return response({ total: 0, items: [] });
    }));
    const obligations = vi.fn(({ employeeLessOwner }: { employeeLessOwner: boolean }) => <div aria-label="Management obligations">{employeeLessOwner ? "Five authorized reassignment items" : "Other obligations"}</div>);
    render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly personalObligations={obligations} />);

    expect(await screen.findByRole("heading", { name: "No personal tasks" })).toBeInTheDocument();
    expect(await screen.findByText("Five authorized reassignment items")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Active personal tasks: 0/ })).toBeInTheDocument();
    const filterForm = screen.getByRole("form", { name: "Task filters" });
    expect(screen.getByRole("textbox", { name: "Search tasks" })).toBeInTheDocument();
    const more = screen.getByText("More", { selector: "summary" }).closest("details")!;
    more.open = true;
    expect(within(more).getByRole("group", { name: "Task display" })).toBeInTheDocument();
    expect(within(more).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(more).getByRole("button", { name: "Active personal tasks: 0" })).toBeInTheDocument();
    expect(within(more).getByRole("button", { name: "Waiting personal tasks: 0" })).toBeInTheDocument();
    expect(within(more).getByRole("button", { name: "Personal tasks in review phase: 0" })).toBeInTheDocument();
    expect(within(more).getByRole("button", { name: "Completed personal tasks: 0" })).toBeInTheDocument();
    fireEvent.click(within(filterForm).getByLabelText("Filters and sort"));
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "IN_PROGRESS" } });
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "  authorized work  " } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(requests.some((url) => {
      const query = new URL(url, "http://localhost").searchParams;
      return url.includes("/api/v1/tasks?") && query.get("scope") === "personal" && query.get("q") === "authorized work" && query.get("status") === "IN_PROGRESS";
    })).toBe(true));
    expect(screen.getAllByText(/This Owner account is not linked to an employee/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Open task:/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    expect(obligations).toHaveBeenCalledWith({ employeeLessOwner: true, onActionCounts: expect.any(Function) });
    const management = screen.getByLabelText("Management obligations");
    const personalEmpty = screen.getByRole("heading", { name: "No personal tasks" }).closest(".task-owner-empty")!;
    expect(management.compareDocumentPosition(filterForm) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(filterForm.compareDocumentPosition(personalEmpty) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(management.compareDocumentPosition(personalEmpty) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByRole("link", { name: "Open organization work" })).toHaveAttribute("href", "/tasks");
  });

  it("does not classify a denied setup response as an employee-less Owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      if (url.endsWith("/setup")) return response({ message: "Forbidden" }, 403);
      if (url.includes("/reviews/inbox")) return response({ total: 0, items: [] });
      if (url.includes("/api/v1/tasks")) return response({ total: 0, items: [] });
      return response({});
    }));
    const obligations = vi.fn(() => <div>Management obligations</div>);
    render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly personalObligations={obligations} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("do not have access");
    expect(screen.queryByRole("heading", { name: "No personal tasks" })).not.toBeInTheDocument();
    expect(obligations).toHaveBeenCalledWith({ employeeLessOwner: false, onActionCounts: expect.any(Function) });
  });

  it("does not infer an employee-less Owner layout when setup data is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      if (url.endsWith("/setup")) return response({ message: "Setup unavailable" }, 503);
      if (url.includes("/reviews/inbox")) return response({ total: 0, items: [] });
      if (url.includes("/api/v1/tasks")) return response({ total: 0, items: [] });
      return response({});
    }));
    const obligations = vi.fn(() => <div>Management obligations</div>);
    render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly personalObligations={obligations} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Tasks could not be loaded");
    expect(screen.queryByRole("heading", { name: "No personal tasks" })).not.toBeInTheDocument();
    expect(obligations).toHaveBeenCalledWith({ employeeLessOwner: false, onActionCounts: expect.any(Function) });
  });

  it("drills summary counts into the same filtered paginated personal queue and restores base phase on clear", async () => {
    vi.stubGlobal("innerWidth", 390);
    window.history.replaceState(null, "", "/my-work?projectId=project-1&q=concept");
    const requests: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.endsWith("/waiting-50")) return response({ ...detail, task: { ...task, id: "waiting-50", title: "waiting task 50", status: "WAITING" } });
      const parsed = new URL(url, "http://localhost"); requests.push(parsed);
      const phase = parsed.searchParams.get("phase") ?? "active";
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const total = phase === "active" ? 51 : phase === "waiting" ? 52 : phase === "review" ? 53 : 54;
      const limit = Number(parsed.searchParams.get("limit"));
      if (limit === 1) return response({ total, items: [{ id: `count-${phase}` }] });
      const queuedTask = { ...task, id: `${phase}-${offset}`, title: `${phase} task ${offset}`, status: phase === "waiting" ? "WAITING" : "NOT_STARTED" };
      return response({ total, items: [queuedTask] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="task-csrf" owner={false} listFirst personalOnly />);

    expect(await screen.findByRole("button", { name: "Open task: active task 0" })).toBeInTheDocument();
    const more = screen.getByText("More", { selector: "summary" }).closest("details")!;
    more.setAttribute("open", "");
    await screen.findByRole("button", { name: "Active personal tasks: 51" });
    await screen.findByRole("button", { name: "Completed personal tasks: 54" });
    more.removeAttribute("open");
    const waitingTile = await screen.findByRole("button", { name: "Waiting / blocked: 52" });
    fireEvent.click(waitingTile);
    expect(await screen.findByRole("button", { name: "Open task: waiting task 0" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Work card results" })).toHaveTextContent("52 tasks · Waiting / blocked");
    expect(within(screen.getByRole("region", { name: "Work overview" })).queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Work queue" })).toHaveFocus();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
    expect(waitingTile).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.searchParams.get("workPhase")).toBe("waiting");
      expect(url.searchParams.get("phase")).toBe("active");
    });
    expect(requests.some((url) => url.searchParams.get("phase") === "waiting" && url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === "50" && url.searchParams.get("projectId") === "project-1" && url.searchParams.get("q") === "concept")).toBe(true);
    const row = screen.getByRole("button", { name: "Open task: waiting task 0" });
    const paging = screen.getByRole("button", { name: "Next" }).closest(".task-list-paging")!;
    expect(row.compareDocumentPosition(paging) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("button", { name: "Open task: waiting task 50" })).toBeInTheDocument();
    expect(requests.some((url) => url.searchParams.get("phase") === "waiting" && url.searchParams.get("offset") === "50")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open task: waiting task 50" }));
    expect(await screen.findByRole("heading", { name: "waiting task 50" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to task list" }));
    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.searchParams.get("workPhase")).toBe("waiting");
      expect(url.searchParams.get("taskId")).toBeNull();
    });
    expect(await screen.findByRole("button", { name: "Open task: waiting task 50" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear work card selection" }));
    expect(await screen.findByRole("button", { name: "Open task: active task 0" })).toBeInTheDocument();
    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.searchParams.get("workPhase")).toBeNull();
      expect(url.searchParams.get("phase")).toBe("active");
      expect(url.searchParams.get("projectId")).toBe("project-1");
      expect(url.searchParams.get("q")).toBe("concept");
    });
  });

  it("preserves an unsaved task action when card switching is cancelled", async () => {
    window.history.replaceState(null, "", "/my-work");
    const waitDetail = { ...detail, task: { ...task, status: "IN_PROGRESS" }, capabilities: { ...detail.capabilities, wait: true } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = String(input);
      if (url.endsWith("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.endsWith("/task-1")) return response(waitDetail);
      return response({ total: 1, items: [waitDetail.task] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    fireEvent.change(await screen.findByLabelText("Reason for waiting"), { target: { value: "Keep this unfinished explanation" } });
    const waiting = await screen.findByRole("button", { name: "Waiting / blocked: 1" });
    fireEvent.click(waiting);
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Reason for waiting")).toHaveValue("Keep this unfinished explanation");
    expect(waiting).toHaveAttribute("aria-pressed", "false");
    expect(new URL(window.location.href).searchParams.get("taskId")).toBe("task-1");
    confirm.mockReturnValue(true);
    fireEvent.click(waiting);
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("workPhase")).toBe("waiting"));
    expect(screen.queryByLabelText("Reason for waiting")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Work queue" })).toHaveFocus();
    confirm.mockRestore();
  });

  it.each([390, 320])("toggles and replaces card filters at %spx while revealing the queue and preserving search", async width => {
    vi.stubGlobal("innerWidth", width);
    window.history.replaceState(null, "", "/my-work?projectId=project-1&q=concept&offset=50");
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.pathname.endsWith("/setup")) return response(setup);
      if (url.pathname.endsWith("/task-1")) return response(detail);
      if (url.pathname.includes("/reviews/inbox")) return response({ total: 0, items: [] });
      requests.push(url);
      const total = url.searchParams.get("phase") === "waiting" ? 3 : url.searchParams.get("dateBasis") === "target" ? 2 : 51;
      return response({ total, items: [task] });
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Open task: Prepare concept" }));
    await screen.findByRole("heading", { name: "Prepare concept" });
    const waiting = await screen.findByRole("button", { name: "Waiting / blocked: 3" });
    fireEvent.click(waiting);
    await waitFor(() => expect(screen.getByRole("status", { name: "Work card results" })).toHaveTextContent("3 tasks · Waiting / blocked"));
    expect(screen.queryByRole("heading", { name: "Prepare concept" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Work queue" })).toHaveFocus();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("offset")).toBe(false));
    expect(new URL(window.location.href).searchParams.has("taskId")).toBe(false);
    fireEvent.click(waiting);
    await waitFor(() => expect(screen.queryByRole("status", { name: "Work card results" })).not.toBeInTheDocument());
    expect(waiting).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(waiting);
    fireEvent.click(await screen.findByRole("button", { name: "Overdue: 2" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Work card results" })).toHaveTextContent("2 tasks · Overdue"));
    expect(waiting).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Overdue: 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Waiting / blocked: 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear work card selection" }));
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("workPhase")).toBe(false));
    expect(new URL(window.location.href).searchParams.get("projectId")).toBe("project-1");
    expect(new URL(window.location.href).searchParams.get("q")).toBe("concept");
    expect(requests.some(url => url.searchParams.get("phase") === "waiting" && url.searchParams.get("limit") === "50" && url.searchParams.get("offset") === "0")).toBe(true);
  });

  it("uses the same Target-overdue preset for count and queue and restores the applied Committed range", async () => {
    window.history.replaceState(null, "", "/my-work?projectId=project-1&q=concept&dateBasis=committed&dateFrom=2026-10-01&dateTo=2026-10-31");
    const requests: URL[] = [];
    let failCalendar = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/dashboard/sources/tasks")) return failCalendar ? response({}, 503) : response({ source: "tasks", today: "2026-10-12" });
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.pathname.endsWith("/setup")) return response(setup);
      if (url.pathname.includes("/reviews/inbox")) return response({ total: 2, items: [] });
      requests.push(url);
      return response({ total: 51, items: [task] });
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    const card = await screen.findByRole("button", { name: "Overdue: 51" });
    fireEvent.click(card);
    await waitFor(() => expect(requests.some(url => url.searchParams.get("dateBasis") === "target" && url.searchParams.get("limit") === "50")).toBe(true));
    for (const limit of ["1", "50"]) {
      const query = requests.find(url => url.searchParams.get("dateBasis") === "target" && url.searchParams.get("limit") === limit)!;
      expect(query.searchParams.get("scope")).toBe("personal");
      expect(query.searchParams.get("phase")).toBe("active");
      expect(query.searchParams.get("dateTo")).toBe("2026-10-11");
      expect(query.searchParams.get("dateFrom")).toBeNull();
      expect(query.searchParams.get("projectId")).toBe("project-1");
      expect(query.searchParams.get("q")).toBe("concept");
    }
    expect(screen.getByText(/Applied date range paused while this card filter is active/)).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("dateBasis")).toBe("committed");
    expect(new URL(window.location.href).searchParams.get("workPhase")).toBe("overdue");
    failCalendar = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText(/Overdue calendar or count is unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open task: Prepare concept" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear work card selection" }));
    expect(await screen.findByRole("button", { name: "Open task: Prepare concept" })).toBeInTheDocument();
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("dateFrom")).toBe("2026-10-01"));
    expect(requests.at(-1)?.searchParams.get("dateTo")).toBe("2026-10-31");
  });

  it("renders the prototype priority pill and mobile status/due chips on personal rows only", async () => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.pathname.endsWith("/setup")) return response(setup);
      if (url.pathname.endsWith("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-12" });
      requests.push(url);
      return response({ total: 1, items: [task] });
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    const open = await screen.findByRole("button", { name: "Open task: Prepare concept" });
    // The parity row is an overlay button plus sibling cells, so step up to the row.
    const row = open.closest(".my-work-demo-row")!;
    const pill = row.querySelector(".my-work-priority-cell .my-work-priority")!;
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent("Normal");
    expect(pill.className).toContain("pr-Normal");
    const rowText = row.querySelector(".my-work-row-text")!;
    expect(rowText.querySelector(".my-work-mobile-state")).toHaveTextContent("Not started");
    expect(rowText.querySelector(".my-work-mobile-due")).toHaveTextContent("2026-10-12");
  });

  it("marks the mobile due chip overdue from the organization calendar, not the browser clock", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.pathname.endsWith("/setup")) return response(setup);
      if (url.pathname.endsWith("/dashboard/sources/tasks")) return response({ source: "tasks", today: "2026-10-20" });
      return response({ total: 1, items: [task] });
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
    const open = await screen.findByRole("button", { name: "Open task: Prepare concept" });
    const row = open.closest(".my-work-demo-row")!;
    await waitFor(() => {
      const due = row.querySelector(".my-work-row-text .my-work-mobile-due")!;
      expect(due.classList.contains("overdue")).toBe(true);
    });
  });

  it("keeps the organization priority text on non-personal rows without the prototype pill", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.pathname.endsWith("/setup")) return response(setup);
      return response({ total: 1, items: [task] });
    }));
    render(<TaskWorkspace csrfToken="csrf" owner listFirst={false} personalOnly={false} />);
    const row = await screen.findByRole("button", { name: "Open task: Prepare concept" });
    const priorityCell = row.querySelector(".task-queue-priority")!;
    expect(priorityCell.querySelector(".priority-pill")).toBeNull();
    expect(priorityCell.querySelector(".task-priority")).toHaveTextContent("MEDIUM");
    expect(row.querySelector(".task-queue-primary .my-work-mobile-state")).toBeNull();
  });

  it("keeps display controls discoverable in More while placing explanation and pagination after the populated queue", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      const parsed = new URL(url, "http://localhost");
      return response({ total: 51, items: [{ ...task, id: `task-${parsed.searchParams.get("offset") ?? "0"}` }] });
    }));
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);

    const row = await screen.findByRole("button", { name: "Open task: Prepare concept" });
    const search = screen.getByRole("textbox", { name: "Search tasks" });
    const filterForm = screen.getByRole("form", { name: "Task filters" });
    expect(filterForm).not.toHaveClass("has-expanded-search");
    fireEvent.focus(search);
    fireEvent.blur(search);
    expect(filterForm).toHaveClass("has-expanded-search");
    const disclosure = screen.getByText("More", { selector: "summary" }).closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("More", { selector: "summary" }));
    disclosure.setAttribute("open", "");
    const toolbar = screen.getByRole("group", { name: "Task display" }).closest<HTMLDivElement>(".task-toolbar")!;
    const paging = screen.getByRole("button", { name: "Next" }).closest(".task-list-paging")!;
    const about = screen.getByText("About task counts", { selector: "summary" }).closest("details")!;
    expect(disclosure).toContainElement(toolbar);
    expect(toolbar.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(row.compareDocumentPosition(paging) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(paging.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reset filters" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(filterForm).not.toHaveClass("has-expanded-search");
  });

  it("shows timestamped same-query stale rows but clears them before a changed-query failure", async () => {
    let failAll = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      const parsed = new URL(url, "http://localhost");
      if (failAll && parsed.pathname === "/api/v1/tasks") return response({ message: "Task service unavailable." }, 503);
      return response({ total: 1, items: [{ ...task, id: parsed.searchParams.get("scope") ?? "all", title: `Rows for ${parsed.searchParams.get("scope") ?? "all"}` }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="task-csrf" owner listFirst />);
    expect(await screen.findByRole("button", { name: "Open task: Rows for all" })).toBeInTheDocument();
    failAll = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/stale snapshot/i);
    expect(screen.getByText(/Stale snapshot · last successfully refreshed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open task: Rows for all" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Task scope" }), { target: { value: "owned" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open task: Rows for all" })).not.toBeInTheDocument());
    expect(await screen.findByRole("alert")).toHaveTextContent("Tasks could not be loaded");
    expect(screen.queryByText(/Stale snapshot · last successfully refreshed/)).not.toBeInTheDocument();
  });

  it("shows canonical queue states, priorities, primary owner and separate target and committed dates", async () => {
    const statuses = ["NOT_STARTED", "IN_PROGRESS", "WAITING", "SUBMITTED_INTERNAL_REVIEW", "IN_INTERNAL_REVIEW", "CORRECTIONS_REQUIRED", "INTERNAL_APPROVED", "SUBMITTED_CLIENT_REVIEW", "IN_CLIENT_REVIEW", "CLIENT_REVISION_REQUIRED", "CLIENT_APPROVED", "COMPLETED", "STOPPED_DUE_TO_PROJECT_CANCELLATION"];
    const priorities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const items = statuses.map((status, index) => ({ ...task, id: `queue-${index}`, title: `Queue task ${index}`, status, priority: priorities[index % priorities.length]!, primaryOwnerEmployeeId: index === 1 ? "departed-employee" : "employee-1", committedDueDate: index === 0 ? null : "2026-10-20T00:00:00.000Z", requiresReassignment: index === 1 }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/creation-options") ? response(creationOptionsForSetup(setup, String(input))) : String(input).endsWith("/setup") ? response(setup) : response({ total: items.length, items }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="task-csrf" owner listFirst />);

    const first = await screen.findByRole("button", { name: "Open task: Queue task 0" });
    const firstRow = first.closest(".task-queue-row")!;
    const secondRow = screen.getByRole("button", { name: "Open task: Queue task 1" }).closest(".task-queue-row")!;
    expect(firstRow).toHaveTextContent("Asha");
    expect(firstRow).toHaveTextContent("Low");
    expect(firstRow).toHaveTextContent("Concept");
    expect(firstRow.querySelector(".task-queue-committed strong")).toHaveTextContent("\u2014");
    expect(firstRow).toHaveTextContent("12 Oct 2026");
    expect(secondRow).toHaveTextContent("20 Oct 2026");
    expect(first).toHaveAccessibleDescription(/Primary owner: Asha\. Priority: LOW\. Status: Not started/);
    expect(secondRow).toHaveTextContent("Task owner");
    expect(secondRow).toHaveTextContent("Needs reassignment after employee exit");
    for (const priority of priorities) expect(screen.getAllByText(priority.toLowerCase().replace(/^./, letter => letter.toUpperCase()), { selector: ".task-priority" }).length).toBeGreaterThan(0);
    for (const status of statuses) expect(screen.getByText(status.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()), { selector: ".task-state" })).toBeInTheDocument();
    expect(screen.queryByText("Dev", { selector: ".task-queue-cell" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/tasks/queue-"))).toBe(false);
  });

  it("keeps mobile selector options, task selection, query state and Back navigation connected", async () => {
    let detailRead = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.endsWith("/task-1")) { detailRead = true; return response(detail); }
      return response({ total: 1, items: [task] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="task-csrf" owner listFirst />);
    await screen.findByRole("button", { name: "Open task: Prepare concept" });
    const scope = screen.getByLabelText("Task scope");
    // Owner role is offered the demo's two scopes; both are existing backend
    // scopes (`mine` and `all`), only the labels follow the demo.
    expect(within(scope).getAllByRole("option").map((option) => option.textContent)).toEqual(["Organization"]);
    const display = screen.getByLabelText("Task display mode");
    fireEvent.change(display, { target: { value: "timeline" } });
    expect(new URL(window.location.href).searchParams.get("view")).toBe("timeline");
    fireEvent.change(display, { target: { value: "list" } });
    fireEvent.click(screen.getByRole("button", { name: "Open task: Prepare concept" }));
    await screen.findByRole("heading", { name: "Prepare concept" });
    await waitFor(() => expect(detailRead).toBe(true));
    expect(new URL(window.location.href).searchParams.get("taskId")).toBe("task-1");
    fireEvent.click(screen.getByRole("button", { name: "Back to task list" }));
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("taskId")).toBeNull());
    expect(screen.getByRole("button", { name: "Open task: Prepare concept" })).toBeInTheDocument();
  });

  it("applies the approved task filters as a resettable backend query", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      return response({ total: 0, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="task-csrf" owner listFirst />);
    await screen.findByRole("form", { name: "Task filters" });

    fireEvent.change(screen.getByLabelText("Filter by project"), { target: { value: "project-1" } });
    fireEvent.change(screen.getByLabelText("Filter by primary owner"), { target: { value: "employee-2" } });
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "  concept review  " } });
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "IN_PROGRESS" } });
    fireEvent.change(screen.getByLabelText("Filter by phase"), { target: { value: "waiting" } });
    fireEvent.change(screen.getByLabelText("Filter date basis"), { target: { value: "committed" } });
    fireEvent.change(screen.getByLabelText("Filter date from"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Filter date through"), { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => expect(requests.some((url) => url.includes("ownerEmployeeId=employee-2"))).toBe(true));
    const applied = new URL(requests.filter((url) => url.includes("ownerEmployeeId=employee-2")).at(-1)!, "http://localhost");
    expect(applied.searchParams.get("projectId")).toBe("project-1");
    expect(applied.searchParams.get("q")).toBe("concept review");
    expect(applied.searchParams.get("status")).toBe("IN_PROGRESS");
    expect(applied.searchParams.get("phase")).toBe("waiting");
    expect(applied.searchParams.get("dateBasis")).toBe("committed");
    expect(applied.searchParams.get("dateFrom")).toBe("2026-10-01");
    expect(applied.searchParams.get("dateTo")).toBe("2026-10-31");

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(requests.filter((url) => url.includes("/api/v1/tasks?")).at(-1)).toContain("offset=0"));
    const reset = new URL(requests.filter((url) => url.includes("/api/v1/tasks?")).at(-1)!, "http://localhost");
    expect(reset.searchParams.get("projectId")).toBeNull();
    expect(reset.searchParams.get("ownerEmployeeId")).toBeNull();
    expect(reset.searchParams.get("q")).toBeNull();
    expect(reset.searchParams.get("dateBasis")).toBeNull();
  });

  it("keeps task creation blocked after an overload warning until explicit acknowledgement", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push([url, init]);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 0, items: [] });
      if (url === "/api/v1/tasks" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { acknowledgeOverload?: boolean };
        return body.acknowledgeOverload ? response(task) : response({ message: "Overload warning: review employee capacity and acknowledge before assigning work" }, 409);
      }
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="task-csrf" owner={false} />);
    await screen.findByText("No primary tasks match these filters.");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Assigned to you.");
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "Call supplier" } });
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-10-15" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Needed for project setup" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Create task" }).at(-1)!);
    const warning = await screen.findByRole("alert", { name: "Capacity warning" });
    expect(warning).toHaveTextContent("Overload warning");
    expect(calls.filter(([url, init]) => url === "/api/v1/tasks" && init?.method === "POST")).toHaveLength(1);
    fireEvent.click(within(warning).getByRole("button", { name: "Acknowledge and create task" }));
    await waitFor(() => expect(calls.filter(([url, init]) => url === "/api/v1/tasks" && init?.method === "POST")).toHaveLength(2));
    expect(JSON.parse(String(calls.filter(([url, init]) => url === "/api/v1/tasks" && init?.method === "POST")[1]?.[1]?.body))).toMatchObject({ acknowledgeOverload: true, title: "Call supplier", reason: "Needed for project setup" });
    expect(new Headers(calls.filter(([url, init]) => url === "/api/v1/tasks" && init?.method === "POST")[1]?.[1]?.headers).get("X-CSRF-Token")).toBe("task-csrf");
  });

  it("keeps reassignment unchanged until the manager acknowledges the capacity warning", async () => {
    const reassignable = { ...detail, capabilities: { ...detail.capabilities, reassign: true } };
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push([url, init]);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1")) return response(reassignable);
      if (url.endsWith("/task-1/reassign") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { acknowledgeOverload?: boolean };
        return body.acknowledgeOverload ? response({ ...task, primaryOwnerEmployeeId: "employee-2" }) : response({ message: "Overload warning: review employee capacity and acknowledge before reassigning work" }, 409);
      }
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="task-csrf" owner />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    fireEvent.change(screen.getByLabelText("New owner"), { target: { value: "employee-2" } });
    fireEvent.change(screen.getByLabelText("Reason for change"), { target: { value: "Move work to available teammate" } });
    fireEvent.click(screen.getByRole("button", { name: "Reassign" }));
    const warning = await screen.findByRole("alert", { name: "Capacity warning" });
    expect(calls.filter(([url]) => url.endsWith("/task-1/reassign"))).toHaveLength(1);
    expect(warning).toHaveTextContent("Assignment remains unchanged");
    fireEvent.click(within(warning).getByRole("button", { name: "Acknowledge and reassign owner" }));
    await waitFor(() => expect(calls.filter(([url]) => url.endsWith("/task-1/reassign"))).toHaveLength(2));
    expect(JSON.parse(String(calls.filter(([url]) => url.endsWith("/task-1/reassign"))[1]?.[1]?.body))).toMatchObject({ newOwnerEmployeeId: "employee-2", expectedVersion: 1, reason: "Move work to available teammate", acknowledgeOverload: true });
  });

  it("creates a self-task without sending an owner override and includes the CSRF token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 0, items: [] });
      if (url === "/api/v1/tasks") return response({ ...task, id: "new-task" });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-test" owner={false} />);
    await screen.findByText("No primary tasks match these filters.");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Assigned to you.");
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "Call supplier" } });
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-10-15" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Needed for project setup" } });
    // The self-task scenario renders the EMPLOYEE variant (owner={false}), which
    // runs the composer in compact mode — Tags/Checklist are hidden inside
    // "Optional planning" (not rendered). The assertions below confirm no
    // ownerEmployeeId is sent and that CSRF is attached.
    fireEvent.click(screen.getAllByRole("button", { name: "Create task" }).at(-1)!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/v1/tasks" && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/v1/tasks" && init?.method === "POST");
    expect(call?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-test" });
    const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("ownerEmployeeId");
    expect(body).toMatchObject({ title: "Call supplier", reason: "Needed for project setup" });
  });

  it("shows explicit assignment controls only when the setup endpoint permits assignment", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup({ ...setup, canAssign: false }, String(input)));
      if (url.endsWith("/setup")) return response({ ...setup, canAssign: false });
      if (url.includes("?scope=")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1")) return response(detail);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    expect(screen.queryByText("Assign to an employee")).not.toBeInTheDocument();
    expect(screen.getByText("Asha")).toBeInTheDocument();
    expect(screen.getByText("Linked plan item: Concept")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open internal review" })).toHaveAttribute("href", "/reviews?taskId=task-1");
    expect(screen.getByText("Design", { selector: ".task-tags li" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Confirm brief" })).toBeChecked();
  });

  it("opens correction instructions on the originating review round", async () => {
    const correctionTask: Task = { ...task, id: "correction-task", title: "Correct: Prepare concept", type: "CORRECTION" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [correctionTask] });
      if (url.endsWith("/correction-task")) return response({ ...detail, task: correctionTask, linkedReviewTaskId: "original-task" });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} />);
    await screen.findByRole("heading", { name: "Correct: Prepare concept" });
    expect(screen.getByRole("link", { name: "Open correction instructions in internal review" })).toHaveAttribute("href", "/reviews?taskId=original-task");
    expect(screen.queryByRole("link", { name: "Open internal review" })).not.toBeInTheDocument();
  });

  it("reports a stale task conflict and reloads authoritative details", async () => {
    let detailReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1/state") && init?.method === "POST") return response({}, 409);
      if (url.endsWith("/task-1")) { detailReads++; return response(detail); }
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    fireEvent.change(screen.getByLabelText("Reason for change"), { target: { value: "Begin scheduled work" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    expect(await screen.findByText(/changed elsewhere/)).toBeInTheDocument();
    await waitFor(() => expect(detailReads).toBeGreaterThan(1));
  });

  it("edits an open task with its expected version and reason", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1") && init?.method === "PUT") return response({ ...task, title: "Updated concept", version: 2 });
      if (url.endsWith("/task-1")) return response({ ...detail, capabilities: { ...detail.capabilities, edit: true } });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-edit" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    fireEvent.click(screen.getByRole("button", { name: "Edit task" }));
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "Updated concept" } });
    fireEvent.change(screen.getByLabelText("Edit reason"), { target: { value: "Clarify the design work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/task-1") && init?.method === "PUT")).toBe(true));
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/task-1") && init?.method === "PUT");
    expect(call?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-edit" });
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ expectedVersion: 1, title: "Updated concept", reason: "Clarify the design work", planItemId: "plan-1", tags: ["Design"], checklist: [{ label: "Confirm brief", checked: true }] });
    expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty("committedDueDate");
  });

  it("sets a committed date separately from target date and displays immutable change history", async () => {
    let current: Detail = { ...detail, task: { ...task, status: "IN_PROGRESS", version: 2 }, history: { statusChanges: [], ownerChanges: [], committedDateChanges: [] }, capabilities: { ...detail.capabilities, changeCommittedDate: true } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.endsWith("/task-1/committed-date") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 2, committedDueDate: "2026-10-20", reason: "Client approved the delivery commitment" });
        expect(init.headers).toMatchObject({ "X-CSRF-Token": "csrf-commit" });
        current = { ...current, task: { ...current.task, committedDueDate: "2026-10-20T00:00:00.000Z", version: 3 }, history: { ...current.history, committedDateChanges: [{ id: "date-change-1", oldDate: null, newDate: "2026-10-20T00:00:00.000Z", actorId: "owner-1", reason: "Client approved the delivery commitment", taskVersion: 3, occurredAt: "2026-09-29T10:00:00.000Z" }] } };
        return response(current);
      }
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-commit" owner={true} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    expect(screen.getByText("Target date").parentElement).toHaveTextContent("2026-10-12");
    expect(screen.getAllByText("Committed due date")[0]?.parentElement).toHaveTextContent("Not set");
    fireEvent.change(screen.getByLabelText("Committed due date"), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText("Reason", { selector: "input" }), { target: { value: "Client approved the delivery commitment" } });
    fireEvent.click(screen.getByRole("button", { name: "Set committed date" }));
    await screen.findByText("Committed due date set.");
    expect(screen.getAllByText("Committed due date")[0]?.parentElement).toHaveTextContent("2026-10-20");
    expect(screen.getByText(/Committed due date set to 2026-10-20: Client approved the delivery commitment/)).toBeInTheDocument();
    expect(screen.getByText("Target date").parentElement).toHaveTextContent("2026-10-12");
  });

  it("links an accessible predecessor and requires a second acknowledged early-start action", async () => {
    let current: Detail = { ...detail, task: { ...task, status: "NOT_STARTED", version: 1 }, dependencies: { predecessors: [], hasUnfinished: false, hiddenCount: 0 }, capabilities: { ...detail.capabilities, transition: true, manageDependencies: true } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.includes("/task-1/dependency-candidates")) return response({ items: [{ id: "task-a", title: "Prepare source drawings", status: "IN_PROGRESS" }] });
      if (url.endsWith("/task-1/dependencies") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ predecessorTaskId: "task-a", expectedVersion: 1, reason: "Drawings must be ready" });
        current = { ...current, task: { ...current.task, version: 2 }, dependencies: { predecessors: [{ id: "task-a", title: "Prepare source drawings", status: "IN_PROGRESS" }], hasUnfinished: true, hiddenCount: 0 } };
        return response({});
      }
      if (url.endsWith("/task-1/state") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start with known unfinished source", acknowledgeUnfinishedDependencies: true });
        current = { ...current, task: { ...current.task, status: "IN_PROGRESS", version: 3 }, capabilities: { ...current.capabilities, transition: true } };
        return response({});
      }
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-dependency" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    fireEvent.change(screen.getByLabelText("Search predecessor tasks"), { target: { value: "drawings" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("dependency-candidates?q=drawings"), expect.anything()));
    fireEvent.change(await screen.findByLabelText("Link an accessible predecessor"), { target: { value: "task-a" } });
    fireEvent.change(screen.getByLabelText("Reason for dependency change"), { target: { value: "Drawings must be ready" } });
    fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
    await screen.findByText("Dependency added.");
    expect(screen.getByText(/At least one predecessor is unfinished/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason for change"), { target: { value: "Start with known unfinished source" } });
    fireEvent.click(screen.getByRole("button", { name: "Review early start" }));
    expect(screen.queryByRole("button", { name: "Start task" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    await screen.findByText("Task marked in progress.");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/task-1/state"))).toHaveLength(1);
  });

  it("flags exit-waiting tasks and withholds transitions until reassignment", async () => {
    const waiting = { ...task, status: "WAITING", requiresReassignment: true };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [waiting] });
      if (url.endsWith("/task-1")) return response({ ...detail, task: waiting, capabilities: { ...detail.capabilities, transition: true, reassign: false } });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    expect(screen.getAllByText(/Needs reassignment after employee exit/)).toHaveLength(2);
    expect(screen.getByText(/A manager must reassign this task before it can resume/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume task" })).not.toBeInTheDocument();
  });

  it("waits with required cause and optional known party, then shows persisted history", async () => {
    let current: Detail = { ...detail, task: { ...task, status: "IN_PROGRESS", version: 2 }, capabilities: { ...detail.capabilities, wait: true, resume: false } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.endsWith("/task-1/wait") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ expectedVersion: 2, reason: "Waiting for supplier access", delayCause: "Supplier credentials pending", responsibleParty: "Primary client" });
        expect(init.headers).toMatchObject({ "X-CSRF-Token": "csrf-wait" });
        current = { ...current, task: { ...current.task, status: "WAITING", version: 3, waitingReason: "Waiting for supplier access", waitingDelayCause: "Supplier credentials pending", waitingResponsibleParty: "Primary client" }, history: { statusChanges: [{ reason: "Waiting for supplier access", toStatus: "WAITING", delayCause: "Supplier credentials pending", responsibleParty: "Primary client" }], ownerChanges: [] }, capabilities: { ...current.capabilities, wait: false, resume: true } };
        return response(current);
      }
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-wait" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    expect(screen.getByRole("form", { name: "Wait on task" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason for waiting"), { target: { value: "Waiting for supplier access" } });
    fireEvent.change(screen.getByLabelText("Delay cause"), { target: { value: "Supplier credentials pending" } });
    fireEvent.change(screen.getByLabelText("Known responsible party (optional)"), { target: { value: "Primary client" } });
    fireEvent.click(screen.getByRole("button", { name: "Move to waiting" }));
    expect(await screen.findByText("Supplier credentials pending", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for supplier access", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText(/Responsible party: Primary client/)).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Resume task" })).toBeInTheDocument();
  });

  it("resumes ordinary waiting with a reason and expected version", async () => {
    let current: Detail = { ...detail, task: { ...task, status: "WAITING", version: 5, waitingDelayCause: "Supplier response" }, history: { statusChanges: [], ownerChanges: [] }, capabilities: { ...detail.capabilities, transition: false, wait: false, resume: true } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.endsWith("/task-1/resume") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 5, reason: "Supplier has restored access" });
        current = { ...current, task: { ...current.task, status: "IN_PROGRESS", version: 6, waitingDelayCause: null }, capabilities: { ...current.capabilities, transition: true, wait: true, resume: false } };
        return response(current);
      }
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    fireEvent.change(screen.getByLabelText("Reason for resuming"), { target: { value: "Supplier has restored access" } });
    fireEvent.click(screen.getByRole("button", { name: "Resume task" }));
    await waitFor(() => expect(screen.getByText("In progress", { selector: ".task-state" })).toBeInTheDocument());
    expect(screen.getByText("Task resumed.")).toBeInTheDocument();
  });

  it("lets the current primary owner request a later commitment from a filtered approver and reloads the pending request", async () => {
    let current: Detail = { ...detail, task: { ...task, status: "IN_PROGRESS", version: 4, committedDueDate: "2026-10-20T00:00:00.000Z" }, capabilities: { ...detail.capabilities, requestExtension: true } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.endsWith("/extension-approvers")) return response({ items: [{ accountId: "manager-1", name: "scoped-manager@example.test", kind: "STAFF" }, { accountId: "owner-1", name: "owner@example.test", kind: "OWNER" }] });
      if (url.endsWith("/extension-requests") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 4, proposedDate: "2026-10-27", approverAccountId: "manager-1", reason: "Supplier delivery moved by one week" });
        expect(init.headers).toMatchObject({ "X-CSRF-Token": "csrf-extension" });
        current = { ...current, task: { ...current.task, version: 5 }, capabilities: { ...current.capabilities, requestExtension: false }, extensions: [{ id: "approval-1", previousDate: "2026-10-20", proposedDate: "2026-10-27", reason: "Supplier delivery moved by one week", state: "PENDING", requesterId: "employee-1", approverId: "manager-1", requestedAt: "2026-09-29T10:00:00.000Z", canDecide: false }] };
        return response({ approvalId: "approval-1", state: "PENDING" }, 201);
      }
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-extension" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    await screen.findByRole("option", { name: "scoped-manager@example.test · Scoped manager" });
    expect(screen.getByRole("option", { name: "owner@example.test · Owner" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Proposed new date"), { target: { value: "2026-10-27" } });
    fireEvent.change(screen.getByLabelText("Approver"), { target: { value: "manager-1" } });
    fireEvent.change(screen.getByLabelText("Reason", { selector: "input" }), { target: { value: "Supplier delivery moved by one week" } });
    fireEvent.click(screen.getByRole("button", { name: "Request extension" }));
    expect(await screen.findByText("Deadline extension requested.")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Supplier delivery moved by one week").parentElement?.parentElement).toHaveTextContent("2026-10-20 → 2026-10-27");
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/task-1") && !init?.method)).toBe(true);
  });

  it("blocks extension submission when approvers are denied and allows an explicit retry", async () => {
    let approverReads = 0;
    const committed = { ...task, status: "IN_PROGRESS", version: 2, committedDueDate: "2026-10-20T00:00:00.000Z" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [committed] });
      if (url.endsWith("/extension-approvers")) { approverReads++; return approverReads === 1 ? response({}, 403) : response({ items: [{ accountId: "owner-1", name: "owner@example.test", kind: "OWNER" }] }); }
      if (url.endsWith("/task-1")) return response({ ...detail, task: committed, capabilities: { ...detail.capabilities, requestExtension: true } });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} />);
    await screen.findByRole("alert");
    expect(screen.getByText("Eligible approvers could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request extension" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("option", { name: "owner@example.test · Owner" })).toBeInTheDocument();
    await waitFor(() => expect(approverReads).toBe(2));
  });

  it("approves an extension with a reason and refreshes committed date plus decision history", async () => {
    const pending = { id: "approval-2", previousDate: "2026-10-20", proposedDate: "2026-10-27", reason: "Supplier delivery moved by one week", state: "PENDING", requesterId: "employee-1", approverId: "manager-1", requestedAt: "2026-09-29T10:00:00.000Z", canDecide: true };
    let current: Detail = { ...detail, task: { ...task, status: "IN_PROGRESS", version: 7, committedDueDate: "2026-10-20T00:00:00.000Z" }, history: { statusChanges: [], ownerChanges: [] }, extensions: [pending], capabilities: { ...detail.capabilities, requestExtension: false } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.endsWith("/extension-requests/approval-2/decision") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ outcome: "APPROVED", reason: "Owner confirmed revised delivery date" });
        expect(init.headers).toMatchObject({ "X-CSRF-Token": "csrf-decision" });
        current = { ...current, task: { ...current.task, version: 8, committedDueDate: "2026-10-27T00:00:00.000Z" }, history: { ...current.history, committedDateChanges: [{ id: "date-8", oldDate: "2026-10-20T00:00:00.000Z", newDate: "2026-10-27T00:00:00.000Z", actorId: "manager-1", reason: "Owner confirmed revised delivery date", taskVersion: 8, occurredAt: "2026-09-29T11:00:00.000Z" }] }, extensions: [{ ...pending, state: "APPROVED", canDecide: false, decision: { outcome: "APPROVED", reason: "Owner confirmed revised delivery date", decidedAt: "2026-09-29T11:00:00.000Z" } }] };
        return response({ approvalId: "approval-2", outcome: "APPROVED" }, 201);
      }
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-decision" owner={true} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    const reason = screen.getByLabelText("Decision reason");
    const approve = screen.getByRole("button", { name: "Approve extension" });
    expect(approve).toBeDisabled();
    fireEvent.change(reason, { target: { value: "Owner confirmed revised delivery date" } });
    fireEvent.click(approve);
    expect(await screen.findByText("Deadline extension approved.")).toBeInTheDocument();
    expect(screen.getByText("Approved: Owner confirmed revised delivery date")).toBeInTheDocument();
    expect(screen.getByText("2026-10-27", { selector: ".task-facts dd" })).toBeInTheDocument();
    expect(screen.getByText(/Committed due date changed from 2026-10-20 to 2026-10-27: Owner confirmed revised delivery date/)).toBeInTheDocument();
  });

  it("rejects an extension without changing the committed date", async () => {
    const pending = { id: "approval-3", previousDate: "2026-10-20", proposedDate: "2026-10-27", reason: "Supplier delivery moved by one week", state: "PENDING", requesterId: "employee-1", approverId: "owner-1", requestedAt: "2026-09-29T10:00:00.000Z", canDecide: true };
    let current: Detail = { ...detail, task: { ...task, status: "IN_PROGRESS", version: 9, committedDueDate: "2026-10-20T00:00:00.000Z" }, extensions: [pending], capabilities: { ...detail.capabilities, requestExtension: false } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.endsWith("/extension-requests/approval-3/decision") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ outcome: "REJECTED", reason: "The revised date is not feasible" });
        current = { ...current, task: { ...current.task, version: 10 }, extensions: [{ ...pending, state: "REJECTED", canDecide: false, decision: { outcome: "REJECTED", reason: "The revised date is not feasible", decidedAt: "2026-09-29T11:00:00.000Z" } }] };
        return response({ approvalId: "approval-3", outcome: "REJECTED" }, 201);
      }
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={true} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "The revised date is not feasible" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject extension" }));
    expect(await screen.findByText("Deadline extension rejected.")).toBeInTheDocument();
    expect(screen.getByText("Rejected: The revised date is not feasible")).toBeInTheDocument();
    expect(screen.getByText("2026-10-20", { selector: ".task-facts dd" })).toBeInTheDocument();
    expect(screen.queryByText(/Committed due date changed from/)).not.toBeInTheDocument();
  });

  it("allows an Owner to withdraw a pending extension with an auditable reason", async () => {
    const pending = { id: "approval-withdraw", previousDate: "2026-10-20", proposedDate: "2026-10-27", reason: "Supplier delivery moved", state: "PENDING", requesterId: "employee-1", approverId: "owner-1", requestedAt: "2026-09-29T10:00:00.000Z", canDecide: true, canWithdraw: true };
    let current: Detail = { ...detail, task: { ...task, status: "IN_PROGRESS", version: 6, committedDueDate: "2026-10-20T00:00:00.000Z" }, extensions: [pending], capabilities: { ...detail.capabilities, requestExtension: false } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.endsWith("/task-1/extension-requests/approval-withdraw/withdraw") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ reason: "Owner is consolidating duplicate approvals" });
        current = { ...current, extensions: [{ ...pending, state: "WITHDRAWN", canWithdraw: false, decision: { outcome: "WITHDRAWN", reason: "Owner is consolidating duplicate approvals", decidedAt: "2026-09-29T11:00:00.000Z" } }] };
        return response({ approvalId: pending.id, state: "WITHDRAWN" });
      }
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-withdraw" owner={true} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    expect(screen.getByLabelText("Decision reason")).toBeInTheDocument();
    expect(screen.queryByLabelText("Reason for withdrawing request")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve extension" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Owner is consolidating duplicate approvals" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw extension request" }));
    expect(await screen.findByText("Deadline extension request withdrawn.")).toBeInTheDocument();
    expect(screen.getByText("Withdrawn: Owner is consolidating duplicate approvals")).toBeInTheDocument();
  });

  it("configures, pauses and resumes a recurring task with versioned reasons and immutable history", async () => {
    const recurringTask = { ...task, type: "RECURRING", version: 4 };
    const current: Detail = { ...detail, task: recurringTask, capabilities: { ...detail.capabilities } };
    let schedule = { rule: null as null | { id: string; sourceTaskId: string; frequency: "DAILY" | "WEEKLY" | "MONTHLY"; anchorDate: string; effectiveFromDate: string; paused: boolean; version: number; configuredById: string; createdAt: string; updatedAt: string }, history: [] as Array<{ id: string; ruleVersion: number; action: "configured" | "paused" | "resumed"; actorId: string; reason: string; before: unknown; after: unknown; occurredAt: string }>, capabilities: { configure: true, pause: false, resume: false }, timezone: "Asia/Kolkata" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [current.task] });
      if (url.endsWith("/task-1/recurrence") && init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedTaskVersion: 4, expectedVersion: 0, frequency: "MONTHLY", firstOccurrenceDate: "2026-10-31", reason: "Monthly client review cycle" });
        expect(init.headers).toMatchObject({ "X-CSRF-Token": "csrf-recurrence" });
        const after = { frequency: "MONTHLY", anchorDate: "2026-10-31T00:00:00.000Z", effectiveFromDate: "2026-10-31T00:00:00.000Z", paused: false };
        schedule = { ...schedule, rule: { id: "rule-1", sourceTaskId: "task-1", frequency: "MONTHLY", anchorDate: after.anchorDate, effectiveFromDate: after.effectiveFromDate, paused: false, version: 1, configuredById: "employee-1", createdAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:00.000Z" }, capabilities: { configure: true, pause: true, resume: false }, history: [{ id: "rec-history-1", ruleVersion: 1, action: "configured", actorId: "employee-1", reason: "Monthly client review cycle", before: null, after, occurredAt: "2026-09-29T10:00:00.000Z" }] };
        return response(schedule);
      }
      if (url.endsWith("/task-1/recurrence/pause") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedTaskVersion: 4, expectedVersion: 1, reason: "Waiting for the next planning window" });
        const before = { paused: false }; const after = { paused: true };
        schedule = { ...schedule, rule: { ...schedule.rule!, paused: true, version: 2 }, capabilities: { configure: true, pause: false, resume: true }, history: [...schedule.history, { id: "rec-history-2", ruleVersion: 2, action: "paused", actorId: "employee-1", reason: "Waiting for the next planning window", before, after, occurredAt: "2026-09-29T11:00:00.000Z" }] };
        return response(schedule);
      }
      if (url.endsWith("/task-1/recurrence/resume") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedTaskVersion: 4, expectedVersion: 2, reason: "Planning window is open" });
        const before = { paused: true }; const after = { paused: false };
        schedule = { ...schedule, rule: { ...schedule.rule!, paused: false, version: 3, effectiveFromDate: "2026-10-31T00:00:00.000Z" }, capabilities: { configure: true, pause: true, resume: false }, history: [...schedule.history, { id: "rec-history-3", ruleVersion: 3, action: "resumed", actorId: "employee-1", reason: "Planning window is open", before, after, occurredAt: "2026-09-29T12:00:00.000Z" }] };
        return response(schedule);
      }
      if (url.endsWith("/task-1/recurrence")) return response(schedule);
      if (url.endsWith("/task-1")) return response(current);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf-recurrence" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    expect(await screen.findByText("Organization timezone:")).toHaveTextContent("Asia/Kolkata");
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "MONTHLY" } });
    fireEvent.change(screen.getByLabelText("First occurrence date"), { target: { value: "2026-10-31" } });
    fireEvent.change(screen.getByLabelText("Reason", { selector: "input" }), { target: { value: "Monthly client review cycle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save recurrence rule" }));
    expect(await screen.findByText("Recurrence rule saved.")).toBeInTheDocument();
    expect(screen.getByText("Monthly", { selector: ".task-recurrence-facts dd" })).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.getByText("Schedule history").parentElement).toHaveTextContent("Monthly client review cycle");
    fireEvent.change(screen.getByLabelText("Reason for pausing"), { target: { value: "Waiting for the next planning window" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause recurrence" }));
    expect(await screen.findByText("Recurrence paused.")).toBeInTheDocument();
    expect(screen.getByText("Paused", { selector: ".task-recurrence-facts dd" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason for resuming"), { target: { value: "Planning window is open" } });
    fireEvent.click(screen.getByRole("button", { name: "Resume recurrence" }));
    expect(await screen.findByText("Recurrence resumed.")).toBeInTheDocument();
    expect(screen.getByText("Active", { selector: ".task-recurrence-facts dd" })).toBeInTheDocument();
    expect(screen.getByText("Paused", { selector: ".task-recurrence-history strong" })).toBeInTheDocument();
    expect(screen.getByText("Schedule history").parentElement).toHaveTextContent("Waiting for the next planning window");
    expect(screen.getByText("Resumed")).toBeInTheDocument();
    expect(screen.getByText("Schedule history").parentElement).toHaveTextContent("Planning window is open");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/task-1/recurrence"))).toBe(true);
  });

  it("loads recurrence details only for recurring tasks and hides mutations without capabilities", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (String(input).includes("/creation-options")) return response(creationOptionsForSetup(setup, String(input)));
      if (url.endsWith("/setup")) return response(setup);
      if (url.includes("?scope=")) return response({ total: 1, items: [task] });
      if (url.endsWith("/task-1")) return response(detail);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskWorkspace csrfToken="csrf" owner={false} />);
    await screen.findByRole("heading", { name: "Prepare concept" });
    expect(screen.queryByRole("region", { name: "Recurrence schedule" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/recurrence"))).toBe(false);
  });
});
