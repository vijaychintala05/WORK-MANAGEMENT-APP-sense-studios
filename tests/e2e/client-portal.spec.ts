import { approveFixtureWork } from "./review-work-fixture.js";
import { expect, test } from "@playwright/test";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "../../apps/api/src/s27-disposable-test-target.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type FixtureDatabase = {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  end(): Promise<void>;
};

test("client portal isolated sign-in, passkey item/final approval, persisted review and revocation", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(process.env.S14_E2E_ENABLED !== "1" && process.env.S24_E2E_ENABLED !== "1" && process.env.S25_E2E_ENABLED !== "1", "Set an approved isolated client browser acceptance flag");
  test.skip(!process.env.DATABASE_URL, "Dedicated local S14 PostgreSQL database required");
  test.skip(!process.env.EMAIL_VERIFICATION_SECRET, "EMAIL_VERIFICATION_SECRET is required for the local S14 code fixture");
  test.skip(Boolean(process.env.BREVO_API_KEY || process.env.BREVO_SENDER_EMAIL || process.env.BREVO_SENDER_NAME), "Run without a configured Brevo sender so no email leaves the local test");

  const databaseUrl = process.env.DATABASE_URL!;
const disposableS27Database = Boolean(process.env.DATABASE_URL && isS27DisposableTestTarget("DATABASE_URL", process.env.DATABASE_URL));
  const parsedUrl = new URL(databaseUrl);
  const dedicatedS14Database = parsedUrl.port === "56434" && /^\/sense_s14_[a-z0-9_]*_test$/.test(parsedUrl.pathname);
  const designatedVerifyDatabase = parsedUrl.port === "56433" && /^\/sense_s13_s14_verify_20261001(?:_[a-z0-9]+)?_test$/.test(parsedUrl.pathname);
  const explicitlyEnabledS15Database = process.env.S15_E2E_ENABLED === "1" && parsedUrl.port === "56433" && /^\/sense_s15_[a-z0-9_]*_test$/.test(parsedUrl.pathname);
  const explicitlyEnabledS24Database = process.env.S24_E2E_ENABLED === "1" && parsedUrl.port === "56433" && /^\/sense_[a-z0-9_]*s24_[a-z0-9_]*_test$/.test(parsedUrl.pathname);
  const explicitlyEnabledS25Database = process.env.S25_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsedUrl.hostname) && ((["56433", "57433"].includes(parsedUrl.port) && /^\/sense_s25_main_s25_[a-z0-9_]+_test$/i.test(parsedUrl.pathname)) || (parsedUrl.port === "56436" && /^\/sense_s14_s25_[a-z0-9_]+_test$/i.test(parsedUrl.pathname)));
  const explicitlyEnabledS26Database = process.env.S26_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsedUrl.hostname) && parsedUrl.port === "57433" && /^\/sense_s26_main_s26_[a-z0-9_]+_test$/i.test(parsedUrl.pathname);
  const explicitlyEnabledS27Database = process.env.S27_E2E_ENABLED === "1" && parsedUrl.hostname === "127.0.0.1" && parsedUrl.port === "57433" && /^\/sense_s27_main_s27_[a-z0-9_]+_test$/.test(parsedUrl.pathname) || disposableS27Database;
  if (!["localhost", "127.0.0.1"].includes(parsedUrl.hostname) || (!dedicatedS14Database && !designatedVerifyDatabase && !explicitlyEnabledS15Database && !explicitlyEnabledS24Database && !explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database)) {
    throw new Error("Client portal browser fixture requires its dedicated local S14 database, an explicitly enabled approved S13/S15 target, or an explicitly enabled S24 _test target on port 56433");
  }

  const require = createRequire(resolve("apps/api/package.json"));
  const { Client } = require("pg") as { Client: new (config: { connectionString: string }) => FixtureDatabase };
  const db = new Client({ connectionString: databaseUrl });
  const suffix = randomUUID();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const ownerSecret = randomBytes(32).toString("base64url");
  const ownerCsrf = createHmac("sha256", ownerSecret).update("csrf").digest("base64url");
  const ownerSessionId = randomUUID();
  const branchId = randomUUID();
  const clientEmail = `s14-client-auth-${suffix}@example.test`;
  const projectTitle = `S14 client auth ${suffix.slice(0, 8)}`;
  const sessionName = "sense_client_sid";
  const internalRequests: string[] = [];
  const clientRequests: string[] = [];
  let cdp: import("@playwright/test").CDPSession | undefined;

  await db.connect();
  if (disposableS27Database) {
    const identity = await db.query<{ database: string; port: number }>("SELECT current_database() AS database, inet_server_port() AS port");
    if (!matchesS27DisposableServer(process.env.DATABASE_URL!, identity.rows[0]!.database, identity.rows[0]!.port)) throw new Error("Connected PostgreSQL server does not match the guarded S27 disposable target");
  }
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(2602)");
    await db.query("SELECT pg_advisory_xact_lock(6092706)");
    const orgResult = await db.query<{ id: string }>("SELECT id FROM organizations LIMIT 1");
    const organizationId = orgResult.rows[0]?.id ?? randomUUID();
    if (!orgResult.rows[0]) {
      await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [organizationId, "S14 client portal browser fixture"]);
    }
    const ownerResult = await db.query<{ id: string }>("SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE' LIMIT 1");
    const ownerAccountId = ownerResult.rows[0]?.id ?? randomUUID();
    if (!ownerResult.rows[0]) {
      await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [ownerAccountId, `s14-browser-owner-${suffix}@example.test`]);
    }
    const credentialCount = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM passkey_credentials WHERE "accountId"=$1 AND "revokedAt" IS NULL', [ownerAccountId]);
    for (let index = credentialCount.rows[0]!.count; index < 2; index += 1) {
      await db.query('INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4)', [randomUUID(), randomUUID(), ownerAccountId, randomBytes(32)]);
    }
    const recoveryCode = await db.query('SELECT id FROM owner_recovery_codes WHERE "accountId"=$1 AND "usedAt" IS NULL AND "replacedAt" IS NULL AND "acknowledgedAt" IS NOT NULL LIMIT 1', [ownerAccountId]);
    if (!recoveryCode.rows[0]) {
      await db.query('INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [randomUUID(), ownerAccountId, hash(randomUUID())]);
    }
    await db.query('INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [branchId, organizationId, `S14 portal ${suffix}`]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [ownerSessionId, ownerAccountId, hash(ownerSecret), hash(ownerCsrf)]);
    await db.query("COMMIT");

    const ownerHeaders = {
      Cookie: `sense_sid=${ownerSecret}`,
      Origin: baseURL!,
      "X-CSRF-Token": ownerCsrf
    };
    const projectResponse = await page.request.post("/api/v1/projects", {
      headers: ownerHeaders,
      data: { branchId, title: projectTitle, deliveryType: "DESIGN", scopes: ["Architecture"], reason: "Create isolated client portal auth project" }
    });
    const projectBody = await projectResponse.text();
    expect(projectResponse.status(), projectBody).toBe(201);
    const project = JSON.parse(projectBody) as { project: { id: string; version: number } };
    const grantResponse = await page.request.post(`/api/v1/client-access/projects/${project.project.id}/primary`, {
      headers: ownerHeaders,
      data: {
        email: clientEmail,
        expectedProjectVersion: 1,
        expectedPrimaryGrantId: null,
        reason: "Appoint Primary Client for isolated sign-in acceptance"
      }
    });
    const grantBody = await grantResponse.text();
    expect(grantResponse.status(), grantBody).toBe(201);
    const client = await db.query<{ id: string }>('SELECT id FROM accounts WHERE "normalizedEmail"=$1 AND kind=\'CLIENT\'', [clientEmail]);
    expect(client.rows).toHaveLength(1);
    const clientAccountId = client.rows[0]!.id;
    const workerAccountId = randomUUID(), workerEmployeeId = randomUUID(), teamId = randomUUID();
    await db.query('INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") SELECT $1,"organizationId",id,$2,CURRENT_TIMESTAMP FROM branches WHERE id=$3', [teamId, `S14 review team ${suffix}`, branchId]);
    await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [workerAccountId, `s14-worker-${suffix}@example.test`]);
    await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") SELECT $1,"organizationId",$2,id,$3,CURRENT_DATE,CURRENT_TIMESTAMP FROM branches WHERE id=$4', [workerEmployeeId, workerAccountId, teamId, branchId]);
    for (const permission of ["project.view", "project.manage", "task.assign"]) await db.query('INSERT INTO employee_permission_overrides(id,"organizationId","employeeId","permissionKey",effect,"scopeKind","branchId",reason) SELECT $1,"organizationId",$2,$3,\'ALLOW\',\'BRANCH\',id,$4 FROM branches WHERE id=$5', [randomUUID(), workerEmployeeId, permission, "S14 browser scoped project permissions", branchId]);
    const command = async (path: string, data: unknown) => {
      const result = await page.request.post(path, { headers: ownerHeaders, data });
      expect(result.status(), await result.text()).toBe(201);
      return result.json();
    };
    await command(`/api/v1/projects/${project.project.id}/assignments`, { employeeId: workerEmployeeId, expectedVersion: 1, reason: "Assign browser client brief owner" });
    await command(`/api/v1/projects/${project.project.id}/lead`, { employeeId: workerEmployeeId, expectedVersion: 2, reason: "Assign browser Design Project Lead" });
    await command(`/api/v1/projects/${project.project.id}/status`, { toStatus: "ACTIVE", expectedVersion: 3, reason: "Activate browser Design client review" });
    const task = await command("/api/v1/tasks", { projectId: project.project.id, ownerEmployeeId: workerEmployeeId, title: "Design approval brief", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: "CLIENT", reason: "Create browser client approval brief" }) as { id: string; version: number };
    await command(`/api/v1/tasks/${task.id}/state`, { toState: "IN_PROGRESS", expectedVersion: task.version, reason: "Start browser client brief" });
    const approvedWork = await approveFixtureWork({ page, db, origin: baseURL!, ownerHeaders, projectId: project.project.id, taskId: task.id, workerAccountId, workerEmployeeId, manualPublication: true });
    const reviewPackage = await command(`/api/v1/client-reviews/projects/${project.project.id}/packages`, { title: "Design brief approval", reason: "Publish browser client approval brief", items: [{ taskId: task.id, expectedTaskVersion: approvedWork.version, workSubmissionId: approvedWork.submissionId, label: "Design approval brief" }] }) as { id: string };

    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/v1/client-portal/")) clientRequests.push(path);
      if (["/api/v1/auth/", "/api/v1/org/", "/api/v1/projects", "/api/v1/tasks", "/api/v1/crm", "/api/v1/client-access/"].some((prefix) => path.startsWith(prefix))) {
        internalRequests.push(path);
      }
    });
    await context.clearCookies();
    await page.goto("/client-portal/");
    await expect(page.getByRole("heading", { name: "Client portal sign in" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("s14-client-portal-sign-in.png") });

    await page.getByLabel("Email address").fill(clientEmail);
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(page.getByRole("status")).toContainText("If this address has access, a code has been sent.");

    const testCode = String(100_000 + Math.floor(Math.random() * 900_000));
    const codeHash = createHmac("sha256", process.env.EMAIL_VERIFICATION_SECRET!)
      .update(`${clientAccountId}:${clientEmail}:${testCode}`)
      .digest("hex");
    const replaced = await db.query(
      'UPDATE client_portal_codes SET "codeHash"=$1,"expiresAt"=CURRENT_TIMESTAMP+interval \'10 minutes\',"attempts"=0,"consumedAt"=NULL WHERE "accountId"=$2',
      [codeHash, clientAccountId]
    );
    expect(replaced.rowCount).toBe(1);

    await page.getByLabel("One-time code").fill(testCode);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Client portal account" })).toBeVisible();
    await expect(page.getByText(clientEmail, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Client portal account" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account security", exact: true })).toBeVisible();
    await expect(page.getByText("0 registered passkeys")).toBeVisible();

    const cookies = await context.cookies(baseURL!);
    expect(cookies.map((cookie) => cookie.name)).toContain(sessionName);
    expect(cookies.map((cookie) => cookie.name)).not.toContain("sense_sid");
    expect(cookies.find((cookie) => cookie.name === sessionName)).toMatchObject({ httpOnly: true });
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);

    cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });
    await page.getByRole("button", { name: "Register a passkey" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Passkey registered." })).toHaveText("Passkey registered.");
    await expect(page.getByText("1 registered passkey")).toBeVisible();
    if (await page.getByRole("button", { name: "Open project dashboard", exact: true }).count()) await page.getByRole("button", { name: "Open project dashboard", exact: true }).click();
    const clientDashboard = page.locator(".client-dashboard");
    await expect(clientDashboard.getByRole("heading", { name: "Project dashboard" })).toBeVisible();
    await expect(clientDashboard).toContainText("Project status");
    await expect(clientDashboard).toContainText("ACTIVE");
    await expect(clientDashboard).toContainText("Shared approvals");
    await expect(clientDashboard).toContainText("0 / 1");
    await expect(clientDashboard.getByRole("heading", { name: "Recent submitted packages" })).toBeVisible();
    await expect(clientDashboard).toContainText("Design brief approval");
    await expect(clientDashboard.getByRole("heading", { name: "Reviews available to you" })).toBeVisible();
    await expect(clientDashboard).toContainText("Design approval brief");
    await expect(clientDashboard.getByRole("heading", { name: "Approved shared items" })).toBeVisible();
    await expect(clientDashboard).toContainText("There are no current gallery items available to your account.");
    const clientScreenshotDirectory = resolve(process.env.S24_SCREENSHOT_DIR ?? ".env.s24-tools/screenshots");
    mkdirSync(clientScreenshotDirectory, { recursive: true });
    const pendingDashboardCapture = await page.screenshot({ path: testInfo.outputPath("s24-client-dashboard-pending.png"), fullPage: true });
    writeFileSync(join(clientScreenshotDirectory, `s24-client-dashboard-pending-${testInfo.project.name}.png`), pendingDashboardCapture);
    if (await page.getByRole("button", { name: "Open project reviews", exact: true }).count()) await page.getByRole("button", { name: "Open project reviews", exact: true }).click();
    await page.getByRole("button", { name: /Design approval brief/ }).click();
    await page.getByLabel("Reason", { exact: true }).last().fill("Approve the exact Design brief");
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve with passkey", exact: true })).toBeVisible();
    await page.getByLabel("Typed signature", { exact: true }).fill("S14 Primary Client");
    await page.getByRole("checkbox", { name: "I consent to record this as my electronic approval." }).check();
    await page.getByRole("button", { name: "Approve with passkey", exact: true }).click();
    await expect(page.getByRole("button", { name: "Record final approval", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "I consent to record this as my final electronic approval." }).check();
    await page.getByRole("button", { name: "Record final approval", exact: true }).click();
    await expect.poll(async () => (await db.query('SELECT id FROM client_final_approvals WHERE "packageId"=$1 AND "accountId"=$2', [reviewPackage.id, clientAccountId])).rows.length).toBe(1);
    await page.reload();
    await page.getByRole("button", { name: "Open project reviews", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Client review", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Design approval brief/ }).click();
    await expect(page.getByText("Final overall approval", { exact: true })).not.toBeVisible();
    if (await page.getByRole("button", { name: "Open project dashboard", exact: true }).count()) await page.getByRole("button", { name: "Open project dashboard", exact: true }).click();
    const approvedDashboard = page.locator(".client-dashboard");
    await approvedDashboard.getByRole("button", { name: "Refresh" }).click();
    await expect(approvedDashboard).toContainText("1 / 1");
    await expect(approvedDashboard).toContainText("Design approval brief");
    const approvedDashboardCapture = await page.screenshot({ path: testInfo.outputPath("s24-client-dashboard-approved.png"), fullPage: true });
    writeFileSync(join(clientScreenshotDirectory, `s24-client-dashboard-approved-${testInfo.project.name}.png`), approvedDashboardCapture);
    if (await page.getByRole("button", { name: "Open project reviews", exact: true }).count()) await page.getByRole("button", { name: "Open project reviews", exact: true }).click();
    await page.getByRole("button", { name: /Design approval brief/ }).click();
    const selectedContrast = await page.locator('.client-review-item-list button[aria-current="true"]').evaluate((button) => {
      const luminance = (rgb: string): number => {
        const channels = rgb.match(/\d+/g)!.slice(0, 3).map((value) => { const channel = Number(value) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      const background = luminance(getComputedStyle(button).backgroundColor);
      const text = luminance(getComputedStyle(button.querySelector("small")!).color);
      return (Math.max(background, text) + 0.05) / (Math.min(background, text) + 0.05);
    });
    expect(selectedContrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: testInfo.outputPath("s14-client-review-approved.png"), fullPage: true });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Account security", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Client portal account", exact: true })).toBeVisible();
    await expect(page.getByText("1 registered passkey")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("s14-client-portal-security.png") });

    const passkeys = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM passkey_credentials WHERE "accountId"=$1 AND "revokedAt" IS NULL', [clientAccountId]);
    expect(passkeys.rows[0]?.count).toBe(1);
    const clientCookies = await context.cookies(baseURL!);
    expect(clientCookies.filter((cookie) => cookie.name.endsWith("sense_client_sid"))).toHaveLength(1);
    expect(clientCookies.some((cookie) => cookie.name.endsWith("sense_sid"))).toBe(false);

    const internalSetup = await page.request.get("/api/v1/projects/setup");
    expect(internalSetup.status()).toBe(401);
    expect(internalRequests).toEqual([]);
    expect(clientRequests).toContain("/api/v1/client-portal/projects");
    expect(clientRequests).toContain(`/api/v1/client-portal/reviews/projects/${project.project.id}`);
    expect(clientRequests).toContain(`/api/v1/client-portal/projects/${project.project.id}/gallery`);
    expect(clientRequests.some((path) => path.startsWith("/api/v1/dashboard") || path.startsWith("/api/v1/reports"))).toBe(false);

    const currentPortalSession = await db.query<{ id: string }>('SELECT id FROM client_portal_sessions WHERE "accountId"=$1 AND "revokedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1', [clientAccountId]);
    expect(currentPortalSession.rows).toHaveLength(1);
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("heading", { name: "Client portal sign in" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("This session was revoked. Sign in again to continue.");
    const revoked = await db.query<{ revokedAt: Date | null }>('SELECT "revokedAt" FROM client_portal_sessions WHERE id=$1 AND "accountId"=$2', [currentPortalSession.rows[0]!.id, clientAccountId]);
    expect(revoked.rows[0]?.revokedAt).not.toBeNull();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Client portal sign in" })).toBeVisible();
    expect(internalRequests).toEqual([]);
    const endingCookies = await context.cookies(baseURL!);
    expect(endingCookies.some((cookie) => cookie.name === sessionName)).toBe(false);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(mobileOverflow).toBe(false);

    await context.addCookies([{ name: "sense_sid", value: ownerSecret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    await page.goto("/client-reviews");
    const staffReviews = page.locator(".client-review-workspace");
    await staffReviews.getByLabel("Active project").selectOption(project.project.id);
    await expect(staffReviews.getByRole("button", { name: "Complete approved task" })).toBeVisible();
    await staffReviews.getByLabel("Reason", { exact: true }).fill("Complete the Primary-approved Design delivery");
    await staffReviews.getByRole("button", { name: "Complete approved task" }).click();
    await expect(staffReviews.getByText("Approved task completed.")).toBeVisible();
    await expect.poll(async () => (await db.query<{ status: string }>('SELECT status FROM tasks WHERE id=$1', [task.id])).rows[0]?.status).toBe("COMPLETED");
    await page.reload();
    await staffReviews.getByLabel("Active project").selectOption(project.project.id);
    await expect(staffReviews.getByText("Design approval brief", { exact: true })).toBeVisible();
    await expect(staffReviews.getByRole("button", { name: "Complete approved task" })).not.toBeVisible();
    await page.goto(`/projects?projectId=${encodeURIComponent(project.project.id)}&projectSection=documents`);
    const confirmed = page.getByRole("region", { name: "Confirmed drawings", exact: true });
    await expect(confirmed.getByText("Design approval brief", { exact: true })).toBeVisible();
    await expect(confirmed.getByText(/Approved link/)).toBeVisible();
    await expect(confirmed.getByRole("link", { name: "Open approved link" })).toHaveAttribute("target", "_blank");
    await expect(confirmed.getByText("External content may change; the approved URL is preserved.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("review-confirmed-approved-link.png"), fullPage: true });

  } finally {
    if (cdp) await cdp.detach();
    await db.end();
  }
});
