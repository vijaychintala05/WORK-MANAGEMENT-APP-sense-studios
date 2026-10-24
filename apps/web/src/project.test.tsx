import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectWorkspace } from "./project.js";

afterEach(() => vi.unstubAllGlobals());
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ProjectWorkspace", () => {
  it("loads summaries only for the selected section and retains canonical project context", async () => {
    const project = { id: "summary-project", title: "Summary studio", status: "ACTIVE", deliveryType: "DESIGN", version: 1, scopes: [], branch: { id: "branch-1", name: "Mumbai" } };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url === "/api/v1/project-templates") return response({ templates: [], canManage: false, defaults: { DESIGN: [], TURNKEY: [] } });
      if (url.endsWith("/plan")) return response({ plan: null, items: [], history: [], capabilities: {} });
      if (url === "/api/v1/projects/setup") return response({ owner: false, branches: [project.branch] });
      if (url.startsWith("/api/v1/projects?")) return response({ total: 1, items: [project] });
      if (url === `/api/v1/projects/${project.id}`) return response({ project, capabilities: {} });
      if (url === `/api/v1/documents/projects/${project.id}`) return response({ project: { id: project.id }, files: [{ id: "file-1", fileName: "Specification.pdf", viewOnly: false }] });
      if (url.endsWith("/confirmed-drawings")) return response({ items: [] });
      if (url.startsWith("/api/v1/reviews/inbox?")) return response({ total: 0, items: [] });
      return response({}, 404);
    }));
    render(<ProjectWorkspace csrfToken="csrf" owner={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /Summary studio/ }));
    await screen.findByRole("heading", { name: project.title });
    expect(calls.some(url => url.includes("/documents/") || url.includes("/reviews/"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    await screen.findByText("Specification.pdf");
    expect(screen.getByRole("link", { name: "Open documents" })).toHaveAttribute("href", `/documents?projectId=${project.id}`);
    expect(calls.filter(url => url.includes("/reviews/inbox"))).toHaveLength(0);
    expect(calls.filter(url => url.endsWith("/confirmed-drawings"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reviews" }));
    await screen.findByText("No waiting internal review rounds available to you in this project.");
    expect(screen.queryByText("Specification.pdf")).not.toBeInTheDocument();
    expect(new URL(calls.find(url => url.includes("/reviews/inbox"))!, "https://sense.invalid").searchParams.get("projectId")).toBe(project.id);
    fireEvent.click(screen.getByRole("button", { name: "Delivery" }));
    expect(screen.getByRole("link", { name: "Open delivery plan" })).toHaveAttribute("href", `/projects?projectId=${project.id}&projectSection=plan#project-plan`);
    expect(calls.some(url => url.includes("/turnkey/"))).toBe(false);
  });

  it("creates a Won-lead Draft project with multiple baseline scopes and CSRF", async () => {
    const branch = { id: "branch-1", name: "Mumbai" };
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push([url, init]);
      if (url === "/api/v1/project-templates") return response({ templates: [], canManage: false, defaults: { DESIGN: [], TURNKEY: [] } });
      if (url.endsWith("/plan")) return response({ plan: null, items: [], history: [], capabilities: { complete: false, override: false } });
      if (url === "/api/v1/projects/setup") return response({ branches: [branch] });
      if (url.startsWith("/api/v1/crm/clients?")) return response({ items: [] });
      if (url.startsWith("/api/v1/crm/leads?")) return response({ items: [{ id: "lead-won-1", title: "Accepted proposal" }], total: 1 });
      if (url.startsWith("/api/v1/projects?")) return response({ total: 0, items: [] });
      if (url === "/api/v1/projects" && init?.method === "POST") return response({ project: { id: "project-1" } }, 201);
      return response({}, 404);
    }));
    render(<ProjectWorkspace csrfToken="csrf-project" owner />);
    await screen.findByText("No projects match these filters.");
    fireEvent.change(screen.getByLabelText("Project branch"), { target: { value: branch.id } });
    fireEvent.change(screen.getByLabelText("Project title"), { target: { value: "Studio renovation" } });
    fireEvent.change(screen.getByLabelText("Delivery type"), { target: { value: "TURNKEY" } });
    fireEvent.change(screen.getByLabelText("Initial service scopes"), { target: { value: "Architecture\nInterior design" } });
    fireEvent.change(await screen.findByLabelText("Won lead"), { target: { value: "lead-won-1" } });
    fireEvent.change(screen.getByLabelText("Creation reason"), { target: { value: "Won proposal accepted" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Draft project" }));
    await waitFor(() => expect(calls.some(([url, init]) => url === "/api/v1/projects" && init?.method === "POST")).toBe(true));
    const init = calls.find(([url]) => url === "/api/v1/projects")?.[1];
    expect(init?.headers).toMatchObject({ "X-CSRF-Token": "csrf-project" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ branchId: branch.id, title: "Studio renovation", deliveryType: "TURNKEY", scopes: ["Architecture", "Interior design"], wonLeadId: "lead-won-1", reason: "Won proposal accepted" });
    expect(JSON.parse(String(init?.body)).idempotencyKey).toBeUndefined();
  });

  it("shows the Owner access denial from setup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 403)));
    render(<ProjectWorkspace csrfToken="csrf" owner />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You need Owner access to manage projects.");
  });

  it("lets staff read server-visible projects and request pending cancellation", async () => {
    const project = { id: "assigned-project", title: "Assigned work", status: "ACTIVE", deliveryType: "DESIGN", version: 4, scopes: [], branch: { id: "branch-1", name: "Mumbai" } };
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push([url, init]);
      if (url === "/api/v1/project-templates") return response({ templates: [], canManage: false, defaults: { DESIGN: [], TURNKEY: [] } });
      if (url.endsWith("/plan")) return response({ plan: null, items: [], history: [], capabilities: { complete: false, override: false } });
      if (url === "/api/v1/projects/setup") return response({ owner: false, branches: [{ id: "branch-1", name: "Mumbai" }], employees: [] });
      if (url.startsWith("/api/v1/projects?")) return response({ total: 1, items: [project] });
      if (url === "/api/v1/projects/" + project.id) return response({ project, capabilities: { requestCancellation: true }, cancellationRequests: [] });
      if (url === "/api/v1/projects/" + project.id + "/cancellation-requests") return response({ request: { status: "PENDING" } }, 201);
      return response({}, 404);
    }));
    render(<ProjectWorkspace csrfToken="csrf-project" owner={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /Assigned work/ }));
    fireEvent.change(await screen.findByLabelText("Project action reason"), { target: { value: "Delivery date is at risk" } });
    fireEvent.click(screen.getByRole("button", { name: "Request cancellation" }));
    expect(await screen.findByText("Cancellation request submitted and pending Owner review.")).toBeInTheDocument();
    const call = calls.find(([url]) => url.endsWith("/cancellation-requests"));
    expect(call?.[1]).toMatchObject({ method: "POST", headers: { "X-CSRF-Token": "csrf-project" } });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ reason: "Delivery date is at risk" });
  });

  it("reloads details after a stale-version conflict and sends the version and reason", async () => {
    const branch = { id: "branch-1", name: "Mumbai" };
    const project = { id: "project-1", title: "Studio", status: "DRAFT", deliveryType: "DESIGN", version: 3, scopes: [], branch };
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push([url, init]);
      if (url === "/api/v1/project-templates") return response({ templates: [], canManage: false, defaults: { DESIGN: [], TURNKEY: [] } });
      if (url.endsWith("/plan")) return response({ plan: null, items: [], history: [], capabilities: { complete: false, override: false } });
      if (url === "/api/v1/projects/setup") return response({ branches: [branch], ownerAccountId: "owner-acct", employees: [{ id: "emp-1", accountId: "acct-1", name: "Asha", homeBranchId: branch.id }] });
      if (url.startsWith("/api/v1/projects?")) return response({ total: 1, items: [project] });
      if (url === "/api/v1/projects/" + project.id) return response({ project, capabilities: { assignLead: true } });
      if (url === "/api/v1/projects/" + project.id + "/lead") return response({}, 409);
      return response({}, 404);
    }));
    render(<ProjectWorkspace csrfToken="csrf-project" owner />);
    fireEvent.click(await screen.findByRole("button", { name: /Studio/ }));
    expect(await screen.findByRole("option", { name: "Owner" })).toHaveValue("owner-acct");
    fireEvent.change(await screen.findByLabelText("Project action reason"), { target: { value: "Appoint accountable lead" } });
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    fireEvent.change(screen.getByLabelText("Project lead"), { target: { value: "emp-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Set lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The latest details are loaded");
    const action = calls.find(([url]) => url.endsWith("/lead"));
    expect(action?.[1]).toMatchObject({ method: "POST", headers: { "X-CSRF-Token": "csrf-project" } });
    expect(JSON.parse(String(action?.[1]?.body))).toEqual({ employeeId: "emp-1", expectedVersion: 3, reason: "Appoint accountable lead" });
  });

  it("lets the current scope approver decide a pending change with a reason", async () => {
    const branch = { id: "branch-1", name: "Mumbai" };
    const project = { id: "project-2", title: "Residence", status: "ACTIVE", deliveryType: "DESIGN", version: 5, scopes: [], branch };
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push([url, init]);
      if (url === "/api/v1/project-templates") return response({ templates: [], canManage: false, defaults: { DESIGN: [], TURNKEY: [] } });
      if (url.endsWith("/plan")) return response({ plan: null, items: [], history: [], capabilities: { complete: false, override: false } });
      if (url === "/api/v1/projects/setup") return response({ branches: [branch], employees: [], owner: false });
      if (url.startsWith("/api/v1/projects?")) return response({ total: 1, items: [project] });
      if (url === "/api/v1/projects/" + project.id) return response({ project, currentLeadName: "Mira Shah", capabilities: { decideScope: true }, scopeChanges: [{ name: "Landscape", status: "PENDING", approvalId: "approval-7", approval: { state: "PENDING" }, reason: "Client requested it" }] });
      if (url === "/api/v1/projects/" + project.id + "/scope-requests/approval-7/decision") return response({ decided: true });
      return response({}, 404);
    }));
    render(<ProjectWorkspace csrfToken="csrf-project" owner={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /Residence/ }));
    expect(await screen.findByText("Mira Shah")).toBeInTheDocument();
    expect(await screen.findByText(/Landscape · PENDING · Client requested it/)).toBeInTheDocument();
    expect(screen.getByText(/requester cannot approve their own request/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Project action reason"), { target: { value: "Approved after scope review" } });
    fireEvent.click(approve);
    expect(await screen.findByText("Scope change approved.")).toBeInTheDocument();
    const decision = calls.find(([url]) => url.endsWith("/scope-requests/approval-7/decision"));
    expect(decision?.[1]).toMatchObject({ method: "POST", headers: { "X-CSRF-Token": "csrf-project" } });
    expect(JSON.parse(String(decision?.[1]?.body))).toEqual({ outcome: "APPROVED", reason: "Approved after scope review" });
  });

  it("lets only the Owner withdraw a pending scope request with a reason", async () => {
    const branch = { id: "branch-1", name: "Mumbai" };
    const project = { id: "project-3", title: "Townhouse", status: "ACTIVE", deliveryType: "DESIGN", version: 2, scopes: [], branch };
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push([url, init]);
      if (url === "/api/v1/project-templates") return response({ templates: [], canManage: false, defaults: { DESIGN: [], TURNKEY: [] } });
      if (url.endsWith("/plan")) return response({ plan: null, items: [], history: [], capabilities: { complete: false, override: false } });
      if (url === "/api/v1/projects/setup") return response({ branches: [branch], employees: [], owner: true, ownerAccountId: "owner-account" });
      if (url.startsWith("/api/v1/projects?")) return response({ total: 1, items: [project] });
      if (url === "/api/v1/projects/" + project.id) return response({ project, scopeChanges: [{ name: "Lighting", status: "PENDING", approvalId: "approval-9", approval: { state: "PENDING" }, reason: "Client request" }] });
      if (url === "/api/v1/projects/" + project.id + "/scope-requests/approval-9/withdraw") return response({ withdrawn: true });
      return response({}, 404);
    }));
    render(<ProjectWorkspace csrfToken="csrf-project" owner />);
    fireEvent.click(await screen.findByRole("button", { name: /Townhouse/ }));
    expect(await screen.findByText(/withdraw the request with a reason, change the approver above/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const withdraw = await screen.findByRole("button", { name: "Withdraw" });
    expect(withdraw).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Project action reason"), { target: { value: "Approver is unavailable" } });
    fireEvent.click(withdraw);
    expect(await screen.findByText(/Pending scope request withdrawn/)).toBeInTheDocument();
    const call = calls.find(([url]) => url.endsWith("/scope-requests/approval-9/withdraw"));
    expect(call?.[1]).toMatchObject({ method: "POST", headers: { "X-CSRF-Token": "csrf-project" } });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ reason: "Approver is unavailable" });
  });

  it("ignores a stale Branch response after the Owner switches branches", async () => {
    const first = { id: "branch-1", name: "Mumbai" }, second = { id: "branch-2", name: "Pune" };
    let finishFirst: ((value: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/project-templates") return Promise.resolve(response({ templates: [], canManage: false, defaults: { DESIGN: [], TURNKEY: [] } }));
      if (url === "/api/v1/projects/setup") return Promise.resolve(response({ branches: [first, second] }));
      if (url.startsWith("/api/v1/crm/")) return Promise.resolve(response({ items: [], total: 0 }));
      if (url.includes(`branchId=${first.id}`)) return new Promise<Response>((resolve) => { finishFirst = resolve; });
      if (url.includes(`branchId=${second.id}`)) return Promise.resolve(response({ total: 1, items: [{ id: "new", title: "Pune project", status: "DRAFT", deliveryType: "DESIGN", scopes: [], branch: second }] }));
      return Promise.resolve(response({ total: 0, items: [] }));
    }));
    render(<ProjectWorkspace csrfToken="csrf" owner />);
    await screen.findByLabelText("Project branch");
    await waitFor(() => expect(screen.getByLabelText("Project branch")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Project branch"), { target: { value: first.id } });
    await waitFor(() => expect(finishFirst).toBeDefined());
    fireEvent.change(screen.getByLabelText("Project branch"), { target: { value: second.id } });
    expect(await screen.findByText("Pune project")).toBeInTheDocument();
    finishFirst!(response({ total: 1, items: [{ id: "old", title: "Mumbai project", status: "DRAFT", deliveryType: "DESIGN", scopes: [], branch: first }] }));
    await waitFor(() => expect(screen.queryByText("Mumbai project")).not.toBeInTheDocument());
    expect(screen.getByText("Pune project")).toBeInTheDocument();
  });
});
