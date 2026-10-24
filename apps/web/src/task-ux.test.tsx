// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TaskWorkspace } from "./task.js";

const self = "11111111-1111-4111-8111-111111111111";
const employee = { id: self, name: "me@example.test", homeBranchId: "branch" };
const collaborator = { id: "22222222-2222-4222-8222-222222222222", name: "helper@example.test", homeBranchId: "branch" };
const projects = [{ id: "project-1", title: "Studio", status: "ACTIVE", branchId: "branch" }];
const planItems = [{ id: "plan-1", projectId: "project-1", kind: "STAGE" as const, label: "Concept" }];

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function creationOptions(setup: { actorEmployeeId: string | null; canAssign: boolean }) {
  const owners = setup.canAssign ? [employee, collaborator] : setup.actorEmployeeId ? [employee] : [];
  return { actorEmployeeId: setup.actorEmployeeId, project: null, canAssign: setup.canAssign, canCreate: owners.length > 0, owners, collaborators: setup.canAssign ? [employee, collaborator] : [], readAt: "2026-10-15T00:00:00Z" };
}

function installApi(options: { actorEmployeeId?: string | null; canAssign?: boolean; total?: number; items?: unknown[] }) {
  const setup = { actorEmployeeId: options.actorEmployeeId !== undefined ? options.actorEmployeeId : self, canAssign: options.canAssign ?? false, employees: [employee, collaborator], projects, planItems };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/setup")) return response(setup);
    if (String(input).includes("/creation-options")) return response(creationOptions(setup));
    if (url.pathname === "/api/v1/dashboard/sources/tasks") return response({ source: "tasks", today: "2026-10-15", sections: [] });
    if (url.pathname === "/api/v1/tasks") return response({ total: options.total ?? 0, items: options.items ?? [] });
    if (url.pathname.includes("/reviews/inbox")) return response({ total: 0, items: [] });
    return response({});
  }));
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("shared empty states and create form grouping", () => {
  it("renders a structured empty state with clear-filters action for a filtered-empty list", async () => {
    installApi({ actorEmployeeId: self, total: 0 });
    render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    await screen.findByText("No organization tasks match these filters.");
    const emptyState = screen.getByText("No organization tasks match these filters.").closest(".task-empty-state")!;
    expect(emptyState).toHaveAttribute("role", "status");
    expect(emptyState.querySelector(".task-empty-state__icon")).not.toBeNull();
    expect(emptyState.querySelector(".task-empty-state__title")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("renders a structured empty state without clear-filters for an employee-less Owner", async () => {
    installApi({ actorEmployeeId: null, total: 1 });
    render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
    await screen.findByText("This Owner account is not linked to an employee. Open organization work to manage tasks.");
    const emptyState = screen.getByText("This Owner account is not linked to an employee. Open organization work to manage tasks.").closest(".task-empty-state")!;
    expect(emptyState).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("renders clear-filters action in the cards view empty state", async () => {
    installApi({ actorEmployeeId: self, total: 0 });
    render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    fireEvent.click(await screen.findByRole("button", { name: "Cards" }));
    await screen.findByText("No tasks match this scope and filters.");
    const emptyState = screen.getByText("No tasks match this scope and filters.").closest(".task-empty-state")!;
    expect(emptyState).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("renders clear-filters action in the timeline view empty state", async () => {
    installApi({ actorEmployeeId: self, total: 0 });
    render(<TaskWorkspace csrfToken="csrf" owner listFirst />);
    fireEvent.click(await screen.findByRole("button", { name: "Timeline" }));
    await screen.findByText("No tasks on this page.");
    const emptyState = screen.getByText("No tasks on this page.").closest(".task-empty-state")!;
    expect(emptyState).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("groups primary fields outside and optional planning fields inside a details element", async () => {
    installApi({ actorEmployeeId: self, canAssign: true, total: 0 });
    render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst />);
    fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
    const form = await screen.findByRole("form", { name: "Create task" });
    expect(within(form).getByLabelText("Task name")).toBeInTheDocument();
    expect(within(form).getByLabelText("Target date")).toBeInTheDocument();
    expect(within(form).getByLabelText("Reason")).toBeInTheDocument();
    // EMPLOYEE variant renders the compact composer: Optional planning and
    // Collaborator sections are omitted, but the always-visible primary fields remain.
    expect(within(form).queryByText("Optional planning", { selector: "summary" })).toBeNull();
    expect(within(form).queryAllByText(/Collaborators \(optional\)/)).toHaveLength(0);
    expect(within(form).getByLabelText("Description (optional)")).toBeInTheDocument();
  });
});
