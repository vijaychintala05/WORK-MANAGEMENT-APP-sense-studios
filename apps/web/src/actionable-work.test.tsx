import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MyWorkAttentionResponse, MyWorkRow } from "@sense/contracts";
import { ActionableWork, attentionFilterQuery, validAttentionPage } from "./actionable-work.js";

const task = (id = "task-1"): MyWorkRow => ({ source: "task", sourceId: id, taskId: id, title: id, responsibility: "primary_owner", reason: "due_today", deadline: "2026-10-13T00:00:00.000Z", deadlineKind: "target_date", destination: `/my-work?taskId=${id}` });
const review: MyWorkRow = { source: "review", sourceId: "round-1", roundId: "round-1", taskId: "task-review", title: "Review drawing", responsibility: "assigned_reviewer", reason: "review_decision_required", deadline: "2026-10-12T00:00:00.000Z", deadlineKind: "review_date", destination: "/reviews" };
const decision: MyWorkRow = { source: "approval", sourceId: "request-1", requestId: "request-1", title: "Decision on material", responsibility: "decision", reason: "decision_required", deadline: null, deadlineKind: "decision_expiry", destination: "/decisions" };
function page(items: MyWorkRow[] = [], source: MyWorkAttentionResponse["source"] = "all", totalItems = items.length, offset = 0): MyWorkAttentionResponse {
  return { status: "ready", source, sourceCounts: { task: source === "all" || source === "task" ? { status: "ready", total: totalItems - items.filter(row => row.source !== "task").length } : { status: "excluded" }, review: source === "all" || source === "review" ? { status: "ready", total: source === "review" ? totalItems : items.filter(row => row.source === "review").length } : { status: "excluded" }, approval: source === "all" || source === "approval" ? { status: "ready", total: source === "approval" ? totalItems : items.filter(row => row.source === "approval").length } : { status: "excluded" } }, items, totalItems, offset, limit: 25, hasMore: offset + 25 < totalItems, readAt: "2026-10-13T12:00:00Z", timezone: "Asia/Kolkata" };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); });
function renderWork(props: Partial<React.ComponentProps<typeof ActionableWork>> = {}) {
  const counts = vi.fn(), expired = vi.fn(), open = vi.fn();
  const result = render(<MemoryRouter><ActionableWork accountId="account-a" onActionCounts={counts} onSessionExpired={expired} onOpenTask={open} {...props} /></MemoryRouter>);
  return { ...result, counts, expired, open };
}
describe("Shared-snapshot attention queue", () => {
  it("shows source labels and omits unknown status and priority instead of inventing canonical values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page([review, task(), decision]))));
    renderWork(); await screen.findByRole("button", { name: /task-1/ });
    expect([...document.querySelectorAll(".actionable-work .my-work-status")].map(node => node.textContent)).toEqual(["Assigned reviews", "Tasks", "Decisions"]);
    expect(document.querySelectorAll(".actionable-work .my-work-status-none")).toHaveLength(3);
    expect(document.querySelectorAll(".actionable-work .my-work-priority")).toHaveLength(0);
    for (const control of document.querySelectorAll(".actionable-work__row > button, .actionable-work__row > a")) {
      expect(control.getAttribute("aria-label")).not.toMatch(/SUBMITTED_INTERNAL_REVIEW|PENDING_DECISION|NOT_STARTED|Normal priority/);
    }
    expect(screen.getByRole("link", { name: /Review drawing/ })).toHaveAccessibleName(expect.stringContaining("Review decision required"));
  });
  it("rejects an invalid timezone as unavailable without rendering rows or claiming fresh counts", async () => {
    const invalid = { ...page([task()]), timezone: "Invalid/Not-A-Timezone" };
    expect(validAttentionPage(invalid)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => response(invalid)));
    const { counts } = renderWork();
    expect(await screen.findByRole("alert")).toHaveTextContent("Attention sources are unavailable");
    expect(screen.queryByRole("button", { name: /task-1/ })).not.toBeInTheDocument();
    await waitFor(() => expect(counts).toHaveBeenLastCalledWith(expect.objectContaining({ actionableTasks: { status: "unavailable" } })));
  });
  it("derives overdue annotations from the response clock and organization timezone", async () => {
    const body = { ...page([{ ...task(), reason: "overdue", status: "IN_PROGRESS", priority: "HIGH" }]), readAt: "2026-10-13T23:50:00Z" };
    vi.stubGlobal("fetch", vi.fn(async () => response(body)));
    renderWork(); const control = await screen.findByRole("button", { name: /task-1/ });
    expect(control.closest("li")).toHaveClass("is-overdue", "state-progress");
    expect(control).toHaveTextContent("Task · Overdue");
    expect(control).toHaveAccessibleName(expect.stringContaining("IN PROGRESS · HIGH priority"));
  });
  it("preserves exact status fills with the approved dark-label contrast correction", () => {
    const css = readFileSync(resolve(process.cwd(), "src/actionable-work.css"), "utf8");
    for (const state of ["todo", "progress", "done"]) expect(css).toContain(`.my-work-status-${state} { background: var(--state-${state}); color: #0b100d; }`);
    for (const [state, fill] of [["todo", "#758496"], ["progress", "#2384be"], ["done", "#2b916a"]]) expect(css).toContain(`--state-${state}: ${fill}`);
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    const priorities = [...css.matchAll(/\.actionable-work \.my-work-priority\.pr-(Urgent|High|Normal|Low) \{[^}]*background: (#[a-f0-9]{6}); color: (#[a-f0-9]{6})/g)];
    expect(priorities).toHaveLength(4);
    for (const match of priorities) {
      const background = luminance(match[2]!), foreground = luminance(match[3]!);
      expect((Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("renders one ordered list from one complete response, preserving typed destinations and source counts", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => { void input; return response(page([review, task(), decision])); }); vi.stubGlobal("fetch", fetcher);
    const { counts, open } = renderWork();
    await screen.findByRole("button", { name: /task-1/ });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0]?.[0])).toContain("/api/v1/my-work/attention?");
    expect(document.querySelectorAll(".actionable-work ul")).toHaveLength(1);
    expect([...document.querySelectorAll(".actionable-work li strong")].map(node => node.textContent)).toEqual(["Review drawing", "task-1", "Decision on material"]);
    expect(screen.getByRole("link", { name: /Review drawing/ })).toHaveAttribute("href", "/reviews?taskId=task-review&roundId=round-1");
    expect(screen.getByRole("link", { name: /Decision on material/ })).toHaveAttribute("href", "/decisions?approvalId=request-1");
    fireEvent.click(screen.getByRole("button", { name: /task-1/ })); expect(open).toHaveBeenCalledWith("task-1");
    await waitFor(() => expect(counts).toHaveBeenLastCalledWith({ actionableTasks: { status: "ready", total: 1 }, assignedReviews: { status: "ready", total: 1 }, decisions: { status: "ready", total: 1 } }));
  });
  it("pages the global result only once without local reordering or per-source requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input), "http://test").searchParams.get("offset"));
      return response(page(offset ? [task("task-26")] : Array.from({ length: 25 }, (_, i) => task(`task-${i + 1}`)), "all", 26, offset));
    }));
    renderWork(); await screen.findByRole("button", { name: /^task-1\b/ });
    fireEvent.click(screen.getByRole("button", { name: "Next" })); await screen.findByRole("button", { name: /task-26/ });
    expect(screen.getByText("26–26 of 26 work items")).toBeInTheDocument();
  });
  it("visibly selects Tasks for task-only filters and restores all work after clearing them", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => response(page([], new URL(String(input), "http://test").searchParams.get("source") as "all" | "task"))); vi.stubGlobal("fetch", fetcher);
    const clear = vi.fn(), counts = vi.fn();
    const result = renderWork({ filters: { phase: "active", status: "WAITING", q: "drawing" }, onClearTaskFilters: clear, onActionCounts: counts });
    await screen.findByText("No authorized actions match these filters.");
    expect(screen.getByLabelText("Attention work type")).toHaveValue("task"); expect(screen.getByLabelText("Attention work type")).toBeDisabled();
    await waitFor(() => expect(counts).toHaveBeenLastCalledWith(expect.objectContaining({ assignedReviews: { status: "excluded" }, decisions: { status: "excluded" } })));
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("q=drawing"); expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("phase=active");
    fireEvent.click(screen.getByRole("button", { name: /Clear task-only filters/ })); expect(clear).toHaveBeenCalledOnce();
    result.rerender(<MemoryRouter><ActionableWork accountId="account-a" filters={{ phase: "active", q: "drawing" }} onActionCounts={counts} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText("Attention work type")).toHaveValue("all"));
  });
  it("keeps common search/project filters across work-type selection", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => response(page([], new URL(String(input), "http://test").searchParams.get("source") as "all" | "review"))); vi.stubGlobal("fetch", fetcher);
    renderWork({ filters: { q: "plan", projectId: "project-a" } }); await screen.findByText("No authorized actions match these filters.");
    fireEvent.change(screen.getByLabelText("Attention work type"), { target: { value: "review" } });
    await waitFor(() => expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("source=review"));
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("projectId=project-a"); expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("q=plan");
  });
  it.each(["priorities", "collaboratorEmployeeIds"])("selects Tasks for %s and restores mixed work when cleared", async key => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => response(page([], new URL(String(input), "http://test").searchParams.get("source") as "all" | "task"))); vi.stubGlobal("fetch", fetcher);
    const clear = vi.fn(), counts = vi.fn(); const value = key === "priorities" ? "HIGH" : "11111111-1111-4111-8111-111111111111";
    const result = renderWork({ filters: { phase: "active", q: "drawing", [key]: value }, onClearTaskFilters: clear, onActionCounts: counts });
    await screen.findByText("No authorized actions match these filters.");
    expect(screen.getByLabelText("Attention work type")).toHaveValue("task"); expect(screen.getByLabelText("Attention work type")).toBeDisabled();
    expect(new URL(String(fetcher.mock.calls.at(-1)?.[0]), "http://test").searchParams.get(key)).toBe(value);
    await waitFor(() => expect(counts).toHaveBeenLastCalledWith(expect.objectContaining({ assignedReviews: { status: "excluded" }, decisions: { status: "excluded" } })));
    fireEvent.click(screen.getByRole("button", { name: /Clear task-only filters/ })); expect(clear).toHaveBeenCalledOnce();
    result.rerender(<MemoryRouter><ActionableWork accountId="account-a" filters={{ phase: "active", q: "drawing" }} onActionCounts={counts} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText("Attention work type")).toHaveValue("all"));
  });
  it("retains the same page as visibly stale on failure and disables stale pagination", async () => {
    let fail = false; vi.stubGlobal("fetch", vi.fn(async () => fail ? response({}, 503) : response(page(Array.from({ length: 25 }, (_, i) => task(`task-${i}`)), "all", 26))));
    const { counts } = renderWork(); await screen.findByRole("button", { name: /task-0/ }); fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh attention" })); await screen.findByText(/Refresh failed/);
    expect(screen.getByRole("button", { name: /task-0/ })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await waitFor(() => expect(counts).toHaveBeenLastCalledWith(expect.objectContaining({ actionableTasks: { status: "stale", total: 26 } })));
  });
  it.each([401, 403])("clears old protected rows on authorization loss (%s), rather than retaining them as stale", async status => {
    let fail = false; vi.stubGlobal("fetch", vi.fn(async () => response(fail ? {} : page([task()]), fail ? status : 200)));
    const { expired } = renderWork(); await screen.findByRole("button", { name: /task-1/ }); fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh attention" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /task-1/ })).not.toBeInTheDocument());
    expect(expired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
  it("clears private rows on explicit session loss and ignores a deferred old response", async () => {
    let resolve: ((value: Response) => void) | undefined; let defer = false;
    vi.stubGlobal("fetch", vi.fn(() => defer ? new Promise<Response>(done => { resolve = done; }) : Promise.resolve(response(page([task()])))));
    renderWork(); await screen.findByRole("button", { name: /task-1/ }); defer = true; fireEvent.click(screen.getByRole("button", { name: "Refresh attention" }));
    act(() => window.dispatchEvent(new Event("sense-session-ended")));
    await act(async () => resolve?.(response(page([task("old-secret")]))));
    expect(screen.queryByRole("button", { name: /old-secret|task-1/ })).not.toBeInTheDocument();
  });
  it("does not show an earlier account/query page while new reads are pending", async () => {
    let pending = false; vi.stubGlobal("fetch", vi.fn(() => pending ? new Promise<Response>(() => undefined) : Promise.resolve(response(page([task("private-old")])))));
    const { rerender, counts } = renderWork(); await screen.findByRole("button", { name: /private-old/ }); pending = true;
    rerender(<MemoryRouter><ActionableWork accountId="account-b" onActionCounts={counts} /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: /private-old/ })).not.toBeInTheDocument();
  });
  it("keeps counts available with no hidden source lists when the attention card is unselected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page([task()])))); const { counts } = renderWork({ enabled: false });
    await waitFor(() => expect(counts).toHaveBeenLastCalledWith(expect.objectContaining({ actionableTasks: { status: "ready", total: 1 } })));
    expect(screen.queryByRole("region", { name: "Needs your attention" })).not.toBeInTheDocument();
  });
  it("rejects fabricated totals, duplicate identities and approval rows carrying a fake task id", () => {
    expect(validAttentionPage(page([task(), decision]))).toBe(true);
    expect(validAttentionPage({ ...page([task()]), totalItems: 10 })).toBe(false);
    expect(validAttentionPage(page([task(), task()]))).toBe(false);
    expect(validAttentionPage(page([{ ...decision, taskId: "invented" }]))).toBe(false);
  });
  it("forwards only supported applied filters, preserving the active phase as My Tasks context", () => {
    expect(attentionFilterQuery({ phase: "active", sort: "created_desc", scope: "all", q: "plan", status: "WAITING", dateBasis: "committed", dateFrom: "2026-10-13" }).toString()).toBe("q=plan&status=WAITING&dateFrom=2026-10-13&dateBasis=committed");
  });
});
