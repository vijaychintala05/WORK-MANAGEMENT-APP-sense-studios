import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import { ClientReviewPortal, StaffClientReviewWorkspace } from "./client-review.js";
import type { PortalSession } from "./client-portal-auth.js";

const STAFF = "/api/v1/client-reviews";
const { startAuthentication } = vi.hoisted(() => ({ startAuthentication: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication }));

const primarySession: PortalSession = { account: { id: "client-1", email: "primary@example.test", kind: "CLIENT" }, csrfToken: "client-csrf", activePasskeyCount: 1 };
const project = { id: "project-1", title: "Kitchen project", status: "ACTIVE", primary: true, expiresAt: null, grantId: "grant-primary", version: 1 };
const item = {
  id: "item-1", label: "A-101 R2", status: "IN_REVIEW", version: 3,
  task: { id: "task-1", title: "Kitchen elevations", status: "IN_CLIENT_REVIEW" },
  revision: { id: "revision-1", label: "R2", mimeType: "application/pdf" }, decision: null, comments: [] as Array<{ id: string; authorEmail: string; text: string; annotations: Array<{ page: number; x: number; y: number; text: string }>; referenceId: string | null; createdAt: string }>
};
const reviews = { project: { id: project.id, title: project.title, status: project.status }, packages: [{ id: "package-1", title: "Kitchen review", status: "OPEN", version: 2, items: [item] }] };
function response(body: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal("fetch", fn);
  return fn;
}
beforeEach(() => { vi.restoreAllMocks(); startAuthentication.mockReset(); });

describe("client review portal", () => {
  it("opens an invited review deep link only after the project and item are in authorized results", async () => {
    const fetchMock = mockFetch(url => url === "/api/v1/client-portal/projects" ? response({ projects: [project] })
      : url.endsWith("/reviews/projects/project-1") ? response(reviews)
      : url.endsWith("/reviews/items/item-1") ? response(item) : response({}, 404));
    render(<ClientReviewPortal session={primarySession} requestedProjectId="project-1" requestedItemId="item-1" />);
    expect(await screen.findByRole("heading", { name: /^Client review$/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reviews/items/item-1"))).toBe(true);
  });

  it("does not fetch a foreign deep-link project", async () => {
    const fetchMock = mockFetch(() => response({ projects: [project] }));
    render(<ClientReviewPortal session={primarySession} requestedProjectId="foreign-project" requestedItemId="foreign-item" />);
    expect(await screen.findByText("This project is not available under your current access.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a deep-link item absent from its authorized project package", async () => {
    const fetchMock = mockFetch(url => url === "/api/v1/client-portal/projects" ? response({ projects: [project] })
      : url.endsWith("/reviews/projects/project-1") ? response(reviews) : response({}, 404));
    render(<ClientReviewPortal session={primarySession} requestedProjectId="project-1" requestedItemId="foreign-item" />);
    expect(await screen.findByText("This item is not available in the selected project.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("foreign-item"))).toBe(false);
  });

  it("loads only authorized projects and shows a safe empty state when there are none", async () => {
    const fetchMock = mockFetch((url) => url === "/api/v1/client-portal/projects" ? response({ projects: [] }) : response({}, 404));
    render(<ClientReviewPortal session={primarySession} />);
    expect(await screen.findByText(/no client projects/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });

  it("posts a comment and normalized annotation with CSRF, then refreshes the exact item", async () => {
    let detail = item;
    let sentBody: unknown;
    const fetchMock = mockFetch((url, init) => {
      if (url === "/api/v1/client-portal/projects") return response({ projects: [project] });
      if (url.endsWith("/reviews/projects/project-1")) return response(reviews);
      if (url.endsWith("/reviews/items/item-1/comments") && init?.method === "POST") {
        sentBody = JSON.parse(String(init.body));
        const sent = sentBody as { text: string; annotations: Array<{ page: number; x: number; y: number; text: string }> };
        detail = { ...detail, comments: [{ id: "comment-1", authorEmail: primarySession.account.email, text: sent.text, annotations: sent.annotations, referenceId: null, createdAt: "2026-10-01T09:00:00.000Z" }] };
        return response(detail);
      }
      if (url.endsWith("/reviews/items/item-1")) return response(detail);
      return response({}, 404);
    });
    render(<ClientReviewPortal session={primarySession} />);
    fireEvent.click(await screen.findByRole("button", { name: /A-101 R2/ }));
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Please review this corner" } });
    fireEvent.change(screen.getByLabelText("Annotation text"), { target: { value: "Corner detail" } });
    fireEvent.change(screen.getByLabelText("Page"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("X (0–1)"), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("Y (0–1)"), { target: { value: "0.75" } });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    expect(await screen.findByText("Comment saved.")).toBeInTheDocument();
    expect(new Headers(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/reviews/items/item-1/comments"))?.[1]?.headers).get("X-CSRF-Token")).toBe("client-csrf");
    expect(sentBody).toEqual({ text: "Please review this corner", annotations: [{ page: 2, x: 0.25, y: 0.75, text: "Corner detail" }], reason: "Client review comment" });
    expect(await screen.findByText("Please review this corner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View issued file" })).toHaveAttribute("href", "/api/v1/client-portal/items/item-1/stream");
  });

  it("requires Primary Client authority and passkey registration before approval proof", async () => {
    const nonPrimary = { ...primarySession, activePasskeyCount: 0 };
    const fetchMock = mockFetch((url) => url === "/api/v1/client-portal/projects" ? response({ projects: [{ ...project, primary: false }] }) : url.endsWith("/reviews/projects/project-1") ? response(reviews) : response(item));
    render(<ClientReviewPortal session={nonPrimary} />);
    fireEvent.click(await screen.findByRole("button", { name: /A-101 R2/ }));
    expect(await screen.findByRole("heading", { name: "Client review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve with passkey/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /record final approval/i })).not.toBeInTheDocument();
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("approval-options"))).toBe(false);
  });

  it("requires browser UV proof before posting exact item approval", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url === "/api/v1/client-portal/projects") return response({ projects: [project] });
      if (url.endsWith("/reviews/projects/project-1")) return response(reviews);
      if (url.endsWith("/items/item-1/approval-options")) return response({ ceremonyId: "ceremony-1", options: { challenge: "fresh" } });
      if (url.endsWith("/items/item-1/decision")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ kind: "APPROVED", expectedVersion: 3, signatureName: "Client Signer", consent: true, ceremonyId: "ceremony-1", response: { id: "uv-response" } });
        return response({ ...item, status: "APPROVED", version: 4 });
      }
      if (url.endsWith("/items/item-1")) return response(item);
      return response({}, 404);
    });
    startAuthentication.mockResolvedValue({ id: "uv-response" });
    render(<ClientReviewPortal session={primarySession} />);
    fireEvent.click(await screen.findByRole("button", { name: /A-101 R2/ }));
    fireEvent.change(await screen.findByLabelText("Typed signature"), { target: { value: "Client Signer" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /consent to record this as my electronic approval/i }));
    fireEvent.click(screen.getByRole("button", { name: "Approve with passkey" }));
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "fresh" } }));
    expect(await screen.findByText(/item approved with passkey verification/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/items/item-1/decision") && init?.credentials === "same-origin")).toBe(true);
  });
});

describe("internal client review publishing", () => {
  it("publishes the selected task and exact revision with its displayed current version", async () => {
    let postedBody: unknown;
    const fetchMock = mockFetch((url, init) => {
      if (url === "/api/v1/projects/setup") return response({ branches: [{ id: "branch-1" }] });
      if (url.startsWith("/api/v1/projects?")) return response({ items: [{ ...project, branch: { id: "branch-1", name: "Main" } }] });
      if (url === `${STAFF}/projects/project-1`) return response({ ...reviews, packages: [], eligibleTasks: [{ id: "task-1", title: "Kitchen elevations", version: 7, status: "INTERNAL_APPROVED", revisions: [{ id: "revision-1", label: "CR1", mimeType: "application/pdf", state: "ISSUED", drawingId: "drawing-1" }] }] });
      if (url === "/api/v1/client-access/projects/project-1") return response({ projectVersion: 1, grants: [] });
      if (url === `${STAFF}/projects/project-1/packages` && init?.method === "POST") {
        postedBody = JSON.parse(String(init.body));
        return response({});
      }
      return response({}, 404);
    });
    render(<StaffClientReviewWorkspace csrfToken="staff-csrf" owner />);
    fireEvent.change(await screen.findByLabelText("Package title"), { target: { value: "Client set 1" } });
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "task-1" } });
    fireEvent.change(screen.getByLabelText("Approved evidence"), { target: { value: "revision-1" } });
    fireEvent.change(screen.getByLabelText("Client label"), { target: { value: "Sheet A101" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Ready for client" } });
    fireEvent.click(screen.getByRole("button", { name: "Send for client review" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/packages"))).toBe(true));
    expect(new Headers(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/packages"))?.[1]?.headers).get("X-CSRF-Token")).toBe("staff-csrf");
    expect(postedBody).toEqual({ title: "Client set 1", reason: "Ready for client", items: [{ taskId: "task-1", expectedTaskVersion: 7, revisionId: "revision-1", label: "Sheet A101" }] });
    expect(await screen.findByText("Client review package sent.")).toBeInTheDocument();
  });
});

describe("client correction task commands", () => {
  it("completes through ordinary task transitions and resumes using the original task version", async () => {
    const correctionItem = { id: "item-1", taskId: "original-task", label: "Correct elevations", status: "REVISION_REQUIRED", version: 4, correctionTaskId: "correction-task" };
    const commands: Array<{ url: string; body: Record<string, unknown> }> = [];
    const correctionReviews = { ...reviews, packages: [{ ...reviews.packages[0], items: [correctionItem] }], eligibleTasks: [], capabilities: { assignCorrection: true }, correctionOwners: [] };
    mockFetch((url, init) => {
      if (url === "/api/v1/projects/setup") return response({ branches: [{ id: "branch-1" }] });
      if (url.startsWith("/api/v1/projects?")) return response({ items: [project] });
      if (url === `${STAFF}/projects/project-1`) return response(correctionReviews);
      if (url === "/api/v1/tasks/correction-task") return response({ task: { id: "correction-task", status: "NOT_STARTED", version: 3 } });
      if (url === "/api/v1/tasks/original-task") return response({ task: { id: "original-task", status: "CLIENT_REVISION_REQUIRED", version: 19 } });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        commands.push({ url, body });
        return response({ id: "correction-task", version: 4, status: "IN_PROGRESS" });
      }
      return response({}, 404);
    });
    render(<StaffClientReviewWorkspace csrfToken="staff-csrf" owner={false} />);
    await screen.findByText("Correct elevations");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Correction work verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete correction" }));
    await screen.findByText("Correction task completed.");
    expect(commands.slice(0, 2)).toEqual([
      { url: "/api/v1/tasks/correction-task/state", body: { toState: "IN_PROGRESS", expectedVersion: 3, reason: "Correction work verified" } },
      { url: "/api/v1/tasks/correction-task/state", body: { toState: "COMPLETED", expectedVersion: 4, reason: "Correction work verified" } }
    ]);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Resume revised original work" } });
    fireEvent.click(screen.getByRole("button", { name: "Resume after completion" }));
    await screen.findByText("Completed correction resumed for internal review.");
    expect(commands[2]).toEqual({ url: `${STAFF}/items/item-1/resume`, body: { expectedTaskVersion: 19, reason: "Resume revised original work" } });
  });
});

describe("client review project selection", () => {
  it("ignores the previous project's delayed details after switching projects", async () => {
    let resolveOld!: (value: Response) => void;
    const oldDetails = new Promise<Response>((resolve) => { resolveOld = resolve; });
    mockFetch((url) => {
      if (url === "/api/v1/projects/setup") return response({ branches: [{ id: "branch-1" }] });
      if (url.startsWith("/api/v1/projects?")) return response({ items: [project, { ...project, id: "project-2", title: "Second project" }] });
      if (url === `${STAFF}/projects/project-1`) return oldDetails;
      if (url === `${STAFF}/projects/project-2`) return response({ project: { ...project, id: "project-2" }, packages: [], eligibleTasks: [] });
      if (url === "/api/v1/client-access/projects/project-2") return response({ projectVersion: 9, grants: [{ id: "second-grant", email: "second@example.test", primary: true, version: 1 }] });
      if (url === "/api/v1/client-access/projects/project-1") return response({ projectVersion: 1, grants: [{ id: "old-grant", email: "old@example.test", primary: true, version: 1 }] });
      return response({}, 404);
    });
    render(<StaffClientReviewWorkspace csrfToken="staff-csrf" owner />);
    await screen.findByRole("option", { name: "Second project" });
    fireEvent.change(screen.getByLabelText("Active project"), { target: { value: "project-2" } });
    await screen.findByText(/second@example.test/);
    await act(async () => { resolveOld(response({ ...reviews, eligibleTasks: [] })); await oldDetails; });
    expect(screen.getByLabelText("Active project")).toHaveValue("project-2");
    expect(screen.getByText(/second@example.test/)).toBeInTheDocument();
    expect(screen.queryByText(/old@example.test/)).not.toBeInTheDocument();
  });
});

describe("client-approved task completion", () => {
  it("offers completion only after Primary package approval and calls the guarded consumer", async () => {
    let final = false, completed = false;
    let completion: unknown;
    mockFetch((url, init) => {
      if (url === "/api/v1/projects/setup") return response({ branches: [{ id: "branch-1" }] });
      if (url.startsWith("/api/v1/projects?")) return response({ items: [project] });
      if (url === `${STAFF}/projects/project-1`) return response({ ...reviews, capabilities: { manage: true }, eligibleTasks: [], packages: [{ ...reviews.packages[0], status: final ? "APPROVED" : "OPEN", items: [{ ...item, taskId: "task-1", status: "APPROVED", taskStatus: completed ? "COMPLETED" : "CLIENT_APPROVED" }] }] });
      if (url === "/api/v1/tasks/task-1") return response({ task: { id: "task-1", status: "CLIENT_APPROVED", version: 12 } });
      if (url === `${STAFF}/tasks/task-1/complete` && init?.method === "POST") { completion = JSON.parse(String(init.body)); completed = true; return response({}); }
      return response({}, 404);
    });
    render(<StaffClientReviewWorkspace csrfToken="staff-csrf" owner={false} />);
    await screen.findByText("A-101 R2");
    expect(screen.queryByRole("button", { name: "Complete approved task" })).not.toBeInTheDocument();
    final = true;
    fireEvent.change(screen.getByLabelText("Active project"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Active project"), { target: { value: "project-1" } });
    await screen.findByRole("button", { name: "Complete approved task" });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Complete approved delivery" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete approved task" }));
    await screen.findByText("Approved task completed.");
    expect(completion).toEqual({ expectedVersion: 12, reason: "Complete approved delivery" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Complete approved task" })).not.toBeInTheDocument());
  });
});
