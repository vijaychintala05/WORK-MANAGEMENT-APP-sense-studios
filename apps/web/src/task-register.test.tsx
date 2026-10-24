// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TaskWorkspace, type Detail, type Task } from "./task.js";

const task: Task = { id: "task-1", title: "Prepare drawing package", type: "PROJECT", priority: "HIGH", targetDate: "2026-10-24T00:00:00Z", description: "Coordinate the approved brief", projectId: "project-1", tags: [], checklist: [], primaryOwnerEmployeeId: "employee-1", status: "NOT_STARTED", version: 4, reviewRequirement: "INTERNAL", createdAt: "2026-10-23T00:00:00Z" };
const detail: Detail = { task, collaborators: [], history: { statusChanges: [], ownerChanges: [] }, capabilities: { edit: false, transition: true, reassign: true, changeCommittedDate: true, manageDependencies: true } };
function install(projection: Detail = detail) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    let body: unknown = {};
    if (url.pathname.endsWith("/setup")) body = { actorEmployeeId: "employee-1", canAssign: true, projects: [{ id: "project-1", title: "Studio", branchId: "branch-1", status: "ACTIVE" }], employees: [{ id: "employee-1", name: "Asha", homeBranchId: "branch-1" }], planItems: [] };
    else if (url.pathname === "/api/v1/tasks") body = { total: 1, items: [task] };
    else if (url.pathname === "/api/v1/tasks/task-1") body = projection;
    else if (url.pathname.endsWith("/state") && init?.method === "POST") body = { ...task, status: "IN_PROGRESS", version: 5 };
    else if (url.pathname.endsWith("/dependency-candidates")) body = { items: [] };
    else if (url.pathname.endsWith("/subtasks")) body = { items: [], parent: null, isSubtask: false, completionBlocked: false, canCreate: false, taskVersion: 4 };
    else if (url.pathname.includes("/people")) body = { primaryOwner: { employeeId: "employee-1", name: "Asha" }, collaborators: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeEach(() => { window.history.replaceState(null, "", "/tasks?scope=all"); vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("standalone task register clarity", () => {
  it("keeps the audit reason beside the top action and sends the unchanged guarded command", async () => {
    const fetcher = install(); window.history.replaceState(null, "", "/tasks?scope=all&taskId=task-1");
    render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    const next = await screen.findByRole("region", { name: "Next step" });
    const action = within(next).getByRole("button", { name: "Start task" });
    expect(action).toBeDisabled();
    expect(within(next).getByText(/Enter a reason of at least 3 characters/)).toBeVisible();
    fireEvent.change(within(next).getByLabelText("Reason for change"), { target: { value: "Ready to begin" } });
    expect(action).toBeEnabled(); fireEvent.click(action);
    await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/state") && init?.method === "POST")).toBe(true));
    const command = fetcher.mock.calls.find(([url, init]) => String(url).endsWith("/state") && init?.method === "POST")!;
    expect(JSON.parse(String(command[1]?.body))).toEqual({ toState: "IN_PROGRESS", expectedVersion: 4, reason: "Ready to begin" });
  });
  it("discloses management fields and keeps the main description before dependencies", async () => {
    install(); window.history.replaceState(null, "", "/tasks?scope=all&taskId=task-1"); render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    const next = await screen.findByRole("region", { name: "Next step" });
    const dependencies = screen.getByText("Dependencies", { selector: "summary" }).closest("details")!;
    expect(dependencies).not.toHaveAttribute("open");
    expect(next.compareDocumentPosition(dependencies) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Coordinate the approved brief").compareDocumentPosition(dependencies) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Reassign owner", { selector: "summary" }).closest("details")).not.toHaveAttribute("open");
  });
  it("makes phase shortcuts clear conflicting granular status filters through the existing query", async () => {
    const fetcher = install(); window.history.replaceState(null, "", "/tasks?scope=mine&status=IN_PROGRESS"); render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst />);
    const phases = await screen.findByRole("navigation", { name: "Task phase" });
    fireEvent.click(within(phases).getByRole("button", { name: "In review" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => { const url = new URL(String(input), "http://localhost"); return url.pathname === "/api/v1/tasks" && url.searchParams.get("phase") === "review" && !url.searchParams.has("status"); })).toBe(true));
    expect(screen.getByLabelText("Task scope")).toHaveTextContent("Assigned to me");
  });
  it("preserves pending search when an immediate phase view changes", async () => {
    install(); render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    const phases = await screen.findByRole("navigation", { name: "Task phase" });
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "Pending search" } });
    fireEvent.click(within(phases).getByRole("button", { name: "Active" }));
    expect(screen.getByLabelText("Search tasks")).toHaveValue("Pending search");
    expect(screen.getByText(/Filters changed/)).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("q")).toBeNull();
  });
  it("keeps correction instructions even when the correction child requires no review", async () => {
    install({ ...detail, task: { ...task, reviewRequirement: "NONE" }, linkedReviewTaskId: "review-parent" });
    window.history.replaceState(null, "", "/tasks?scope=all&taskId=task-1");
    render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    expect(await screen.findByRole("link", { name: "Open correction instructions in internal review" })).toHaveAttribute("href", "/reviews?taskId=review-parent");
  });
  it("does not suggest opening review before a new task has started", async () => {
    install(); window.history.replaceState(null, "", "/tasks?scope=all&taskId=task-1");
    render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    await screen.findByRole("region", { name: "Next step" });
    expect(screen.queryByRole("link", { name: "Open internal review" })).not.toBeInTheDocument();
  });
  it("keeps dirty task changes when navigation through a review link is cancelled", async () => {
    install({ ...detail, linkedReviewTaskId: "review-parent" });
    window.history.replaceState(null, "", "/tasks?scope=all&taskId=task-1");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    const next = await screen.findByRole("region", { name: "Next step" });
    fireEvent.change(within(next).getByLabelText("Reason for change"), { target: { value: "Unsaved reason" } });
    expect(fireEvent.click(screen.getByRole("link", { name: "Open correction instructions in internal review" }))).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Discard unsaved task changes?");
    expect(within(next).getByLabelText("Reason for change")).toHaveValue("Unsaved reason");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Task phase" })).getByRole("button", { name: "Active" }));
    expect(within(next).getByLabelText("Reason for change")).toHaveValue("Unsaved reason");
    confirm.mockRestore();
  });
  it("does not apply standalone navigation or disclosures to Project embedding", async () => {
    install(); render(<TaskWorkspace csrfToken="csrf" owner listFirst projectContext={{ id: "project-1", title: "Studio", status: "ACTIVE" }} />);
    await screen.findByRole("button", { name: "Open task: Prepare drawing package" });
    expect(screen.queryByRole("navigation", { name: "Task phase" })).not.toBeInTheDocument();
    expect(document.querySelector(".task-register")).toBeNull();
  });
});
