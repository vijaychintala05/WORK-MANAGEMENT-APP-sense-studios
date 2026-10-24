import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, vi } from "vitest";
import { App } from "./app.js";

const { startAuthentication, startRegistration } = vi.hoisted(() => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication, startRegistration }));

const account = { id: "acct_1", email: "owner@example.test", kind: "OWNER" as const };
const session = { account, csrfToken: "csrf-test-token" };

function renderApp(path = "/"): void {
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function stubFetchWithCrmSetup(fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, headerSessionResponse: Response): void {
  let headerSessionRead = true;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/v1/auth/session" && headerSessionRead) {
      headerSessionRead = false;
      return Promise.resolve(headerSessionResponse);
    }
    if (url === "/api/v1/crm/setup") return Promise.resolve(response({ branches: [], sources: [], owner: false }));
    if (url === "/api/v1/project-templates") return Promise.resolve(response({ templates: [], canManage: false, defaults: { DESIGN: [], TURNKEY: [] } }));
    if (url === "/api/v1/projects/setup") return Promise.resolve(response({ branches: [] }));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(response({ total: 0, items: [] }));
    if (url === "/api/v1/tasks/setup") return Promise.resolve(response({ actorEmployeeId: null, projects: [], employees: [], planItems: [], canAssign: false }));
    if (url.startsWith("/api/v1/tasks?")) return Promise.resolve(response({ total: 0, items: [] }));
    if (url === "/api/v1/site/projects") return Promise.resolve(response({ items: [] }));
    if (url === "/api/v1/reports/context") return Promise.resolve(response({ categories: [], eventNames: [], owner: false }));
    if (url === "/api/v1/dashboard/schedules") return Promise.resolve(response({ rules: [] }));
    if (url === "/api/v1/dashboard/reminders") return Promise.resolve(response({ reminders: [] }));
    if (url === "/api/v1/dashboard/summaries") return Promise.resolve(response({ summaries: [] }));
    if (url === "/api/v1/reports/snapshots") return Promise.resolve(response({ snapshots: [] }));
    // The workspace shell polls its unread count for the navigation badge; it is
    // not the subject of these journeys, so absorb it here rather than letting it
    // shift the positional mock queues below.
    if (url === "/api/v1/notifications/unread") return Promise.resolve(response({ unread: 0, critical: 0 }));
    const source = url.match(/^\/api\/v1\/dashboard\/sources\/(tasks|decisions|health|performance|workload|site|training)$/)?.[1];
    if (source) return Promise.resolve(response({ source, today: "2026-10-13", readCompletedAt: "2026-10-13T00:00:00.000Z", sections: [], ...(source === "decisions" ? { decisions: { items: [], nextCursor: null } } : {}) }));
    return fetchMock(input, init);
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  startAuthentication.mockReset();
  startRegistration.mockReset();
  localStorage.clear();
  Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: class {} });
});

describe("identity authentication shell", () => {
  it("offers organization setup for the server's successful empty response without a false load error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/auth/session") return response({ ...session, ownerSetupRequired: false });
      if (String(input) === "/api/v1/org") return new Response("", { status: 200 });
      return response([]);
    }));
    renderApp("/settings?section=organization");
    fireEvent.click(await screen.findByRole("button", { name: "Manage organization" }));
    expect(await screen.findByRole("heading", { name: "Set up the organization" })).toBeInTheDocument();
    expect(screen.queryByText(/couldn’t load organization settings/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
  });

  it.each([403, 503])("does not offer organization creation after an unsuccessful setup read (%s)", async status => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/auth/session") return response({ ...session, ownerSetupRequired: false });
      if (String(input) === "/api/v1/org") return response({}, status);
      return response([]);
    }));
    renderApp("/settings?section=organization");
    fireEvent.click(await screen.findByRole("button", { name: "Manage organization" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(status === 403 ? "Organization access is restricted" : "couldn’t load organization settings");
    expect(screen.queryByRole("heading", { name: "Set up the organization" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create organization" })).not.toBeInTheDocument();
  });
  it("opens the internal evidence assistance workspace through authenticated navigation", async () => {
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/auth/session") return response(session);
      if (url === "/api/v1/ai/context") return response({ provider: "deterministic-evidence-v1", providerVersion: "1", requestKinds: ["DAILY", "PROJECT", "MANAGEMENT", "ASSIGNMENT"], capabilities: { DAILY: true, PROJECT: true, MANAGEMENT: true, ASSIGNMENT: true, canDecide: true }, projects: [], tasks: [] });
      if (url === "/api/v1/ai/runs") return response({ items: [] });
      return response({});
    }), response(session));
    renderApp("/assistance");
    expect(await screen.findByRole("heading", { name: "Evidence assistance" })).toBeInTheDocument();
    expect(await screen.findByText(/no live inference or external data transmission/i)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Evidence assistance" }).length).toBeGreaterThan(0);
  });

  it("lands a ready signed-in account on Dashboard while retaining the accepted destinations", async () => {
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/auth/session") return response(session);
      if (url.startsWith("/api/v1/approvals/attention")) return response({ items: [], nextCursor: null });
      if (url === "/api/v1/reports/context") return response({ categories: [], eventNames: [], owner: true });
      if (url === "/api/v1/dashboard/schedules") return response({ rules: [] });
      if (url === "/api/v1/dashboard/reminders") return response({ reminders: [] });
      if (url === "/api/v1/dashboard/summaries") return response({ summaries: [] });
      if (url === "/api/v1/reports/snapshots") return response({ snapshots: [] });
      const source = url.match(/^\/api\/v1\/dashboard\/sources\/(tasks|decisions|health|performance|workload|site|training)$/)?.[1];
      if (source) return response({ source, today: "2026-10-13", readCompletedAt: "2026-10-13T00:00:00.000Z", sections: [], ...(source === "decisions" ? { decisions: { items: [], nextCursor: null } } : {}) });
      return response({}, 404);
    }), response(session));
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "You’re signed in." })).not.toBeInTheDocument();
    const desktopNav = screen.getByRole("navigation", { name: "Workspace navigation" });
    for (const group of ["Work", "People", "Insights", "Manage"]) {
      const disclosure = within(desktopNav).getByRole("button", { name: group });
      if (disclosure.getAttribute("aria-expanded") !== "true") fireEvent.click(disclosure);
    }
    for (const name of ["Account & settings", "Dashboard", "Performance", "External access", "Turnkey operations", "Site delivery"]) expect(screen.getAllByRole("link", { name }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Learning" }).length).toBeGreaterThan(0);
    fireEvent(window, new Event("sense-session-ended"));
    expect(await screen.findByRole("heading", { name: "Sign in to view your dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
    expect(screen.queryByText("owner@example.test")).not.toBeInTheDocument();
  });

  it.each([
    { label: "Owner", currentSession: { ...session, ownerSetupRequired: false, activePasskeyCount: 2 }, visibleWorkspaceSection: "Organization administration", hiddenWorkspaceSection: "Team workspace" },
    { label: "staff", currentSession: { ...session, account: { ...account, kind: "STAFF" as const }, ownerSetupRequired: false }, visibleWorkspaceSection: "Team workspace", hiddenWorkspaceSection: "Organization administration" },
  ])("opens the direct Notifications settings route with $label section grouping", async ({ currentSession, visibleWorkspaceSection, hiddenWorkspaceSection }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/auth/session") return response(currentSession);
      if (url === "/api/v1/auth/sessions") return response([]);
      if (url === "/api/v1/notifications") return response({ items: [], nextCursor: null });
      if (url === "/api/v1/notifications/preferences") return response({ preferences: [], quietHours: null });
      if (url === "/api/v1/notifications/email-status") return response({ verified: true, available: true, items: [] });
      return response({}, 404);
    });
    stubFetchWithCrmSetup(fetchMock, response(currentSession));
    renderApp("/settings?section=notifications");

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByText("Your inbox is clear. New authorized updates will appear here.")).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(navigation).getByRole("heading", { name: "Personal" })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "Account & devices" })).toHaveAttribute("href", "/settings?section=account");
    expect(within(navigation).getByRole("link", { name: "Notifications" })).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getByRole("heading", { name: "Organization & administration" })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: visibleWorkspaceSection })).toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: hiddenWorkspaceSection })).not.toBeInTheDocument();
  });

  it.each(["/my-work", "/tasks", "/projects"])("requires a session before opening %s", async (path) => {
    stubFetchWithCrmSetup(vi.fn(async () => response({}, 401)), response({}, 401));
    renderApp(path);
    expect(await screen.findByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
  });


  it.each(["/tasks", "/documents", "/reviews"])("removes the protected route %s on a session-ended signal", async (path) => {
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/auth/session" ? response(session) : response({ branches: [], total: 0, items: [], categories: [] })), response(session));
    renderApp(path);
    expect(await screen.findByRole("navigation", { name: "Workspace navigation" })).toBeInTheDocument();
    fireEvent(window, new Event("sense-session-ended"));
    expect(await screen.findByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
  });

  it.each(["/my-work", "/tasks", "/documents", "/reviews", "/projects"])("ignores a late session response after explicit session loss on %s", async (path) => {
    const resolveRefresh: Array<(value: Response) => void> = [];
    let authCalls = 0;
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/auth/session") return response({ branches: [], total: 0, items: [], categories: [], nextCursor: null });
      authCalls += 1;
      if (authCalls === 1) return response(session);
      return new Promise<Response>(resolve => { resolveRefresh.push(resolve); });
    }), response(session));
    renderApp(path);
    expect(await screen.findByRole("navigation", { name: "Workspace navigation" })).toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(resolveRefresh).toHaveLength(2));
    fireEvent(window, new Event("sense-session-ended"));
    expect(await screen.findByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    await act(async () => { resolveRefresh.forEach(resolve => resolve(response(session))); });
    expect(screen.getByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
  });

  it("clears Learning after session loss and ignores a late refresh", async () => {
    const resolveRefresh: Array<(value: Response) => void> = [];
    let authCalls = 0;
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/auth/session") {
        authCalls += 1;
        if (authCalls === 1) return response(session);
        return new Promise<Response>(resolve => { resolveRefresh.push(resolve); });
      }
      if (String(input) === "/api/v1/skills/setup") return response({ skills: [], employees: [], eligibleApprovers: [] });
      if (String(input) === "/api/v1/training/setup") return response({ employees: [], modulesByEmployee: [], reviewers: [], practicalTasks: [], assignments: [], capabilities: { currentAccountId: session.account.id, manageableEmployeeIds: [], canManage: false, canSubmit: false } });
      return response({ items: [], total: 0 });
    }), response(session));
    renderApp("/learning");
    expect(await screen.findByRole("heading", { name: "Skills" })).toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(resolveRefresh).toHaveLength(2));
    fireEvent(window, new Event("sense-session-ended"));
    expect(await screen.findByRole("heading", { name: "Sign in to view Learning" })).toBeInTheDocument();
    await act(async () => { resolveRefresh.forEach(resolve => resolve(response(session))); });
    expect(screen.getByRole("heading", { name: "Sign in to view Learning" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
  });

  const protectedRoutePaths = [
    "/revisions", "/client-reviews", "/turnkey", "/time", "/workforce", "/performance", "/project-health",
    "/dashboard", "/reports", "/integrations", "/automation", "/saved-reports", "/site", "/assistance",
  ];

  it.each(protectedRoutePaths)("keeps %s signed out when its initial session read finishes after session loss", async path => {
    const pendingReads: Array<(value: Response) => void> = [];
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/auth/session") return new Promise<Response>(resolve => { pendingReads.push(resolve); });
      return response({}, 404);
    }), response(session));
    renderApp(path);
    await waitFor(() => expect(pendingReads).toHaveLength(1));
    fireEvent(window, new Event("sense-session-ended"));
    expect(await screen.findByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    await act(async () => { pendingReads[0]!(response(session)); });
    expect(screen.getByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
    expect(screen.queryByText("owner@example.test")).not.toBeInTheDocument();
  });

  it.each(protectedRoutePaths)("removes the authenticated %s workspace on explicit session loss", async path => {
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/auth/session" ? response(session) : response({}, 404)), response(session));
    renderApp(path);
    expect(await screen.findByRole("navigation", { name: "Workspace navigation" })).toBeInTheDocument();
    fireEvent(window, new Event("sense-session-ended"));
    expect(await screen.findByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
    expect(screen.queryByText("owner@example.test")).not.toBeInTheDocument();
  });

  it.each(protectedRoutePaths)("ignores delayed %s session refreshes after session loss", async path => {
    let routeReads = 0;
    const pendingReads: Array<(value: Response) => void> = [];
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/auth/session") return response({}, 404);
      routeReads += 1;
      if (routeReads === 1) return response(session);
      return new Promise<Response>(resolve => { pendingReads.push(resolve); });
    }), response(session));
    renderApp(path);
    expect(await screen.findByRole("navigation", { name: "Workspace navigation" })).toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(pendingReads).toHaveLength(2));
    fireEvent(window, new Event("sense-session-ended"));
    expect(await screen.findByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    await act(async () => { pendingReads.forEach(resolve => resolve(response(session))); });
    expect(screen.getByRole("heading", { name: /Sign in to/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
    expect(screen.queryByText("owner@example.test")).not.toBeInTheDocument();
  });

  it("clears the local Site fallback and account pointer when a session ends", async () => {
    const pointerKey = "sense-site-offline-pointer-v1";
    localStorage.setItem(pointerKey, JSON.stringify({ accountId: "acct_1", projectId: "project-1", projectTitle: "Project" }));
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/auth/session") throw new Error("identity service unavailable");
      return response({}, 404);
    }), response(session));
    renderApp("/site");
    expect(await screen.findByRole("heading", { name: "Offline site capture unavailable" })).toBeInTheDocument();
    fireEvent(window, new Event("sense-session-ended"));
    expect(await screen.findByRole("heading", { name: "Sign in to view site delivery" })).toBeInTheDocument();
    expect(localStorage.getItem(pointerKey)).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).not.toBeInTheDocument();
  });

  it("restores the session and shows only the authenticated identity", async () => {
    stubFetchWithCrmSetup(vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/v1/approvals/attention") ? response({ items: [], nextCursor: null }) : response(session)), response(session));
    renderApp("/workspace");

    expect(screen.getByRole("status")).toHaveTextContent(/Checking your session/);
    expect(await screen.findByRole("heading", { name: "You’re signed in." })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByText("owner@example.test")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Projects", level: 1 })).toBeInTheDocument();
  });

  it("runs options, browser assertion, verification, and restores the new session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ ceremonyId: "ceremony-1", options: { challenge: "test" } }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(response([]));
    stubFetchWithCrmSetup(fetchMock, response({}, 401));
    startAuthentication.mockResolvedValue({ id: "credential-response" });
    renderApp("/workspace");

    fireEvent.change(await screen.findByLabelText("Work email"), { target: { value: "owner@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByRole("heading", { name: "You’re signed in." })).toBeInTheDocument();
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "test" } });
    await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/auth/session",
      "/api/v1/auth/passkey/login/options",
      "/api/v1/auth/passkey/login/verify",
      "/api/v1/auth/session",
      "/api/v1/approvals/attention?limit=30",
      "/api/v1/auth/sessions",
    ]));
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ email: "owner@example.test" });
  });

  it("shows a generic invalid response without exposing account details", async () => {
    stubFetchWithCrmSetup(vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({}, 401)), response({}, 401));
    renderApp("/");
    fireEvent.change(await screen.findByLabelText("Work email"), { target: { value: "unknown@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t sign you in/i);
    expect(screen.queryByText(/unknown@example.test/i)).not.toBeInTheDocument();
  });

  it("reports network failure and passkey cancellation in generic terms", async () => {
    stubFetchWithCrmSetup(vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockRejectedValueOnce(new Error("offline")), response({}, 401));
    renderApp("/");
    fireEvent.change(await screen.findByLabelText("Work email"), { target: { value: "owner@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t reach the sign-in service/i);

    startAuthentication.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    vi.mocked(fetch).mockResolvedValueOnce(response({ ceremonyId: "c-2", options: {} }));
    fireEvent.click(screen.getByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/request was cancelled/i);
  });

  it("sends the session CSRF token on logout and confirms completion", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({}));
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/workspace");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/You’ve signed out/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.find(([url]) => url === "/api/v1/auth/logout")?.[1]).toMatchObject({
      method: "POST",
      headers: { "X-CSRF-Token": "csrf-test-token" },
    });
  });

  it("header logout clears protected content and reaches the normal sign-in route", async () => {
    let signedOut = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/auth/logout") { signedOut = true; return response({}); }
      if (url === "/api/v1/auth/session") return signedOut ? response({}, 401) : response(session);
      if (url === "/api/v1/notifications") return response({ items: [], nextCursor: null });
      return response([]);
    });
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/tasks");
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect(await screen.findByLabelText("Work email")).toBeInTheDocument();
    expect(screen.queryByText("We couldn’t sign you out. Try again.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/logout", expect.objectContaining({
      method: "POST", headers: { "X-CSRF-Token": "csrf-test-token" },
    }));
  });

  it("returns to sign in when a refreshed session has been revoked", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({}, 401));
    fetchMock.mockResolvedValueOnce(response({}, 401));
    // A revoked server session keeps returning401 to every concurrent probe.
    fetchMock.mockResolvedValue(response({}, 401));
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/workspace");
    expect(await screen.findByRole("heading", { name: "You’re signed in." })).toBeInTheDocument();
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByLabelText("Work email")).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent(/session ended/i);
  });

  it("bootstraps the first Owner and completes second passkey plus recovery acknowledgment", async () => {
    const setupSession = { ...session, ownerSetupRequired: true, activePasskeyCount: 1 };
    const secondPasskeySession = { ...session, ownerSetupRequired: true, activePasskeyCount: 2 };
    const readySession = { ...session, ownerSetupRequired: false, activePasskeyCount: 2 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ceremonyId: "bootstrap-c", options: { challenge: "bootstrap" } }))
      .mockResolvedValueOnce(response({ authenticated: true }))
      .mockResolvedValueOnce(response(setupSession))
      .mockResolvedValueOnce(response(setupSession))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ ceremonyId: "second-c", options: { challenge: "second" } }))
      .mockResolvedValueOnce(response({ registered: true }))
      .mockResolvedValueOnce(response(secondPasskeySession))
      .mockResolvedValueOnce(response({ recoveryCode: "offline-recovery-code-once" }))
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(response(readySession));
    stubFetchWithCrmSetup(fetchMock, response({}, 401));
    startRegistration.mockResolvedValue({ id: "registration-response" });
    renderApp("/bootstrap");

    fireEvent.change(screen.getByLabelText("Owner work email"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("One-time setup secret"), { target: { value: "s".repeat(40) } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Register Owner passkey" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add second passkey" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create offline recovery code" }));
    expect(await screen.findByLabelText("One-time offline recovery code")).toHaveValue("offline-recovery-code-once");
    fireEvent.click(screen.getByRole("checkbox", { name: /stored this recovery code offline/i }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm offline storage" }));
    expect(await screen.findByRole("heading", { name: "Staff identity access" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/v1/auth/owner/recovery-code/ack");
  });

  it("explains a rejected second passkey without reporting a network failure", async () => {
    const setupSession = { ...session, ownerSetupRequired: true, activePasskeyCount: 1 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/auth/session") return response(setupSession);
      if (url === "/api/v1/auth/passkey/register/options") return response({ ceremonyId: "second-c", options: { challenge: "second" } });
      if (url === "/api/v1/approvals/attention?limit=30") return response({ items: [], nextCursor: null });
      if (url === "/api/v1/crm/setup") return response({ branches: [], sources: [] });
      if (url === "/api/v1/auth/sessions") return response([]);
      return response({}, 404);
    }));
    startRegistration.mockRejectedValue(Object.assign(new Error("Previously registered"), { code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", name: "InvalidStateError" }));
    renderApp("/workspace");
    fireEvent.click(await screen.findByRole("button", { name: "Add second passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already registered.*different passkey method/i);
    expect(screen.queryByText(/couldn’t reach the identity service/i)).not.toBeInTheDocument();
  });

  it("accepts a staff invitation or recovery token and registers a passkey", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ceremonyId: "staff-c", options: { challenge: "staff" } }))
      .mockResolvedValueOnce(response({ authenticated: true }))
      .mockResolvedValueOnce(response({ ...session, account: { ...account, kind: "STAFF" }, ownerSetupRequired: false }))
      .mockResolvedValueOnce(response({ ...session, account: { ...account, kind: "STAFF" }, ownerSetupRequired: false }))
      .mockImplementation(async (input: RequestInfo | URL) => String(input) === "/api/v1/auth/session" ? response({ ...session, account: { ...account, kind: "STAFF" }, ownerSetupRequired: false }) : response({ total: 0, items: [], nextCursor: null }));
    stubFetchWithCrmSetup(fetchMock, response({}, 401));
    startRegistration.mockResolvedValue({ id: "staff-registration" });
    renderApp("/enroll");
    fireEvent.change(screen.getByLabelText("One-time enrollment token"), { target: { value: "t".repeat(44) } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Register staff passkey" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/auth/staff/invitations/options");
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({ token: "t".repeat(44), ceremonyId: "staff-c" });
  });

  it("recovers the Owner using the offline code and a replacement passkey", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ceremonyId: "owner-recovery-c", options: { challenge: "owner-recovery" } }))
      .mockResolvedValueOnce(response({ authenticated: true }))
      .mockResolvedValueOnce(response({ ...session, ownerSetupRequired: true, activePasskeyCount: 1 }))
      .mockResolvedValueOnce(response({ ...session, ownerSetupRequired: true, activePasskeyCount: 1 }))
      .mockResolvedValueOnce(response([]));
    stubFetchWithCrmSetup(fetchMock, response(session));
    startRegistration.mockResolvedValue({ id: "replacement-registration" });
    renderApp("/owner-recovery");
    fireEvent.change(screen.getByLabelText("Owner work email"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("Offline recovery code"), { target: { value: "r".repeat(44) } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Register replacement passkey" }));
    expect(await screen.findByRole("heading", { name: "Secure your Owner account" })).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({ email: "owner@example.test", code: "r".repeat(44), ceremonyId: "owner-recovery-c" });
  });

  it("creates staff invitation and Owner-authorized recovery token handoffs", async () => {
    const ownerSession = { ...session, ownerSetupRequired: false, activePasskeyCount: 2 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(ownerSession))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ invitationToken: "invite-once-token", expiresInSeconds: 86400 }))
      .mockResolvedValueOnce(response({ account: { id: "staff-account-id", email: "staff@example.test", state: "ACTIVE" } }))
      .mockResolvedValueOnce(response({ revokedSessions: 2 }))
      .mockResolvedValueOnce(response({ recoveryToken: "recovery-once-token", expiresInSeconds: 86400 }));
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/workspace");
    fireEvent.change(await screen.findByLabelText("Invite staff by work email"), { target: { value: "staff@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByDisplayValue("invite-once-token")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide token" }));
    fireEvent.change(screen.getByLabelText("Work email for verified staff recovery"), { target: { value: "staff@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Find staff account" }));
    expect(await screen.findByText("staff@example.test", { selector: "strong" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason for recovery authorization"), { target: { value: "Employee verified on a video call." } });
    fireEvent.click(screen.getByRole("button", { name: "Revoke staff sessions" }));
    expect(await screen.findByText("2 staff sessions revoked.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /verified this staff member out of band/i }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke access and authorize recovery" }));
    expect(await screen.findByDisplayValue("recovery-once-token")).toBeInTheDocument();
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": session.csrfToken });
    expect(fetchMock.mock.calls[4]?.[0]).toBe("/api/v1/auth/staff?email=staff%40example.test");
    expect(fetchMock.mock.calls[5]?.[0]).toBe("/api/v1/auth/staff/staff-account-id/revoke-sessions");
    expect(fetchMock.mock.calls[5]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": session.csrfToken });
    expect(fetchMock.mock.calls[6]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": session.csrfToken });
  });

  it("shows session loading, then a readable error with retry and empty state", async () => {
    let finishSessionsRequest: (result: Response) => void = () => undefined;
    const pendingSessions = new Promise<Response>((resolve) => { finishSessionsRequest = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockReturnValueOnce(pendingSessions)
      .mockResolvedValueOnce(response([]));
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/workspace");

    expect(await screen.findByText("Loading your sessions…")).toBeInTheDocument();
    finishSessionsRequest(response({}, 503));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t load your sessions/i);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No sessions are available.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/auth/sessions")).toHaveLength(2);
  });

  it("labels the current device and revokes another session with CSRF, then refreshes the list", async () => {
    const current = {
      id: "current-id-secret-like", createdAt: "2026-09-20T10:00:00.000Z", lastUsedAt: "2026-09-26T09:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z", revokedAt: null, userAgent: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36", current: true,
    };
    const other = {
      id: "other-id-secret-like", createdAt: "2026-09-18T10:00:00.000Z", lastUsedAt: null,
      expiresAt: "2030-01-01T00:00:00.000Z", revokedAt: null, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1", current: false,
    };
    const revoked = { ...other, revokedAt: "2026-09-26T10:00:00.000Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(response([current, other]))
      .mockResolvedValueOnce(response({}, 204))
      .mockResolvedValueOnce(response([current, revoked]));
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/workspace");

    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getByText("Safari on iOS")).toBeInTheDocument();
    expect(screen.queryByText(/current-id-secret-like|other-id-secret-like/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getByText("Safari on iOS").closest("li")).toHaveTextContent(/Revoked/));
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/v1/auth/sessions/other-id-secret-like");
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "DELETE",
      credentials: "include",
      headers: { "X-CSRF-Token": session.csrfToken },
    });
    expect(fetchMock.mock.calls[4]?.[0]).toBe("/api/v1/auth/sessions");
  });

  it("lets the Owner grant and revoke scoped role permissions and employee overrides", async () => {
    const ownerSession = { ...session, ownerSetupRequired: false, activePasskeyCount: 2 };
    const org = { id: "org-s03", name: "Sense Studios" };
    const branch = { id: "branch-s03", organizationId: org.id, name: "Mumbai" };
    const team = { id: "team-s03", branchId: branch.id, organizationId: org.id, name: "Design" };
    const role = { id: "role-s03", name: "Team Leader" };
    const employee = {
      id: "employee-s03", state: "ACTIVE", employeeCode: null,
      account: { normalizedEmail: "designer@example.test", state: "ACTIVE" },
      homeBranch: { id: branch.id, name: branch.name }, homeTeam: { id: team.id, name: team.name },
      jobRoleAssignments: [], permissionOverrides: [], reportsTo: null,
    };
    let rolePermissions: Array<{ id: string; permissionKey: string; scopeKind: string; branchId?: string; teamId?: string }> = [];
    let employeeOverrides: Array<{ id: string; permissionKey: string; effect: "ALLOW" | "DENY"; scopeKind: string; expiresAt: null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/v1/auth/session") return response(ownerSession);
      if (url.startsWith("/api/v1/approvals/attention")) return response({ items: [], nextCursor: null });
      if (url === "/api/v1/auth/sessions") return response([]);
      if (url === "/api/v1/org") return response(org);
      if (url === `/api/v1/org/branches?organizationId=${org.id}`) return response([branch]);
      if (url === `/api/v1/org/teams?organizationId=${org.id}`) return response([team]);
      if (url === `/api/v1/org/roles?organizationId=${org.id}`) return response([{ ...role, permissions: rolePermissions }]);
      if (url === `/api/v1/org/employees?organizationId=${org.id}`) return response([{ ...employee, permissionOverrides: employeeOverrides }]);
      if (url === `/api/v1/org/roles/${role.id}/permissions` && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { permissionKey: string; scopeKind: string; branchId: string; teamId: string };
        rolePermissions = [{ id: "role-permission-s03", ...body }];
        return response(rolePermissions[0]);
      }
      if (url === `/api/v1/org/roles/${role.id}/permissions/role-permission-s03/revoke` && method === "PUT") {
        rolePermissions = [];
        return response({ revoked: true });
      }
      if (url === `/api/v1/org/employees/${employee.id}/permissions` && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { permissionKey: string; effect: "ALLOW" | "DENY"; scopeKind: string; expiresAt?: string };
        employeeOverrides = [{ id: "override-s03", ...body, expiresAt: null }];
        return response(employeeOverrides[0]);
      }
      if (url === `/api/v1/org/employees/${employee.id}/permissions/override-s03/revoke` && method === "PUT") {
        employeeOverrides = [];
        return response({ revoked: true });
      }
      return response({}, 404);
    });
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/workspace");

    fireEvent.click(await screen.findByRole("button", { name: "Manage organization" }));
    expect(await screen.findByRole("heading", { name: "Job role permission bundles" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Permission key")).toBeInTheDocument();
    const permissionPicker = screen.getByRole("combobox", { name: "Permission key" });
    expect(within(permissionPicker).getByRole("option", { name: "View managed employees" })).toHaveValue("org.employee.read");
    expect(within(permissionPicker).queryByRole("option", { name: "projects.read" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/org")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Job role"), { target: { value: role.id } });
    fireEvent.change(screen.getByLabelText("Permission key"), { target: { value: "org.employee.read" } });
    fireEvent.change(screen.getByLabelText("Permission scope"), { target: { value: "TEAM" } });
    fireEvent.change(document.getElementById("permission-branch") as HTMLSelectElement, { target: { value: branch.id } });
    fireEvent.change(document.getElementById("permission-team") as HTMLSelectElement, { target: { value: team.id } });
    fireEvent.change(document.getElementById("permission-reason") as HTMLTextAreaElement, { target: { value: "Authorize team reads" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant permission" }));
    const rolePermissionRow = await screen.findByText("org.employee.read");
    expect(fetchMock.mock.calls.some(([url, init]) => url === `/api/v1/org/roles/${role.id}/permissions` && init?.method === "POST" && JSON.parse(String(init.body)).teamId === team.id)).toBe(true);
    fireEvent.click(within(rolePermissionRow.closest("li") as HTMLElement).getByRole("button", { name: "Revoke org.employee.read from Team Leader" }));
    await waitFor(() => expect(rolePermissions).toHaveLength(0));

    const employeeRow = screen.getByText(employee.account.normalizedEmail).closest("li") as HTMLElement;
    fireEvent.click(within(employeeRow).getByRole("button", { name: "Manage access overrides" }));
    fireEvent.change(within(employeeRow).getByLabelText("Permission key"), { target: { value: "review.decide" } });
    fireEvent.change(within(employeeRow).getByLabelText("Reason"), { target: { value: "Temporarily deny review access" } });
    fireEvent.click(within(employeeRow).getByRole("button", { name: "Save override" }));
    const overrideRow = await within(employeeRow).findByText("DENY", { selector: "strong" });
    expect(fetchMock.mock.calls.some(([url, init]) => url === `/api/v1/org/employees/${employee.id}/permissions` && init?.method === "POST" && JSON.parse(String(init.body)).effect === "DENY")).toBe(true);
    fireEvent.click(within(overrideRow.closest("li") as HTMLElement).getByRole("button", { name: "Revoke review.decide override from designer@example.test" }));
    await waitFor(() => expect(employeeOverrides).toHaveLength(0));
  });

  it("refreshes stale role-presentation hints and lets the Owner clear them without changing permissions", async () => {
    const ownerSession = { ...session, ownerSetupRequired: false, activePasskeyCount: 2 };
    const org = { id: "org-role-presentation", name: "Sense Studios" };
    const role = { id: "role-leader", name: "Team Leader", creationPresentation: "LEADER" };
    let rolePresentation: string | null = "LEADER";
    let roleListReads = 0;
    let rejectStaleWrite = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url === "/api/v1/auth/session") return response(ownerSession);
      if (url.startsWith("/api/v1/approvals/attention")) return response({ items: [], nextCursor: null });
      if (url === "/api/v1/auth/sessions") return response([]);
      if (url === "/api/v1/org") return response(org);
      if (url === `/api/v1/org/branches?organizationId=${org.id}`) return response([]);
      if (url === `/api/v1/org/teams?organizationId=${org.id}`) return response([]);
      if (url === `/api/v1/org/roles?organizationId=${org.id}`) { roleListReads += 1; return response([{ ...role, creationPresentation: rolePresentation, permissions: [] }]); }
      if (url === `/api/v1/org/employees?organizationId=${org.id}`) return response([]);
      if (url === `/api/v1/org/roles/${role.id}/creation-presentation` && method === "PUT") {
        if (rejectStaleWrite) { rejectStaleWrite = false; return response({ message: "stale" }, 409); }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        rolePresentation = body.creationPresentation as string | null;
        return response({ creationPresentation: rolePresentation });
      }
      return response({}, 404);
    });
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/workspace");
    fireEvent.click(await screen.findByRole("button", { name: "Manage organization" }));
    const select = await screen.findByLabelText("Team Leader presentation");
    const presentationForm = screen.getByRole("form", { name: "Team Leader task creation presentation" });
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.change(within(presentationForm).getByRole("textbox"), { target: { value: "Remove outdated task presentation" } });
    fireEvent.click(screen.getByRole("button", { name: "Save presentation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/i);
    const refreshReads = roleListReads;
    fireEvent.click(within(screen.getByRole("region", { name: "Branches, teams and employees" })).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(roleListReads).toBeGreaterThan(refreshReads));
    fireEvent.change(screen.getByLabelText("Team Leader presentation"), { target: { value: "" } });
    fireEvent.change(within(presentationForm).getByRole("textbox"), { target: { value: "Remove outdated task presentation" } });
    fireEvent.click(screen.getByRole("button", { name: "Save presentation" }));
    await waitFor(() => expect(rolePresentation).toBeNull());
    const write = fetchMock.mock.calls.find(([url, init]) => url === `/api/v1/org/roles/${role.id}/creation-presentation` && init?.method === "PUT");
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      organizationId: org.id, creationPresentation: null, expectedCreationPresentation: "LEADER", reason: "Remove outdated task presentation"
    });
    await screen.findByText("Task creation presentation saved.");
  });

  it("persists Owner waiting-alert opt-in and timezone changes with reasons and versions", async () => {
    const ownerSession = { ...session, ownerSetupRequired: false, activePasskeyCount: 2 };
    const org = { id: "org-s10e", name: "Sense Studios", timezone: "Asia/Kolkata", settingsVersion: 3 };
    const branch = { id: "branch-s10e", organizationId: org.id, name: "Mumbai" };
    let currentOrg = { ...org };
    let team = { id: "team-s10e", branchId: branch.id, name: "Design", waitingAlertsEnabled: false, settingsVersion: 7 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/v1/auth/session") return response(ownerSession);
      if (url.startsWith("/api/v1/approvals/attention")) return response({ items: [], nextCursor: null });
      if (url === "/api/v1/auth/sessions") return response([]);
      if (url === "/api/v1/org") return response(currentOrg);
      if (url === `/api/v1/org/branches?organizationId=${org.id}`) return response([branch]);
      if (url === `/api/v1/org/teams?organizationId=${org.id}` && method === "GET") return response([team]);
      if (url === `/api/v1/org/roles?organizationId=${org.id}`) return response([]);
      if (url === `/api/v1/org/employees?organizationId=${org.id}`) return response([]);
      if (url === `/api/v1/org/teams/${team.id}/waiting-alerts` && method === "PUT") {
        expect(JSON.parse(String(init?.body))).toEqual({ enabled: true, expectedVersion: 7, reason: "Enable ordinary waiting notices" });
        expect(init?.headers).toMatchObject({ "X-CSRF-Token": session.csrfToken });
        team = { ...team, waitingAlertsEnabled: true, settingsVersion: 8 };
        return response(team);
      }
      if (url === `/api/v1/org/${org.id}/timezone` && method === "PUT") {
        expect(JSON.parse(String(init?.body))).toEqual({ timezone: "America/New_York", expectedVersion: 3, reason: "Use the project office calendar" });
        expect(init?.headers).toMatchObject({ "X-CSRF-Token": session.csrfToken });
        currentOrg = { ...currentOrg, timezone: "America/New_York", settingsVersion: 4 };
        return response(currentOrg);
      }
      return response({}, 404);
    });
    stubFetchWithCrmSetup(fetchMock, response(session));
    renderApp("/workspace");

    fireEvent.click(await screen.findByRole("button", { name: "Manage organization" }));
    expect(await screen.findByRole("heading", { name: "Recurring task timezone" })).toBeInTheDocument();
    const enableAlerts = screen.getByRole("button", { name: "Enable Waiting alerts for Design" });
    expect(enableAlerts).toBeDisabled();
    fireEvent.click(enableAlerts);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/waiting-alerts") && init?.method === "PUT")).toBe(false);
    fireEvent.change(document.getElementById("org-reason-branch") as HTMLTextAreaElement, { target: { value: "Enable ordinary waiting notices" } });
    fireEvent.click(enableAlerts);
    expect(await screen.findByText(/Waiting alerts enabled/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable Waiting alerts for Design" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("IANA timezone"), { target: { value: "America/New_York" } });
    fireEvent.change(document.getElementById("org-reason-branch") as HTMLTextAreaElement, { target: { value: "" } });
    const changeTimezone = screen.getByRole("button", { name: "Change timezone" });
    expect(changeTimezone).toBeDisabled();
    fireEvent.click(changeTimezone);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/timezone") && init?.method === "PUT")).toBe(false);
    fireEvent.change(document.getElementById("org-reason-branch") as HTMLTextAreaElement, { target: { value: "Use the project office calendar" } });
    fireEvent.click(changeTimezone);
    expect(await screen.findByText("Organization settings saved.")).toBeInTheDocument();
    expect(screen.getByLabelText("IANA timezone")).toHaveValue("America/New_York");
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/timezone") && init?.method === "PUT")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === `/api/v1/org/teams?organizationId=${org.id}`)).toHaveLength(3);
  });

  it("shows only server-scoped team reports and sends CSRF on a reporting change", async () => {
    const staffSession = { ...session, account: { ...account, kind: "STAFF" as const } };
    const managedEmployee = {
      id: "managed-employee", employeeCode: "D-12", hiredAt: "2025-01-01", reportsToId: "leader-employee",
      account: { normalizedEmail: "report@example.test" }, jobRoleAssignments: [{ jobRole: { id: "designer-role", name: "Designer" } }]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/auth/session") return response(staffSession);
      if (url.startsWith("/api/v1/approvals/attention")) return response({ items: [], nextCursor: null });
      if (url === "/api/v1/auth/sessions") return response([]);
      if (url === "/api/v1/org/team/employees") return response({ employees: [managedEmployee], capabilities: { canManageReporting: true }, managerOptions: [{ id: "leader-employee", email: "lead@example.test" }, { id: managedEmployee.id, email: "report@example.test" }] });
      if (url === `/api/v1/org/team/employees/${managedEmployee.id}/reporting` && init?.method === "PUT") return response({ changed: true });
      return response({}, 404);
    });
    stubFetchWithCrmSetup(fetchMock, response(staffSession));
    renderApp("/workspace");

    fireEvent.click(await screen.findByRole("button", { name: "Open team workspace" }));
    expect(await screen.findByText("report@example.test", { selector: "strong" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reports to"), { target: { value: "leader-employee" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Confirm reporting line" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reporting line" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === `/api/v1/org/team/employees/${managedEmployee.id}/reporting` && init?.method === "PUT" && init.headers && (init.headers as Record<string, string>)["X-CSRF-Token"] === session.csrfToken && JSON.parse(String(init.body)).reportsToId === "leader-employee")).toBe(true));
    expect(await screen.findByText("Reporting relationship saved.")).toBeInTheDocument();
  });
});
