import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

type Timer = { id: string; state: "RUNNING" | "PAUSED"; version: number; elapsedSeconds: number; workNote: string };
type Setup = { employeeId: string | null; projects: Array<{ id: string; name: string }>; tasks: Array<{ id: string; title: string; projectId: string | null }> };
class TimeReadError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(path: string, csrf: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/time${path}`, { method: body ? "POST" : "GET", credentials: "include", cache: "no-store", headers: body ? { "Content-Type": "application/json", "X-CSRF-Token": csrf } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json().catch(() => ({})) as { error?: { message?: string }; message?: string };
  if (!response.ok) throw new TimeReadError(result.error?.message ?? result.message ?? `Time source unavailable (${response.status})`, response.status);
  return result as T;
}
export function DashboardTimeWidget({ csrfToken, refreshVersion = 0 }: { csrfToken: string; refreshVersion?: number }): React.JSX.Element {
  const [setup, setSetup] = useState<Setup | null>(null), [timer, setTimer] = useState<Timer | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const [workNote, setWorkNote] = useState(""), [location, setLocation] = useState("OFFICE"), [billable, setBillable] = useState(true);
  const [projectId, setProjectId] = useState(""), [taskId, setTaskId] = useState("");
  const [activityLabel, setActivityLabel] = useState("");
  const [clock, setClock] = useState(Date.now), [readAt, setReadAt] = useState(0);
  const generation = useRef(0), command = useRef<{ signature: string; id: string } | null>(null), busy = useRef(false);
  const load = useCallback(async () => {
    const current = ++generation.current; setError(""); setLoading(true);
    try {
      const [nextSetup, data] = await Promise.all([request<Setup>("/setup", csrfToken), request<{ timer: Timer | null }>("", csrfToken)]);
      if (current !== generation.current) return;
      setSetup(nextSetup); setTimer(data.timer); setReadAt(Date.now()); setClock(Date.now());
    } catch (cause) {
      if (current !== generation.current) return;
      setSetup(null); setTimer(null); setError(cause instanceof Error ? cause.message : "Time source unavailable");
    } finally { if (current === generation.current) setLoading(false); }
  }, [csrfToken]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load, refreshVersion]);
  useEffect(() => { const tick = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(tick); }, []);
  const mutate = async (path: string, payload: Record<string, unknown>) => {
    if (busy.current) return; busy.current = true; setPending(true); setError("");
    const signature = JSON.stringify({ path, payload });
    if (command.current?.signature !== signature) command.current = { signature, id: crypto.randomUUID() };
    try {
      await request(path, csrfToken, { ...payload, commandId: command.current.id }); command.current = null;
      if (path === "/timers") setWorkNote("");
      await load();
    } catch (cause) {
      // Keep the command identity for a same-input retry after an uncertain response.
      if (cause instanceof TimeReadError && [401, 403].includes(cause.status)) { generation.current++; setSetup(null); setTimer(null); setReadAt(0); setLoading(false); }
      setError(cause instanceof Error ? cause.message : "Timer command not confirmed");
    } finally { busy.current = false; setPending(false); }
  };
  const timerAction = (action: "pause" | "resume" | "stop") => {
    if (!timer || pending) return;
    const reason = action === "stop" ? window.prompt("Reason for stopping this timer")?.trim() : "Timer control";
    if (!reason) return;
    void mutate(`/timers/${encodeURIComponent(timer.id)}/${action}`, { expectedVersion: timer.version, reason });
  };
  const elapsed = timer ? timer.elapsedSeconds + (timer.state === "RUNNING" ? Math.max(0, Math.floor((clock - readAt) / 1000)) : 0) : 0;
  const duration = [Math.floor(elapsed / 3600), Math.floor(elapsed % 3600 / 60), elapsed % 60].map(n => String(n).padStart(2, "0")).join(":");
  return <div className="dv-widget-body dv-time-body">
    {error && <div className="dv-source-error" role="alert"><strong>{error}</strong><button type="button" disabled={pending} onClick={() => void load()}>Refresh timer</button></div>}
    {loading ? <p role="status">Reading time source…</p> : timer ? <div className="dv-time-active">
      <div className="dv-time-value"><div className="dv-time-display" data-state={timer.state === "RUNNING" ? "running" : "idle"}>{duration}</div><span className="dv-time-status"><i aria-hidden="true"></i>{timer.state === "RUNNING" ? "Tracking now" : "Paused"}</span></div>
      {timer.workNote && <p>{timer.workNote}</p>}
      <div className="dv-time-controls"><button type="button" disabled={pending} onClick={() => timerAction(timer.state === "RUNNING" ? "pause" : "resume")}>{timer.state === "RUNNING" ? "Pause" : "Resume"}</button><button type="button" disabled={pending} className="secondary-action" onClick={() => timerAction("stop")}>Stop & save</button></div>
    </div> : setup?.employeeId ? <div className="dv-time-idle">
      <div className="dv-time-display">00:00:00</div>
      <label className="dv-time-field">Project<select value={projectId} disabled={pending} onChange={e => { setProjectId(e.target.value); setTaskId(""); setActivityLabel(""); }}><option value="">Non-project activity</option>{setup.projects?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="dv-time-field">Task · optional<select value={taskId} disabled={pending} onChange={e => setTaskId(e.target.value)}><option value="">No linked task</option>{setup.tasks?.filter(t => (t.projectId ?? "") === projectId).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
      {!projectId && <label className="dv-time-field">Non-project activity<input value={activityLabel} maxLength={160} disabled={pending} onChange={e => setActivityLabel(e.target.value)} placeholder="For example, internal coordination" /></label>}
      <label className="dv-time-field">Work note<input value={workNote} maxLength={1000} disabled={pending} onChange={e => setWorkNote(e.target.value)} placeholder="What are you working on?" /></label>
      <div className="dv-time-options"><label className="dv-time-field">Location<select value={location} disabled={pending} onChange={e => setLocation(e.target.value)}><option value="OFFICE">Office</option><option value="SITE">Site</option><option value="REMOTE">Remote</option></select></label><label className="dv-time-check"><input type="checkbox" checked={billable} disabled={pending} onChange={e => setBillable(e.target.checked)} />Billable</label></div>
      <button type="button" disabled={pending || !workNote.trim() || !projectId && !activityLabel.trim()} onClick={() => void mutate("/timers", { workNote: workNote.trim(), location, billable, ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}), ...(!projectId ? { activityLabel: activityLabel.trim() } : {}) })}>Start timer</button>
    </div> : !error && <p>Your account has no employee record for a personal timer.</p>}
    <div className="dv-widget-foot"><span>{readAt ? `Read at ${new Date(readAt).toLocaleTimeString()}` : "Time source not read"}</span><Link to="/time">Time log & manual entry →</Link></div>
  </div>;
}
