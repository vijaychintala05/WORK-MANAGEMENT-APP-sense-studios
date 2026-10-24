import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProjectRelationships } from "./project-relationships";
import { ProjectWorkspace } from "./project";
import { RouteAccessibility } from "./route-accessibility";
import { SessionGroups } from "./session-groups";
import { TaskComposerFields, type TaskComposerDraft } from "./task-composer-fields";
import { workDate, workState } from "./work-labels";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const draft: TaskComposerDraft = { title: "", type: "PROJECT", projectId: "", priority: "MEDIUM", targetDate: "", description: "", ownerId: "", startDate: "", estimatedHours: "", collaboratorIds: ["helper"], collaboratorHours: { helper: "-1" }, planItemId: "", tagsText: "", checklistText: "", reason: "", assignTo: true, reviewRequirement: "NONE" };

describe("reviewed usability improvements", () => {
  it("links errors to required controls and reveals optional errors without losing the draft", () => {
    render(<TaskComposerFields draft={draft} onChange={vi.fn()} projects={[]} planItems={[]} options={{ actorEmployeeId: null, project: null, canAssign: true, canCreate: true, owners: [], collaborators: [{ id: "helper", name: "Helper", homeBranchId: "branch" }], readAt: "" }} optionsError={undefined} retryOptions={vi.fn()} compact={false} busy={false} validationAttempt={1} />);
    const summary = screen.getByRole("alert");
    expect(summary).toHaveFocus();
    expect(screen.getByLabelText("Project")).toBeRequired();
    expect(screen.getByLabelText("Task name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Task name")).toHaveAccessibleDescription("Task name must be between 2 and 160 characters.");
    fireEvent.click(within(summary).getByRole("link", { name: /Collaborator estimated hours/ }));
    const group = screen.getByRole("group", { name: "Collaborators (optional)" });
    expect(group.closest("details")).toHaveAttribute("open");
    expect(group).toHaveFocus();
    expect(screen.getByLabelText("Helper estimated hours")).toHaveValue(-1);
    fireEvent.click(within(summary).getByRole("link", { name: /Task name must/ }));
    expect(screen.getByLabelText("Task name")).toHaveFocus();
  });

  it("keeps current devices ahead of retained historical sessions", () => {
    const sessions = [
      { id: "expired", expiresAt: "2000-01-01", revokedAt: null },
      { id: "current", expiresAt: "2099-01-01", revokedAt: null },
      { id: "revoked", expiresAt: "2099-01-01", revokedAt: "2026-01-01" }
    ];
    render(<SessionGroups sessions={sessions}>{session => <li key={session.id}>{session.id}</li>}</SessionGroups>);
    expect(screen.getByText("current").closest("details")).toBeNull();
    expect(screen.getByText("expired").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("revoked").closest("details")).toBe(screen.getByText("expired").closest("details"));
  });

  it("focuses the editable type for an incompatible fixed-project draft", () => {
    render(<TaskComposerFields draft={{ ...draft, title: "Prepare layout", type: "NON_PROJECT", projectId: "project" }} fixedProject={{ id: "project", title: "Studio" }} onChange={vi.fn()} projects={[]} planItems={[]} options={undefined} optionsError={undefined} retryOptions={vi.fn()} compact={false} busy={false} validationAttempt={1} />);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("link", { name: /Non project tasks cannot use a project/ }));
    expect(screen.getByLabelText("Type")).toHaveFocus();
    expect(screen.getByLabelText("Type")).toHaveAccessibleDescription("Non project tasks cannot use a project. Choose a project task type for this context.");
    expect(screen.getByLabelText("Task project")).toHaveValue("Studio");
  });

  it("focuses page context and offers a keyboard bypass without stealing dialog focus", async () => {
    const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    render(<MemoryRouter><RouteAccessibility /><main><h1>Projects</h1></main></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("heading")).toHaveFocus());
    fireEvent.click(screen.getByRole("link", { name: "Skip to main content" }));
    expect(screen.getByRole("main")).toHaveFocus(); expect(scroll).toHaveBeenCalled();
    cleanup();
    render(<MemoryRouter><RouteAccessibility /><dialog open><input aria-label="Draft" autoFocus /></dialog><main><h1>Tasks</h1></main></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText("Draft")).toHaveFocus());
  });

  it("shows readable date-only values without shifting the operational date", () => {
    expect(workDate("2026-10-22T00:00:00.000Z")).toBe(workDate("2026-10-22"));
    expect(workDate("2026-02-30")).toBe("Date unavailable");
    expect(workState("WAITING_CLIENT_REVIEW")).toBe("Waiting client review");
  });

  it("uses authorized names for relationships and clears selection when the branch changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.includes("/clients?") ? { items: [{ id: "client", name: "Studio client" }] } : { items: [{ id: "won", title: "Accepted brief" }], total: 1 })));
    const onClient = vi.fn(), onLead = vi.fn();
    const props = { clientId: "", wonLeadId: "", onClient, onLead, disabled: false };
    const view = render(<ProjectRelationships {...props} branchId="a" />);
    await screen.findByRole("option", { name: "Studio client" });
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "client" } });
    fireEvent.change(screen.getByLabelText("Won lead"), { target: { value: "won" } });
    expect(onClient).toHaveBeenCalledWith("client"); expect(onLead).toHaveBeenCalledWith("won");
    view.rerender(<ProjectRelationships {...props} branchId="b" />);
    await waitFor(() => expect(onClient).toHaveBeenLastCalledWith(""));
    expect(onLead).toHaveBeenLastCalledWith("");
  });

  it("rejects malformed choices and keeps a denied lookup separate from a readable one", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/clients?") ? response({}, 403) : response({ items: [7], total: 1 })));
    render(<ProjectRelationships branchId="a" clientId="" wonLeadId="" onClient={vi.fn()} onLead={vi.fn()} disabled={false} />);
    await screen.findByText("This account cannot read these CRM choices.");
    expect(screen.getByLabelText("Client")).toBeDisabled();
    expect(screen.getByLabelText("Won lead")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry client and lead choices" })).toBeEnabled();
  });

  it("preserves explicitly granted staff template management below the project directory", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/v1/project-templates") return response({ templates: [], canManage: true, defaults: { DESIGN: [], TURNKEY: [] } });
      if (url === "/api/v1/projects/setup") return response({ branches: [], owner: false });
      return response({ items: [], total: 0 });
    }));
    render(<ProjectWorkspace csrfToken="csrf" owner={false} />);
    const summary = await screen.findByText("Project template reference", { selector: "summary" });
    fireEvent.click(summary);
    expect(await screen.findByRole("button", { name: "Create template" })).toBeEnabled();
    expect(screen.queryByRole("form", { name: "Create project" })).not.toBeInTheDocument();
  });
});
