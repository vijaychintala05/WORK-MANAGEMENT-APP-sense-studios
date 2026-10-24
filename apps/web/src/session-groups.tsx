import type { ReactNode } from "react";

export function SessionGroups<T extends { id: string; expiresAt: string; revokedAt: string | null }>({ sessions, children }: {
  sessions: T[]; children: (session: T) => ReactNode;
}): React.JSX.Element {
  const now = Date.now();
  const active = sessions.filter(item => !item.revokedAt && new Date(item.expiresAt).getTime() > now);
  const history = sessions.filter(item => item.revokedAt || new Date(item.expiresAt).getTime() <= now);
  return <>
    {active.length ? <ul className="session-list">{active.map(children)}</ul> : <p role="status">No active sessions in this list.</p>}
    {history.length > 0 && <details className="session-history"><summary>Session history · {history.length} expired or revoked</summary><p>Previous sign-ins are retained for your account history.</p><ul className="session-list">{history.map(children)}</ul></details>}
  </>;
}
