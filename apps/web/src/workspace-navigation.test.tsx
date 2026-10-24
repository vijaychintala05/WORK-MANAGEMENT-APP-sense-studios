import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { WorkspaceHeader, WorkspaceLayout, workspaceContextLabel } from "./workspace-navigation.js";

let previousWidth = window.innerWidth;

it("keeps destination icons accessible in the collapsed rail", () => {
  render(<MemoryRouter><WorkspaceLayout>Current page</WorkspaceLayout></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
  expect(within(nav).getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
  expect(within(nav).getAllByRole("link", { name: "Dashboard" })).toHaveLength(1);
});

it("opens the native page-finder dialog and navigates from its focused search input", () => {
  render(<MemoryRouter><WorkspaceHeader session={{ account: { email: "owner@example.test", kind: "OWNER" } }} /></MemoryRouter>);
  const trigger = screen.getByRole("button", { name: "Find a page" });
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  const input = screen.getByRole("searchbox", { name: "Search pages" });
  expect(input).toHaveFocus();
  expect(screen.getByRole("dialog", { name: "Page finder" }).tagName).toBe("DIALOG");
  fireEvent.change(input, { target: { value: "Projects" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Projects/ })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.queryByRole("dialog", { name: "Page finder" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(screen.getByRole("link", { name: "New task" })).toHaveAttribute("href", "/tasks?create=1");
});

beforeEach(() => {
  sessionStorage.clear();
  previousWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});

let previousFetch: typeof window.fetch;

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.restoreAllMocks();
  if (previousFetch) window.fetch = previousFetch;
});

/** Mock the unread endpoint so the badge renders without a network round trip. */
function stubUnread(count: number): void {
  previousFetch = window.fetch;
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/notifications/unread")) {
      return new Response(JSON.stringify({ unread: count, critical: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new TypeError("network unavailable");
  }) as typeof window.fetch;
}

function renderWorkspace(path: string): void {
  render(<MemoryRouter initialEntries={[path]}><WorkspaceLayout><main>Current page</main></WorkspaceLayout></MemoryRouter>);
}

describe("workspace navigation", () => {
  it("retains sidebar collapse when moving between route shells", () => {
    renderWorkspace("/tasks");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    cleanup();
    renderWorkspace("/projects");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    cleanup();
    renderWorkspace("/dashboard");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps navigation usable when browser preference storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    renderWorkspace("/tasks");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("provides precise contexts for secondary homes and excludes sign-in/portal pages", () => {
    for (const [path, label] of [["/reports", "Reports"], ["/saved-reports", "Saved reports"], ["/project-health", "Project health"], ["/learning/library", "Library"], ["/settings", "Settings"], ["/tasks", "Tasks"]]) {
      expect(workspaceContextLabel(path!)).toBe(label);
    }
    expect(workspaceContextLabel("/staff/sign-in")).toBeUndefined();
    expect(workspaceContextLabel("/client-portal/login")).toBeUndefined();
  });

  it("applies the studio shell and keeps all mobile destinations accessible", () => {
    renderWorkspace("/my-work");
    expect(screen.getByText("Current page").closest(".workspace-layout")).toHaveClass("workspace-layout--my-work");
    expect(screen.getByText("Current page").closest(".workspace-layout")).toHaveClass("workspace-layout--studio");
    const mobileMain = screen.getByRole("navigation", { name: "Main workspace destinations" });
    /* V10 mobile: fixed 5-tab bottom bar (Home/My Work/Projects/Decisions + More button).
       The More dialog holds every remaining destination. */
    expect(within(mobileMain).getAllByRole("link").map(link => link.textContent)).toEqual(["Home", "My Work", "Projects", "Decisions"]);
    expect(within(mobileMain).getByRole("link", { name: "My Work" })).toHaveAttribute("aria-current", "page");
    expect(mobileMain.querySelectorAll("svg")).toHaveLength(4);
    const more = screen.getByRole("button", { name: "More" });
    expect(more.querySelector("svg")).not.toBeNull();
    fireEvent.click(more);
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "Notifications" })).toHaveAttribute("href", "/notifications");
  });

  it("applies the same studio shell to other routes without applying the personal queue layout", () => {
    renderWorkspace("/tasks");
    expect(screen.getByText("Current page").closest(".workspace-layout")).not.toHaveClass("workspace-layout--my-work");
    expect(screen.getByText("Current page").closest(".workspace-layout")).toHaveClass("workspace-layout--studio");
    expect(screen.getByRole("button", { name: "More" }).querySelector("svg")).not.toBeNull();
  });

  it("keeps the approved destinations available and marks the direct URL active", () => {
    renderWorkspace("/revisions");

    const activeDrawingRegisterLinks = screen.getAllByRole("link", { name: "Drawing register" });
    expect(activeDrawingRegisterLinks.some((link) => link.getAttribute("aria-current") === "page")).toBe(true);
    const destinations = ["Account & settings", "My Work", "Decisions", "Notifications", "Tasks", "Projects", "People", "Project documents", "Drawing register", "Internal reviews", "Client reviews", "Dashboard", "Integrations", "Automation & reports", "Evidence assistance", "Performance", "External access", "Turnkey operations", "Site delivery", "Time", "Workforce", "Learning"];

    const desktopNav = screen.getByRole("navigation", { name: "Workspace navigation" });
    for (const label of ["Work", "People", "Insights", "Manage"]) {
      const disclosure = within(desktopNav).getByRole("button", { name: label });
      expect(disclosure).toBeInTheDocument();
      if (disclosure.getAttribute("aria-expanded") !== "true") fireEvent.click(disclosure);
    }
    const desktopDestinations = destinations.filter(label => label !== "Notifications");
    expect(new Set(within(desktopNav).getAllByRole("link").map(link => String(link.textContent)))).toEqual(new Set(desktopDestinations));
    const mobileMain = screen.getByRole("navigation", { name: "Main workspace destinations" });
    /* V10: mobile bottom bar shows Home/My Work/Projects/Decisions; remaining
       destinations are inside the More dialog. "Home" links to /dashboard. */
    expect(within(mobileMain).getAllByRole("link").map((link) => link.textContent)).toEqual(["Home", "My Work", "Projects", "Decisions"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const moreLinks = within(screen.getByRole("dialog", { name: "More destinations" })).getAllByRole("link");
    const moreLabels = moreLinks.map(link => String(link.textContent));
    const acceptedMore = destinations.filter(label => !["My Work", "Projects", "Decisions"].includes(label));
    expect(new Set(moreLabels)).toEqual(new Set(acceptedMore));
  });

  it("opens More as a labelled dialog, traps keyboard focus, and restores focus on Escape", () => {
    renderWorkspace("/");
    const more = screen.getByRole("button", { name: "More" });
    more.focus();
    fireEvent.click(more);

    const dialog = screen.getByRole("dialog", { name: "More destinations" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = screen.getByRole("button", { name: "Close navigation" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("link", { name: "External access" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it("badges the More button with the unread count and carries it into the dialog", async () => {
    stubUnread(3);
    renderWorkspace("/my-work");
    await waitFor(() => expect(screen.getByRole("button", { name: /3 unread notifications/ })).toHaveTextContent("3"));
    // The badge is presentational, so the More button keeps its exact name until there is a count
    fireEvent.click(screen.getByRole("button", { name: /3 unread notifications/ }));
    const dialog = screen.getByRole("dialog", { name: "More destinations" });
    expect(within(dialog).getByRole("link", { name: "Notifications" })).toHaveTextContent("Notifications3");
  });

  it("caps the badge at 99+ so it cannot push the dialog layout", async () => {
    stubUnread(1000);
    renderWorkspace("/my-work");
    await waitFor(() => expect(screen.getByRole("button", { name: /1000 unread notifications/ })).toHaveTextContent("99+"));
  });

  it("keeps the More button and destinations unchanged when the count is zero or the request fails", async () => {
    stubUnread(0);
    renderWorkspace("/my-work");
    expect(screen.getByRole("button", { name: "More" })).not.toHaveTextContent("0");

    // A failed request must not invent a count — it must fail silent
    vi.restoreAllMocks();
    window.fetch = vi.fn(async () => { throw new TypeError("offline"); }) as typeof window.fetch;
    cleanup();
    renderWorkspace("/tasks");
    await new Promise<void>(resolve => setTimeout(() => { resolve(); }, 20));
    expect(screen.getByRole("button", { name: "More" })).not.toHaveTextContent("0");
    expect(screen.getByRole("navigation", { name: "Main workspace destinations" }).querySelectorAll("a")).toHaveLength(4);
  });
});
