import { verifyDashboardSummaryLayout } from "./dashboard-summary-layout.js";
import { expect, test } from "@playwright/test";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "../../apps/api/src/s27-disposable-test-target.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureUrl = process.env.DATABASE_URL;
const disposableS27Database = Boolean(process.env.DATABASE_URL && isS27DisposableTestTarget("DATABASE_URL", process.env.DATABASE_URL));
const screenshotDirectory = resolve(process.env.S24_SCREENSHOT_DIR ?? ".env.s24-tools/screenshots");

test("S24 dashboard reports freeze, export, history and schedule; staff retain personal reminders", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(12_000);
  const openDashboard = async (reload = false): Promise<void> => {
    const startedAt = Date.now();
    const ready = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/dashboard/sources/tasks" && response.request().method() === "GET", { timeout: 60_000 });
    if (reload) await page.reload(); else await page.goto("/dashboard");
    expect((await ready).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true, level: 1 })).toBeVisible({ timeout: 60_000 });
    console.info(`[s24-e2e] dashboard load ${Date.now() - startedAt}ms`);
  };
  test.skip((process.env.S24_E2E_ENABLED !== "1" && process.env.S25_E2E_ENABLED !== "1" && process.env.S27_E2E_ENABLED !== "1") || !fixtureUrl, "Set an approved isolated S24, S25, or S27 database acceptance flag");
  const parsed = new URL(fixtureUrl!);
  const explicitlyEnabledS24Database = process.env.S24_E2E_ENABLED === "1" && /sense_[a-z0-9_]*s24_[a-z0-9_]*_test$/i.test(parsed.pathname);
  const explicitlyEnabledS25Database = process.env.S25_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsed.hostname) && ((["56433", "57433"].includes(parsed.port) && /^\/sense_s25_main_s25_[a-z0-9_]+_test$/i.test(parsed.pathname)) || (parsed.port === "57433" && /^\/sense_s24_s25_[a-z0-9_]+_test$/i.test(parsed.pathname)));
  const explicitlyEnabledS26Database = process.env.S26_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "57433" && /^\/sense_s26_main_s26_[a-z0-9_]+_test$/i.test(parsed.pathname);
  const explicitlyEnabledS27Database = process.env.S27_E2E_ENABLED === "1" && parsed.hostname === "127.0.0.1" && parsed.port === "57433" && /^\/sense_s27_main_s27_[a-z0-9_]+_test$/.test(parsed.pathname) || disposableS27Database;
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || ((!explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database) && parsed.port !== "56433") || (!explicitlyEnabledS24Database && !explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database)) throw new Error("Dashboard browser acceptance requires an explicitly enabled isolated S24 or exact S25/S26/S27 database on a local test port");
  const require = createRequire(resolve("apps/api/package.json"));
  const { Client } = require("pg") as typeof import("pg");
  const db = new Client({ connectionString: fixtureUrl });
  const suffix = randomUUID().slice(0, 8);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const ownerSecret = randomBytes(32).toString("base64url"), staffSecret = randomBytes(32).toString("base64url");
  const ownerCsrf = createHmac("sha256", ownerSecret).update("csrf").digest("base64url"), staffCsrf = createHmac("sha256", staffSecret).update("csrf").digest("base64url");
  const ownerSession = randomUUID(), staffSession = randomUUID(), staffId = randomUUID(), staffAccount = randomUUID();
  let ownerId: string, organizationId: string, branchId: string, teamId: string;
  await db.connect();
  if (disposableS27Database) {
    const identity = await db.query<{ database: string; port: number }>("SELECT current_database() AS database, inet_server_port() AS port");
    if (!matchesS27DisposableServer(process.env.DATABASE_URL!, identity.rows[0]!.database, identity.rows[0]!.port)) throw new Error("Connected PostgreSQL server does not match the guarded S27 disposable target");
  }
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(61024001)");
    organizationId = (await db.query<{ id: string }>("SELECT id FROM organizations LIMIT 1")).rows[0]?.id ?? randomUUID();
    if (!(await db.query("SELECT id FROM organizations WHERE id=$1", [organizationId])).rowCount) await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [organizationId, `S24 dashboard ${suffix}`]);
    ownerId = (await db.query<{ id: string }>("SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE' LIMIT 1")).rows[0]?.id ?? randomUUID();
    if (!(await db.query("SELECT id FROM accounts WHERE id=$1", [ownerId])).rowCount) await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [ownerId, `s24-owner-${suffix}@example.test`]);
    const keys = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM passkey_credentials WHERE "accountId"=$1 AND "revokedAt" IS NULL', [ownerId]);
    for (let i = keys.rows[0]!.count; i < 2; i++) await db.query('INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4)', [randomUUID(), randomUUID(), ownerId, randomBytes(32)]);
    if (!(await db.query('SELECT id FROM owner_recovery_codes WHERE "accountId"=$1 AND "usedAt" IS NULL AND "replacedAt" IS NULL AND "acknowledgedAt" IS NOT NULL LIMIT 1', [ownerId])).rowCount) await db.query('INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [randomUUID(), ownerId, digest(randomUUID())]);
    const home = await db.query<{ id: string }>("SELECT id FROM branches WHERE \"organizationId\"=$1 LIMIT 1", [organizationId]);
    branchId = home.rows[0]?.id ?? randomUUID();
    if (!home.rows[0]) await db.query('INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [branchId, organizationId, `S24 dashboard ${suffix}`]);
    teamId = (await db.query<{ id: string }>('SELECT id FROM teams WHERE "branchId"=$1 LIMIT 1', [branchId])).rows[0]?.id ?? randomUUID();
    if (!(await db.query("SELECT id FROM teams WHERE id=$1", [teamId])).rowCount) await db.query('INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)', [teamId, organizationId, branchId, `S24 dashboard ${suffix}`]);
    await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [staffAccount, `s24-staff-${suffix}@example.test`]);
    await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [staffId, organizationId, staffAccount, branchId, teamId]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'2 hours\'),($5,$6,$7,$8,CURRENT_TIMESTAMP+interval \'2 hours\')', [ownerSession, ownerId, digest(ownerSecret), digest(ownerCsrf), staffSession, staffAccount, digest(staffSecret), digest(staffCsrf)]);
    await db.query("COMMIT");
  } finally { await db.end(); }

  await mkdir(screenshotDirectory, { recursive: true });
  await context.addCookies([{ name: "sense_sid", value: ownerSecret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
  await openDashboard();
  const summaryViewport = page.viewportSize()!;
  for (const summaryWidth of [1440, 1024, 859, 783, 600, 390, 320]) {
    await page.setViewportSize({ width: summaryWidth, height: 884 });
    await verifyDashboardSummaryLayout(page, testInfo, summaryWidth);
    const summaryTrigger = page.locator("a.dv-summary-overdue");
    await summaryTrigger.focus();
    await expect(summaryTrigger).toBeFocused();
    await expect(summaryTrigger).toHaveAttribute("href", /tasks/);
  }
  await page.setViewportSize(summaryViewport);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(screenshotDirectory, `dashboard-${testInfo.project.name}-overview.png`), fullPage: false });

  await page.getByRole("button", { name: "Reports" }).click();
  await page.getByLabel("Report category").selectOption("employee");
  await page.getByLabel("From").fill("2026-10-01"); await page.getByLabel("To").fill("2026-10-05");
  const firstPreviewResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/reports/preview", { timeout: 60_000 });
  await page.getByRole("button", { name: "Preview report" }).click();
  expect((await firstPreviewResponse).status()).toBe(201);
  await expect(page.getByRole("heading", { name: /employee report/i })).toBeVisible({ timeout: 60_000 });
  for (const label of ["CSV", "Excel", "PDF"]) {
    const startedAt = Date.now();
    const download = page.waitForEvent("download", { timeout: 60_000 }); await page.getByRole("button", { name: label, exact: true }).first().click({ timeout: 60_000 });
    const file = await download; expect(file.suggestedFilename()).toContain("employee");
    console.info(`[s24-e2e] ${label} export download ${Date.now() - startedAt}ms`);
  }
  const printStartedAt = Date.now();
  const printResponse = page.waitForResponse(response => response.url().includes("/api/v1/reports/export") && response.url().includes("format=print"), { timeout: 60_000 });
  await page.getByRole("button", { name: "PRINT", exact: true }).first().click({ timeout: 60_000 });
  expect((await printResponse).headers()["content-type"]).toContain("text/html");
  console.info(`[s24-e2e] print export ${Date.now() - printStartedAt}ms`);
  await openDashboard(); await page.getByRole("button", { name: "Reports" }).click();
  await page.getByLabel("Report category").selectOption("employee");
  const previewResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/reports/preview", { timeout: 60_000 });
  await page.getByRole("button", { name: "Preview report" }).click();
  expect((await previewResponse).status()).toBe(201);
  await expect(page.getByRole("heading", { name: /employee report/i })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Reason for frozen report (required)").fill("Freeze S24 browser test report");
  const frozenResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/reports/snapshots", { timeout: 60_000 });
  await page.getByRole("button", { name: "Freeze report" }).click({ timeout: 60_000 });
  const frozenResult = await frozenResponse;
  expect(frozenResult.status()).toBe(201);
  const frozenBody = await frozenResult.json() as { snapshot: { id: string } };
  await openDashboard(true); await page.getByRole("button", { name: "Reports" }).click();
  const frozenRow = page.locator(`[data-snapshot-id="${frozenBody.snapshot.id}"]`);
  await expect(frozenRow).toBeVisible({ timeout: 60_000 });
  const snapshotRead = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/reports/snapshots/${frozenBody.snapshot.id}`, { timeout: 60_000 });
  await frozenRow.getByRole("button", { name: "Read" }).click({ timeout: 60_000 });
  expect((await snapshotRead).status()).toBe(200);
  const snapshotReason = page.getByText(/Reason: Freeze S24 browser test report/);
  await expect(snapshotReason).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: resolve(screenshotDirectory, `dashboard-${testInfo.project.name}-report-history.png`), fullPage: false });
  await snapshotReason.screenshot({ path: resolve(screenshotDirectory, `s24-snapshot-reason-${testInfo.project.name}.png`) });
  const snapshotFirstRow = page.locator(".dashboard-snapshot table tbody tr").first();
  await expect(snapshotFirstRow).toBeVisible({ timeout: 60_000 });
  await snapshotFirstRow.screenshot({ path: resolve(screenshotDirectory, `s24-snapshot-table-row-${testInfo.project.name}.png`) });

  await page.getByRole("button", { name: "Reminders & schedules" }).click();
  const minute = Number.parseInt(suffix.replaceAll("-", "").slice(0, 8), 16) % 60;
  const ruleTime = `10:${String(minute).padStart(2, "0")}`;
  const changedTime = `11:${String(minute).padStart(2, "0")}`;
  await page.getByLabel("Rule kind").selectOption("SUMMARY"); await page.getByLabel("Summary period").selectOption("WEEKLY");
  await page.getByLabel("Weekdays (0=Sun, 6=Sat) · required").fill("1");
  await page.getByLabel("Local time").fill(ruleTime); await page.getByLabel("Timezone").fill("Asia/Kolkata");
  await page.getByLabel("Audience").selectOption("OWNER"); await page.getByLabel("Reason", { exact: false }).last().fill("Configure S24 browser summary schedule");
  const scheduleSaved = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/api/v1/dashboard/schedules") && !response.url().includes("/schedules/"), { timeout: 60_000 });
  await page.getByRole("button", { name: "Save schedule rule" }).click({ timeout: 60_000 });
  const scheduleResponse = await scheduleSaved; expect(scheduleResponse.status()).toBe(201);
  const createdScheduleResult = await scheduleResponse.json() as { id: string };
  const createdSchedule = page.locator(`[data-schedule-id="${createdScheduleResult.id}"]`);
  await expect(createdSchedule).toBeVisible({ timeout: 60_000 }); await expect(createdSchedule).toContainText(`${ruleTime} · Asia/Kolkata · OWNER`);
  await createdSchedule.getByRole("button", { name: "Edit" }).click(); await page.getByLabel("Local time").fill(changedTime);
  await page.getByLabel("Reason", { exact: false }).last().fill("Update S24 browser summary schedule");
  const editSaved = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/api/v1/dashboard/schedules/"), { timeout: 60_000 });
  await page.getByRole("button", { name: "Save schedule changes" }).click({ timeout: 60_000 });
  const editResponse = await editSaved; expect(editResponse.ok()).toBeTruthy();
  await expect(createdSchedule).toContainText(`${changedTime} · Asia/Kolkata · OWNER`, { timeout: 60_000 });
  await expect(createdSchedule.getByRole("button", { name: "Edit" })).toBeEnabled();
  await page.screenshot({ path: resolve(screenshotDirectory, `s24-configured-schedule-${testInfo.project.name}.png`), fullPage: false });

  await page.getByLabel("Rule kind").selectOption("SUMMARY"); await page.getByLabel("Summary period").selectOption("MORNING");
  await page.getByLabel("Weekdays (0=Sun, 6=Sat)").fill("");
  await page.getByLabel("Day of month").fill("");
  await page.getByLabel("Local time").fill("00:00"); await page.getByLabel("Timezone").fill("Asia/Kolkata");
  await page.getByLabel("Audience").selectOption("OWNER"); await page.getByLabel("Reason", { exact: false }).last().fill("Generate S24 browser summary evidence");
  const morningRuleSaved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/dashboard/schedules", { timeout: 60_000 });
  await page.getByRole("button", { name: "Save schedule rule" }).click({ timeout: 60_000 });
  const morningRuleResponse = await morningRuleSaved;
  expect(morningRuleResponse.status()).toBe(201);
  const morningRule = await morningRuleResponse.json() as { id: string };
  const apiRequire = createRequire(resolve("apps/api/package.json"));
  const { NestFactory } = apiRequire("@nestjs/core") as typeof import("@nestjs/core");
  const { AppModule } = await import("../../apps/api/dist/app.module.js");
  const { DashboardService } = await import("../../apps/api/dist/dashboard.service.js");
  const priorNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const summaryStartedAt = Date.now();
  try {
    const apiContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try { await apiContext.get(DashboardService).runBatch(new Date()); }
    finally { await apiContext.close(); }
  } finally { if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv; }
  console.info(`[s24-e2e] summary runBatch ${Date.now() - summaryStartedAt}ms`);
  const summariesResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/dashboard/summaries" && response.request().method() === "GET", { timeout: 60_000 });
  await openDashboard(true); await page.getByRole("button", { name: "Scheduled summaries" }).click();
  expect((await summariesResponse).status()).toBe(200);
  const persistedSummaries = await summariesResponse.then(response => response.json()) as { summaries: Array<{ id: string; sourceId: string; summary: { kind: string; from?: string; to?: string; generatedAt: string; sections: Array<{ key: string; label: string; rows: unknown[] }> } }> };
  const generatedSummary = persistedSummaries.summaries.find(item => item.sourceId === morningRule.id && item.summary.kind === "MORNING");
  expect(generatedSummary).toBeDefined();
  expect(generatedSummary!.summary.from).toBeTruthy(); expect(generatedSummary!.summary.to).toBeTruthy(); expect(generatedSummary!.summary.generatedAt).toBeTruthy();
  expect(generatedSummary!.summary.sections.length).toBeGreaterThan(0);
  const summaryHistoryRow = page.locator(`[data-summary-id="${generatedSummary!.id}"]`);
  await expect(summaryHistoryRow).toBeVisible({ timeout: 60_000 });
  await summaryHistoryRow.getByRole("button", { name: /Selected|View summary/ }).click();
  await expect(page.getByRole("heading", { name: /MORNING ·/ })).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("heading", { name: /MORNING ·/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(screenshotDirectory, `s24-summary-${testInfo.project.name}.png`), fullPage: false });
  await page.screenshot({ path: resolve(screenshotDirectory, `dashboard-${testInfo.project.name}-schedule.png`), fullPage: false });

  await context.addCookies([{ name: "sense_sid", value: staffSecret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
  await openDashboard();
  await page.getByRole("button", { name: "Reminders & schedules" }).click();
  await expect(page.getByRole("heading", { name: "Schedule rules" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save schedule rule" })).toHaveCount(0);
  await page.getByLabel("Reminder title").fill(`Personal reminder ${suffix}`);
  await page.getByLabel("Due date and time").fill("2026-10-06T10:00");
  await page.getByLabel("Reason", { exact: false }).first().fill("Keep personal S24 reminder");
  const reminderSaved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/dashboard/reminders", { timeout: 60_000 });
  await page.getByRole("button", { name: "Save reminder" }).click({ timeout: 60_000 });
  expect((await reminderSaved).status()).toBe(201);
  await expect(page.getByText(`Personal reminder ${suffix}`)).toBeVisible({ timeout: 60_000 });
  await openDashboard(true); await page.getByRole("button", { name: "Reminders & schedules" }).click();
  await expect(page.getByText(`Personal reminder ${suffix}`)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: resolve(screenshotDirectory, `dashboard-${testInfo.project.name}-staff-reminder.png`), fullPage: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
