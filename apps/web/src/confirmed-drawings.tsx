import { useEffect, useState } from "react";

type Entry = { id: string; label: string; kind: "DRAWING" | "FILE" | "LINK"; fileId: string | null; url: string | null; approvedAt: string; signatureName: string };

export function ConfirmedDrawings({ projectId, onSessionExpired }: { projectId: string; onSessionExpired: () => void }): React.JSX.Element {
  const [state, setState] = useState<{ projectId: string; items?: Entry[]; error?: string }>({ projectId });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ projectId });
    void (async () => {
      try {
        const response = await fetch(`/api/v1/reviews/projects/${encodeURIComponent(projectId)}/confirmed-drawings`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onSessionExpired(); return; }
        if (!response.ok) throw new Error("unavailable");
        const body = await response.json() as { items: Entry[] };
        if (!controller.signal.aborted) setState({ projectId, items: body.items });
      } catch {
        if (!controller.signal.aborted) setState({ projectId, error: "Confirmed drawings could not be loaded with your current access." });
      }
    })();
    return () => controller.abort();
  }, [projectId, refresh, onSessionExpired]);
  const current = state.projectId === projectId ? state : { projectId };
  return <section className="project-resource-summary" aria-label="Confirmed drawings"><h4>Confirmed drawings</h4><p>Exact files and links with the Primary Client’s final approval.</p>{current.error ? <><p role="alert">{current.error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>Retry confirmed drawings</button></> : !current.items ? <p role="status">Loading confirmed drawings…</p> : current.items.length === 0 ? <p>No finally approved drawings, files or links yet.</p> : <ul>{current.items.map(item => <li key={item.id}><strong>{item.label}</strong><p>{item.kind === "LINK" ? "Approved link" : item.kind === "DRAWING" ? "Approved drawing" : "Approved file"} · {new Date(item.approvedAt).toLocaleDateString()} · {item.signatureName}</p>{item.kind === "LINK" ? <><a href={item.url!} target="_blank" rel="noopener noreferrer">Open approved link</a><p>External content may change; the approved URL is preserved.</p></> : item.fileId && <a href={`/api/v1/documents/files/${encodeURIComponent(item.fileId)}/stream`}>Open approved file</a>}</li>)}</ul>}</section>;
}
