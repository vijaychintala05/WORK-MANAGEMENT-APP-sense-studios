import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export type DashboardPerformanceContext = { owner: boolean; employeeId: string | null; employees: Array<{ id: string; label: string; teamId: string | null; canManage: boolean }>; policies: unknown[] };
type Snapshot = { id: string; data: { from: string; to: string; score: number | null; status: string; family: string; policyId?: string; components?: Array<{ metric: string; label?: string; normalized: number | null }> } };
type EmployeeView = { employee: { id: string; label: string }; snapshots: Snapshot[]; teamAverage: number | null; relativeToAverage: number | null };
export function DashboardPerformanceWidget({ context, csrfToken, owner }: { context: DashboardPerformanceContext; csrfToken: string; owner: boolean }): React.JSX.Element {
  const isOwner = owner && context.owner;
  const employees = context.employees.filter(e => isOwner || e.canManage);
  const [mode, setMode] = useState<"teams" | "employees">(isOwner ? "teams" : "employees");
  const [employeeId, setEmployeeId] = useState(() => employees[0]?.id ?? "");
  const [metric, setMetric] = useState("overall"), [data, setData] = useState<EmployeeView | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0);
  const requestId = useRef(0);
  const selectedId = employees.some(e => e.id === employeeId) ? employeeId : "";
  useEffect(() => {
    const current = ++requestId.current; setData(null); setError("");
    if (!selectedId) { setLoading(false); return; }
    setLoading(true);
    void fetch(`/api/v1/performance/employees/${encodeURIComponent(selectedId)}`, { credentials: "include", cache: "no-store", headers: { "X-CSRF-Token": csrfToken } })
      .then(async response => { if (!response.ok) throw new Error(`Performance source unavailable (${response.status})`); return response.json() as Promise<EmployeeView>; })
      .then(next => { if (current === requestId.current && next.employee.id === selectedId) setData(next); })
      .catch(cause => { if (current === requestId.current) setError(cause instanceof Error ? cause.message : "Performance source unavailable"); })
      .finally(() => { if (current === requestId.current) setLoading(false); });
    return () => { requestId.current++; };
  }, [selectedId, csrfToken, refresh]);
  const current = data?.employee.id === selectedId ? data : null;
  const snapshot = current?.snapshots.find(s => s.data.family === "EMPLOYEE" && s.data.status === "SCORED" && typeof s.data.score === "number" && Number.isFinite(s.data.score));
  const component = snapshot?.data.components?.find(c => c.metric === metric);
  const score = mode === "teams" ? metric === "overall" ? current?.teamAverage : null : metric === "overall" ? snapshot?.data.score : component?.normalized;
  const finite = typeof score === "number" && Number.isFinite(score);
  return <div className="dv-widget-body dv-perf-body">
    {isOwner && <div className="dv-performance-tabs" aria-label="Performance view"><button type="button" aria-pressed={mode === "teams"} onClick={() => { setMode("teams"); setMetric("overall"); }}>Teams</button><button type="button" aria-pressed={mode === "employees"} onClick={() => { setMode("employees"); setMetric("overall"); }}>Employees</button></div>}
    <label className="dv-performance-select">{mode === "teams" ? "Team cohort for employee" : "Employee"}<select value={selectedId} onChange={event => { setData(null); setEmployeeId(event.target.value); setMetric("overall"); }}><option value="">Choose an authorized employee</option>{employees.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
    {snapshot && <label className="dv-performance-select">Compare by<select value={metric} onChange={e => setMetric(e.target.value)}><option value="overall">Overall score</option>{snapshot.data.components?.map(c => <option key={c.metric} value={c.metric}>{c.label ?? c.metric.replace(/_/g, " ")}</option>)}</select></label>}
    {loading ? <p role="status">Reading performance source…</p> : error ? <div className="dv-source-error" role="alert"><strong>{error}</strong><button type="button" onClick={() => setRefresh(value => value + 1)}>Retry performance</button></div> : !selectedId ? <p>No employee selected from your authorized management scope.</p> : !snapshot ? <p>No scored performance snapshot is available for this employee. {context.policies.length ? "Generate a period through the performance workspace." : "A scoring policy must be configured first."}</p> : <>
      <div className="dv-perf-score">
        {finite ? <div className="dv-perf-dial" role="img" aria-label={`${mode === "teams" ? "Team average" : "Score"} ${score} out of 100`} style={{ "--score-pct": `${Math.min(100, Math.max(0, score))}%` } as React.CSSProperties}><div className="dv-perf-dial-core"><strong>{Math.round(score)}</strong><span>/ 100</span></div></div> : <p className="dv-perf-unavailable">{mode === "teams" ? "No comparable team score is supplied for this selection." : "This metric is unavailable."}</p>}
        <div className="dv-perf-meta"><strong>{current?.employee.label}</strong><div>{snapshot.data.from} → {snapshot.data.to}</div><small>Policy {snapshot.data.policyId ?? "unavailable"}</small>
          {mode === "employees" && isOwner && current?.teamAverage !== null && <p>Team average <strong>{current?.teamAverage}</strong>{current?.relativeToAverage !== null && <span> · {current!.relativeToAverage! >= 0 ? "+" : ""}{current?.relativeToAverage} vs team</span>}</p>}
        </div>
      </div>
      {mode === "teams" && <p className="dv-perf-explanation">Average of comparable employee scores in this team for the same policy and period. Detailed team metrics are unavailable.</p>}
      {mode === "employees" && snapshot.data.components?.map((c, index) => <div className="dv-performance-component" key={c.metric}>
        <div className="dv-perf-component-head"><span>{c.label ?? c.metric.replace(/_/g, " ")}</span><strong>{c.normalized === null ? "—" : c.normalized}</strong></div>
        {c.normalized !== null && <div className="dv-perf-track" role="img" aria-label={`${c.label ?? c.metric.replace(/_/g, " ")}: ${c.normalized} out of 100`}><i style={{ width: `${Math.min(100, Math.max(0, c.normalized))}%` }} data-tint={index + 1} /></div>}
      </div>)}
    </>}
    <div className="dv-perf-foot"><Link to="/performance">Open performance workspace →</Link><span>Authorized persisted evidence</span></div>
  </div>;
}
