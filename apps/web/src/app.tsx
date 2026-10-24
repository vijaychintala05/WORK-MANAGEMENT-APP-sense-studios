import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { NotificationCenter } from "./notifications.js";
import { SignInHub, StaffRecovery } from "./auth-flow.js";
import { SessionGroups } from "./session-groups.js";
import { AuditRetentionCenter } from "./audit-retention.js";
import { ApprovalQueue } from "./approval-queue.js";
import { MyWorkManagement } from "./my-work-attention.js";
import { ProjectsRoute } from "./projects-route.js";
import { WorkspaceHeader, WorkspaceLayout, workspaceContextLabel } from "./workspace-navigation.js";
import { CrmWorkspace } from "./crm.js";
import { ProjectWorkspace } from "./project.js";
import { TaskWorkspace } from "./task.js";
import { DocumentWorkspace } from "./document.js";
import { RevisionWorkspace } from "./revision.js";
import { ReviewWorkspace } from "./review.js";
import { StaffClientReviewWorkspace } from "./client-review.js";
import { TurnkeyWorkspace } from "./turnkey.js";
import { TimeWorkspace } from "./time.js";
import { WorkforceWorkspace } from "./workforce.js";
import { PerformanceWorkspace } from "./performance.js";
import { DashboardWorkspace } from "./dashboard.js";
import { SiteWorkspace } from "./site.js";
import { SiteOfflineCaptureRoute } from "./site-offline-capture.js";
import { clearOfflinePointer, purgeOfflineAccount, purgeOtherOfflineAccounts, readOfflinePointer } from "./site-offline.js";
import { StaffExternalAccessWorkspace } from "./external-portal.js";
import { IntegrationsWorkspace } from "./integrations.js";
import { AutomationWorkspace } from "./automation.js";
import { AiAssistanceWorkspace } from "./ai-assistance.js";
import { SkillsTrainingWorkspace, SkillsWorkspace } from "./learning.js";
import { TrainingWorkspace } from "./learning-training.js";
import { LibraryWorkspace } from "./library-workspace.js";
import { InsightsNavigation } from "./insights-navigation.js";
import { DecisionsHome, SettingsSectionNavigation, type SettingsSection } from "./settings-homes.js";
import { OrganizationAdmin, TeamWorkspace } from "./organization-admin.js";
import { PeopleSelf } from "./people-self.js";
import { passkeyRegistrationError } from "./passkey-registration-error.js";

const AUTH_PATH = "/api/v1/auth";


type Account = { id: string; email: string; kind: "OWNER" | "STAFF" };
type Session = { account: Account; csrfToken: string; ownerSetupRequired?: boolean; activePasskeyCount?: number };
type DeviceSession = {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  userAgent: string | null;
  current: boolean;
};
type AuthView =
  | { kind: "restoring" }
  | { kind: "signed-out"; notice?: string }
  | { kind: "signed-in"; session: Session }
  | { kind: "session-error"; message: string };
type LoginError = "invalid" | "throttled" | "network" | "unavailable" | "cancelled" | "unsupported";

async function readSession(): Promise<Session | null> {
  const response = await fetch(`${AUTH_PATH}/session`, {
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 401) {
    const pointer = readOfflinePointer();
    clearOfflinePointer();
    window.dispatchEvent(new Event("sense-session-ended"));
    if (pointer) await purgeOfflineAccount(pointer.accountId).catch(() => undefined);
    return null;
  }
  if (!response.ok) throw new Error("session-unavailable");
  const session = (await response.json()) as Session;
  const offlinePointer = readOfflinePointer();
  if (offlinePointer && offlinePointer.accountId !== session.account.id) {
    clearOfflinePointer(offlinePointer.accountId);
    window.dispatchEvent(new Event("sense-session-ended"));
    await purgeOfflineAccount(offlinePointer.accountId).catch(() => undefined);
  }
  await purgeOtherOfflineAccounts(session.account.id).catch(() => undefined);
  return session;
}

function errorMessage(error: LoginError): string {
  switch (error) {
    case "invalid": return "We couldn’t sign you in. Check your passkey and try again.";
    case "throttled": return "Too many attempts. Wait a moment, then try again.";
    case "cancelled": return "The passkey request was cancelled. You can try again when ready.";
    case "network": return "We couldn’t reach the sign-in service. Check your connection and try again.";
    case "unavailable": return "Sign-in is temporarily unavailable. Try again shortly.";
    case "unsupported": return "This browser does not support passkeys. Open this page in a supported browser or device.";
  }
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && ["NotAllowedError", "AbortError"].includes(error.name);
}

function isUnsupportedPasskeyBrowser(error: unknown): boolean {
  return !window.PublicKeyCredential || (error instanceof Error && ["NotSupportedError", "SecurityError"].includes(error.name));
}

function deviceDescription(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const platform = /iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows" : /Mac OS/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "device";
  return `${browser} on ${platform}`;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function Login({ onSignedIn, notice }: { onSignedIn: (session: Session) => void; notice: string | undefined }): React.JSX.Element {
  const loginLocation = useLocation();
  const ownerEntry = loginLocation.pathname === "/owner/sign-in";
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  const signIn = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    if (!window.PublicKeyCredential) {
      setError("unsupported");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const optionsResponse = await fetch(`${AUTH_PATH}/passkey/login/options`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (optionsResponse.status === 429) throw new Error("throttled");
      if (!optionsResponse.ok) throw new Error(optionsResponse.status >= 500 ? "unavailable" : "invalid");
      const { ceremonyId, options } = await optionsResponse.json() as {
        ceremonyId: string;
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      };
      const response = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch(`${AUTH_PATH}/passkey/login/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ceremonyId, response }),
      });
      if (verifyResponse.status === 429) throw new Error("throttled");
      if (!verifyResponse.ok) throw new Error(verifyResponse.status >= 500 ? "unavailable" : "invalid");
      const session = await readSession();
      if (session) {
        const pointer = readOfflinePointer();
        if (pointer && pointer.accountId !== session.account.id) { void purgeOfflineAccount(pointer.accountId).catch(() => undefined); clearOfflinePointer(pointer.accountId); }
        void purgeOtherOfflineAccounts(session.account.id).catch(() => undefined);
      }
      if (!session) throw new Error("invalid");
      onSignedIn(session);
    } catch (cause) {
      if (cause instanceof Error && ["invalid", "throttled", "unavailable"].includes(cause.message)) {
        setError(cause.message as LoginError);
      } else if (isCancellation(cause)) {
        setError("cancelled");
      } else {
        setError("network");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-content">
      <section className="auth-card auth-login" aria-labelledby="login-heading">
        <div className="eyebrow">SENSE STUDIOS WORKSPACE</div>
        <h1 id="login-heading">{ownerEntry ? "Owner sign in" : loginLocation.pathname === "/staff/sign-in" ? "Studio team sign in" : "Sign in with your passkey"}</h1>
        <p className="auth-intro">Use the passkey registered to your work account to continue.</p>
        {notice && <p className="notice" role="status">{notice}</p>}
        {error && <p className="auth-error" role="alert">{errorMessage(error)}</p>}
        <form onSubmit={(event) => void signIn(event)}>
          <label htmlFor="email">Work email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username webauthn"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            maxLength={254}
            disabled={pending}
          />
          <button className="primary-action" type="submit" disabled={pending || !email.trim()}>
            {pending ? "Waiting for passkey…" : "Continue with passkey"}
          </button>
        </form>
        {!window.PublicKeyCredential && <p className="support-note">This browser may not support passkeys. Use a supported browser or device.</p>}
        <nav className="identity-links" aria-label="Identity setup">
          <Link to="/staff/recovery">Can't sign in?</Link>
          <a href="/client-portal/login">Client sign in</a>
          <Link to="/sign-in">All sign-in options</Link>
          <Link to="/bootstrap">Set up the first Owner account</Link>
          <Link to="/enroll">Accept an invitation or recovery token</Link>
          <Link to="/owner-recovery">Recover an Owner account</Link>
          <Link to="/install">Install on your phone</Link>
        </nav>
      </section>
    </main>
  );
}

function Identity({ session, onLogout, busy, error, settingsSection, peopleMode = false, onSessionUpdate }: {
  session: Session;
  onLogout: () => void;
  busy: boolean;
  error: string | undefined;
  settingsSection?: SettingsSection;
  peopleMode?: boolean;
  onSessionUpdate?: (session: Session) => void;
}): React.JSX.Element {
  const location = useLocation();
  const requestedPanel = new URLSearchParams(location.search).get("panel");
  const selectedPersonContext = peopleMode && new URLSearchParams(location.search).has("employeeId");
  const adminPanel = peopleMode ? "people" : requestedPanel === "structure" || requestedPanel === "access" || requestedPanel === "presentation" ? requestedPanel : "all";
  const identityActive = useRef(true);
  const [currentSession, setCurrentSession] = useState(session);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState<string>();
  const [tokenExpiresIn, setTokenExpiresIn] = useState<number>();
  const [storedOffline, setStoredOffline] = useState(false);
  const [staffEmail, setStaffEmail] = useState("");
  const [staffRecoveryEmail, setStaffRecoveryEmail] = useState("");
  const [recoveryTarget, setRecoveryTarget] = useState<{ id: string; email: string; state: string } | null>(null);
  const [recoveryReason, setRecoveryReason] = useState("");
  const [verifiedOutOfBand, setVerifiedOutOfBand] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string>();
  const [deviceSessions, setDeviceSessions] = useState<DeviceSession[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string>();
  const [revokingSessionId, setRevokingSessionId] = useState<string>();
  const [organizationSettingsOpen, setOrganizationSettingsOpen] = useState(false);
  const [teamWorkspaceOpen, setTeamWorkspaceOpen] = useState(false);
  const [notificationsVisited, setNotificationsVisited] = useState(settingsSection === "notifications");

  useEffect(() => setCurrentSession(session), [session]);
  useEffect(() => { identityActive.current = true; return () => { identityActive.current = false; }; }, []);
  useEffect(() => { if (settingsSection === "notifications") setNotificationsVisited(true); }, [settingsSection]);

  const loadDeviceSessions = useCallback(async (): Promise<void> => {
    setSessionsLoading(true);
    setSessionsError(undefined);
    try {
      const response = await fetch(`${AUTH_PATH}/sessions`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("sessions-unavailable");
      setDeviceSessions(await response.json() as DeviceSession[]);
    } catch {
      setSessionsError("We couldn’t load your sessions. Try again.");
    } finally { setSessionsLoading(false); }
  }, []);

  useEffect(() => { if (!peopleMode) void loadDeviceSessions(); }, [loadDeviceSessions, peopleMode]);

  const revokeDeviceSession = async (item: DeviceSession): Promise<void> => {
    if (item.current || revokingSessionId) return;
    setRevokingSessionId(item.id);
    setSessionsError(undefined);
    try {
      const response = await fetch(`${AUTH_PATH}/sessions/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "X-CSRF-Token": currentSession.csrfToken },
      });
      if (!response.ok) throw new Error("session-revoke-failed");
      await loadDeviceSessions();
    } catch {
      setSessionsError("We couldn’t revoke that session. Refresh the list and try again.");
    } finally { setRevokingSessionId(undefined); }
  };

  const addOwnerPasskey = async (): Promise<void> => {
    setPending(true);
    setActionError(undefined);
    setActionSuccess(undefined);
    let browserRegistration = false;
    try {
      const options = await apiPost(`${AUTH_PATH}/passkey/register/options`, {}, currentSession.csrfToken) as Ceremony;
      browserRegistration = true;
      const response = await startRegistration({ optionsJSON: options.options });
      browserRegistration = false;
      await apiPost(`${AUTH_PATH}/passkey/register/verify`, { ceremonyId: options.ceremonyId, response }, currentSession.csrfToken);
      const updated = await readSession();
      if (!identityActive.current) return;
      if (!updated) { onLogout(); return; }
      if (updated.account.id !== currentSession.account.id) return;
      setCurrentSession(updated); onSessionUpdate?.(updated);
      setActionSuccess("Passkey added to this account.");
    } catch (cause) {
      setActionError(browserRegistration
        ? passkeyRegistrationError(cause, { diagnostics: import.meta.env.DEV, browserSupported: Boolean(window.PublicKeyCredential) })
        : publicFlowError(cause));
    } finally { setPending(false); }
  };

  const createRecoveryCode = async (): Promise<void> => {
    setPending(true);
    setActionError(undefined);
    setActionSuccess(undefined);
    try {
      const result = await apiPost(`${AUTH_PATH}/owner/recovery-code`, {}, currentSession.csrfToken) as { recoveryCode: string };
      setToken(result.recoveryCode);
      setTokenExpiresIn(undefined);
      setStoredOffline(false);
    } catch (cause) { setActionError(publicFlowError(cause, "Register a second distinct passkey before creating the recovery code.")); }
    finally { setPending(false); }
  };

  const acknowledgeRecoveryCode = async (): Promise<void> => {
    if (!storedOffline) return;
    setPending(true);
    setActionError(undefined);
    try {
      await apiPost(`${AUTH_PATH}/owner/recovery-code/ack`, { confirmedStoredOffline: true }, currentSession.csrfToken);
      const updated = await readSession();
      if (!identityActive.current) return;
      if (!updated) { onLogout(); return; }
      if (updated.account.id !== currentSession.account.id) return;
      setCurrentSession(updated); onSessionUpdate?.(updated);
      setToken(undefined);
      setActionSuccess("Owner setup is complete. Keep the recovery code offline and use it only once.");
    } catch (cause) { setActionError(publicFlowError(cause)); }
    finally { setPending(false); }
  };

  const createInvitation = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setPending(true); setActionError(undefined); setActionSuccess(undefined); setToken(undefined); setTokenExpiresIn(undefined);
    try {
      const result = await apiPost(`${AUTH_PATH}/staff/invitations`, { email: staffEmail.trim() }, currentSession.csrfToken) as { invitationToken: string; expiresInSeconds: number };
      setToken(result.invitationToken);
      setTokenExpiresIn(result.expiresInSeconds);
    } catch (cause) { setActionError(publicFlowError(cause)); }
    finally { setPending(false); }
  };

  const authorizeRecovery = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!recoveryTarget) return;
    setPending(true); setActionError(undefined); setActionSuccess(undefined); setToken(undefined); setTokenExpiresIn(undefined);
    try {
      const result = await apiPost(`${AUTH_PATH}/staff/${encodeURIComponent(recoveryTarget.id)}/recovery`, {
        reason: recoveryReason.trim(), verifiedOutOfBand: true,
      }, currentSession.csrfToken) as { recoveryToken: string; expiresInSeconds: number };
      setToken(result.recoveryToken);
      setTokenExpiresIn(result.expiresInSeconds);
    } catch (cause) { setActionError(publicFlowError(cause)); }
    finally { setPending(false); }
  };

  const revokeStaffSessions = async (): Promise<void> => {
    if (!recoveryTarget || recoveryReason.trim().length < 10) return;
    setPending(true); setActionError(undefined); setActionSuccess(undefined);
    try {
      const result = await apiPost(`${AUTH_PATH}/staff/${encodeURIComponent(recoveryTarget.id)}/revoke-sessions`, {
        reason: recoveryReason.trim(),
      }, currentSession.csrfToken) as { revokedSessions: number };
      setActionSuccess(`${result.revokedSessions} staff session${result.revokedSessions === 1 ? "" : "s"} revoked.`);
    } catch (cause) { setActionError(publicFlowError(cause)); }
    finally { setPending(false); }
  };

  const lookupStaff = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setPending(true); setActionError(undefined); setRecoveryTarget(null);
    try {
      const response = await fetch(`${AUTH_PATH}/staff?email=${encodeURIComponent(staffRecoveryEmail.trim())}`, {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw Object.assign(new Error("lookup-failed"), { status: response.status });
      const result = await response.json() as { account: { id: string; email: string; state: string } | null };
      if (!result.account || result.account.state !== "ACTIVE") {
        setActionError("No active staff account was found for that email.");
      } else {
        setRecoveryTarget(result.account);
        setVerifiedOutOfBand(false);
      }
    } catch (cause) { setActionError(publicFlowError(cause)); }
    finally { setPending(false); }
  };

  const refreshIdentity = async (): Promise<void> => {
    setRefreshing(true);
    try { const updated = await readSession(); if (!identityActive.current) return; if (updated && updated.account.id === currentSession.account.id) { setCurrentSession(updated); onSessionUpdate?.(updated); } else if (!updated) onLogout(); }
    catch { if (identityActive.current) setActionError("We couldn’t refresh your session. Try again."); }
    finally { setRefreshing(false); }
  };

  const ownerNeedsSetup = currentSession.account.kind === "OWNER" && currentSession.ownerSetupRequired === true;
  const settingsMode = settingsSection !== undefined || peopleMode;
  const owner = currentSession.account.kind === "OWNER";
  const staff = currentSession.account.kind === "STAFF";
  const effectiveSettingsSection = peopleMode ? "people" : settingsSection === "setup" && !ownerNeedsSetup ? "account" : settingsSection;
  const showAccount = !settingsMode || effectiveSettingsSection === "account" || ownerNeedsSetup;
  const showNotifications = !settingsMode || effectiveSettingsSection === "notifications";
  const showOrganization = peopleMode || !settingsMode || effectiveSettingsSection === "organization";
  const showTeam = peopleMode || !settingsMode || effectiveSettingsSection === "team";
  const copyToken = async (): Promise<void> => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); setActionError(undefined); setActionSuccess("Copied. Store or hand off this one-time secret securely."); }
    catch { setActionSuccess(undefined); setActionError("Copy is unavailable in this browser. Select and copy the secret manually."); }
  };

  return (
    <main className={`identity-content${peopleMode ? " people-route" : settingsMode ? " settings-shell" : ""}`}>
      {peopleMode && <><header className="people-route-heading"><p className="settings-homes-eyebrow">WORKSPACE</p><h1>People</h1>{!selectedPersonContext && <p>{owner ? "Manage employee membership, responsibilities and access through the current authorized workflows." : "Your account and permitted reporting team. Team records require an explicit grant."}</p>}</header>{!selectedPersonContext && <nav className="people-personal-links" aria-label="People workspaces"><Link to="/my-work">My Work</Link><Link to="/settings?section=account">My account &amp; devices</Link><Link to="/workforce">Workforce</Link><Link to="/learning">Learning</Link>{owner && <Link to="/settings?section=organization&panel=access">Job roles &amp; permissions</Link>}</nav>}</>}
      {settingsMode && !peopleMode && <header className="settings-shell-heading"><p className="settings-homes-eyebrow">WORKSPACE</p><h1>Settings</h1><p>Manage your account and workspace preferences.</p></header>}
      {settingsMode && !peopleMode && !ownerNeedsSetup && <SettingsSectionNavigation active={effectiveSettingsSection as SettingsSection} owner={owner} staff={staff} />}
      {settingsMode && !peopleMode && !ownerNeedsSetup && <h2 className="settings-section-heading">{effectiveSettingsSection === "account" ? "Account & devices" : effectiveSettingsSection === "notifications" ? "Notifications" : effectiveSettingsSection === "organization" ? "Organization administration" : "Team workspace"}</h2>}
      {(!settingsMode || effectiveSettingsSection === "account" || ownerNeedsSetup) && <div className="eyebrow">IDENTITY</div>}
      {!settingsMode && <><h1>You’re signed in.</h1><p className="auth-intro">Your account is authenticated. Workspace access will appear as approved capabilities are added.</p></>}
      {showAccount && <>
      <section className="identity-card" aria-labelledby="identity-heading">
        <div className="identity-avatar" aria-hidden="true">{currentSession.account.email.slice(0, 1).toUpperCase()}</div>
        <div className="identity-details">
          <h2 id="identity-heading">Account</h2>
          <p>{currentSession.account.email}</p>
          <span className="account-kind">{currentSession.account.kind === "OWNER" ? "Owner account" : "Staff account"}</span>
        </div>
        <button type="button" onClick={onLogout} disabled={busy}>
          {busy ? "Signing out…" : "Sign out"}
        </button>
      </section>
      </>}
      {!settingsMode && <nav className="document-navigation" aria-label="Workspace navigation"><Link to="/dashboard">Dashboard</Link><Link to="/time">Time</Link><Link to="/workforce">Workforce</Link><Link to="/learning">Learning</Link><Link to="/performance">Performance</Link><Link to="/site">Site delivery</Link><Link to="/documents">Project documents</Link><Link to="/revisions">Drawing register</Link><Link to="/reviews">Internal reviews</Link><Link to="/client-reviews">Client reviews</Link><Link to="/external-access">External access</Link><Link to="/turnkey">Turnkey operations</Link></nav>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {peopleMode && staff && <PeopleSelf />}
      {!settingsMode && !ownerNeedsSetup && <ApprovalQueue />}
      {!settingsMode && !ownerNeedsSetup && <CrmWorkspace csrfToken={currentSession.csrfToken} owner={owner} />}
      {!settingsMode && !ownerNeedsSetup && <ProjectWorkspace csrfToken={currentSession.csrfToken} owner={owner} />}
      {!settingsMode && !ownerNeedsSetup && <TaskWorkspace csrfToken={currentSession.csrfToken} owner={owner} />}
      {showAccount && <>
      <section className="identity-section sessions-section" aria-labelledby="sessions-heading">
        <div className="sessions-heading-row">
          <div><div className="eyebrow">DEVICES</div><h2 id="sessions-heading">Active sessions</h2></div>
          <button className="secondary-action" type="button" onClick={() => void loadDeviceSessions()} disabled={sessionsLoading}>Refresh</button>
        </div>
        {sessionsLoading && <p role="status" className="identity-note">Loading your sessions…</p>}
        {sessionsError && <div className="sessions-error"><p role="alert" className="auth-error">{sessionsError}</p><button className="secondary-action" type="button" onClick={() => void loadDeviceSessions()}>Try again</button></div>}
        {!sessionsLoading && !sessionsError && deviceSessions?.length === 0 && <p className="identity-note" role="status">No sessions are available.</p>}
        {!sessionsLoading && !sessionsError && deviceSessions && deviceSessions.length > 0 && (
          <SessionGroups sessions={deviceSessions}>
            {(item) => {
              const expired = new Date(item.expiresAt).getTime() <= Date.now();
              const status = item.current ? "Current device" : item.revokedAt ? "Revoked" : expired ? "Expired" : "Active";
              return <li className="session-item" key={item.id}>
                <div className="session-copy">
                  <h3>{deviceDescription(item.userAgent)}{item.current && <span className="current-device-badge">This device</span>}</h3>
                  <p>{status} · Signed in {displayDate(item.createdAt)}</p>
                  {item.lastUsedAt && <p>Last used {displayDate(item.lastUsedAt)}</p>}
                </div>
                {!item.current && !item.revokedAt && !expired && <button className="secondary-action" type="button" disabled={revokingSessionId !== undefined} onClick={() => void revokeDeviceSession(item)}>{revokingSessionId === item.id ? "Revoking…" : "Revoke"}</button>}
              </li>;
            }}
          </SessionGroups>
        )}
      </section>
      </>}
      {settingsMode ? notificationsVisited && <div hidden={!showNotifications}><NotificationCenter csrfToken={currentSession.csrfToken} initiallyOpen /></div> : <NotificationCenter csrfToken={currentSession.csrfToken} />}
      {ownerNeedsSetup && (
        <section className="identity-section" aria-labelledby="owner-setup-heading">
          <div className="eyebrow">OWNER SETUP</div><h2 id="owner-setup-heading">Secure your Owner account</h2>
          <p>Add a second distinct passkey, create your one-time offline recovery code, then confirm that you stored it safely.</p>
          <ol className="owner-setup-progress"><li>{(currentSession.activePasskeyCount ?? 0) >= 2 ? "Two passkeys registered" : "Register a second passkey"}</li><li>{token ? "Save your offline recovery code" : "Create your recovery code"}</li><li>Confirm safe storage</li></ol>
          {!token && <div className="identity-actions">
            {(currentSession.activePasskeyCount ?? 0) < 2 && <button type="button" disabled={pending} onClick={() => void addOwnerPasskey()}>Add second passkey</button>}
            {(currentSession.activePasskeyCount ?? 0) >= 2 && <button type="button" disabled={pending} onClick={() => void createRecoveryCode()}>Create offline recovery code</button>}
          </div>}
          {token && <div className="secret-handoff">
            <label htmlFor="recovery-code">One-time offline recovery code</label><textarea id="recovery-code" readOnly value={token} rows={2} />
            <button type="button" onClick={() => void copyToken()}>Copy code</button>
            <label className="check-row"><input type="checkbox" checked={storedOffline} onChange={(event) => setStoredOffline(event.target.checked)} />I stored this recovery code offline where only I can access it.</label>
            <button type="button" disabled={pending || !storedOffline} onClick={() => void acknowledgeRecoveryCode()}>Confirm offline storage</button>
          </div>}
        </section>
      )}
      {owner && currentSession.ownerSetupRequired === false && (showOrganization || settingsMode) && <div hidden={settingsMode && !showOrganization}>
        {!peopleMode && (adminPanel === "all" || adminPanel === "structure") && <AuditRetentionCenter csrfToken={currentSession.csrfToken} />}
        <section className={`identity-section${peopleMode ? " people-administration" : ""}`} aria-labelledby={peopleMode || adminPanel !== "all" ? "organization-heading" : "organization-settings-toggle"}>
          {!peopleMode && adminPanel === "all" && <div className="sessions-heading-row">
            <div><div className="eyebrow">ORGANIZATION</div><h2 id="organization-settings-toggle">Organization settings</h2></div>
            <button className="secondary-action" type="button" aria-expanded={organizationSettingsOpen} onClick={() => setOrganizationSettingsOpen((open) => !open)}>
              {organizationSettingsOpen ? "Hide settings" : "Manage organization"}
            </button>
          </div>}
          {(peopleMode || adminPanel !== "all" || organizationSettingsOpen) && <OrganizationAdmin key={adminPanel} session={currentSession} panel={adminPanel} />}
        </section>
      </div>}
      {staff && (showTeam || settingsMode) && (
        <div hidden={settingsMode && !showTeam}>
        <section className="identity-section" aria-labelledby="team-workspace-heading">
          {!peopleMode && <div className="sessions-heading-row">
            <div><div className="eyebrow">TEAM</div><h2 id="team-workspace-heading">Team workspace</h2></div>
            <button className="secondary-action" type="button" aria-expanded={teamWorkspaceOpen} onClick={() => setTeamWorkspaceOpen((open) => !open)}>
              {teamWorkspaceOpen ? "Close team workspace" : "Open team workspace"}
            </button>
          </div>}
          {peopleMode && <h2 id="team-workspace-heading">Permitted reporting team</h2>}
          {(peopleMode || teamWorkspaceOpen) && <TeamWorkspace session={currentSession} />}
        </section>
        </div>
      )}
      {owner && currentSession.ownerSetupRequired === false && (peopleMode || !settingsMode || settingsSection === "organization" && adminPanel === "all") && (
        <section className="identity-section" aria-labelledby="staff-identity-heading">
          <details open={peopleMode ? undefined : true}><summary className="staff-identity-disclosure">Staff invitations and recovery</summary>
          <div className="eyebrow">IDENTITY ADMINISTRATION</div><h2 id="staff-identity-heading">Staff identity access</h2>
          <form className="identity-form" onSubmit={(event) => void createInvitation(event)}>
            <label htmlFor="staff-invite-email">Invite staff by work email</label>
            <div className="inline-form"><input id="staff-invite-email" type="email" required maxLength={320} value={staffEmail} onChange={(event) => setStaffEmail(event.target.value)} /><button disabled={pending}>Create invitation</button></div>
          </form>
          <form className="identity-form" onSubmit={(event) => void lookupStaff(event)}>
            <label htmlFor="staff-recovery-email">Work email for verified staff recovery</label>
            <div className="inline-form"><input id="staff-recovery-email" type="email" maxLength={320} value={staffRecoveryEmail} onChange={(event) => { setStaffRecoveryEmail(event.target.value); setRecoveryTarget(null); }} required /><button disabled={pending}>Find staff account</button></div>
          </form>
          {recoveryTarget && <form className="identity-form" onSubmit={(event) => void authorizeRecovery(event)}>
            <p className="resolved-account">Recovery target: <strong>{recoveryTarget.email}</strong></p>
            <label htmlFor="recovery-reason">Reason for recovery authorization</label>
            <textarea id="recovery-reason" minLength={10} maxLength={1000} value={recoveryReason} onChange={(event) => setRecoveryReason(event.target.value)} required />
            <p className="identity-note">Revoking sessions signs the staff member out immediately. Recovery also revokes sessions and passkeys.</p>
            <button type="button" className="secondary-action" disabled={pending || recoveryReason.trim().length < 10} onClick={() => void revokeStaffSessions()}>Revoke staff sessions</button>
            <label className="check-row"><input type="checkbox" checked={verifiedOutOfBand} onChange={(event) => setVerifiedOutOfBand(event.target.checked)} required />I verified this staff member out of band.</label>
            <button disabled={pending || !verifiedOutOfBand}>Revoke access and authorize recovery</button>
          </form>}
          {token && <div className="secret-handoff"><label htmlFor="handoff-token">One-time enrollment token for secure handoff</label><textarea id="handoff-token" readOnly value={token} rows={2} />{tokenExpiresIn !== undefined && <p className="identity-note">Expires in {Math.ceil(tokenExpiresIn / 3600)} hours.</p>}<button type="button" onClick={() => void copyToken()}>Copy token</button><button type="button" className="secondary-action" onClick={() => { setToken(undefined); setTokenExpiresIn(undefined); }}>Hide token</button></div>}
          </details>
        </section>
      )}
      {(peopleMode || showAccount || effectiveSettingsSection === "organization" || ownerNeedsSetup) && actionError && <p className="auth-error" role="alert">{actionError}</p>}
      {(peopleMode || showAccount || effectiveSettingsSection === "organization" || ownerNeedsSetup) && actionSuccess && <p className="notice" role="status">{actionSuccess}</p>}
      {showAccount && <div className="identity-bottom-actions">
        <button className="secondary-action" type="button" onClick={() => void refreshIdentity()} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh session"}</button>
        <p className="identity-note" role="status">Your sign-in is checked again when you return to this page.</p>
      </div>}
    </main>
  );
}

type Ceremony = { ceremonyId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] };

async function apiPost(path: string, body: unknown, csrfToken?: string): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error("request-failed"), { status: response.status });
  return response.status === 204 ? undefined : response.json();
}

function publicFlowError(error: unknown, forbiddenMessage?: string): string {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
  if (status === 429) return "Too many attempts. Wait a moment, then try again.";
  if (status === 401 || status === 400) return "The request could not be completed. Check the details and try again.";
  if (status === 403 && forbiddenMessage) return forbiddenMessage;
  if (status === 403) return "Sign out and sign in again before changing credentials or recovery settings.";
  if (status >= 500) return "The identity service is temporarily unavailable. Try again shortly.";
  if (isUnsupportedPasskeyBrowser(error)) return "This browser does not support passkeys. Open this page in a supported browser or device.";
  if (isCancellation(error)) return "The passkey request was cancelled. You can try again when ready.";
  return "We couldn’t reach the identity service. Check your connection and try again.";
}

function Bootstrap(): React.JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState(""); const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false); const [error, setError] = useState<string>();
  const [ceremony, setCeremony] = useState<Ceremony>();
  const start = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setPending(true); setError(undefined);
    try {
      const options = await apiPost(`${AUTH_PATH}/bootstrap/options`, { email: email.trim(), secret }) as Ceremony;
      setCeremony(options);
      setSecret("");
    }
    catch (cause) { setError(publicFlowError(cause)); }
    finally { setPending(false); }
  };
  const enroll = async (): Promise<void> => {
    if (!ceremony) return;
    setPending(true); setError(undefined);
    try {
      const response = await startRegistration({ optionsJSON: ceremony.options });
      await apiPost(`${AUTH_PATH}/bootstrap/verify`, { ceremonyId: ceremony.ceremonyId, response });
      const restored = await readSession();
      if (!restored) throw new Error("session-missing");
      navigate("/");
    } catch (cause) { setError(publicFlowError(cause)); }
    finally { setPending(false); }
  };
  return <main className="auth-content"><section className="auth-card"><div className="eyebrow">FIRST OWNER SETUP</div><h1>Register the first Owner passkey</h1><p className="auth-intro">Enter the initial Owner email and one-time setup secret provided by the deployment administrator.</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {!ceremony ? <form onSubmit={(event) => void start(event)}><label htmlFor="bootstrap-email">Owner work email</label><input id="bootstrap-email" type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} /><label htmlFor="bootstrap-secret">One-time setup secret</label><input id="bootstrap-secret" type="password" autoComplete="one-time-code" required minLength={32} maxLength={512} value={secret} onChange={(event) => setSecret(event.target.value)} /><button disabled={pending}>{pending ? "Preparing passkey…" : "Continue"}</button></form> : <div className="identity-actions"><p role="status">The registration ceremony is ready.</p><button disabled={pending} onClick={() => void enroll()}>{pending ? "Registering…" : "Register Owner passkey"}</button><button className="secondary-action" onClick={() => setCeremony(undefined)}>Start over</button></div>}
    <Link className="text-link" to="/">Back to sign in</Link></section></main>;
}

function Enrollment(): React.JSX.Element {
  const navigate = useNavigate();
  const [token, setToken] = useState(""); const [ceremony, setCeremony] = useState<Ceremony>();
  const [pending, setPending] = useState(false); const [error, setError] = useState<string>();
  const getOptions = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setPending(true); setError(undefined);
    try { setCeremony(await apiPost(`${AUTH_PATH}/staff/invitations/options`, { token: token.trim() }) as Ceremony); }
    catch (cause) { setError(publicFlowError(cause)); }
    finally { setPending(false); }
  };
  const enroll = async (): Promise<void> => {
    if (!ceremony) return;
    setPending(true); setError(undefined);
    try {
      const response = await startRegistration({ optionsJSON: ceremony.options });
      await apiPost(`${AUTH_PATH}/staff/invitations/verify`, { token: token.trim(), ceremonyId: ceremony.ceremonyId, response });
      setToken("");
      const restored = await readSession(); if (!restored) throw new Error("session-missing"); navigate("/");
    } catch (cause) { setError(publicFlowError(cause)); }
    finally { setPending(false); }
  };
  return <main className="auth-content"><section className="auth-card"><div className="eyebrow">STAFF ENROLLMENT</div><h1>Set up your passkey</h1><p className="auth-intro">Paste the one-time invitation or recovery token provided by your Owner. The token stays on this page and is sent only to the identity service.</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {!ceremony ? <form onSubmit={(event) => void getOptions(event)}><label htmlFor="enrollment-token">One-time enrollment token</label><input id="enrollment-token" type="password" autoComplete="off" required minLength={32} maxLength={512} value={token} onChange={(event) => setToken(event.target.value)} /><button disabled={pending}>{pending ? "Checking token…" : "Continue"}</button></form> : <div className="identity-actions"><p role="status">The registration ceremony is ready.</p><button disabled={pending} onClick={() => void enroll()}>{pending ? "Registering…" : "Register staff passkey"}</button><button className="secondary-action" onClick={() => setCeremony(undefined)}>Use a different token</button></div>}
    <Link className="text-link" to="/">Back to sign in</Link></section></main>;
}

function OwnerRecovery(): React.JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState(""); const [code, setCode] = useState("");
  const [ceremony, setCeremony] = useState<Ceremony>(); const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const getOptions = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setPending(true); setError(undefined);
    try { setCeremony(await apiPost(`${AUTH_PATH}/owner/recovery/options`, { email: email.trim(), code: code.trim() }) as Ceremony); }
    catch (cause) { setError(publicFlowError(cause)); }
    finally { setPending(false); }
  };
  const recover = async (): Promise<void> => {
    if (!ceremony) return;
    setPending(true); setError(undefined);
    try {
      const response = await startRegistration({ optionsJSON: ceremony.options });
      await apiPost(`${AUTH_PATH}/owner/recovery/verify`, { email: email.trim(), code: code.trim(), ceremonyId: ceremony.ceremonyId, response });
      setCode("");
      const restored = await readSession(); if (!restored) throw new Error("session-missing"); navigate("/");
    } catch (cause) { setError(publicFlowError(cause)); }
    finally { setPending(false); }
  };
  return <main className="auth-content"><section className="auth-card"><div className="eyebrow">OWNER RECOVERY</div><h1>Recover with your offline code</h1><p className="auth-intro">Use the one-time recovery code kept offline. Recovery replaces existing passkeys and sessions.</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {!ceremony ? <form onSubmit={(event) => void getOptions(event)}><label htmlFor="recovery-email">Owner work email</label><input id="recovery-email" type="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} /><label htmlFor="owner-recovery-code">Offline recovery code</label><input id="owner-recovery-code" type="password" autoComplete="off" required minLength={32} maxLength={512} value={code} onChange={(event) => setCode(event.target.value)} /><button disabled={pending}>{pending ? "Checking recovery code…" : "Continue"}</button></form> : <div className="identity-actions"><p role="status">Register a replacement passkey to complete recovery.</p><button disabled={pending} onClick={() => void recover()}>{pending ? "Recovering…" : "Register replacement passkey"}</button><button className="secondary-action" onClick={() => setCeremony(undefined)}>Start over</button></div>}
    <Link className="text-link" to="/">Back to sign in</Link></section></main>;
}

function AuthHome({ legacyWorkspace = false }: { legacyWorkspace?: boolean }): React.JSX.Element {
  const [view, setView] = useState<AuthView>({ kind: "restoring" });
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();

  const restore = useCallback(async () => {
    try {
      const session = await readSession();
      setView((previous) => session
        ? { kind: "signed-in", session }
        : {
            kind: "signed-out",
            ...(previous.kind === "signed-in" ? { notice: "Your session ended. Sign in again to continue." } : {}),
          });
      if (!session) { const pointer = readOfflinePointer(); if (pointer) void purgeOfflineAccount(pointer.accountId).catch(() => undefined); clearOfflinePointer(); window.dispatchEvent(new Event("sense-session-ended")); }
    } catch {
      setView({ kind: "session-error", message: "We couldn’t check your session. Try again." });
    }
  }, []);

  useEffect(() => {
    void restore();
  }, [restore, refreshAttempt]);

  useEffect(() => {
    if (view.kind !== "signed-in") return;
    const recheck = (): void => {
      if (document.visibilityState === "visible") void restore();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [restore, view.kind]);

  const logout = async (): Promise<void> => {
    if (view.kind !== "signed-in" || logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError(undefined);
    try {
      const response = await fetch(`${AUTH_PATH}/logout`, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": view.session.csrfToken },
      });
      if (response.status === 401) {
        const pointer = readOfflinePointer(); if (pointer) void purgeOfflineAccount(pointer.accountId).catch(() => undefined); clearOfflinePointer();
        window.dispatchEvent(new Event("sense-session-ended"));
        setView({ kind: "signed-out", notice: "Your session ended. Sign in again to continue." });
      } else if (!response.ok) {
        setLogoutError("We couldn’t sign you out. Try again.");
      } else {
        const pointer = readOfflinePointer(); if (pointer) void purgeOfflineAccount(pointer.accountId).catch(() => undefined); clearOfflinePointer();
        window.dispatchEvent(new Event("sense-session-ended"));
        setView({ kind: "signed-out", notice: "You’ve signed out." });
      }
    } catch {
      setLogoutError("We couldn’t reach the sign-in service. Try signing out again.");
    } finally {
      setLogoutBusy(false);
    }
  };

  if (view.kind === "restoring") return <main className="auth-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (view.kind === "session-error") {
    return <main className="auth-content"><section className="auth-card"><p className="auth-error" role="alert">{view.message}</p><button type="button" onClick={() => setRefreshAttempt((n) => n + 1)}>Try again</button></section></main>;
  }
  if (view.kind === "signed-out") return <Login onSignedIn={(session) => setView({ kind: "signed-in", session })} notice={view.notice} />;
  if (!legacyWorkspace && !(view.session.account.kind === "OWNER" && view.session.ownerSetupRequired)) {
    const linkedTaskId = new URLSearchParams(window.location.search).get("taskId");
    return <Navigate replace to={linkedTaskId ? `/tasks?taskId=${encodeURIComponent(linkedTaskId)}` : "/dashboard"} />;
  }
  return <WorkspaceLayout key={view.session.account.id}><Identity key={view.session.account.id} session={view.session} onLogout={() => void logout()} busy={logoutBusy} error={logoutError} /></WorkspaceLayout>;
}

function HeaderControls(): React.JSX.Element | null {
  const { session } = useSessionProbe();
  const location = useLocation();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutInFlight = useRef(false);
  const navigate = useNavigate();

  const logout = async (): Promise<void> => {
    if (!session || logoutInFlight.current) return;
    logoutInFlight.current = true;
    setLogoutBusy(true);
    setLogoutError("");
    try {
      const response = await fetch(`${AUTH_PATH}/logout`, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": session.csrfToken },
      });
      if (!response.ok && response.status !== 401) throw new Error("logout-failed");
      const pointer = readOfflinePointer();
      if (pointer) await purgeOfflineAccount(pointer.accountId).catch(() => undefined);
      clearOfflinePointer();
      window.dispatchEvent(new Event("sense-session-ended"));
      navigate("/", { replace: true });
    } catch {
      setLogoutError("We couldn’t sign you out. Try again.");
    } finally {
      logoutInFlight.current = false;
      setLogoutBusy(false);
    }
  };

  if (!session) return null;
  const contextLabel = workspaceContextLabel(location.pathname);
  const logoutButton = <button className="site-header-logout" type="button" onClick={() => void logout()} disabled={logoutBusy}>
    {logoutBusy ? "Logging out…" : "Log out"}
  </button>;
  return <div className="site-header-controls">
    {logoutError && <p className="site-header-error" role="alert">{logoutError}</p>}
    {contextLabel && !session.ownerSetupRequired ? <WorkspaceHeader session={session} contextLabel={contextLabel}>{logoutButton}</WorkspaceHeader> : <>
    {!session.ownerSetupRequired && <NavLink className="site-header-notifications" to="/notifications" aria-label="Notifications">
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
      <span>Notifications</span>
    </NavLink>}
    {logoutButton}
    </>}
  </div>;
}

function NotFound(): React.JSX.Element {
  return <main className="auth-content"><section className="auth-card"><div className="eyebrow">PAGE NOT FOUND</div><h1>That page is not here.</h1><Link to="/" className="home-link">Return to sign in</Link></section></main>;
}

function DocumentsRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view project documents</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><DocumentWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} /></main></WorkspaceLayout>;
}

function NotificationsRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/workspace">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view notifications</h1><Link to="/">Return to sign in</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><NotificationCenter csrfToken={session.csrfToken} initiallyOpen /></main></WorkspaceLayout>;
}

function SettingsRoute(): React.JSX.Element {
  const { session, failed, updateSession } = useProtectedRouteSession();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();
  const location = useLocation();
  const navigate = useNavigate();
  const logout = async (): Promise<void> => {
    if (!session || logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError(undefined);
    try {
      const response = await fetch(`${AUTH_PATH}/logout`, { method: "POST", credentials: "include", headers: { "X-CSRF-Token": session.csrfToken } });
      if (!response.ok && response.status !== 401) throw new Error("logout-failed");
      const pointer = readOfflinePointer();
      if (pointer) void purgeOfflineAccount(pointer.accountId).catch(() => undefined);
      clearOfflinePointer();
      window.dispatchEvent(new Event("sense-session-ended"));
      updateSession(() => null);
      navigate("/", { replace: true });
    } catch {
      setLogoutError("We couldn’t sign you out. Try again.");
    } finally { setLogoutBusy(false); }
  };
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/workspace">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view settings</h1><Link to="/">Return to sign in</Link></section></main>;
  const owner = session.account.kind === "OWNER";
  const requestedSection = new URLSearchParams(location.search).get("section");
  const validSections: SettingsSection[] = ["account", "notifications", ...(owner ? ["organization" as const] : ["team" as const])];
  const section: SettingsSection = owner && session.ownerSetupRequired ? "setup" : validSections.includes(requestedSection as SettingsSection) ? requestedSection as SettingsSection : "account";
  return <WorkspaceLayout key={session.account.id}><Identity key={session.account.id} session={session} onLogout={() => void logout()} busy={logoutBusy} error={logoutError} settingsSection={section} onSessionUpdate={(updated) => updateSession((current) => current?.account.id === updated.account.id ? updated : current)} /></WorkspaceLayout>;
}

function DecisionsRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/workspace">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view decisions</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/workspace">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><DecisionsHome /></main></WorkspaceLayout>;
}

function PeopleRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><p role="alert">We couldn’t check your session. Return to the workspace and try again.</p><Link to="/">Return to workspace</Link></main>;
  if (!session) return <main className="identity-content"><h1>Sign in to view People</h1><Link to="/">Return to sign in</Link></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><h1>Complete Owner setup first</h1><Link to="/workspace">Return to Owner setup</Link></main>;
  return <WorkspaceLayout key={session.account.id}><Identity key={session.account.id} session={session} onLogout={() => undefined} busy={false} error={undefined} peopleMode /></WorkspaceLayout>;
}

function TasksRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view tasks</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content tasks-route"><TaskWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} listFirst /></main></WorkspaceLayout>;
}

function MyWorkRoute(): React.JSX.Element {
  const { session, failed, updateSession } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view My Work</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  const personalObligations = ({ employeeLessOwner }: { employeeLessOwner: boolean }): React.ReactNode => <div className="my-work-obligations"><MyWorkManagement key={`management-${session.account.id}`} prioritizeReassignment={employeeLessOwner} onSessionExpired={() => updateSession(() => null)} /></div>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content my-work-route"><TaskWorkspace key={`tasks-${session.account.id}`} accountId={session.account.id} csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} listFirst personalOnly personalObligations={personalObligations} onSessionExpired={() => updateSession(() => null)} /></main></WorkspaceLayout>;
}

/**
 * Header/presence probe: renders for anonymous visitors too, so a failed
 * session read must not flip it into an error state. No `failed` flag.
 */
function useSessionProbe(): { session: Session | null | undefined } {
  const [session, setSession] = useState<Session | null>();
  useEffect(() => {
    let active = true;
    let generation = 0;
    const restore = (): void => {
      const requestId = ++generation;
      void readSession().then(value => {
        if (active && requestId === generation) setSession(value);
      }).catch(() => undefined);
    };
    const ended = (): void => { generation += 1; if (active) setSession(null); };
    const recheck = (): void => { if (document.visibilityState === "visible") restore(); };
    restore();
    window.addEventListener("sense-session-ended", ended);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      active = false;
      generation += 1;
      window.removeEventListener("sense-session-ended", ended);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);
  return { session };
}

/** Keep protected workspaces out of the tree after explicit session loss. */
function useProtectedRouteSession(): { session: Session | null | undefined; failed: boolean; updateSession: (updater: (current: Session | null | undefined) => Session | null | undefined) => void } {
  const [session, setSession] = useState<Session | null>();
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const updateSession = useCallback((updater: (current: Session | null | undefined) => Session | null | undefined): void => {
    if (mounted.current) setSession(updater);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const restore = (): void => {
      const requestId = ++generation;
      void readSession().then(value => {
        if (active && requestId === generation) { setSession(value); setFailed(false); }
      }).catch(() => {
        if (active && requestId === generation) setFailed(true);
      });
    };
    const ended = (): void => {
      generation += 1;
      if (active) { setSession(null); setFailed(false); }
    };
    const recheck = (): void => { if (document.visibilityState === "visible") restore(); };
    restore();
    window.addEventListener("sense-session-ended", ended);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      active = false;
      generation += 1;
      window.removeEventListener("sense-session-ended", ended);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);
  return { session, failed, updateSession };
}

function RevisionsRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view the drawing register</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><RevisionWorkspace csrfToken={session.csrfToken} /></main></WorkspaceLayout>;
}

function ReviewsRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to review project drawings</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><ReviewWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} /></main></WorkspaceLayout>;
}

function ClientReviewsRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to manage client reviews</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><StaffClientReviewWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} /></main></WorkspaceLayout>;
}

function TurnkeyRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view Turnkey operations</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><TurnkeyWorkspace csrfToken={session.csrfToken} /></main></WorkspaceLayout>;
}

export function App(): React.JSX.Element {
  const siteHeaderRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const header = siteHeaderRef.current;
    if (!header) return;
    const root = document.documentElement;
    const updateHeaderHeight = (): void => {
      const height = `${Math.ceil(header.getBoundingClientRect().height)}px`;
      if (root.style.getPropertyValue("--sense-header-height") !== height) {
        root.style.setProperty("--sense-header-height", height);
      }
    };
    updateHeaderHeight();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeaderHeight);
      return () => {
        window.removeEventListener("resize", updateHeaderHeight);
        root.style.removeProperty("--sense-header-height");
      };
    }
    const observer = new ResizeObserver(updateHeaderHeight);
    observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--sense-header-height");
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="site-header" ref={siteHeaderRef}>
        <Link to="/" className="brand" aria-label="Sense Studios home">
          <span className="brand-mark">S</span>
          <span><strong>SENSE STUDIOS</strong><small>WORK MANAGEMENT</small></span>
        </Link>
        <span className="phase-badge">IDENTITY</span>
        <HeaderControls />
      </header>
      <Routes>
        <Route path="/sign-in" element={<SignInHub />} />
        <Route path="/staff/sign-in" element={<AuthHome />} />
        <Route path="/owner/sign-in" element={<AuthHome />} />
        <Route path="/staff/recovery" element={<StaffRecovery />} />
        <Route path="/" element={<AuthHome />} />
        <Route path="/workspace" element={<AuthHome legacyWorkspace />} />
        <Route path="/my-work" element={<MyWorkRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/decisions" element={<DecisionsRoute />} />
        <Route path="/notifications" element={<NotificationsRoute />} />
        <Route path="/tasks" element={<TasksRoute />} />
        <Route path="/projects" element={<ProjectsRoute readSession={readSession} />} />
        <Route path="/people" element={<PeopleRoute />} />
        <Route path="/bootstrap" element={<Bootstrap />} />
        <Route path="/enroll" element={<Enrollment />} />
        <Route path="/owner-recovery" element={<OwnerRecovery />} />
        <Route path="/documents" element={<DocumentsRoute />} />
        <Route path="/revisions" element={<RevisionsRoute />} />
        <Route path="/reviews" element={<ReviewsRoute />} />
        <Route path="/client-reviews" element={<ClientReviewsRoute />} />
        <Route path="/external-access" element={<ExternalAccessRoute />} />
        <Route path="/turnkey" element={<TurnkeyRoute />} />
        <Route path="/time" element={<TimeRoute />} />
        <Route path="/workforce" element={<WorkforceRoute />} />
        <Route path="/learning" element={<LearningRoute key="learning-legacy" />} />
        <Route path="/learning/skills" element={<LearningRoute key="learning-skills" area="skills" />} />
        <Route path="/learning/training" element={<LearningRoute key="learning-training" area="training" />} />
        <Route path="/learning/library" element={<LearningRoute key="learning-library" area="library" />} />
        <Route path="/performance" element={<PerformanceRoute key="performance" />} />
        <Route path="/project-health" element={<PerformanceRoute key="project-health" initialTab="project" focused />} />
        <Route path="/dashboard" element={<DashboardRoute key="dashboard" />} />
        <Route path="/reports" element={<DashboardRoute key="reports" initialTab="reports" focused />} />
        <Route path="/integrations" element={<IntegrationsRoute />} />
        <Route path="/automation" element={<AutomationRoute key="automation" />} />
        <Route path="/saved-reports" element={<AutomationRoute key="saved-reports" savedReportsOnly />} />
        <Route path="/assistance" element={<AiAssistanceRoute />} />
        <Route path="/site" element={<SiteRoute />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <footer className="site-footer">Sense Studios · Secure workspace</footer>
    </div>
  );
}

function ExternalAccessRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to manage external access</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><StaffExternalAccessWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} /></main></WorkspaceLayout>;
}

function TimeRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view time records</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><TimeWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} /></main></WorkspaceLayout>;
}

function WorkforceRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view workforce records</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content workforce-route"><WorkforceWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} /></main></WorkspaceLayout>;
}

function LearningRoute({ area }: { area?: "skills" | "training" | "library" }): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const legacyPanel = query.get("panel");
  const panel = area ?? (legacyPanel === "library" || (!legacyPanel && (query.has("recordId") || query.has("versionId"))) ? "library" : legacyPanel === "training" || (!legacyPanel && query.has("assignmentId")) ? "training" : legacyPanel === "skills" || (!legacyPanel && (query.has("employeeId") || query.has("ratingId") || query.has("changeId"))) ? "skills" : "legacy");
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view Learning</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  const areaLinks = [["skills", "Skills", "/learning?panel=skills"], ["training", "Training", "/learning?panel=training"], ["library", "Library", "/learning?panel=library"]] as const;
  const preservedQuery = new URLSearchParams(location.search);
  preservedQuery.delete("panel");
  const queryString = preservedQuery.toString();
  const legacyCombined = panel === "legacy";
  return <WorkspaceLayout key={session.account.id}><main className="identity-content learning-route"><nav className="learning-area-tabs" aria-label="Learning areas">{areaLinks.map(([key, label, path]) => <Link key={key} to={`${path}${queryString ? `&${queryString}` : ""}`} aria-current={panel === key ? "page" : undefined}>{label}</Link>)}</nav>{panel === "library" ? <LibraryWorkspace csrfToken={session.csrfToken} /> : panel === "training" ? <TrainingWorkspace csrfToken={session.csrfToken} /> : legacyCombined ? <SkillsTrainingWorkspace csrfToken={session.csrfToken} /> : <SkillsWorkspace csrfToken={session.csrfToken} />}</main></WorkspaceLayout>;
}

function PerformanceRoute({ initialTab = "employee", focused = false }: { initialTab?: "employee" | "project"; focused?: boolean }): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view performance records</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  const projectId = new URLSearchParams(window.location.search).get("projectId") ?? undefined;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><InsightsNavigation {...(projectId ? { projectId } : {})} /><PerformanceWorkspace csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} initialTab={initialTab} focused={focused} /></main></WorkspaceLayout>;
}

function DashboardRoute({ initialTab = "dashboard", focused = false }: { initialTab?: "dashboard" | "summaries" | "reports" | "schedules"; focused?: boolean }): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view your dashboard</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  const reportsHome = initialTab === "reports";
  return <WorkspaceLayout key={session.account.id}><main className="identity-content">{reportsHome && <InsightsNavigation />}<DashboardWorkspace accountId={session.account.id} csrfToken={session.csrfToken} owner={session.account.kind === "OWNER"} initialTab={initialTab} focused={focused} /></main></WorkspaceLayout>;
}

function IntegrationsRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to manage calendar integrations</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><IntegrationsWorkspace csrfToken={session.csrfToken} /></main></WorkspaceLayout>;
}

function AutomationRoute({ savedReportsOnly = false }: { savedReportsOnly?: boolean }): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to manage automation and reports</h1><Link to="/">Return to sign in</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content">{savedReportsOnly && <InsightsNavigation />}<AutomationWorkspace csrfToken={session.csrfToken} mode={savedReportsOnly ? "saved-reports" : "automation"} /></main></WorkspaceLayout>;
}

function SiteRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <SiteOfflineCaptureRoute />;
  if (!session) { const pointer = readOfflinePointer(); if (pointer) void purgeOfflineAccount(pointer.accountId).catch(() => undefined); if (pointer) window.dispatchEvent(new Event("sense-session-ended")); clearOfflinePointer(); return <main className="identity-content"><section className="identity-section"><h1>Sign in to view site delivery</h1><Link to="/">Return to sign in</Link></section></main>; }
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to Owner setup</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><SiteWorkspace csrfToken={session.csrfToken} accountId={session.account.id} /></main></WorkspaceLayout>;
}

function AiAssistanceRoute(): React.JSX.Element {
  const { session, failed } = useProtectedRouteSession();
  if (session === undefined && !failed) return <main className="identity-content"><p className="loading-state" role="status">Checking your session…</p></main>;
  if (failed) return <main className="identity-content"><section className="identity-section"><p className="auth-error" role="alert">We couldn’t check your session. Try again from the workspace home.</p><Link to="/">Return to workspace</Link></section></main>;
  if (!session) return <main className="identity-content"><section className="identity-section"><h1>Sign in to view evidence assistance</h1><Link to="/">Return to workspace</Link></section></main>;
  if (session.account.kind === "OWNER" && session.ownerSetupRequired) return <main className="identity-content"><section className="identity-section"><h1>Complete Owner setup first</h1><Link to="/">Return to workspace</Link></section></main>;
  return <WorkspaceLayout key={session.account.id}><main className="identity-content"><AiAssistanceWorkspace csrfToken={session.csrfToken} /></main></WorkspaceLayout>;
}
