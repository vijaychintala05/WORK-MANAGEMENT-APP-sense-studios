import { test, expect } from "@playwright/test";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "../../apps/api/src/s27-disposable-test-target.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureUrl = process.env.DATABASE_URL;
const disposableS27Database = Boolean(process.env.DATABASE_URL && isS27DisposableTestTarget("DATABASE_URL", process.env.DATABASE_URL));
const screenshotDirectory = resolve(process.env.S23_SCREENSHOT_DIR ?? ".env.s23-tools/screenshots");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

test("Owner configures test-only policies, publishes source-backed snapshots and reviews persist for staff", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  test.skip((process.env.S23_E2E_ENABLED !== "1" && process.env.S25_E2E_ENABLED !== "1" && process.env.S27_E2E_ENABLED !== "1") || !fixtureUrl, "Set an approved isolated S23, S25, or S27 database acceptance flag");
  const parsed = new URL(fixtureUrl!);
  const explicitlyEnabledS23Database = process.env.S23_E2E_ENABLED === "1" && /^\/?sense_s15_s19_s17_s20_s22_s23_(?:s24_)?[a-z0-9_]+_test$/i.test(parsed.pathname);
  const explicitlyEnabledS25Database = process.env.S25_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsed.hostname) && ((["56433", "57433"].includes(parsed.port) && /^\/sense_s25_main_s25_[a-z0-9_]+_test$/i.test(parsed.pathname)) || (parsed.port === "57433" && /^\/sense_s23_s25_[a-z0-9_]+_test$/i.test(parsed.pathname)));
  const explicitlyEnabledS26Database = process.env.S26_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "57433" && /^\/sense_s26_main_s26_[a-z0-9_]+_test$/i.test(parsed.pathname);
  const explicitlyEnabledS27Database = process.env.S27_E2E_ENABLED === "1" && parsed.hostname === "127.0.0.1" && parsed.port === "57433" && /^\/sense_s27_main_s27_[a-z0-9_]+_test$/.test(parsed.pathname) || disposableS27Database;
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || ((!explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database) && parsed.port !== "56433") || (!explicitlyEnabledS23Database && !explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database)) throw new Error("Performance browser acceptance requires an explicitly enabled isolated S23 or exact S25/S26/S27 database on a local test port");
  const require = createRequire(resolve("apps/api/package.json"));
  const { Client } = require("pg") as typeof import("pg");
  const db = new Client({ connectionString: fixtureUrl });
  const suffix = randomUUID().slice(0, 8);
  const employeeEmail = `s23-test-${suffix}@example.test`;
  const employeeSecret = randomBytes(32).toString("base64url");
  const employeeCsrf = createHmac("sha256", employeeSecret).update("csrf").digest("base64url");
  const reviewerSecret = randomBytes(32).toString("base64url");
  const reviewerCsrf = createHmac("sha256", reviewerSecret).update("csrf").digest("base64url");
  const employeeId = randomUUID(), employeeAccountId = randomUUID(), reviewerId = randomUUID(), reviewerAccountId = randomUUID();
  let taskStatusId: string;
  const ownerAccountId = randomUUID();
  const branchId = randomUUID(), teamId = randomUUID();
  let fixtureBranchId: string;
  const ownerSecret = randomBytes(32).toString("base64url");
  const ownerCsrf = createHmac("sha256", ownerSecret).update("csrf").digest("base64url");
  await db.connect();
  if (disposableS27Database) {
    const identity = await db.query<{ database: string; port: number }>("SELECT current_database() AS database, inet_server_port() AS port");
    if (!matchesS27DisposableServer(process.env.DATABASE_URL!, identity.rows[0]!.database, identity.rows[0]!.port)) throw new Error("Connected PostgreSQL server does not match the guarded S27 disposable target");
  }
  try {
    // The preceding identity E2E deliberately deletes its Owner. Provision a
    // local fixture identity with the same readiness records used by other
    // browser specs; no production account or credential is touched.
    const owner = await db.query<{ id: string }>("SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE' LIMIT 1");
    if (!owner.rows[0]) {
      await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [ownerAccountId, `s23-owner-${suffix}@example.test`]);
      await db.query('INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4),($5,$6,$3,$7)', [randomUUID(), randomUUID(), ownerAccountId, randomBytes(32), randomUUID(), randomUUID(), randomBytes(32)]);
      await db.query('INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [randomUUID(), ownerAccountId, digest(randomUUID())]);
      owner.rows.push({ id: ownerAccountId });
    }
    let home = await db.query<{ organizationId: string; branchId: string; teamId: string }>('SELECT "organizationId", "homeBranchId" AS "branchId", "homeTeamId" AS "teamId" FROM employees WHERE state=\'ACTIVE\' LIMIT 1');
    if (!home.rows[0]) {
      const organization = await db.query<{ id: string }>("SELECT id FROM organizations LIMIT 1");
      const organizationId = organization.rows[0]?.id ?? randomUUID();
      if (!organization.rows[0]) await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [organizationId, `S23 browser fixture ${suffix}`]);
      await db.query('INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [branchId, organizationId, `S23 browser ${suffix}`]);
      await db.query('INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)', [teamId, organizationId, branchId, `S23 browser team ${suffix}`]);
      home = { ...home, rows: [{ organizationId, branchId, teamId }] };
    }
    fixtureBranchId = home.rows[0].branchId;
    await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [employeeAccountId, employeeEmail]);
    await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [employeeId, home.rows[0].organizationId, employeeAccountId, home.rows[0].branchId, home.rows[0].teamId]);
    await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [reviewerAccountId, `s23-reviewer-${suffix}@example.test`]);
    await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [reviewerId, home.rows[0].organizationId, reviewerAccountId, home.rows[0].branchId, home.rows[0].teamId]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'2 hours\')', [randomUUID(), owner.rows[0].id, digest(ownerSecret), digest(ownerCsrf)]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'2 hours\')', [randomUUID(), employeeAccountId, digest(employeeSecret), digest(employeeCsrf)]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'2 hours\')', [randomUUID(), reviewerAccountId, digest(reviewerSecret), digest(reviewerCsrf)]);
    for (const [targetId, permission] of [[employeeId, "project.view"], [employeeId, "project.manage"], [reviewerId, "project.view"], [reviewerId, "review.decide"]]) await db.query('INSERT INTO employee_permission_overrides(id,"organizationId","employeeId","permissionKey",effect,"scopeKind","branchId",reason) VALUES($1,$2,$3,$4,\'ALLOW\',\'BRANCH\',$5,$6)', [randomUUID(), home.rows[0].organizationId, targetId, permission, home.rows[0].branchId, "Explicit S23 browser source fixture grant"]);
    await context.addCookies([{ name: "sense_sid", value: ownerSecret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
  } finally { await db.end(); }

  await mkdir(screenshotDirectory, { recursive: true });
  const apiPost = async <T>(path: string, secret: string, csrf: string, payload: Record<string, unknown>): Promise<T> => {
    const response = await page.request.post(path, { headers: { Cookie: `sense_sid=${secret}`, Origin: baseURL!, "X-CSRF-Token": csrf }, data: payload });
    const body = await response.json().catch(() => ({})) as T & { message?: string };
    if (!response.ok()) throw new Error(`S23 fixture POST ${path} failed (${response.status()}): ${JSON.stringify(body)}`);
    return body;
  };
  const fillReason = async (value: string) => {
    const input = page.getByLabel("Reason for this action (required)");
    await expect(input).toBeEnabled();
    await input.fill(value);
  };
  const createdProject = await apiPost<{ project: { id: string; version: number } }>("/api/v1/projects", ownerSecret, ownerCsrf, { branchId: fixtureBranchId, title: `S23 performance ${suffix}`, deliveryType: "DESIGN", scopes: ["Fictional review scope"], reason: "Create fictional S23 acceptance project" });
  const projectId = createdProject.project.id;
  let projectVersion = createdProject.project.version;
  for (const employee of [employeeId, reviewerId]) {
    const assignment = await apiPost<{ project?: { version: number }; version?: number }>(`/api/v1/projects/${projectId}/assignments`, ownerSecret, ownerCsrf, { employeeId: employee, expectedVersion: projectVersion, reason: "Assign fictional S23 source participants" });
    projectVersion = assignment.project?.version ?? assignment.version ?? projectVersion + 1;
  }
  const lead = await apiPost<{ project?: { version: number }; version?: number }>(`/api/v1/projects/${projectId}/lead`, ownerSecret, ownerCsrf, { employeeId, expectedVersion: projectVersion, reason: "Name fictional S23 project lead" });
  projectVersion = lead.project?.version ?? lead.version ?? projectVersion + 1;
  await apiPost(`/api/v1/projects/${projectId}/status`, ownerSecret, ownerCsrf, { toStatus: "ACTIVE", expectedVersion: projectVersion, reason: "Activate fictional S23 evidence project" });
  const createdTask = await apiPost<{ id: string; version: number }>("/api/v1/tasks", ownerSecret, ownerCsrf, { projectId, ownerEmployeeId: employeeId, title: `S23 reviewed on-time evidence ${suffix}`, type: "PROJECT", priority: "MEDIUM", targetDate: today, reviewRequirement: "INTERNAL", reason: "Create fictional task through the real work service" });
  const taskId = createdTask.id;
  const assignedReviewer = await apiPost<{ task: { version: number } }>(`/api/v1/reviews/tasks/${taskId}/reviewer`, ownerSecret, ownerCsrf, { employeeId: reviewerId, expectedVersion: createdTask.version, reason: "Assign independent fictional S23 reviewer" });
  const startedTask = await apiPost<{ id: string; version: number }>(`/api/v1/tasks/${taskId}/state`, ownerSecret, ownerCsrf, { toState: "IN_PROGRESS", expectedVersion: assignedReviewer.task.version, reason: "Start fictional reviewed work through the real task service" });
  const submitted = await apiPost<{ task: { version: number }; rounds: Array<{ id: string }> }>(`/api/v1/reviews/tasks/${taskId}/submit`, employeeSecret, employeeCsrf, { reviewUrl: "https://files.sensestudios.com/e2e/performance-work", expectedVersion: startedTask.version, reason: "Submit fictional work for independent review" });
  const roundId = submitted.rounds[0]!.id;
  await apiPost(`/api/v1/reviews/rounds/${roundId}/start`, reviewerSecret, reviewerCsrf, { reason: "Start the independent fictional review" });
  const decided = await apiPost<{ task: { version: number } }>(`/api/v1/reviews/rounds/${roundId}/decision`, reviewerSecret, reviewerCsrf, { kind: "APPROVED", reason: "Approve fictional first-pass work" });
  await apiPost(`/api/v1/reviews/tasks/${taskId}/complete`, employeeSecret, employeeCsrf, { expectedVersion: decided.task.version, reason: "Complete accepted fictional work through the real review service" });
  const readDb = new Client({ connectionString: fixtureUrl });
  await readDb.connect();
  try {
    taskStatusId = (await readDb.query<{ id: string }>('SELECT id FROM task_status_changes WHERE "taskId"=$1 ORDER BY "taskVersion" DESC LIMIT 1', [taskId])).rows[0]?.id ?? "";
  } finally { await readDb.end(); }
  await page.goto("/performance");
  await expect(page.getByRole("heading", { name: "Performance" })).toBeVisible();
  await page.getByLabel("Employee").selectOption({ label: employeeEmail });
  await expect(page.getByText("Policy not configured")).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate employee snapshot/i })).toBeDisabled();
  await page.screenshot({ path: resolve(screenshotDirectory, `performance-${testInfo.project.name}-no-policy.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const editor = page.getByText("Owner policy setup and approval").locator("..");
  await editor.getByLabel("Policy family").selectOption("EMPLOYEE");
  await editor.getByLabel("Role group key").fill(`TEST-${suffix}`);
  await editor.getByLabel("Label").fill(`Fictional S23 browser policy ${suffix}`);
  await editor.getByLabel("Effective from").fill(today);
  const employeeComponents = editor.locator(".perf-component");
  await editor.getByRole("button", { name: "Add measurable source" }).click();
  await employeeComponents.nth(0).getByLabel("Metric").selectOption("REVIEW_FIRST_PASS");
  await editor.getByRole("button", { name: "Add measurable source" }).click();
  await employeeComponents.nth(1).getByLabel("Metric").selectOption("TASK_ON_TIME");
  await employeeComponents.nth(0).getByLabel("Weight").fill("90");
  await employeeComponents.nth(0).getByLabel("Minimum").fill("0");
  await employeeComponents.nth(0).getByLabel("Maximum").fill("100");
  await employeeComponents.nth(1).getByLabel("Weight").fill("10");
  await employeeComponents.nth(1).getByLabel("Minimum").fill("0");
  await employeeComponents.nth(1).getByLabel("Maximum").fill("100");
  await employeeComponents.nth(1).getByLabel("Required evidence").uncheck();
  await editor.getByLabel("Attendance maximum weight").fill("0");
  await editor.getByLabel("Efficiency maximum weight").fill("0");
  await editor.getByLabel("Strength at or above").fill("80");
  await editor.getByLabel("Weakness below").fill("50");
  await editor.getByLabel("Critical below").fill("25");
  await editor.getByLabel("Delayed below").fill("50");
  await editor.getByLabel("At Risk below").fill("75");
  await fillReason("Create explicitly fictional S23 browser policy");
  await editor.getByRole("button", { name: "Save policy draft" }).click();
  const employeePolicyCard = page.getByText(new RegExp(`Fictional S23 browser policy ${suffix} · EMPLOYEE/TEST-${suffix}`)).locator("..");
  await expect(employeePolicyCard).toBeVisible();
  await fillReason("Approve explicitly fictional S23 browser policy");
  await employeePolicyCard.getByRole("button", { name: "Approve policy" }).click();
  await expect(employeePolicyCard).toContainText("APPROVED");
  await page.getByLabel("Approved group").selectOption(`TEST-${suffix}`);
  await page.getByLabel("Effective from", { exact: true }).first().fill(today);
  await fillReason("Assign fictional test employee group");
  await page.getByRole("button", { name: "Save dated group assignment" }).click();
  await page.getByLabel("From", { exact: true }).first().fill(today);
  await page.getByLabel("To", { exact: true }).first().fill(today);
  await expect(page.getByRole("button", { name: /Generate employee snapshot/i })).toBeEnabled();
  await fillReason("Record source-backed fictional browser score");
  await page.getByRole("button", { name: /Generate employee snapshot/i }).click();
  await expect(page.getByText("100.0 / 100").first()).toBeVisible();
  await expect(page.getByText(/First-pass review approval:/)).toBeVisible();
  await fillReason("Retain a second immutable score-history result");
  await page.getByRole("button", { name: /Generate employee snapshot/i }).click();
  await expect(page.getByText(/Compared with immutable snapshot/)).toBeVisible();
  await expect(page.getByText(/Change from prior result: 0\.0 points/)).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDirectory, `performance-${testInfo.project.name}-score-history.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("tab", { name: "Design / Turnkey health" }).click();
  await page.getByRole("button", { name: new RegExp(`S23 performance ${suffix}`) }).click();
  await expect(page.getByRole("heading", { name: `S23 performance ${suffix}` })).toBeVisible();
  await editor.getByLabel("Policy family").selectOption("DESIGN");
  const contextResponse = await page.request.get("/api/v1/performance/context");
  const currentContext = await contextResponse.json() as { policies: Array<{ state: string; data: { family?: string; groupKey?: string; effectiveFrom?: string; components?: Array<{ metric: string; weight: number; min: number; max: number; direction: string; required: boolean }> } }> };
  const existingDesignPolicy = currentContext.policies.find(policy => policy.state === "APPROVED" && policy.data.family === "DESIGN" && policy.data.groupKey === "DESIGN" && policy.data.effectiveFrom === today && policy.data.components?.length === 1 && policy.data.components[0]?.metric === "PROJECT_REVIEW_FIRST_PASS" && policy.data.components[0]?.weight === 100 && policy.data.components[0]?.min === 0 && policy.data.components[0]?.max === 100 && policy.data.components[0]?.direction === "HIGHER" && policy.data.components[0]?.required);
  if (!existingDesignPolicy) {
  await editor.getByLabel("Label").fill(`Fictional S23 design policy ${suffix}`);
  await editor.getByLabel("Effective from").fill(today);
  await editor.getByRole("button", { name: "Add measurable source" }).click();
  const designComponent = editor.locator(".perf-component").first();
  await designComponent.getByLabel("Metric").selectOption("PROJECT_REVIEW_FIRST_PASS");
  await designComponent.getByLabel("Weight").fill("100");
  await designComponent.getByLabel("Minimum").fill("0");
  await designComponent.getByLabel("Maximum").fill("100");
  await editor.getByLabel("Attendance maximum weight").fill("0");
  await editor.getByLabel("Efficiency maximum weight").fill("0");
  await editor.getByLabel("Strength at or above").fill("80");
  await editor.getByLabel("Weakness below").fill("50");
  await editor.getByLabel("Critical below").fill("25");
  await editor.getByLabel("Delayed below").fill("50");
  await editor.getByLabel("At Risk below").fill("75");
  await fillReason("Create fictional Design health policy");
  await editor.getByRole("button", { name: "Save policy draft" }).click();
  await fillReason("Approve fictional Design health policy");
  const designPolicyCard = page.getByText(new RegExp(`Fictional S23 design policy ${suffix} · DESIGN/DESIGN`)).locator("..");
  await expect(designPolicyCard).toBeVisible();
  await expect(designPolicyCard.getByRole("button", { name: "Approve policy" })).toBeEnabled();
  await fillReason("Approve fictional Design health policy");
  await designPolicyCard.getByRole("button", { name: "Approve policy" }).click();
  await expect(designPolicyCard).toContainText("APPROVED");
  }
  await expect(page.getByRole("button", { name: "Generate project health snapshot" })).toBeEnabled();
  await page.getByLabel("From", { exact: true }).first().fill(today);
  await page.getByLabel("To", { exact: true }).first().fill(today);

  await page.getByLabel("Delay cause").selectOption("CLIENT");
  await page.getByLabel("Allocated delay (days)").fill("1");
  await page.getByLabel("Delay source kind").selectOption("TASK_STATUS");
  await page.getByLabel("Source record ID").fill(taskStatusId);
  await page.getByLabel("From", { exact: true }).last().fill(today);
  await page.getByLabel("To", { exact: true }).last().fill(today);
  await page.getByLabel("Evidence summary").fill("Client review dependency, fictional acceptance source");
  await fillReason("Record explicitly reviewed test delay allocation");
  await page.getByRole("button", { name: "Record attributed delay" }).click();
  await expect(page.getByText(/CLIENT · 1 days/)).toBeVisible();
  await fillReason("Capture fictional source-backed Design health");
  await page.getByRole("button", { name: "Generate project health snapshot" }).click();
  await expect(page.getByText("100.0 / 100").last()).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDirectory, `performance-${testInfo.project.name}-health.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("tab", { name: "Employee performance" }).click();
  await page.getByLabel("Review frequency").selectOption("MONTHLY");
  await page.getByLabel("From", { exact: true }).first().fill(today);
  await page.getByLabel("To", { exact: true }).first().fill(today);
  await page.getByLabel("Cycle goals (one per line)").fill("Improve review readiness");
  await page.getByLabel("Development actions (one per line)").fill("Use the approved preflight checklist");
  await fillReason("Create fictional test review cycle");
  await page.getByRole("button", { name: "Create review cycle" }).click();
  await expect(page.locator(".perf-cycle > p").filter({ hasText: /^Goals: Improve review readiness$/ })).toBeVisible();
  await fillReason("Finalize fictional browser review cycle");
  await expect(page.getByLabel("Reason for this action (required)")).toHaveValue("Finalize fictional browser review cycle");
  await page.getByRole("button", { name: "Finalize cycle" }).click();
  await expect(page.getByText("Finalized")).toBeVisible();
  await page.reload();
  await page.getByLabel("Employee").selectOption({ label: employeeEmail });
  await expect(page.locator(".perf-cycle > p").filter({ hasText: /^Goals: Improve review readiness$/ })).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDirectory, `performance-${testInfo.project.name}-cycle.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.context().addCookies([{ name: "sense_sid", value: employeeSecret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: employeeEmail })).toBeVisible();
  await fillReason("Acknowledge my fictional test cycle");
  await page.getByLabel("Your acknowledgement").fill("I have read this fictional review cycle.");
  await page.getByRole("button", { name: "Acknowledge this cycle" }).click();
  await expect(page.getByText(/I have read this fictional review cycle/)).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDirectory, `performance-${testInfo.project.name}-employee-cycle.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
