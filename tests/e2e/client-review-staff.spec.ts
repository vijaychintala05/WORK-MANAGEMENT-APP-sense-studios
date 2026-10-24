import { approveFixtureWork } from "./review-work-fixture.js";
import { expect, test } from "@playwright/test";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "../../apps/api/src/s27-disposable-test-target.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

type FixtureDatabase = {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  end(): Promise<void>;
};

test("Owner appoints and expires a Primary Client, then publishes an approved task for review", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(process.env.S14_E2E_ENABLED !== "1" && process.env.S25_E2E_ENABLED !== "1", "Set an approved isolated client review browser acceptance flag");
  test.skip(!process.env.DATABASE_URL, "A dedicated local S14 PostgreSQL database is required");
  test.skip(Boolean(process.env.BREVO_API_KEY || process.env.BREVO_SENDER_EMAIL || process.env.BREVO_SENDER_NAME), "Run without a configured Brevo sender so no email leaves the local test");

  const databaseUrl = process.env.DATABASE_URL!;
const disposableS27Database = Boolean(process.env.DATABASE_URL && isS27DisposableTestTarget("DATABASE_URL", process.env.DATABASE_URL));
  const parsedUrl = new URL(databaseUrl);
  const designatedVerifyDatabase = /^\/sense_s13_s14_verify_20261001(?:_[a-z0-9]+)?_test$/.test(parsedUrl.pathname);
  const explicitlyEnabledS15Database = process.env.S15_E2E_ENABLED === "1" && /^\/sense_s15_[a-z0-9_]*_test$/.test(parsedUrl.pathname);
  const explicitlyEnabledS25Database = process.env.S25_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsedUrl.hostname) && ((["56433", "57433"].includes(parsedUrl.port) && /^\/sense_s25_main_s25_[a-z0-9_]+_test$/i.test(parsedUrl.pathname)) || (parsedUrl.port === "56436" && /^\/sense_s14_s25_[a-z0-9_]+_test$/i.test(parsedUrl.pathname)));
  const explicitlyEnabledS26Database = process.env.S26_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsedUrl.hostname) && parsedUrl.port === "57433" && /^\/sense_s26_main_s26_[a-z0-9_]+_test$/i.test(parsedUrl.pathname);
  const explicitlyEnabledS27Database = process.env.S27_E2E_ENABLED === "1" && parsedUrl.hostname === "127.0.0.1" && parsedUrl.port === "57433" && /^\/sense_s27_main_s27_[a-z0-9_]+_test$/.test(parsedUrl.pathname) || disposableS27Database;
  if (!["localhost", "127.0.0.1"].includes(parsedUrl.hostname) || ((!explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database) && parsedUrl.port !== "56433") || (!designatedVerifyDatabase && !explicitlyEnabledS15Database && !explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database)) {
    throw new Error("Client review staff browser fixture requires a sense_s13_s14_verify_20261001*_test or explicitly enabled sense_s15_*_test database on local PostgreSQL port 56433");
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
  const email = `s14-primary-${suffix}@example.test`;
  const projectTitle = `S14 staff review ${suffix.slice(0, 8)}`;
  const taskTitle = `Client-ready task ${suffix.slice(0, 8)}`;

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
    if (!orgResult.rows[0]) await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [organizationId, "S14 staff review browser fixture"]);
    const ownerResult = await db.query<{ id: string }>("SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE' LIMIT 1");
    const ownerAccountId = ownerResult.rows[0]?.id ?? randomUUID();
    if (!ownerResult.rows[0]) await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [ownerAccountId, `s14-staff-owner-${suffix}@example.test`]);
    const credentials = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM passkey_credentials WHERE "accountId"=$1 AND "revokedAt" IS NULL', [ownerAccountId]);
    for (let index = credentials.rows[0]!.count; index < 2; index += 1) {
      await db.query('INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4)', [randomUUID(), randomUUID(), ownerAccountId, randomBytes(32)]);
    }
    const recovery = await db.query('SELECT id FROM owner_recovery_codes WHERE "accountId"=$1 AND "usedAt" IS NULL AND "replacedAt" IS NULL AND "acknowledgedAt" IS NOT NULL LIMIT 1', [ownerAccountId]);
    if (!recovery.rows[0]) await db.query('INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [randomUUID(), ownerAccountId, hash(randomUUID())]);
    await db.query('INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [branchId, organizationId, `S14 staff ${suffix}`]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [ownerSessionId, ownerAccountId, hash(ownerSecret), hash(ownerCsrf)]);
    await db.query("COMMIT");

    const ownerHeaders = { Cookie: `sense_sid=${ownerSecret}`, Origin: baseURL!, "X-CSRF-Token": ownerCsrf };
    const projectResponse = await page.request.post("/api/v1/projects", { headers: ownerHeaders, data: { branchId, title: projectTitle, deliveryType: "DESIGN", scopes: ["Architecture"], reason: "Create isolated client review staff project" } });
    const projectBody = await projectResponse.text();
    expect(projectResponse.status(), projectBody).toBe(201);
    const project = JSON.parse(projectBody) as { project: { id: string } };

    const teamId = randomUUID(), employeeId = randomUUID(), staffAccountId = randomUUID();
    await db.query('INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)', [teamId, organizationId, branchId, `S14 review team ${suffix}`]);
    await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [staffAccountId, `s14-worker-${suffix}@example.test`]);
    await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [employeeId, organizationId, staffAccountId, branchId, teamId]);
    for (const permissionKey of ["project.view", "project.manage", "task.assign"]) await db.query('INSERT INTO employee_permission_overrides(id,"organizationId","employeeId","permissionKey",effect,"scopeKind","branchId",reason) VALUES($1,$2,$3,$4,\'ALLOW\',\'BRANCH\',$5,$6)', [randomUUID(), organizationId, employeeId, permissionKey, branchId, "Scoped S14 browser employee permissions"]);
    const command = async (path: string, data: unknown): Promise<unknown> => {
      const response = await page.request.post(path, { headers: ownerHeaders, data });
      const body = await response.text();
      expect(response.status(), body).toBe(201);
      return JSON.parse(body) as unknown;
    };
    await command(`/api/v1/projects/${project.project.id}/assignments`, { employeeId, expectedVersion: 1, reason: "Assign staff task owner" });
    const assignedVersion = (await db.query<{ version: number }>('SELECT version FROM projects WHERE id=$1', [project.project.id])).rows[0]!.version;
    await command(`/api/v1/projects/${project.project.id}/lead`, { employeeId, expectedVersion: assignedVersion, reason: "Assign staff review lead" });
    const projectVersion = (await db.query<{ version: number }>('SELECT version FROM projects WHERE id=$1', [project.project.id])).rows[0]!.version;
    await command(`/api/v1/projects/${project.project.id}/status`, { toStatus: "ACTIVE", expectedVersion: projectVersion, reason: "Activate client review project" });
    const task = await command("/api/v1/tasks", { projectId: project.project.id, ownerEmployeeId: employeeId, title: taskTitle, type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: "CLIENT", reason: "Create client review task" }) as { id: string; version: number };
    await command(`/api/v1/tasks/${task.id}/state`, { toState: "IN_PROGRESS", expectedVersion: task.version, reason: "Start client review task" });

    await approveFixtureWork({ page, db, origin: baseURL!, ownerHeaders, projectId: project.project.id, taskId: task.id, workerAccountId: staffAccountId, workerEmployeeId: employeeId, manualPublication: true });

    await context.addCookies([{ name: "sense_sid", value: ownerSecret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    await page.goto("/client-reviews");
    const workspace = page.locator(".client-review-workspace");
    await expect(workspace.getByRole("heading", { name: "Client reviews" })).toBeVisible();
    await workspace.getByLabel("Active project").selectOption(project.project.id);
    await expect(workspace.getByLabel("Primary Client email")).toBeVisible();
    await workspace.getByLabel("Primary Client email").fill(email);
    await workspace.getByLabel("Reason for appointment or replacement").fill("Appoint the Primary Client for this project");
    const primaryResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/client-access/projects/${project.project.id}/primary`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Set Primary Client" }).click();
    const primaryResult = await primaryResponse;
    expect(primaryResult.status(), await primaryResult.text()).toBe(201);
    await expect(workspace.locator(".client-review-access-list")).toContainText(email);

    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await workspace.getByLabel("Reason for appointment or replacement").fill("Set a future client access expiry");
    await workspace.getByLabel("New expiry").fill(expiry);
    const expiryResponse = page.waitForResponse((response) => /\/api\/v1\/client-access\/grants\/.+/.test(response.url()) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Set expiry" }).click();
    const expiryResult = await expiryResponse;
    expect(expiryResult.status(), await expiryResult.text()).toBe(201);
    await page.reload();
    await workspace.getByLabel("Active project").selectOption(project.project.id);
    await expect(workspace.locator(".client-review-access-list")).toContainText(email);
    const savedGrant = await db.query<{ expiresAt: Date | null }>('SELECT "expiresAt" FROM client_portal_grants WHERE "projectId"=$1 AND "primary"=true AND "revokedAt" IS NULL', [project.project.id]);
    expect(savedGrant.rows).toHaveLength(1);
    expect(savedGrant.rows[0]!.expiresAt?.toISOString().slice(0, 10)).toBe(expiry);

    await workspace.getByLabel("Package title").fill("Initial client package");
    await workspace.getByLabel("Task", { exact: true }).selectOption(task.id);
    await workspace.getByLabel("Approved evidence").selectOption("approved-work");
    await workspace.getByLabel("Reason", { exact: true }).last().fill("Publish the internally approved client task");
    const packageResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/client-reviews/projects/${project.project.id}/packages`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Send for client review" }).click();
    const packageResult = await packageResponse;
    expect(packageResult.status(), await packageResult.text()).toBe(201);
    await expect(workspace.getByText("Client review package sent.")).toBeVisible();
    await expect(workspace.getByText(taskTitle)).toBeVisible();
    await expect.poll(async () => (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM client_review_packages WHERE "projectId"=$1', [project.project.id])).rows[0]?.count).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("s14-client-review-staff.png") });
  } finally {
    await db.end();
  }
});
