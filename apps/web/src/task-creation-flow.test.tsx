import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { TaskWorkspace, type Detail, type Task } from "./task.js";
const task: Task = { id: "created-task", title: "Coordinate delivery", type: "NON_PROJECT", priority: "MEDIUM", targetDate: "2026-10-17", tags: [], checklist: [], primaryOwnerEmployeeId: "other", status: "NOT_STARTED", version: 1, reviewRequirement: "NONE", createdAt: "2026-10-15" };
const detail: Detail = { task, collaborators: [], history: { statusChanges: [], ownerChanges: [] }, capabilities: { edit: false, transition: false, reassign: false } };
const person = { id: "other", name: "teammate@example.test", homeBranchId: "branch" };
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.restoreAllMocks(); window.history.replaceState(null, "", "/my-work");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });
function installApi(mode: "success" | "uncertain" | "capacity") {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v1/tasks/setup") return response({ actorEmployeeId: null, projects: [], employees: [person], planItems: [], canAssign: true });
    if (url.pathname === "/api/v1/tasks/creation-options") return response({ actorEmployeeId: null, project: null, canAssign: true, canCreate: true, owners: [person], collaborators: [person], readAt: "2026-10-15T00:00:00Z" });
    if (url.pathname === "/api/v1/tasks" && init?.method === "POST") {
      if (mode === "uncertain") throw new TypeError("Network response lost");
      if (mode === "capacity") return response({ message: "Overload warning: review employee capacity" }, 409);
      return response(task);
    }
    if (url.pathname === "/api/v1/tasks") return response({ items: [], total: 0 });
    if (url.pathname === "/api/v1/tasks/created-task") return response(detail);
    if (url.pathname.includes("/dashboard/sources/")) return response({ today: "2026-10-15", sections: [] });
    return response({}, 404);
  });
  vi.stubGlobal("fetch", mock); return mock;
}
async function fillTask() {
  const trigger = await screen.findByRole("button", { name: "Create task" }); await waitFor(() => expect(trigger).toBeEnabled()); fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog"); const form = within(dialog).getByRole("form", { name: "Create task" });
  fireEvent.change(await within(form).findByLabelText("Primary owner"), { target: { value: "other" } });
  fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: task.title } });
  fireEvent.change(within(form).getByLabelText("Target date"), { target: { value: "2026-10-17" } });
  fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Coordinate the agreed delivery work" } });
  return { dialog, form };
}
describe("confirmed task creation and recoverable drafts", () => {
  it("focuses invalid fields without leaving a dirty form and still guards navigation away", async () => {
    const mock = installApi("success"), confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<><a href="/projects">Leave for projects</a><TaskWorkspace csrfToken="csrf" owner listFirst personalOnly /></>);
    const { form } = await fillTask();
    fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: "" } });
    fireEvent.submit(form);
    const summary = within(form).getByRole("alert");
    fireEvent.click(within(summary).getByRole("link", { name: "Task name must be between 2 and 160 characters." }));
    expect(within(form).getByLabelText("Task name")).toHaveFocus();
    expect(within(form).getByLabelText("Reason")).toHaveValue("Coordinate the agreed delivery work");
    expect(confirm).not.toHaveBeenCalled();
    expect(form).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Leave for projects" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved new task details?");
    expect(form).toBeInTheDocument();
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("consumes the shell create intent only after authoritative creation access is available", async () => {
    installApi("success"); window.history.replaceState(null, "", "/tasks?create=1");
    render(<TaskWorkspace csrfToken="csrf" owner accountId="owner" listFirst />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("form", { name: "Create task" })).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.has("create")).toBe(false);
  });
  it("sends only one create when two submit events arrive before a pending response", async () => {
    const mock = installApi("success");
    const initial = mock.getMockImplementation()!;
    let resolveCreate: ((value: Response) => void) | undefined;
    mock.mockImplementation((input, init) => init?.method === "POST" ? new Promise<Response>(resolve => { resolveCreate = resolve; }) : initial(input, init));
    render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
    const { form } = await fillTask();
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => resolveCreate!(response(task)));
    expect(await screen.findByRole("heading", { name: task.title })).toBeInTheDocument();
  });
  it("opens the returned canonical task without inserting another employee's task into the personal queue", async () => {
    const mock = installApi("success"); render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
    const { dialog } = await fillTask(); fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("heading", { name: task.title })).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("taskId")).toBe(task.id);
    expect(screen.queryByRole("button", { name: `Open task: ${task.title}` })).not.toBeInTheDocument();
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(mock.mock.calls.some(([url]) => String(url).includes("scope=personal"))).toBe(true);
  });
  it("preserves an uncertain create draft and makes no automatic retry", async () => {
    const mock = installApi("uncertain"); render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
    const { dialog, form } = await fillTask(); fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(await within(dialog).findByText(/could not confirm whether the task was created/)).toBeInTheDocument();
    expect(within(form).getByLabelText("Task name")).toHaveValue(task.title);
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.queryByText("Task created.")).not.toBeInTheDocument();
  });
  it("invalidates a capacity acknowledgement when the draft changes", async () => {
    installApi("capacity"); render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
    const { dialog, form } = await fillTask(); fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(await within(dialog).findByRole("button", { name: "Acknowledge and create task" })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Task name"), { target: { value: "Changed scope" } });
    expect(within(dialog).queryByRole("button", { name: "Acknowledge and create task" })).not.toBeInTheDocument();
  });
  it("recovers an uncertain response only on explicit action with the exact submitted command and key", async () => {
    const mock = installApi("uncertain"); render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
    const { dialog, form } = await fillTask(); fireEvent.submit(form);
    const recover = await within(dialog).findByRole("button", { name: "Check creation result" });
    expect(within(form).getByLabelText("Task name")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeDisabled();
    const first = mock.mock.calls.find(([,init]) => init?.method === "POST")![1]!.body;
    expect(JSON.parse(String(first)).idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    const initial = mock.getMockImplementation()!;
    mock.mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(response(task)) : initial(input,init));
    fireEvent.click(recover);
    expect(await screen.findByRole("heading", { name: task.title })).toBeInTheDocument();
    const writes = mock.mock.calls.filter(([,init]) => init?.method === "POST");
    expect(writes).toHaveLength(2); expect(writes[1]![1]!.body).toBe(first);
    expect(new URL(window.location.href).searchParams.get("taskId")).toBe(task.id);
  });
  it("retains the acknowledged command and key when its response is lost", async () => {
    const mock = installApi("capacity"); render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
    const { dialog, form } = await fillTask(); fireEvent.submit(form);
    const ack = await within(dialog).findByRole("button", { name: "Acknowledge and create task" });
    const initial = mock.getMockImplementation()!;
    mock.mockImplementation((input,init) => init?.method === "POST" ? Promise.reject(new TypeError("Lost acknowledged result")) : initial(input,init));
    fireEvent.click(ack);
    const recover = await within(dialog).findByRole("button", { name: "Check creation result" });
    const writes = () => mock.mock.calls.filter(([,init]) => init?.method === "POST").map(([,init]) => JSON.parse(String(init!.body)));
    expect(writes()[1]).toEqual({ ...writes()[0], acknowledgeOverload: true });
    mock.mockImplementation((input,init) => init?.method === "POST" ? Promise.resolve(response(task)) : initial(input,init));
    fireEvent.click(recover);
    await screen.findByRole("heading", { name: task.title });
    expect(writes()).toHaveLength(3); expect(writes()[2]).toEqual(writes()[1]);
  });
  it("does not erase the command for a malformed success result", async () => {
    const mock = installApi("success"), initial = mock.getMockImplementation()!;
    mock.mockImplementation((input,init) => init?.method === "POST" ? Promise.resolve(response({})) : initial(input,init));
    render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
    const { dialog, form } = await fillTask(); fireEvent.submit(form);
    await within(dialog).findByRole("button", { name: "Check creation result" });
    expect(within(form).getByLabelText("Task name")).toHaveValue(task.title);
    expect(screen.queryByText("Task created.")).not.toBeInTheDocument();
    expect(mock.mock.calls.filter(([,init]) => init?.method === "POST")).toHaveLength(1);
  });
});
