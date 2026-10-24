import { expect, test } from "@playwright/test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "../../apps/api/src/s27-disposable-test-target.js";

const fixtureUrl = process.env.DATABASE_URL;
const disposableS27Database = Boolean(fixtureUrl && isS27DisposableTestTarget("DATABASE_URL", fixtureUrl));
const screenshots = resolve(process.env.S26_SCREENSHOT_DIR ?? ".env.s26-tools/screenshots");
type QueryResult<T> = { rows: T[]; rowCount: number | null };
type FixtureDatabase = { connect(): Promise<void>; query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>; end(): Promise<void> };

test("S26 Owner saves a report and scoped event rule, then reviews an event generated run", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  test.skip((process.env.S26_E2E_ENABLED !== "1" && process.env.S27_E2E_ENABLED !== "1") || !fixtureUrl, "Set S26_E2E_ENABLED or S27_E2E_ENABLED with its guarded dedicated PostgreSQL fixture");
  const parsed = new URL(fixtureUrl!);
  const explicitlyEnabledS26Database = process.env.S26_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "57433" && /^\/sense_s26_main_s26_[a-z0-9_]+_test$/.test(parsed.pathname);
  const explicitlyEnabledS27Database = (process.env.S27_E2E_ENABLED === "1" && parsed.hostname === "127.0.0.1" && parsed.port === "57433" && /^\/sense_s27_main_s27_[a-z0-9_]+_test$/.test(parsed.pathname)) || disposableS27Database;
  if ((parsed.port !== "57433" && !disposableS27Database) || (!explicitlyEnabledS26Database && !explicitlyEnabledS27Database)) {
    throw new Error("S26 browser acceptance requires the isolated S26 main test database on port 57433");
  }
  const fixtureEnvironment = explicitlyEnabledS27Database ? process.env.S27_TEST_ENV_FILE : process.env.S26_TEST_ENV_FILE;
  if (!fixtureEnvironment) throw new Error("S26 browser acceptance requires the reviewed slice test env file for the isolated AUT worker");
  const require = createRequire(resolve("apps/api/package.json"));
  const { Client } = require("pg") as { Client: new (config: { connectionString: string }) => FixtureDatabase };
  const db = new Client({ connectionString: fixtureUrl! });
  const readTaskState = async (title: string): Promise<{ status: string; version: number; priority: string; targetDate: string } | undefined> => {
    const stateDb = new Client({ connectionString: fixtureUrl! });
    await stateDb.connect();
    try {
      return (await stateDb.query<{ status: string; version: number; priority: string; targetDate: string }>(`SELECT status::text,version,priority::text,"targetDate"::text AS "targetDate" FROM tasks WHERE title=$1`, [title])).rows[0];
    } finally { await stateDb.end(); }
  };
  const suffix = randomUUID().slice(0, 8);
  const token = randomBytes(32).toString("base64url");
  const csrf = createHmac("sha256", token).update("csrf").digest("base64url");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  let ownerId: string, employeeId: string;
  await db.connect();
  if (disposableS27Database) {
    const identity = await db.query<{ database: string; port: number }>("SELECT current_database() AS database, inet_server_port() AS port");
    if (!matchesS27DisposableServer(process.env.DATABASE_URL!, identity.rows[0]!.database, identity.rows[0]!.port)) throw new Error("Connected PostgreSQL server does not match the guarded S27 disposable target");
  }
  try {
    ownerId = (await db.query<{ id: string }>(`SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE' ORDER BY id LIMIT 1`)).rows[0]?.id ?? "";
    if (!ownerId) {
      ownerId = randomUUID();
      await db.query(`INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,'OWNER','ACTIVE',CURRENT_TIMESTAMP)`, [ownerId, `s26-owner-${suffix}@example.test`]);
    }
    const keys = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM passkey_credentials WHERE "accountId"=$1 AND "revokedAt" IS NULL`, [ownerId]);
    for (let index = keys.rows[0]!.count; index < 2; index += 1) await db.query(`INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4)`, [randomUUID(), randomUUID(), ownerId, randomBytes(32)]);
    const recovery = await db.query(`SELECT id FROM owner_recovery_codes WHERE "accountId"=$1 AND "usedAt" IS NULL AND "replacedAt" IS NULL AND "acknowledgedAt" IS NOT NULL LIMIT 1`, [ownerId]);
    if (!recovery.rows[0]) await db.query(`INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)`, [randomUUID(), ownerId, digest(randomUUID())]);
    let organizationId = (await db.query<{ id: string }>(`SELECT id FROM organizations ORDER BY id LIMIT 1`)).rows[0]?.id;
    if (!organizationId) {
      organizationId = randomUUID();
      await db.query(`INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)`, [organizationId, `S26 browser ${suffix}`]);
    }
    employeeId = (await db.query<{ id: string }>(`SELECT e.id FROM employees e JOIN accounts a ON a.id=e."accountId" WHERE e.state='ACTIVE' AND a.state='ACTIVE' AND e."organizationId"=$1 ORDER BY e.id LIMIT 1`, [organizationId])).rows[0]?.id ?? "";
    if (!employeeId) {
      const branchId = (await db.query<{ id: string }>(`SELECT id FROM branches WHERE "organizationId"=$1 AND active=true ORDER BY id LIMIT 1`, [organizationId])).rows[0]?.id ?? randomUUID();
      if (!(await db.query(`SELECT id FROM branches WHERE id=$1`, [branchId])).rows[0]) await db.query(`INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)`, [branchId, organizationId, `S26 browser ${suffix}`]);
      const teamId = (await db.query<{ id: string }>(`SELECT id FROM teams WHERE "branchId"=$1 ORDER BY id LIMIT 1`, [branchId])).rows[0]?.id ?? randomUUID();
      if (!(await db.query(`SELECT id FROM teams WHERE id=$1`, [teamId])).rows[0]) await db.query(`INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)`, [teamId, organizationId, branchId, `S26 browser ${suffix}`]);
      const staffAccountId = randomUUID(); employeeId = randomUUID();
      await db.query(`INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,'STAFF','ACTIVE',CURRENT_TIMESTAMP)`, [staffAccountId, `s26-staff-${suffix}@example.test`]);
      await db.query(`INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)`, [employeeId, organizationId, staffAccountId, branchId, teamId]);
    }
    await db.query(`INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval '2 hours')`, [randomUUID(), ownerId, digest(token), digest(csrf)]);
  } finally { await db.end(); }

  await mkdir(screenshots, { recursive: true });
  await context.addCookies([{ name: "sense_sid", value: token, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
  const contextResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/automation/context" && response.request().method() === "GET");
  await page.goto("/automation");
  const initialContextResponse = await contextResponse;
  expect(initialContextResponse.status()).toBe(200);
  const initialContext = await initialContextResponse.json() as { eventNames: string[]; recipients: { id: string; label: string }[]; runs: { id: string; ruleId: string; actionKind: string; status: string }[] };
  await expect(page.getByRole("heading", { name: "Automation & reports" })).toBeVisible();

  await page.getByLabel("Report name", { exact: true }).fill(`S26 report ${suffix}`);
  await page.getByRole("combobox", { name: "Category", exact: true }).selectOption("project");
  await page.getByLabel("From", { exact: true }).fill("2026-01-01");
  await page.getByLabel("To", { exact: true }).fill("2026-12-31");
  await page.getByLabel("Record", { exact: true }).check();
  await page.getByLabel("State", { exact: true }).check();
  await page.getByRole("combobox", { name: "Group by", exact: true }).selectOption("status");
  await page.getByRole("combobox", { name: "Chart", exact: true }).selectOption("BAR");
  await page.getByLabel("Reason for saving report", { exact: true }).fill("S26 browser acceptance saved report");
  const previewResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/automation/reports/preview");
  await page.getByRole("button", { name: "Preview report" }).click();
  expect((await previewResponse).status()).toBe(201);
  await expect(page.getByRole("heading", { name: "Report preview" })).toBeVisible();
  const saveReportResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/automation/reports");
  await page.getByRole("button", { name: "Save report" }).click();
  const savedReport = await saveReportResponse;
  expect(savedReport.status()).toBe(201);
  const savedReportBody = await savedReport.json() as { id: string };
  await expect(page.getByText(`S26 report ${suffix}`, { exact: true })).toBeVisible();
  const reportRow = page.locator("section[aria-labelledby='saved-reports-heading'] .automation-list li").filter({ hasText: `S26 report ${suffix}` });
  await reportRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(screenshots, `s26-report-${testInfo.project.name}.png`), fullPage: false });
  const csvDownload = page.waitForEvent("download");
  await reportRow.getByRole("link", { name: "CSV" }).click();
  expect((await csvDownload).suggestedFilename()).toContain("project");

  await page.getByLabel("Rule name", { exact: true }).fill(`S26 notice ${suffix}`);
  await page.getByRole("combobox", { name: "Project scope", exact: true }).selectOption("");
  const eventName = initialContext.eventNames.find((name) => name === "task.created");
  const ownerRecipient = initialContext.recipients.find((item) => item.id === ownerId);
  if (!eventName || !ownerRecipient) throw new Error("S26 fixture has no task.created event or authorized Owner recipient");
  await page.getByLabel(eventName, { exact: true }).check();
  await page.getByRole("combobox", { name: "Action", exact: true }).selectOption("NOTIFY");
  await page.getByRole("combobox", { name: "Authorized recipient", exact: true }).selectOption(ownerRecipient.id);
  await page.getByLabel("Reason for rule change", { exact: true }).fill("S26 browser acceptance internal notice");
  const saveRuleResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/automation/rules");
  await page.getByRole("button", { name: "Save automation rule" }).click();
  const savedRule = await saveRuleResponse;
  expect(savedRule.status()).toBe(201);
  const savedRuleBody = await savedRule.json() as { id: string };
  await expect(page.getByText(`S26 notice ${suffix}`, { exact: true })).toBeVisible();
  const rulesPanel = page.locator("section[aria-labelledby='rules-heading']");
  await rulesPanel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(screenshots, `s26-rule-${testInfo.project.name}.png`), fullPage: false });

  const taskDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const taskResponse = await page.request.post("/api/v1/tasks", { headers: { "X-CSRF-Token": csrf, Origin: new URL(baseURL!).origin }, data: { title: `S26 source event ${suffix}`, type: "NON_PROJECT", priority: "LOW", targetDate: taskDate, ownerEmployeeId: employeeId, reason: "S26 event driven automation browser acceptance" } });
  expect(taskResponse.status()).toBe(201);
  await new Promise<void>((resolveBatch, rejectBatch) => {
    const helper = resolve(process.env.SENSE_REVIEW_ROUTING_TEST_RUN ? "scripts/acceptance/review-routing-aut-batch.mjs" : process.env.SENSE_RECOVERY_TEST_MANIFEST && disposableS27Database ? "scripts/ci/run-aut-batch-s27.mjs" : explicitlyEnabledS27Database ? ".env.s27-tools/run-aut-batch-s27.mjs" : ".env.s26-tools/run-aut-batch.mjs");
    const child = spawn(process.execPath, [helper, fixtureEnvironment], { cwd: process.cwd(), env: process.env, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectBatch);
    child.once("close", (code) => code === 0 ? resolveBatch() : rejectBatch(new Error(`Guarded AUT batch failed (${code}): ${stderr.slice(-1200)}`)));
  });
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/automation/context", { headers: { "Cache-Control": "no-cache" } });
    const body = await response.json() as { runs: { id: string; ruleId: string; actionKind: string; status: string }[] };
    return body.runs.some((run) => run.actionKind === "NOTIFY" && run.status === "DELIVERED" && run.ruleId === savedRuleBody.id && !initialContext.runs.some((old) => old.id === run.id));
  }, { timeout: 90_000, intervals: [1_000, 2_000, 4_000] }).toBe(true);
  await page.reload();
  const activity = page.locator("section[aria-labelledby='runs-heading']");
  await expect(activity.getByRole("heading", { name: "Recent automation activity" })).toBeVisible();
  await expect(activity.getByText(/NOTIFY\s*·\s*Notice created/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/email delivery and read receipts are managed separately/i)).toBeVisible();
  await activity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(screenshots, `s26-activity-${testInfo.project.name}.png`), fullPage: false });

  await page.getByLabel("Rule name", { exact: true }).fill(`S26 recommendation ${suffix}`);
  await page.getByLabel(eventName, { exact: true }).check();
  await page.getByRole("combobox", { name: "Action", exact: true }).selectOption("RECOMMENDATION");
  await page.getByRole("combobox", { name: "Authorized recipient", exact: true }).selectOption(ownerRecipient.id);
  const recommendationText = `Review this task through its ordinary workflow (${suffix})`;
  await page.getByLabel("Recommendation", { exact: true }).fill(recommendationText);
  await page.getByLabel("Reason for rule change", { exact: true }).fill("S26 browser acceptance nonbinding recommendation");
  const saveRecommendationResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/automation/rules");
  await page.getByRole("button", { name: "Save automation rule" }).click();
  const savedRecommendation = await saveRecommendationResponse;
  expect(savedRecommendation.status()).toBe(201);
  const recommendationRule = await savedRecommendation.json() as { id: string };

  const recommendationTaskTitle = `S26 recommendation source ${suffix}`;
  const recommendationTaskResponse = await page.request.post("/api/v1/tasks", { headers: { "X-CSRF-Token": csrf, Origin: new URL(baseURL!).origin }, data: { title: recommendationTaskTitle, type: "NON_PROJECT", priority: "LOW", targetDate: taskDate, ownerEmployeeId: employeeId, reason: "S26 nonbinding recommendation source" } });
  expect(recommendationTaskResponse.status()).toBe(201);
  const taskBeforeDecision = await readTaskState(recommendationTaskTitle);
  if (!taskBeforeDecision) throw new Error("S26 recommendation source task was not persisted");
  await new Promise<void>((resolveBatch, rejectBatch) => {
    const helper = resolve(process.env.SENSE_REVIEW_ROUTING_TEST_RUN ? "scripts/acceptance/review-routing-aut-batch.mjs" : process.env.SENSE_RECOVERY_TEST_MANIFEST && disposableS27Database ? "scripts/ci/run-aut-batch-s27.mjs" : explicitlyEnabledS27Database ? ".env.s27-tools/run-aut-batch-s27.mjs" : ".env.s26-tools/run-aut-batch.mjs");
    const child = spawn(process.execPath, [helper, fixtureEnvironment], { cwd: process.cwd(), env: process.env, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectBatch);
    child.once("close", (code) => code === 0 ? resolveBatch() : rejectBatch(new Error(`Guarded AUT batch failed (${code}): ${stderr.slice(-1200)}`)));
  });
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/automation/context", { headers: { "Cache-Control": "no-cache" } });
    const body = await response.json() as { runs: { ruleId: string; actionKind: string; status: string }[] };
    return body.runs.some((run) => run.ruleId === recommendationRule.id && run.actionKind === "RECOMMENDATION" && run.status === "PENDING");
  }, { timeout: 90_000, intervals: [1_000, 2_000, 4_000] }).toBe(true);
  await page.reload();
  await expect(page.getByText(recommendationText, { exact: true })).toBeVisible();
  page.once("dialog", dialog => dialog.accept("Reviewed the source task; no change authorized here"));
  const approveResponse = page.waitForResponse(response => response.request().method() === "POST" && /\/api\/v1\/automation\/runs\/[^/]+\/decision$/.test(new URL(response.url()).pathname));
  const recommendationRun = page.locator("section[aria-labelledby='runs-heading'] li").filter({ hasText: recommendationText });
  await recommendationRun.getByRole("button", { name: "Approve recommendation" }).click();
  expect((await approveResponse).status()).toBe(201);
  await expect(page.getByText("Recommendation approved. The proposed change still requires the ordinary authorized workflow.")).toBeVisible();
  const taskAfterDecision = await readTaskState(recommendationTaskTitle);
  expect(taskAfterDecision).toEqual(taskBeforeDecision);
  const finalReportPreview = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/automation/reports/${savedReportBody.id}/preview`);
  const finalReportRow = page.locator("section[aria-labelledby='saved-reports-heading'] .automation-list li").filter({ hasText: `S26 report ${suffix}` });
  await finalReportRow.getByRole("button", { name: "Preview", exact: true }).click();
  const refreshedReportResponse = await finalReportPreview;
  expect(refreshedReportResponse.status()).toBe(200);
  const refreshedReport = await refreshedReportResponse.json() as { table: { rows: Array<Record<string, unknown>> }; chart: Array<{ label: string; count: number }> };
  expect(refreshedReport.table.rows.length).toBeGreaterThan(0);
  expect(refreshedReport.chart.length).toBeGreaterThan(0);
  expect(refreshedReport.chart.reduce((sum, group) => sum + group.count, 0)).toBeGreaterThan(0);
  await expect(page.getByRole("img", { name: `Bar chart with ${refreshedReport.chart.length} groups` })).toBeVisible();
  await page.locator("section[aria-labelledby='report-preview-heading']").screenshot({ path: resolve(screenshots, `s26-countchart-${testInfo.project.name}.png`) });
  await recommendationRun.screenshot({ path: resolve(screenshots, `s26-recommendation-${testInfo.project.name}.png`) });
});
