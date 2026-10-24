import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { TaskComposerFields, taskCreateBody, taskDraftError, type TaskComposerDraft } from "./task-composer-fields.js";
const draft: TaskComposerDraft = { title: "Prepare layout", type: "PROJECT", projectId: "project", priority: "HIGH", targetDate: "2026-10-16", description: "", ownerId: "owner", startDate: "", estimatedHours: "", collaboratorIds: [], collaboratorHours: {}, planItemId: "", tagsText: "", checklistText: "", reason: "Prepare the approved project work", assignTo: true, reviewRequirement: "INTERNAL" };
describe("shared task composer validation and fields", () => {
  it.each([
    { title: "x" }, { targetDate: "2026-99-99" }, { targetDate: "2026-02-30" }, { description: "x".repeat(2001) },
    { startDate: "2026-10-17" }, { estimatedHours: "-1" }, { estimatedHours: "100001" },
    { tagsText: "Same, Same" }, { tagsText: "x".repeat(31) }, { checklistText: "x".repeat(121) },
    { checklistText: Array.from({ length: 11 }, () => "Item").join("\n") }, { reason: "x" }, { projectId: "" },
    { collaboratorIds: ["person"], collaboratorHours: { person: "NaN" } },
  ])("rejects invalid field input without mutating its draft: %j", patch => {
    const value = { ...draft, ...patch }; const before = JSON.stringify(value);
    expect(taskDraftError(value)).toEqual(expect.any(String)); expect(JSON.stringify(value)).toBe(before);
  });
  it("builds one supported payload with independent owner, collaborators, checklist and review requirement", () => {
    const value = { ...draft, collaboratorIds: ["helper"], collaboratorHours: { helper: "1.5" }, tagsText: "Layout", checklistText: "[x] Confirm brief\n[ ] Check dimensions", estimatedHours: "0" };
    expect(taskDraftError(value)).toBeUndefined();
    const body = taskCreateBody(value, { actorEmployeeId: null, project: null, canAssign: true, canCreate: true, owners: [], collaborators: [], readAt: "" });
    expect(body).toMatchObject({ ownerEmployeeId: "owner", collaborators: [{ employeeId: "helper", estimatedHours: 1.5 }], estimatedHours: 0, reviewRequirement: "INTERNAL", checklist: [{ label: "Confirm brief", checked: true }, { label: "Check dimensions", checked: false }] });
    expect(body).not.toHaveProperty("committedDueDate"); expect(body).not.toHaveProperty("status");
  });
  it("clears incompatible participants/planning when the project context changes", () => {
    const onChange = vi.fn();
    render(<TaskComposerFields draft={draft} onChange={onChange} projects={[{ id: "project", title: "Studio", status: "ACTIVE" }]} planItems={[]} options={undefined} optionsError={undefined} retryOptions={() => undefined} compact={false} busy={false} />);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ projectId: "", ownerId: "", collaboratorIds: [], planItemId: "", type: "NON_PROJECT", reviewRequirement: "NONE" }));
  });
  it("uses self ownership when the current context denies assignment despite a previous assignment draft", () => {
    render(<TaskComposerFields draft={draft} onChange={() => undefined} projects={[]} planItems={[]} options={{ actorEmployeeId: "self", project: null, canAssign: false, canCreate: true, owners: [{ id: "self", name: "Self", homeBranchId: "branch" }], collaborators: [], readAt: "" }} optionsError={undefined} retryOptions={() => undefined} compact={false} busy={false} />);
    expect(screen.getByText("Assigned to you.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Primary owner")).not.toBeInTheDocument();
  });
  it("hides optional planning and collaborator sections for compact (non-owner) variants", () => {
    const props = { onChange: () => undefined, projects: [{ id: "project", title: "Studio", status: "ACTIVE" as const }], planItems: [{ id: "stage", projectId: "project", kind: "STAGE", label: "Design" }], options: { actorEmployeeId: null, project: null, canAssign: true, canCreate: true, owners: [{ id: "owner", name: "Owner", homeBranchId: "branch" }], collaborators: [{ id: "helper", name: "Helper", homeBranchId: "branch" }], readAt: "" }, optionsError: undefined, retryOptions: () => undefined, busy: false };
    const view = render(<TaskComposerFields draft={draft} compact={false} {...props} />);
    expect(screen.getByText("Optional planning", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByText(/^Collaborators \(optional\)/, { selector: "summary" })).toBeInTheDocument();
    view.rerender(<TaskComposerFields draft={draft} compact={true} {...props} />);
    expect(screen.queryByText("Optional planning", { selector: "summary" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Collaborators \(optional\)/, { selector: "summary" })).not.toBeInTheDocument();
  });
  it("requires internal approval when client review is selected and normalizes recovered CLIENT drafts", () => {
    const onChange = vi.fn();
    const props = { onChange, projects: [], planItems: [], options: undefined, optionsError: undefined, retryOptions: () => undefined, compact: false, busy: false };
    const view = render(<TaskComposerFields {...props} draft={draft} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Client review required" }));
    expect(onChange).toHaveBeenCalledWith({ reviewRequirement: "BOTH" });
    view.rerender(<TaskComposerFields {...props} draft={{ ...draft, reviewRequirement: "BOTH" }} />);
    expect(screen.getByRole("checkbox", { name: "Internal review required" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Internal review required" })).toBeDisabled();
    expect(taskCreateBody({ ...draft, reviewRequirement: "CLIENT" }, { canAssign: false, actorEmployeeId: "owner" } as never).reviewRequirement).toBe("BOTH");
  });

});
