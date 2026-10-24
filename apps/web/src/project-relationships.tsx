import { useEffect, useRef, useState } from "react";

type Client = { id: string; name: string };
type Lead = { id: string; title: string };
type Read = { branchId: string; clients: Client[]; leads: Lead[]; total: number; clientError: string; leadError: string; loading: boolean };

/** Existing CRM reads remain the authority; no raw identifier entry or new grant. */
export function ProjectRelationships({ branchId, clientId, wonLeadId, onClient, onLead, disabled }: {
  branchId: string; clientId: string; wonLeadId: string; onClient: (id: string) => void; onLead: (id: string) => void; disabled: boolean;
}): React.JSX.Element {
  const [read, setRead] = useState<Read>();
  const [revision, setRevision] = useState(0);
  const [clientSearch, setClientSearch] = useState("");
  const [leadSearch, setLeadSearch] = useState("");
  const [moreBusy, setMoreBusy] = useState(false);
  const generation = useRef(0);
  const previousBranch = useRef(branchId);
  useEffect(() => {
    if (previousBranch.current !== branchId) { onClient(""); onLead(""); setClientSearch(""); setLeadSearch(""); previousBranch.current = branchId; }
  }, [branchId, onClient, onLead]);
  useEffect(() => {
    const current = ++generation.current;
    setMoreBusy(false);
    if (!branchId) { setRead(undefined); return; }
    let live = true;
    setRead({ branchId, clients: [], leads: [], total: 0, clientError: "", leadError: "", loading: true });
    const get = async <T,>(path: string): Promise<T> => {
      const response = await fetch(path, { credentials: "include", cache: "no-store" });
      if (response.status === 401 && live) window.dispatchEvent(new Event("sense-session-ended"));
      if (!response.ok) throw new Error(response.status === 403 ? "This account cannot read these CRM choices." : "Choices could not be loaded. Try again.");
      const result = await response.json() as { items?: unknown; total?: unknown };
      if (!Array.isArray(result.items) || !result.items.every(item => item && typeof item === "object" && typeof item.id === "string" && typeof (path.includes("/clients?") ? item.name : item.title) === "string") || (path.includes("/leads?") && (typeof result.total !== "number" || !Number.isFinite(result.total) || result.total < 0))) throw new Error("Choices could not be loaded. Try again.");
      return result as T;
    };
    void Promise.allSettled([
      get<{ items: Client[] }>(`/api/v1/crm/clients?branchId=${encodeURIComponent(branchId)}`),
      get<{ items: Lead[]; total: number }>(`/api/v1/crm/leads?branchId=${encodeURIComponent(branchId)}&stage=WON&offset=0&limit=100`)
    ]).then(([clients, leads]) => {
      if (!live || generation.current !== current) return;
      setRead({ branchId, clients: clients.status === "fulfilled" ? clients.value.items : [], leads: leads.status === "fulfilled" ? leads.value.items : [], total: leads.status === "fulfilled" ? leads.value.total : 0,
        clientError: clients.status === "rejected" ? String(clients.reason instanceof Error ? clients.reason.message : "Client choices unavailable.") : "",
        leadError: leads.status === "rejected" ? String(leads.reason instanceof Error ? leads.reason.message : "Lead choices unavailable.") : "", loading: false });
    });
    return () => { live = false; generation.current++; };
  }, [branchId, revision]);
  const current = read?.branchId === branchId ? read : undefined;
  const more = async (): Promise<void> => {
    if (!current || moreBusy || current.leads.length >= current.total) return;
    const request = generation.current;
    setMoreBusy(true);
    try {
      const response = await fetch(`/api/v1/crm/leads?branchId=${encodeURIComponent(branchId)}&stage=WON&offset=${current.leads.length}&limit=100`, { credentials: "include", cache: "no-store" });
      if (response.status === 401 && request === generation.current) window.dispatchEvent(new Event("sense-session-ended"));
      if (!response.ok) throw new Error("More won leads could not be loaded.");
      const result = await response.json() as { items: Lead[]; total: number };
      if (!Array.isArray(result.items) || !result.items.every(item => item && typeof item === "object" && typeof item.id === "string" && typeof item.title === "string") || !Number.isFinite(result.total) || result.total < 0) throw new Error("Invalid choices");
      if (request === generation.current) setRead(value => value?.branchId === branchId ? { ...value, leads: [...value.leads, ...result.items], total: result.total, leadError: "" } : value);
    } catch { if (request === generation.current) setRead(value => value ? { ...value, leadError: "More won leads could not be loaded. Try again." } : value); }
    finally { if (request === generation.current) setMoreBusy(false); }
  };
  return <section className="project-relationships" aria-label="Client and lead links">
    <p>Link an existing client or won lead, or leave both blank for a direct project.</p>
    {!branchId ? <p>Choose a project branch to find clients and won leads.</p> : !current || current.loading ? <p role="status">Loading client and lead choices…</p> : <>
      <label className="relationship-search">Search clients<input type="search" value={clientSearch} onChange={event => setClientSearch(event.target.value)} disabled={disabled} /></label>
      <label>Client (optional)<select aria-label="Client" value={clientId} onChange={event => onClient(event.target.value)} disabled={disabled || !!current.clientError}><option value="">No linked client</option>{current.clients.filter(client => client.id === clientId || client.name.toLowerCase().includes(clientSearch.toLowerCase())).map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
      {current.clientError ? <p role="alert">{current.clientError}</p> : !current.clients.some(client => client.name.toLowerCase().includes(clientSearch.toLowerCase())) && <p role="status">No clients match this search.</p>}
      <label className="relationship-search">Search won leads<input type="search" value={leadSearch} onChange={event => setLeadSearch(event.target.value)} disabled={disabled} /></label>
      <label>Won lead (optional)<select aria-label="Won lead" value={wonLeadId} onChange={event => onLead(event.target.value)} disabled={disabled || !!current.leadError}><option value="">Direct project — no won lead</option>{current.leads.filter(lead => lead.id === wonLeadId || lead.title.toLowerCase().includes(leadSearch.toLowerCase())).map(lead => <option key={lead.id} value={lead.id}>{lead.title}</option>)}</select></label>
      {current.leadError && <p role="alert">{current.leadError}</p>}
      {!current.leadError && !current.leads.some(lead => lead.title.toLowerCase().includes(leadSearch.toLowerCase())) && <p role="status">No loaded won leads match this search.</p>}
      {current.leads.length < current.total && <button type="button" disabled={disabled || moreBusy} onClick={() => void more()}>{moreBusy ? "Loading…" : `Load more won leads (${current.leads.length} of ${current.total})`}</button>}
      {(current.clientError || current.leadError) && <button type="button" disabled={disabled} onClick={() => setRevision(value => value + 1)}>Retry client and lead choices</button>}
    </>}
  </section>;
}
