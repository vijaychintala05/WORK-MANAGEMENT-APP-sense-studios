// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReviewWorkspace } from "./review.js";

const evidenceCallbacks = vi.hoisted(() => new Map<string, { state: (state: "ready" | "denied") => void; point: (point: { page: number; x: number; y: number }) => void }>());
vi.mock("./review-evidence.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ReviewEvidence: (props: { fileId: string; roundId: string; canAnnotate: boolean; onSelectPoint: (point: { page: number; x: number; y: number }) => void; onEvidenceState: (state: "ready" | "denied") => void }) => {
      evidenceCallbacks.set(props.roundId, { state: props.onEvidenceState, point: props.onSelectPoint });
      return React.createElement("div", { "data-testid": `evidence-${props.roundId}` },
      React.createElement("span", null, props.fileId),
      React.createElement("button", { type: "button", onClick: () => props.onEvidenceState("ready") }, "Mark evidence ready"),
      React.createElement("button", { type: "button", onClick: () => props.onEvidenceState("denied") }, "Deny evidence"),
      props.canAnnotate && React.createElement("button", { type: "button", onClick: () => props.onSelectPoint({ page: 2, x: .25, y: .75 }) }, "Select evidence point"));
    },
  };
});

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function isInboxRequest(url: string): boolean { return new URL(url, "http://localhost").pathname === "/api/v1/reviews/inbox"; }
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { window.history.replaceState(null, "", "/"); evidenceCallbacks.clear(); });

describe("ReviewWorkspace", () => {
  it("loads the inbox, opens a task, and sends a version-bound submission with CSRF", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isInboxRequest(url)) return response({ items: [] });
      if (url.endsWith("/tasks/task-1") && init?.method !== "POST") return response({ task: { id: "task-1", title: "Review plan", status: "IN_PROGRESS", version: 4, reviewRequirement: "REQUIRED", projectId: "project-1" }, assignment: null, rounds: [], categories: [], reviewerCandidates: [], correctionOwnerCandidates: [], availableRevisions: [{ id: "revision-1", label: "R2", state: "WORKING" }], capabilities: { assignReviewer: false, submit: true, start: false, comment: false, decide: false, assignCorrection: false, complete: false, manageCategories: false } });
      if (url.endsWith("/tasks/task-1/submit")) return response({ ok: true });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf-review" /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText("Open linked project task by ID"), { target: { value: "task-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    await screen.findByRole("heading", { name: "Review plan" });
    fireEvent.change(screen.getByLabelText("Exact drawing revision"), { target: { value: "revision-1" } });
    fireEvent.change(screen.getByLabelText("Submission reason"), { target: { value: "Ready for independent review" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit for internal review" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/tasks/task-1/submit") && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/tasks/task-1/submit") && init?.method === "POST");
    expect(call?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-review" });
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ revisionId: "revision-1", expectedVersion: 4, reason: "Ready for independent review" });
  });

  it("shows empty inbox and explicit access denial states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ message: "forbidden" }, 403)));
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf" /></MemoryRouter>);
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access to this review or task.");
    vi.stubGlobal("fetch", vi.fn(async () => response({ total: 0, items: [] })));
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf" /></MemoryRouter>);
    expect(await screen.findByText("No reviews match the waiting queue.")).toBeInTheDocument();
  });

  it("keeps the submitted task snapshot visible after the current task title changes and the detail refreshes", async () => {
    const round = { id: "round-history", roundNumber: 1, status: "APPROVED", submittedAt: "2026-09-30T08:00:00.000Z", submittedByName: "Asha", reviewerName: "Dev", taskVersion: 7, taskSnapshot: { title: "Original submitted title", priority: "HIGH", committedDueDate: "2026-11-15" }, revisionLabel: "R3", revisionFileId: "revision-file-3", comments: [{ id: "comment-one", authorName: "Dev", comment: "See markups", annotations: [], markupFileId: "markup-file-one", createdAt: "2026-09-30T08:10:00.000Z" }, { id: "comment-two", authorName: "Asha", comment: "Additional markup", annotations: [], markupFileId: "markup-file-two", createdAt: "2026-09-30T08:20:00.000Z" }], decision: { kind: "APPROVED" as const, comment: "Reviewed against submitted scope", decidedAt: "2026-09-30T08:30:00.000Z" } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (isInboxRequest(url)) return response({ items: [{ roundId: round.id, taskId: "task-history", taskTitle: "Edited current title", projectId: "project-1", projectTitle: "Studio", roundNumber: 1, status: "APPROVED" }] });
      if (url.endsWith("/tasks/task-history")) return response({ task: { id: "task-history", title: "Edited current title", status: "INTERNAL_APPROVED", version: 9, reviewRequirement: "INTERNAL", projectId: "project-1" }, assignment: null, rounds: [round], categories: [], reviewerCandidates: [], correctionOwnerCandidates: [], availableRevisions: [], capabilities: { assignReviewer: false, submit: false, start: false, comment: false, decide: false, assignCorrection: false, complete: false, manageCategories: false } });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf-review" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Edited current title/ }));
    await screen.findByRole("heading", { name: "Edited current title" });
    const snapshot = screen.getByRole("region", { name: "Round 1 submission snapshot" });
    expect(snapshot).toHaveTextContent("Task version7");
    expect(snapshot).toHaveTextContent("Title at submissionOriginal submitted title");
    expect(snapshot).toHaveTextContent("Priority at submissionHIGH");
    expect(snapshot).toHaveTextContent("Committed date at submission2026-11-15");
    expect(screen.getByRole("link", { name: "Open exact submitted file R3" })).toHaveAttribute("href", "/api/v1/documents/files/revision-file-3/stream");
    const markupLinks = screen.getAllByRole("link", { name: "Download markup file" });
    expect(markupLinks).toHaveLength(2);
    expect(markupLinks.map((link) => link.getAttribute("href"))).toEqual(["/api/v1/documents/files/markup-file-one/stream", "/api/v1/documents/files/markup-file-two/stream"]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/tasks/task-history")).length).toBeGreaterThan(1));
    expect(screen.getByRole("region", { name: "Round 1 submission snapshot" })).toHaveTextContent("Original submitted title");
    expect(screen.getByRole("heading", { name: "Edited current title" })).toBeInTheDocument();
  });

  it("shows authorized task/review controls and immutable withdrawal/escalation history with isolated comment and decision drafts", async () => {
    const rounds = [
      { id: "round-withdrawn", roundNumber: 1, status: "SUBMITTED", submittedAt: "2026-09-30T09:00:00Z", submittedByName: "Asha", reviewerName: "Dev", taskVersion: 4, taskSnapshot: { title: "Plan", priority: "HIGH", committedDueDate: "2026-11-15" }, comments: [], withdrawal: { reason: "Replace incorrect upload", at: "2026-09-30T09:15:00Z", actorId: "employee-1" }, escalations: [] },
      { id: "round-active", roundNumber: 2, status: "IN_REVIEW", submittedAt: "2026-09-30T08:00:00Z", submittedByName: "Asha", reviewerName: "Dev", taskVersion: 3, taskSnapshot: { title: "Plan", priority: "HIGH", committedDueDate: "2026-11-15" }, comments: [], withdrawal: null, escalations: [{ id: "escalation-old", recipientAccountId: "lead@example.test", reason: "Resolve reviewer conflict", createdAt: "2026-09-30T08:20:00Z" }] }
    ];
    const detail = { task: { id: "task-controls", title: "Plan", status: "SUBMITTED_INTERNAL_REVIEW", version: 6, reviewRequirement: "INTERNAL", projectId: "project-controls", priority: "HIGH" as const, committedDueDate: "2026-11-15" }, assignment: null, rounds, categories: [], reviewerCandidates: [], correctionOwnerCandidates: [], availableRevisions: [], availableMarkupFiles: [{ id: "markup-file-1", fileName: "coordination.pdf", mimeType: "application/pdf" }, { id: "markup-file-2", fileName: "markup.png", mimeType: "image/png" }], capabilities: { assignReviewer: false, submit: false, start: false, comment: true, decide: true, assignCorrection: false, complete: false, manageCategories: false, escalate: true, withdraw: true, changePriority: true, changeDeadline: true } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (isInboxRequest(url)) return response({ items: [] });
      if (url.endsWith("/tasks/task-controls")) return response(detail);
      if (url.includes("/escalate") || url.includes("/withdraw") || url.includes("/priority") || url.includes("/deadline")) return response(detail);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf-review" /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText("Open linked project task by ID"), { target: { value: "task-controls" } });
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    await screen.findByRole("heading", { name: "Plan" });
    expect(screen.getByText(/Resolve reviewer conflict/)).toBeInTheDocument();
    expect(screen.getByText(/Replace incorrect upload/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upload markup in the project document register" })).toHaveAttribute("href", "/documents?projectId=project-controls");
    expect(screen.getByLabelText("Uploaded markup file")).toHaveValue("");
    expect(screen.getByLabelText("Uploaded markup file").querySelectorAll("option")).toHaveLength(3);
    expect(screen.queryByLabelText("Uploaded markup file ID")).not.toBeInTheDocument();
    const taskControls = screen.getByRole("heading", { name: "Task controls" }).closest("section")!;
    expect(taskControls).toHaveTextContent("Task priority: HIGH");
    expect(taskControls).toHaveTextContent("Committed date: 2026-11-15");

    const commentForm = screen.getByRole("heading", { name: "Add comment or markup" }).closest("form")!;
    const decisionForm = screen.getByRole("heading", { name: "Record decision" }).closest("form")!;
    fireEvent.change(within(commentForm).getByLabelText("Comment"), { target: { value: "Comment draft only" } });
    fireEvent.change(within(commentForm).getByLabelText("Annotation text"), { target: { value: "Comment annotation" } });
    fireEvent.change(within(commentForm).getByLabelText("Uploaded markup file"), { target: { value: "markup-file-1" } });
    fireEvent.change(within(decisionForm).getByLabelText("Decision"), { target: { value: "CORRECTIONS_REQUIRED" } });
    fireEvent.change(within(decisionForm).getByLabelText("Decision comment"), { target: { value: "Decision draft only" } });
    fireEvent.change(within(decisionForm).getByLabelText("Annotation text"), { target: { value: "Decision annotation" } });
    fireEvent.change(within(decisionForm).getByLabelText("Uploaded markup file"), { target: { value: "markup-file-2" } });
    expect(within(commentForm).getByLabelText("Comment")).toHaveValue("Comment draft only");
    expect(within(decisionForm).getByLabelText("Decision comment")).toHaveValue("Decision draft only");
    expect(within(commentForm).getByLabelText("Annotation text")).toHaveValue("Comment annotation");
    expect(within(decisionForm).getByLabelText("Annotation text")).toHaveValue("Decision annotation");

    const historicalRound = document.querySelector<HTMLLIElement>("#review-round-round-withdrawn")!;
    expect(within(historicalRound).queryByRole("heading", { name: "Escalate review" })).not.toBeInTheDocument();
    expect(within(historicalRound).queryByRole("heading", { name: "Withdraw submission" })).not.toBeInTheDocument();
    const activeRound = document.querySelector<HTMLLIElement>("#review-round-round-active")!;
    const escalationForm = within(activeRound).getByRole("heading", { name: "Escalate review" }).closest("form")!;
    fireEvent.change(within(escalationForm).getByLabelText("Escalation reason"), { target: { value: "Need independent lead intervention" } });
    fireEvent.click(within(escalationForm).getByRole("button", { name: "Record escalation" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/rounds/round-active/escalate"))).toBe(true));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/rounds/round-active/escalate"))?.[1]?.body))).toEqual({ reason: "Need independent lead intervention" });

    const withdrawalForm = within(activeRound).getByRole("heading", { name: "Withdraw submission" }).closest("form")!;
    fireEvent.change(within(withdrawalForm).getByLabelText("Withdrawal reason"), { target: { value: "Correct the submitted file selection" } });
    fireEvent.click(within(withdrawalForm).getByRole("button", { name: "Withdraw submission" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/rounds/round-active/withdraw"))).toBe(true));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/rounds/round-active/withdraw"))?.[1]?.body))).toEqual({ reason: "Correct the submitted file selection" });

    const priorityForm = screen.getByRole("heading", { name: "Task controls" }).closest("section")!.querySelector("form")!;
    fireEvent.change(within(priorityForm).getByLabelText("New priority"), { target: { value: "CRITICAL" } });
    fireEvent.change(within(priorityForm).getByLabelText("Priority change reason"), { target: { value: "Client risk requires immediate priority" } });
    fireEvent.click(within(priorityForm).getByRole("button", { name: "Change priority" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/rounds/round-active/priority"))).toBe(true));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/rounds/round-active/priority"))?.[1]?.body))).toMatchObject({ priority: "CRITICAL", expectedVersion: 6, reason: "Client risk requires immediate priority" });

    const deadlineForm = screen.getByRole("heading", { name: "Task controls" }).closest("section")!.querySelectorAll("form")[1]!;
    fireEvent.change(within(deadlineForm).getByLabelText("New committed date"), { target: { value: "2026-12-01" } });
    fireEvent.change(within(deadlineForm).getByLabelText("Committed date change reason"), { target: { value: "Approved client commitment moved" } });
    fireEvent.click(within(deadlineForm).getByRole("button", { name: "Change committed date" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/rounds/round-active/deadline"))).toBe(true));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/rounds/round-active/deadline"))?.[1]?.body))).toMatchObject({ committedDueDate: "2026-12-01", expectedVersion: 6, reason: "Approved client commitment moved" });
  });

  it("reloads the selected task when switching inbox history and keeps the exact round selection", async () => {
    const round = (id: string, roundNumber: number) => ({ id, roundNumber, status: "APPROVED", submittedAt: "2026-10-01T08:00:00Z", submittedByName: "Asha", reviewerName: "Dev", taskVersion: roundNumber, taskSnapshot: { title: `Snapshot ${roundNumber}`, priority: "HIGH", committedDueDate: null }, comments: [], withdrawal: null, escalations: [] });
    const detail = { task: { id: "task-history-switch", title: "History task", status: "INTERNAL_APPROVED", version: 3, reviewRequirement: "INTERNAL", projectId: "project-1", priority: "HIGH", committedDueDate: null }, assignment: null, rounds: [round("round-one", 1), round("round-two", 2)], categories: [], reviewerCandidates: [], correctionOwnerCandidates: [], availableRevisions: [], availableMarkupFiles: [], capabilities: { assignReviewer: false, submit: false, start: false, comment: false, decide: false, assignCorrection: false, complete: false, manageCategories: false } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/reviews/inbox")) return response({ items: [{ roundId: "round-two", taskId: "task-history-switch", taskTitle: "History task", projectId: "project-1", projectTitle: "Studio", roundNumber: 2, status: "APPROVED" }] });
      if (url.endsWith("/tasks/task-history-switch")) return response(detail);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf" /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText("Open linked project task by ID"), { target: { value: "task-history-switch" } });
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    await screen.findByRole("heading", { name: "History task" });
    fireEvent.click(screen.getByRole("button", { name: /History task.*Round 2/ }));
    await waitFor(() => expect(document.querySelector("#review-round-round-two")).toHaveAttribute("aria-current", "true"));
    fireEvent.change(screen.getByLabelText("Review queue"), { target: { value: "history" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/inbox?historical=true"))).toBe(true));
    expect(screen.getByLabelText("Open linked project task by ID")).toHaveValue("task-history-switch");
    expect(document.querySelector("#review-round-round-two")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /History task.*Round 2/ })).toHaveAttribute("aria-current", "true");
  });

  it("requires ready evidence, carries the selected point into the comment, and keeps actions bound to the selected exact round", async () => {
    const rounds = [1, 2].map((number) => ({ id: `round-${number}`, roundNumber: number, status: "IN_REVIEW", submittedAt: "2026-10-01T08:00:00Z", submittedByName: "Asha", reviewerName: "Dev", taskVersion: number, taskSnapshot: { title: "Plan", priority: "HIGH", committedDueDate: null }, revisionFileId: `file-${number}`, revisionFileMimeType: "application/pdf", revisionFileName: `plan-${number}.pdf`, revisionLabel: `R${number}`, comments: [], withdrawal: null, escalations: [] }));
    const detail = { task: { id: "task-evidence", title: "Plan", status: "IN_REVIEW", version: 3, reviewRequirement: "INTERNAL", projectId: "project-1", priority: "HIGH", committedDueDate: null }, assignment: null, rounds, categories: [], reviewerCandidates: [], correctionOwnerCandidates: [], availableRevisions: [], availableMarkupFiles: [], capabilities: { assignReviewer: false, submit: false, start: false, comment: true, decide: true, assignCorrection: false, complete: false, manageCategories: false } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isInboxRequest(url)) return response({ items: rounds.map((item) => ({ roundId: item.id, taskId: "task-evidence", taskTitle: "Plan", projectId: "project-1", projectTitle: "Studio", roundNumber: item.roundNumber, status: item.status })) });
      if (url.endsWith("/tasks/task-evidence") && init?.method !== "POST") return response(detail);
      if (url.endsWith("/comment") || url.endsWith("/decision")) return response({ ok: true });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Plan.*Round 2/ }));
    await screen.findByRole("heading", { name: "Plan" });
    const latest = document.querySelector<HTMLLIElement>("#review-round-round-2")!;
    expect(latest).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Historical round · read only. Feedback remains attached to its exact round.")).toBeInTheDocument();
    fireEvent.click(within(latest).getByRole("button", { name: "Inspect exact round 2 evidence" }));
    const decisionForm = within(latest).getByRole("heading", { name: "Record decision" }).closest("form")!;
    const commentForm = within(latest).getByRole("heading", { name: "Add comment or markup" }).closest("form")!;
    fireEvent.change(within(decisionForm).getByLabelText("Decision comment"), { target: { value: "Looks good" } });
    fireEvent.change(within(decisionForm).getByLabelText("Decision reason"), { target: { value: "Checked exact revision" } });
    expect(within(decisionForm).getByRole("button", { name: "Save decision" })).toBeDisabled();
    fireEvent.click(within(latest).getByRole("button", { name: "Mark evidence ready" }));
    expect(within(decisionForm).getByRole("button", { name: "Save decision" })).toBeEnabled();
    fireEvent.change(within(commentForm).getByLabelText("Page"), { target: { value: "99" } });
    fireEvent.change(within(commentForm).getByLabelText("X"), { target: { value: ".25" } });
    fireEvent.change(within(commentForm).getByLabelText("Y"), { target: { value: ".75" } });
    fireEvent.change(within(commentForm).getByLabelText("Annotation text"), { target: { value: "Manually supplied point" } });
    fireEvent.change(within(commentForm).getByLabelText("Comment"), { target: { value: "Please revise this point" } });
    fireEvent.change(within(commentForm).getByLabelText("Reason"), { target: { value: "Exact location needs correction" } });
    expect(within(commentForm).getByRole("button", { name: "Add comment" })).toBeDisabled();
    fireEvent.click(within(latest).getByRole("button", { name: "Select evidence point" }));
    expect(within(commentForm).getByLabelText("Page")).toHaveValue(2);
    expect(within(commentForm).getByLabelText("X")).toHaveValue(.25);
    expect(within(commentForm).getByLabelText("Y")).toHaveValue(.75);
    fireEvent.change(within(commentForm).getByLabelText("Annotation text"), { target: { value: "Check dimension" } });
    fireEvent.click(within(commentForm).getByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/rounds/round-2/comment"))).toBe(true));
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/rounds/round-2/comment"));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ comment: "Please revise this point", annotations: [{ page: 2, x: .25, y: .75, text: "Check dimension" }], reason: "Exact location needs correction" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/rounds/round-1/comment"))).toBe(false);
  });

  it("clears protected review data after a denied detail load and refreshes current context after a conflict", async () => {
    const detail = { task: { id: "task-conflict", title: "Conflict task", status: "IN_REVIEW", version: 3, reviewRequirement: "INTERNAL", projectId: "project-1", priority: "HIGH", committedDueDate: null }, assignment: null, rounds: [{ id: "round-conflict", roundNumber: 1, status: "IN_REVIEW", submittedAt: "2026-10-01T08:00:00Z", submittedByName: "Asha", reviewerName: "Dev", taskVersion: 2, taskSnapshot: { title: "Conflict task", priority: "HIGH", committedDueDate: null }, comments: [], withdrawal: null, escalations: [] }], categories: [], reviewerCandidates: [], correctionOwnerCandidates: [], availableRevisions: [], availableMarkupFiles: [], capabilities: { assignReviewer: false, submit: false, start: false, comment: true, decide: false, assignCorrection: false, complete: false, manageCategories: false, escalate: false, withdraw: false, changePriority: false, changeDeadline: false } };
    let deny = false; let conflict = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isInboxRequest(url)) return response({ items: [{ roundId: "round-conflict", taskId: "task-conflict", taskTitle: "Conflict task", projectId: "project-1", projectTitle: "Studio", roundNumber: 1, status: "IN_REVIEW" }] });
      if (url.endsWith("/tasks/task-conflict") && init?.method !== "POST") return deny ? response({}, 403) : response(detail);
      if (url.endsWith("/comment")) return conflict ? response({}, 409) : response({ ok: true });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Conflict task/ }));
    await screen.findByRole("heading", { name: "Conflict task" });
    const form = screen.getByRole("heading", { name: "Add comment or markup" }).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Comment"), { target: { value: "A note" } });
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Review note" } });
    conflict = true;
    fireEvent.click(within(form).getByRole("button", { name: "Add comment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The review changed elsewhere. Latest details were refreshed.");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/tasks/task-conflict")).length).toBeGreaterThan(1);
    deny = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("You do not have access to this review or task.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Conflict task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add comment or markup" })).not.toBeInTheDocument();
  });

  it("ignores stale evidence callbacks and clears the workspace when the currently inspected file is denied", async () => {
    const rounds = [1, 2].map((number) => ({ id: `round-stale-${number}`, roundNumber: number, status: "IN_REVIEW", submittedAt: "2026-10-01T08:00:00Z", submittedByName: "Asha", reviewerName: "Dev", taskVersion: number, taskSnapshot: { title: "Stale context", priority: "HIGH", committedDueDate: null }, revisionFileId: `file-stale-${number}`, comments: [], withdrawal: null, escalations: [] }));
    const detail = { task: { id: "task-stale", title: "Stale context", status: "IN_REVIEW", version: 3, reviewRequirement: "INTERNAL", projectId: "project-1", priority: "HIGH", committedDueDate: null }, assignment: null, rounds, categories: [], reviewerCandidates: [], correctionOwnerCandidates: [], availableRevisions: [], availableMarkupFiles: [], capabilities: { assignReviewer: false, submit: false, start: false, comment: true, decide: false, assignCorrection: false, complete: false, manageCategories: false } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isInboxRequest(url)) return response({ items: rounds.map((item) => ({ roundId: item.id, taskId: "task-stale", taskTitle: "Stale context", projectId: "project-1", projectTitle: "Studio", roundNumber: item.roundNumber, status: item.status })) });
      if (url.endsWith("/tasks/task-stale") && init?.method !== "POST") return response(detail);
      return response({});
    }));
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Stale context.*Round 1/ }));
    await screen.findByRole("heading", { name: "Stale context" });
    fireEvent.click(within(document.querySelector<HTMLLIElement>("#review-round-round-stale-1")!).getByRole("button", { name: "Inspect exact round 1 evidence" }));
    const staleCallback = evidenceCallbacks.get("round-stale-1")!;
    fireEvent.click(screen.getByRole("button", { name: /Stale context.*Round 2/ }));
    await waitFor(() => expect(document.querySelector("#review-round-round-stale-2")).toHaveAttribute("aria-current", "true"));
    fireEvent.click(within(document.querySelector<HTMLLIElement>("#review-round-round-stale-2")!).getByRole("button", { name: "Inspect exact round 2 evidence" }));
    staleCallback.state("denied");
    expect(screen.getByRole("heading", { name: "Stale context" })).toBeInTheDocument();
    expect(screen.getByTestId("evidence-round-stale-2")).toBeInTheDocument();
    fireEvent.click(within(document.querySelector<HTMLLIElement>("#review-round-round-stale-2")!).getByRole("button", { name: "Deny evidence" }));
    expect(await screen.findByText("You do not have access to this review or task.")).toBeInTheDocument();
    expect(screen.queryByTestId("evidence-round-stale-2")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Stale context" })).not.toBeInTheDocument();
  });

  it("does not let an older successful detail response restore data after a newer request is denied", async () => {
    const detail = { task: { id: "task-race", title: "Race task", status: "IN_REVIEW", version: 2, reviewRequirement: "INTERNAL", projectId: "project-1", priority: "HIGH", committedDueDate: null }, assignment: null, rounds: [{ id: "round-race", roundNumber: 1, status: "IN_REVIEW", submittedAt: "2026-10-01T08:00:00Z", submittedByName: "Asha", reviewerName: "Dev", taskVersion: 1, taskSnapshot: { title: "Race task", priority: "HIGH", committedDueDate: null }, comments: [], withdrawal: null, escalations: [] }], categories: [], reviewerCandidates: [], correctionOwnerCandidates: [], availableRevisions: [], availableMarkupFiles: [], capabilities: { assignReviewer: false, submit: false, start: false, comment: false, decide: false, assignCorrection: false, complete: false, manageCategories: false } };
    let detailRequests = 0;
    let resolveOlder!: (value: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/reviews/inbox")) return response({ items: [{ roundId: "round-race", taskId: "task-race", taskTitle: "Race task", projectId: "project-1", projectTitle: "Studio", roundNumber: 1, status: "IN_REVIEW" }] });
      if (url.endsWith("/tasks/task-race")) {
        detailRequests += 1;
        if (detailRequests === 2) return olderResponse;
        if (detailRequests === 3) return response({}, 401);
        return response(detail);
      }
      return response({});
    }));
    render(<MemoryRouter><ReviewWorkspace csrfToken="csrf" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Race task/ }));
    await screen.findByRole("heading", { name: "Race task" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(detailRequests).toBe(2));
    window.history.pushState(null, "", "/reviews?taskId=task-race&roundId=round-race&queue=history&historical=true");
    fireEvent.popState(window);
    await waitFor(() => expect(detailRequests).toBe(3));
    expect(await screen.findByText("You do not have access to this review or task.")).toBeInTheDocument();
    resolveOlder(response(detail));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Race task" })).not.toBeInTheDocument());
    expect(screen.queryByText("No review history is available in this list.")).not.toBeInTheDocument();
  });
});
