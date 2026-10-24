import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { WorkspaceLayout } from "./workspace-navigation.js";
import { ProjectWorkspace } from "./project.js";

type Session = { account: { id: string; email: string; kind: "OWNER" | "STAFF" }; csrfToken: string; ownerSetupRequired?: boolean };

export function ProjectsRoute({ readSession }: { readSession: () => Promise<Session | null> }): React.JSX.Element {
  const [session, setSession] = useState<Session | null>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = (): void => { const token = ++generation; void readSession().then((value) => { if (active && token === generation) { setSession(value); setFailed(false); } }).catch(() => { if (active && token === generation) setFailed(true); }); };
    const onSessionEnded = (): void => { generation += 1; if (active) { setSession(null); setFailed(false); } };
    refresh();
    window.addEventListener("sense-session-ended", onSessionEnded);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; generation += 1; window.removeEventListener("sense-session-ended", onSessionEnded); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [readSession]);
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view projects</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  const initialProjectId = new URLSearchParams(window.location.search).get("projectId") ?? "";
  return <WorkspaceLayout key={session.account.id}><main className="identity-content projects-route"><ProjectWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} listFirst initialProjectId={initialProjectId} /></main></WorkspaceLayout>;
}
