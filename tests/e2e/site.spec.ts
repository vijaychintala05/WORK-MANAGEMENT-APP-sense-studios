import { expect, test } from "@playwright/test";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "../../apps/api/src/s27-disposable-test-target.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const disposableS27Database = Boolean(process.env.DATABASE_URL && isS27DisposableTestTarget("DATABASE_URL", process.env.DATABASE_URL));
type FixtureDatabase = {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  end(): Promise<void>;
};

test("site reports, independent snag repair and handover persist across refresh", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(!process.env.DATABASE_URL || !process.env.NAS_ROOT, "An isolated local PostgreSQL test database and NAS_ROOT are required");
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  const standardSiteTestTarget = databaseUrl.port === "56433" && databaseUrl.pathname.endsWith("_test");
  const approvedS25MainTarget = process.env.S25_E2E_ENABLED === "1" && databaseUrl.port === "57433" && /^\/sense_s25_main_s25_[a-z0-9_]+_test$/.test(databaseUrl.pathname);
  const approvedS26MainTarget = process.env.S26_E2E_ENABLED === "1" && databaseUrl.port === "57433" && /^\/sense_s26_main_s26_[a-z0-9_]+_test$/.test(databaseUrl.pathname);
  const approvedS27MainTarget = process.env.S27_E2E_ENABLED === "1" && databaseUrl.hostname === "127.0.0.1" && databaseUrl.port === "57433" && /^\/sense_s27_main_s27_[a-z0-9_]+_test$/.test(databaseUrl.pathname) || disposableS27Database;
  if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || (!standardSiteTestTarget && !approvedS25MainTarget && !approvedS26MainTarget && !approvedS27MainTarget)) {
    throw new Error("S20 browser acceptance requires a dedicated localhost PostgreSQL _test database on port 56433");
  }
  const require = createRequire(resolve("apps/api/package.json"));
  const { Client } = require("pg") as { Client: new (config: { connectionString: string }) => FixtureDatabase };
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const suffix = randomUUID();
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const auth = () => { const secret = randomBytes(32).toString("base64url"); return { secret, csrf: createHmac("sha256", secret).update("csrf").digest("base64url"), id: randomUUID() }; };
  const ownerAuth = auth(), leadAuth = auth();
  const branchId = randomUUID(), teamId = randomUUID();
  const leadAccountId = randomUUID(), leadEmployeeId = randomUUID();
  const fixerAuth = auth(), verifierAuth = auth();
  const fixerAccountId = randomUUID(), fixerEmployeeId = randomUUID();
  const verifierAccountId = randomUUID(), verifierEmployeeId = randomUUID();
  const projectTitle = `S20 site ${suffix.slice(0, 8)}`;
  let fixtureCommitted = false;

  await db.connect();
  if (disposableS27Database) {
    const identity = await db.query<{ database: string; port: number }>("SELECT current_database() AS database, inet_server_port() AS port");
    if (!matchesS27DisposableServer(process.env.DATABASE_URL!, identity.rows[0]!.database, identity.rows[0]!.port)) throw new Error("Connected PostgreSQL server does not match the guarded S27 disposable target");
  }
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(6092706)");
    const organizationResult = await db.query<{ id: string }>("SELECT id FROM organizations LIMIT 1");
    const organizationId = organizationResult.rows[0]?.id ?? randomUUID();
    if (!organizationResult.rows[0]) await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [organizationId, "S20 site browser fixture"]);
    const existingOwner = await db.query<{ id: string }>("SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE' LIMIT 1");
    const ownerAccountId = existingOwner.rows[0]?.id ?? randomUUID();
    if (!existingOwner.rows[0]) await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [ownerAccountId, `s20-owner-${suffix}@example.test`]);
    const credentials = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM passkey_credentials WHERE "accountId"=$1 AND "revokedAt" IS NULL', [ownerAccountId]);
    for (let index = credentials.rows[0]!.count; index < 2; index += 1) await db.query('INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4)', [randomUUID(), randomUUID(), ownerAccountId, randomBytes(32)]);
    const recovery = await db.query('SELECT id FROM owner_recovery_codes WHERE "accountId"=$1 AND "usedAt" IS NULL AND "replacedAt" IS NULL AND "acknowledgedAt" IS NOT NULL LIMIT 1', [ownerAccountId]);
    if (!recovery.rows[0]) await db.query('INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [randomUUID(), ownerAccountId, hash(randomUUID())]);
    await db.query('INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [branchId, organizationId, `S20 site ${suffix}`]);
    await db.query('INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)', [teamId, organizationId, branchId, `S20 team ${suffix}`]);
    for (const [accountId, employeeId, role] of [[leadAccountId, leadEmployeeId, "lead"], [fixerAccountId, fixerEmployeeId, "fixer"], [verifierAccountId, verifierEmployeeId, "verifier"]] as const) {
      await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [accountId, `s20-${role}-${suffix}@example.test`]);
      await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [employeeId, organizationId, accountId, branchId, teamId]);
      for (const permissionKey of ["project.view", "project.manage", "employee.manage", "site.view", "site.work", "document.view"]) await db.query('INSERT INTO employee_permission_overrides(id,"organizationId","employeeId","permissionKey",effect,"scopeKind","branchId",reason) VALUES($1,$2,$3,$4,\'ALLOW\',\'BRANCH\',$5,$6)', [randomUUID(), organizationId, employeeId, permissionKey, branchId, "S20 site browser acceptance grant"]);
    }
    for (const [accountId, accountAuth] of [[ownerAccountId, ownerAuth], [leadAccountId, leadAuth], [fixerAccountId, fixerAuth], [verifierAccountId, verifierAuth]] as const) await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [accountAuth.id, accountId, hash(accountAuth.secret), hash(accountAuth.csrf)]);
    await db.query("COMMIT");
    fixtureCommitted = true;

    await context.addCookies([{ name: "sense_sid", value: ownerAuth.secret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    const ownerHeaders = { Cookie: `sense_sid=${ownerAuth.secret}`, Origin: baseURL!, "X-CSRF-Token": ownerAuth.csrf };
    const command = async (path: string, data: unknown) => {
      const response = await page.request.post(path, { headers: ownerHeaders, data });
      const body = await response.text();
      expect(response.status(), `${path}: ${body}`).toBe(201);
      return JSON.parse(body) as Record<string, unknown>;
    };
    const created = await command("/api/v1/projects", { branchId, title: projectTitle, deliveryType: "TURNKEY", scopes: ["Site delivery"], reason: "Create isolated S20 site browser project" });
    const projectId = (created.project as { id: string }).id;
    let projectVersion = 1;
    for (const employeeId of [leadEmployeeId, fixerEmployeeId, verifierEmployeeId]) {
      await command(`/api/v1/projects/${projectId}/assignments`, { employeeId, expectedVersion: projectVersion, reason: "Assign site delivery acceptance participant" });
      projectVersion = (await db.query<{ version: number }>('SELECT version FROM projects WHERE id=$1', [projectId])).rows[0]!.version;
    }
    await command(`/api/v1/projects/${projectId}/lead`, { employeeId: leadEmployeeId, expectedVersion: projectVersion, reason: "Appoint assigned site lead" });
    projectVersion = (await db.query<{ version: number }>('SELECT version FROM projects WHERE id=$1', [projectId])).rows[0]!.version;
    await command(`/api/v1/projects/${projectId}/status`, { toStatus: "ACTIVE", expectedVersion: projectVersion, reason: "Activate isolated site delivery project" });

    const imageBytes = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
    const folder = await command(`/api/v1/documents/projects/${projectId}/folders`, { name: "Site evidence", confidential: false, reason: "Create site photo evidence folder" });
    const upload = await command(`/api/v1/documents/projects/${projectId}/uploads`, { folderId: folder.id, fileName: "north-slab.jpg", mimeType: "image/jpeg", sizeBytes: imageBytes.length, confidential: false, viewOnly: true, reason: "Upload site progress photo" });
    const chunk = await page.request.put(`/api/v1/documents/uploads/${upload.uploadId}/chunks/0`, { headers: { ...ownerHeaders, "Content-Type": "application/octet-stream", "X-Chunk-SHA256": hash(imageBytes) }, data: imageBytes });
    expect(chunk.status(), await chunk.text()).toBe(200);
    const image = await command(`/api/v1/documents/uploads/${upload.uploadId}/finalize`, {});

    await context.clearCookies();
    await context.addCookies([{ name: "sense_sid", value: leadAuth.secret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    await page.goto("/site");
    const workspace = page.locator(".site-workspace");
    await expect(workspace.getByRole("heading", { name: "Site progress and daily work" })).toBeVisible();
    await workspace.getByLabel("Active Turnkey project").selectOption(projectId);
    await expect(workspace.getByRole("heading", { name: projectTitle })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await workspace.getByLabel("Reason for the next site action").fill("Appoint site report owner");
    await workspace.getByLabel("Appoint the responsible person").selectOption(leadAccountId);
    const responsibleResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/site/projects/${projectId}/responsible`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Appoint responsible person" }).click();
    expect((await responsibleResponse).status()).toBe(201);
    const responsibleSaved = await db.query<{ responsibleAccountId: string }>('SELECT "responsibleAccountId" FROM site_workspaces WHERE "projectId"=$1', [projectId]);
    expect(responsibleSaved.rows[0]?.responsibleAccountId).toBe(leadAccountId);

    await workspace.getByLabel("Reason for the next site action").fill("Plan tomorrow site activity");
    await workspace.getByLabel("Package title").fill("Prepare north slab");
    await workspace.getByLabel("Work date").fill(new Date().toISOString().slice(0, 10));
    await workspace.getByLabel("Planned progress (%)").fill("25");
    await workspace.getByLabel("Planned quantity").fill("12.5");
    await workspace.getByLabel("Quantity unit").fill("m3");
    await workspace.getByLabel("Plan for tomorrow").nth(0).fill("Start slab preparation");
    const packageResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/site/projects/${projectId}/packages`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Create package" }).click();
    expect((await packageResponse).status()).toBe(201);
    await expect(workspace.getByRole("heading", { name: "Prepare north slab" })).toBeVisible();
    expect((await db.query<{ state: string; title: string; plannedQuantity: string }>(`SELECT state,data->>'title' AS title,data->>'plannedQuantity' AS "plannedQuantity" FROM site_records WHERE "projectId"=$1 AND kind='PACKAGE'`, [projectId])).rows[0]).toMatchObject({ state: "OPEN", title: "Prepare north slab", plannedQuantity: "12.5" });

    await workspace.getByLabel("Reason for the next site action").fill("Record today's site work");
    await workspace.getByLabel("Work completed today").fill("Marked and cleaned the slab area");
    await workspace.getByLabel("Manpower trade").fill("Masonry");
    await workspace.getByLabel("People reported for trade").fill("3");
    await workspace.getByLabel("Materials received").fill("Two cement pallets");
    await workspace.getByLabel("Issues").fill("None");
    await workspace.getByLabel("Delay causes").fill("None");
    const reportsPanel = workspace.getByRole("heading", { name: "Daily reports" }).locator("..");
    await reportsPanel.getByLabel("Plan for tomorrow").fill("Begin steel fixing");
    await reportsPanel.getByRole("checkbox", { name: /north-slab\.jpg/ }).check();
    const reportResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/site/projects/${projectId}/reports`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Save report draft" }).click();
    expect((await reportResponse).status()).toBe(201);
    await expect(workspace.getByText("Marked and cleaned the slab area")).toBeVisible();
    const reportId = (await db.query<{ id: string }>('SELECT id FROM site_records WHERE "projectId"=$1 AND kind=\'REPORT\' ORDER BY "createdAt" DESC LIMIT 1', [projectId])).rows[0]!.id;
    await workspace.getByLabel("Reason for the next site action").fill("Confirm site report after review");
    const confirmResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/site/reports/${reportId}/confirm`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Confirm daily report" }).click();
    expect((await confirmResponse).status()).toBe(201);
    await expect(workspace.getByText(/Confirmed by/)).toBeVisible();
    const confirmed = await db.query<{ state: string; workCompleted: string; manpower: unknown; progressSnapshot: unknown; photoEvidence: Array<{ documentId: string; blobId: string; sha256: string; name: string }> }>(`SELECT state,data->>'workCompleted' AS "workCompleted",data->'manpower' AS manpower,data->'progressSnapshot' AS "progressSnapshot",data->'photoEvidence' AS "photoEvidence" FROM site_records WHERE id=$1`, [reportId]);
    expect(confirmed.rows[0]).toMatchObject({ state: "CONFIRMED", workCompleted: "Marked and cleaned the slab area", manpower: [{ trade: "Masonry", count: 3 }] });
    expect(confirmed.rows[0]?.progressSnapshot).toBeTruthy();
    expect(confirmed.rows[0]?.photoEvidence).toMatchObject([{ documentId: image.id, name: "north-slab.jpg", sha256: hash(imageBytes) }]);

    const packagePanel = workspace.locator(".site-record").filter({ hasText: "Prepare north slab" });
    await workspace.getByLabel("Reason for the next site action").fill("Record actual package progress and passing quality");
    await packagePanel.getByLabel("Actual progress (%)").fill("100");
    await packagePanel.getByLabel("Actual quantity").fill("12.5");
    await packagePanel.getByLabel("Quality status").selectOption("PENDING");
    await packagePanel.getByLabel("Material status").fill("All materials available");
    await packagePanel.getByLabel("Blockers").fill("None");
    await packagePanel.getByLabel("Plan for tomorrow").fill("Curing inspection");
    await packagePanel.getByRole("button", { name: "Save progress" }).click();
    await expect(workspace.getByText("Progress observation saved.")).toBeVisible();
    await expect(packagePanel.getByText(/100%/)).toBeVisible();
    expect((await db.query<{ actualPercent: string; qualityStatus: string }>(`SELECT data->>'actualPercent' AS "actualPercent",data->>'qualityStatus' AS "qualityStatus" FROM site_records WHERE id=(SELECT id FROM site_records WHERE "projectId"=$1 AND kind='PACKAGE' LIMIT 1)`, [projectId])).rows[0]).toEqual({ actualPercent: "100", qualityStatus: "PENDING" });
    await workspace.getByLabel("Reason for the next site action").fill("Make explicit package completion decision");
    await packagePanel.getByRole("button", { name: "Decide package complete" }).click();
    await expect(packagePanel.locator(".site-state")).toHaveText("COMPLETED");
    await workspace.getByLabel("Reason for the next site action").fill("Record passing quality evidence after package completion");
    await packagePanel.getByLabel("Quality status").selectOption("PASSED");
    await packagePanel.getByRole("button", { name: "Save progress" }).click();
    await expect(workspace.getByText("Progress observation saved.")).toBeVisible();
    expect((await db.query<{ state: string; qualityStatus: string }>(`SELECT state,data->>'qualityStatus' AS "qualityStatus" FROM site_records WHERE id=(SELECT id FROM site_records WHERE "projectId"=$1 AND kind='PACKAGE' LIMIT 1)`, [projectId])).rows[0]).toEqual({ state: "COMPLETED", qualityStatus: "PASSED" });

    await workspace.getByLabel("Reason for the next site action").fill("Record tile finish snag");
    await workspace.getByLabel("Title", { exact: true }).fill("Uneven tile edge");
    await workspace.getByLabel("Description").fill("Tile edge at the north wall needs correction");
    await workspace.getByRole("button", { name: "Create snag" }).click();
    const snagCard = workspace.locator(".site-record").filter({ hasText: "Uneven tile edge" });
    await expect(snagCard).toBeVisible();
    await workspace.getByLabel("Reason for the next site action").fill("Assign named repair person");
    await snagCard.getByLabel("Assign fixer").selectOption(fixerAccountId);
    await snagCard.getByRole("button", { name: "Assign fixer" }).click();
    await expect(snagCard.locator(".site-state")).toHaveText("ASSIGNED");
    await workspace.getByLabel("Reason for the next site action").fill("Appoint independent snag verifier");
    await snagCard.getByLabel("Name verifier").selectOption(verifierAccountId);
    await snagCard.getByRole("button", { name: "Appoint verifier" }).click();
    await expect(workspace.getByText("Independent verifier appointed.", { exact: true })).toBeVisible();

    const useActor = async (actor: typeof fixerAuth): Promise<void> => {
      await context.clearCookies();
      await context.addCookies([{ name: "sense_sid", value: actor.secret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
      await page.goto("/site");
      await workspace.getByLabel("Active Turnkey project").selectOption(projectId);
      await expect(workspace.getByRole("heading", { name: projectTitle })).toBeVisible();
    };
    await useActor(fixerAuth);
    const fixerSnag = workspace.locator(".site-record").filter({ hasText: "Uneven tile edge" });
    await workspace.getByLabel("Reason for the next site action").fill("Start assigned tile repair");
    await fixerSnag.getByRole("button", { name: "Start repair" }).click();
    await expect(fixerSnag.locator(".site-state")).toHaveText("IN PROGRESS");
    await workspace.getByLabel("Reason for the next site action").fill("Submit first repair for independent check");
    await fixerSnag.getByLabel("Repair note").fill("Reset the edge and regrouted the tile");
    await fixerSnag.getByRole("button", { name: "Ready for verification" }).click();
    await expect(fixerSnag.locator(".site-state")).toHaveText("READY FOR VERIFICATION");

    await useActor(verifierAuth);
    const verifierSnag = workspace.locator(".site-record").filter({ hasText: "Uneven tile edge" });
    await workspace.getByLabel("Reason for the next site action").fill("Record failed independent inspection");
    await verifierSnag.getByLabel("Verification outcome").selectOption("FAILED");
    await verifierSnag.getByLabel("Verification note").fill("Edge remains raised after the first repair");
    await verifierSnag.getByRole("button", { name: "Record independent check" }).click();
    await expect(verifierSnag.locator(".site-state")).toHaveText("IN PROGRESS");
    const verificationHistory = verifierSnag.locator("details");
    await verificationHistory.getByText("Verification attempts (1)", { exact: true }).click();
    const failedAttempt = verificationHistory.getByRole("listitem");
    await expect(failedAttempt).toContainText("FAILED · repair 1");
    await expect(failedAttempt).toContainText("Edge remains raised after the first repair");

    await useActor(fixerAuth);
    const reworkSnag = workspace.locator(".site-record").filter({ hasText: "Uneven tile edge" });
    await workspace.getByLabel("Reason for the next site action").fill("Rework the failed tile edge");
    await reworkSnag.getByLabel("Repair note").fill("Lifted tile and reset the substrate level");
    await reworkSnag.getByRole("button", { name: "Ready for verification" }).click();
    await expect(reworkSnag.locator(".site-state")).toHaveText("READY FOR VERIFICATION");

    await useActor(verifierAuth);
    const passedSnag = workspace.locator(".site-record").filter({ hasText: "Uneven tile edge" });
    await workspace.getByLabel("Reason for the next site action").fill("Pass repaired edge after reinspection");
    await passedSnag.getByLabel("Verification outcome").selectOption("PASSED");
    await passedSnag.getByLabel("Verification note").fill("Edge is flush and grout is complete");
    await passedSnag.getByRole("button", { name: "Record independent check" }).click();
    await expect(passedSnag.locator(".site-state")).toHaveText("VERIFIED");

    await useActor(leadAuth);
    const managerSnag = workspace.locator(".site-record").filter({ hasText: "Uneven tile edge" });
    await workspace.getByLabel("Reason for the next site action").fill("Close current passed snag verification");
    await managerSnag.getByRole("button", { name: "Close verified snag" }).click();
    await expect(managerSnag.locator(".site-state")).toHaveText("CLOSED");
    const persistedAttempts = await db.query<{ outcomes: string[]; count: number }>(`SELECT array_agg(outcome::text ORDER BY "repairGeneration") AS outcomes,count(*)::int AS count FROM site_verification_attempts WHERE "projectId"=$1`, [projectId]);
    expect(persistedAttempts.rows[0]).toMatchObject({ outcomes: ["FAILED", "PASSED"], count: 2 });
    const closedSnag = await db.query<{ state: string; closedBy: string; closureVerificationId: string }>(`SELECT state,data->>'closedBy' AS "closedBy",data->>'closureVerificationId' AS "closureVerificationId" FROM site_records WHERE "projectId"=$1 AND kind='SNAG'`, [projectId]);
    expect(closedSnag.rows[0]).toMatchObject({ state: "CLOSED", closedBy: leadAccountId });
    expect(closedSnag.rows[0]?.closureVerificationId).toBeTruthy();

    await workspace.getByLabel("Reason for the next site action").fill("Record separate site handover decision");
    await workspace.getByLabel("Handover decision note").fill("Current package complete, passing quality, and closed snag verified");
    await workspace.getByRole("button", { name: "Record site handover" }).click();
    await expect(workspace.getByText(/Site handover decision recorded/)).toBeVisible();
    expect((await db.query<{ state: string; note: string }>(`SELECT state,data->>'note' AS note FROM site_records WHERE "projectId"=$1 AND kind='HANDOVER'`, [projectId])).rows[0]).toMatchObject({ state: "CONFIRMED", note: "Current package complete, passing quality, and closed snag verified" });

    await page.reload();
    await workspace.getByLabel("Active Turnkey project").selectOption(projectId);
    await expect(workspace.getByRole("heading", { name: "Prepare north slab" })).toBeVisible();
    await expect(workspace.getByText("Marked and cleaned the slab area")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await testInfo.attach(`s20-site-${testInfo.project.name}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    const screenshotDirectory = resolve(process.env.S20_SCREENSHOT_DIR ?? ".env.s20-tools/screenshots");
    mkdirSync(screenshotDirectory, { recursive: true });
    writeFileSync(join(screenshotDirectory, `s20-site-${testInfo.project.name}.png`), await page.screenshot({ fullPage: true }));

    await context.clearCookies();
    await context.addCookies([{ name: "sense_sid", value: ownerAuth.secret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    const dashboardReady = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/dashboard/sources/site" && response.request().method() === "GET", { timeout: 30_000 });
    await page.goto("/dashboard");
    expect((await dashboardReady).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
    // V10 keeps Site as an optional Owner widget. Exercise the real gallery
    // before checking the same persisted project facts as the earlier panel.
    await page.getByRole("button", { name: "Edit widgets", exact: true }).click();
    await page.getByRole("button", { name: "Add widgets", exact: true }).click();
    await page.getByRole("region", { name: "Add widgets", exact: true }).getByRole("button", { name: /^Site delivery/ }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const siteDashboard = page.locator(".dv-widget-body > div").filter({ has: page.getByRole("heading", { name: `Site: ${projectTitle}`, exact: true }) });
    await expect(siteDashboard).toBeVisible();
    for (const summary of ["Prepare north slab", "Daily report ·", "Uneven tile edge", "Site handover ·"]) await expect(siteDashboard).toContainText(summary);
    for (const fact of ["COMPLETED", "100", "Marked and cleaned the slab area", "CLOSED", "Tile edge at the north wall needs correction", "Current package complete, passing quality, and closed snag verified"]) await expect(siteDashboard).toContainText(fact);
    const s24ScreenshotDirectory = resolve(process.env.S24_SCREENSHOT_DIR ?? ".env.s24-tools/screenshots");
    mkdirSync(s24ScreenshotDirectory, { recursive: true });
    await siteDashboard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(s24ScreenshotDirectory, `s24-site-dashboard-viewport-${testInfo.project.name}.png`), fullPage: false });
    for (const [name, fact] of [["package", "Prepare north slab"], ["report", "Marked and cleaned the slab area"], ["snag", "Uneven tile edge"], ["handover", "Current package complete, passing quality, and closed snag verified"]] as const) {
      // V10 groups source status/date/value in one line; retain each factual
      // screenshot without requiring the earlier separate value span.
      await siteDashboard.getByText(fact, { exact: false }).first().screenshot({ path: resolve(s24ScreenshotDirectory, `s24-site-dashboard-${name}-${testInfo.project.name}.png`) });
    }
  } finally {
    if (fixtureCommitted) await db.query('UPDATE sessions SET "revokedAt"=CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])', [[ownerAuth.id, leadAuth.id, fixerAuth.id, verifierAuth.id]]);
    await db.end();
  }
});
