import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";

vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/auth/session") return new Response(JSON.stringify({ account: { id: "shell-test", email: "owner@example.test", kind: "OWNER" }, csrfToken: "shell-csrf" }), { status: 200 });
    if (path === "/api/v1/notifications/unread") return new Response(JSON.stringify({ unread: 0 }), { status: 200 });
    // Unavailable module reads must not remove the shared navigation/actions.
    return new Response(JSON.stringify({ message: "Unavailable test source" }), { status: 403 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("shared authenticated shell", () => {
  it.each([
    ["/dashboard", "Dashboard"], ["/my-work", "My Work"], ["/tasks", "Tasks"],
    ["/projects", "Projects"], ["/settings", "Settings"], ["/reports", "Reports"],
    ["/learning/library", "Library"],
  ])("keeps one global header and the same entry points on %s", async (path, label) => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    const finder = await screen.findByRole("button", { name: "Find a page" });
    const header = finder.closest(".site-header") as HTMLElement;
    expect(header).not.toBeNull();
    expect(document.querySelectorAll(".workspace-header")).toHaveLength(1);
    expect(header.querySelector(".workspace-header-context")).toHaveTextContent(label);
    expect(within(header).getByRole("link", { name: "New task" })).toHaveAttribute("href", "/tasks?create=1");
    expect(within(header).getAllByRole("link", { name: "Notifications" })).toHaveLength(1);
    expect(within(header).getByRole("link", { name: "Account settings for owner@example.test" })).toHaveAttribute("href", "/settings");
    expect(within(header).getByRole("button", { name: "Log out" })).toBeEnabled();
    expect(await screen.findByRole("navigation", { name: "Workspace navigation" })).toBeInTheDocument();
  });
});
