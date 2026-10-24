import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DashboardTaskMix, DashboardProjectOverview, taskStateMix } from "./dashboard-data-visuals.js";

describe("Dashboard source-state presentation", () => {
  it("shows exact source states without inferring priority or a cross-card total", () => {
    expect(taskStateMix([{ status: "IN_PROGRESS" }, { status: "WAITING" }, { status: "IN_PROGRESS" }])).toEqual([
      { label: "In progress", count: 2, tone: "progress" }, { label: "Waiting", count: 1, tone: "waiting" },
    ]);
  });
  it("keeps missing states explicit", () => {
    expect(taskStateMix([{}, { status: "" }])).toEqual([{ label: "Status unavailable", count: 2, tone: "other" }]);
  });
  it("shows an empty source without inventing a distribution", () => {
    render(<DashboardTaskMix rows={[]} />);
    expect(screen.getByText("No matching tasks")).toBeInTheDocument();
    expect(document.querySelectorAll(".dv-task-mix-bar > span")).toHaveLength(0);
  });
  it.each([false, undefined])("does not publish zero from unavailable or missing project evidence (%s)", available => {
    render(<DashboardProjectOverview available={Boolean(available)} rows={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Project summary unavailable");
    expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
  });
  it("counts only readable project rows and supplied finite scores", () => {
    const { rerender } = render(<DashboardProjectOverview available rows={[{ score: 82 }, {}, { score: null }, { score: Number.NaN }]} />);
    expect(screen.getByText("4", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("1 with scored evidence")).toBeInTheDocument();
    rerender(<DashboardProjectOverview available rows={[]} />);
    expect(screen.getByText("0 with scored evidence")).toBeInTheDocument();
  });
});
