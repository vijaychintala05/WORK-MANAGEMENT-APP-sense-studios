import { test, expect } from "@playwright/test";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "../../apps/api/src/s27-disposable-test-target.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const disposableS27Database = Boolean(process.env.DATABASE_URL && isS27DisposableTestTarget("DATABASE_URL", process.env.DATABASE_URL));
test("linked project task is submitted, reviewed from inbox, and assigned correction survives refresh", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  test.skip(!process.env.DATABASE_URL, "Dedicated S13 PostgreSQL database required");
  const url = new URL(process.env.DATABASE_URL!);
  const dedicatedS13Database = /^\/sense_s13_[a-z0-9_]*_test$/.test(url.pathname);
  const explicitlyEnabledS15Database = process.env.S15_E2E_ENABLED === "1" && /^\/sense_s15_[a-z0-9_]*_test$/.test(url.pathname);
  const explicitlyEnabledS25Database = process.env.S25_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(url.hostname) && ((["56433", "57433"].includes(url.port) && /^\/sense_s25_main_s25_[a-z0-9_]+_test$/i.test(url.pathname)) || (url.port === "57433" && /^\/sense_s13_s25_[a-z0-9_]+_test$/i.test(url.pathname)));
  const explicitlyEnabledS26Database = process.env.S26_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "57433" && /^\/sense_s26_main_s26_[a-z0-9_]+_test$/i.test(url.pathname);
  const explicitlyEnabledS27Database = process.env.S27_E2E_ENABLED === "1" && url.hostname === "127.0.0.1" && url.port === "57433" && /^\/sense_s27_main_s27_[a-z0-9_]+_test$/.test(url.pathname) || disposableS27Database;
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || ((!explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database) && url.port !== "56433") || (!dedicatedS13Database && !explicitlyEnabledS15Database && !explicitlyEnabledS25Database && !explicitlyEnabledS26Database && !explicitlyEnabledS27Database)) throw new Error("Review browser fixture requires an isolated local S13, explicitly enabled S15, or explicitly enabled exact S25/S26/S27 test database");
  const require = createRequire(resolve("apps/api/package.json"));
  const { Client } = require("pg") as typeof import("pg");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const suffix = randomUUID();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const session = () => {
    const secret = randomBytes(32).toString("base64url");
    return { secret, csrf: createHmac("sha256", secret).update("csrf").digest("base64url"), id: randomUUID() };
  };
  const ownerSession = session(), managerSession = session(), submitterSession = session(), reviewerSession = session();
  const branchId = randomUUID(), teamId = randomUUID();
  const managerAccountId = randomUUID(), managerEmployeeId = randomUUID();
  const submitterAccountId = randomUUID(), submitterEmployeeId = randomUUID();
  const reviewerAccountId = randomUUID(), reviewerEmployeeId = randomUUID();
  const correctionAccountId = randomUUID(), correctionEmployeeId = randomUUID();
  const projectTitle = `S13 browser review ${suffix.slice(0, 8)}`;
  const taskTitle = `Submit for review ${suffix.slice(0, 8)}`;
  await db.connect();
  if (disposableS27Database) {
    const identity = await db.query<{ database: string; port: number }>("SELECT current_database() AS database, inet_server_port() AS port");
    if (!matchesS27DisposableServer(process.env.DATABASE_URL!, identity.rows[0]!.database, identity.rows[0]!.port)) throw new Error("Connected PostgreSQL server does not match the guarded S27 disposable target");
  }
  let ownerAccountId: string;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(6092706)");
    const orgResult = await db.query<{ id: string }>("SELECT id FROM organizations LIMIT 1");
    const organizationId = orgResult.rows[0]?.id ?? randomUUID();
    if (!orgResult.rows[0]) await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [organizationId, "S13 browser review fixture"]);
    const ownerResult = await db.query<{ id: string }>("SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE' LIMIT 1");
    ownerAccountId = ownerResult.rows[0]?.id ?? randomUUID();
    if (!ownerResult.rows[0]) await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [ownerAccountId, `s13-browser-owner-${suffix}@example.test`]);
    const credentialCount = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM passkey_credentials WHERE "accountId"=$1 AND "revokedAt" IS NULL', [ownerAccountId]);
    for (let index = credentialCount.rows[0]!.count; index < 2; index += 1) await db.query('INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4)', [randomUUID(), randomUUID(), ownerAccountId, randomBytes(32)]);
    const recoveryCount = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM owner_recovery_codes WHERE "accountId"=$1 AND "usedAt" IS NULL AND "replacedAt" IS NULL AND "acknowledgedAt" IS NOT NULL', [ownerAccountId]);
    if (!recoveryCount.rows[0]!.count) await db.query('INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [randomUUID(), ownerAccountId, hash(randomUUID())]);
    await db.query('INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [branchId, organizationId, `S13 review ${suffix}`]);
    await db.query('INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)', [teamId, organizationId, branchId, `S13 review team ${suffix}`]);
    for (const [accountId, employeeId, role] of [[managerAccountId, managerEmployeeId, "manager"], [submitterAccountId, submitterEmployeeId, "submitter"], [reviewerAccountId, reviewerEmployeeId, "reviewer"], [correctionAccountId, correctionEmployeeId, "correction"]] as const) {
      await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [accountId, `s13-${role}-${suffix}@example.test`]);
      await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [employeeId, organizationId, accountId, branchId, teamId]);
    }
    const permissionRows = [
      [managerEmployeeId, "project.view"], [managerEmployeeId, "project.manage"], [managerEmployeeId, "task.assign"],
      [submitterEmployeeId, "project.view"], [reviewerEmployeeId, "project.view"], [reviewerEmployeeId, "review.decide"], [correctionEmployeeId, "project.view"]
    ] as const;
    for (const [employeeId, permissionKey] of permissionRows) await db.query('INSERT INTO employee_permission_overrides(id,"organizationId","employeeId","permissionKey",effect,"scopeKind","branchId",reason) VALUES($1,$2,$3,$4,\'ALLOW\',\'BRANCH\',$5,$6)', [randomUUID(), organizationId, employeeId, permissionKey, branchId, "S13 browser acceptance grant"]);
    for (const [accountId, auth] of [[ownerAccountId, ownerSession], [managerAccountId, managerSession], [submitterAccountId, submitterSession], [reviewerAccountId, reviewerSession]] as const) {
      await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [auth.id, accountId, hash(auth.secret), hash(auth.csrf)]);
    }
    await db.query("COMMIT");

    const ownerHeaders = { Cookie: `sense_sid=${ownerSession.secret}`, Origin: baseURL!, "X-CSRF-Token": ownerSession.csrf };
    const projectResponse = await page.request.post("/api/v1/projects", { headers: ownerHeaders, data: { branchId, title: projectTitle, deliveryType: "DESIGN", scopes: ["Architecture"], reason: "Create S13 review browser project" } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { project: { id: string } };
    const projectId = project.project.id;
    let projectVersion = 1;
    for (const employeeId of [managerEmployeeId, submitterEmployeeId, reviewerEmployeeId, correctionEmployeeId]) {
      const assigned = await page.request.post(`/api/v1/projects/${projectId}/assignments`, { headers: ownerHeaders, data: { employeeId, expectedVersion: projectVersion, reason: "Grant project review access" } });
      expect(assigned.status()).toBe(201);
      projectVersion = (await db.query<{ version: number }>('SELECT version FROM projects WHERE id=$1', [projectId])).rows[0]!.version;
    }
    const lead = await page.request.post(`/api/v1/projects/${projectId}/lead`, { headers: ownerHeaders, data: { employeeId: managerEmployeeId, expectedVersion: projectVersion, reason: "Appoint assigned Project Lead" } });
    expect(lead.status()).toBe(201);
    projectVersion = (await db.query<{ version: number }>('SELECT version FROM projects WHERE id=$1', [projectId])).rows[0]!.version;
    const activated = await page.request.post(`/api/v1/projects/${projectId}/status`, { headers: ownerHeaders, data: { toStatus: "ACTIVE", expectedVersion: projectVersion, reason: "Activate review project" } });
    expect(activated.status()).toBe(201);

    const taskResponse = await page.request.post("/api/v1/tasks", { headers: ownerHeaders, data: { title: taskTitle, type: "PROJECT", projectId, ownerEmployeeId: submitterEmployeeId, priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: "INTERNAL", reason: "Create a task requiring internal review" } });
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json() as { id: string; version: number };
    const categoryResponse = await page.request.post("/api/v1/reviews/categories", { headers: ownerHeaders, data: { name: `S13 corrections ${suffix.slice(0, 6)}`, reason: "Add browser test correction category" } });
    expect(categoryResponse.status()).toBe(201);
    const category = await categoryResponse.json() as { id: string };
    const managerHeaders = { Cookie: `sense_sid=${managerSession.secret}`, Origin: baseURL!, "X-CSRF-Token": managerSession.csrf };
    const assignedReviewer = await page.request.post(`/api/v1/reviews/tasks/${task.id}/reviewer`, { headers: managerHeaders, data: { employeeId: reviewerEmployeeId, expectedVersion: task.version, reason: "Assign independent reviewer" } });
    expect(assignedReviewer.status()).toBe(201);
    const assignedTaskVersion = (await assignedReviewer.json() as { task: { version: number } }).task.version;
    const submitterHeaders = { Cookie: `sense_sid=${submitterSession.secret}`, Origin: baseURL!, "X-CSRF-Token": submitterSession.csrf };
    const startedTask = await page.request.post(`/api/v1/tasks/${task.id}/state`, { headers: submitterHeaders, data: { toState: "IN_PROGRESS", expectedVersion: assignedTaskVersion, reason: "Start the assigned drawing task" } });
    const startedBody = await startedTask.text();
    expect(startedTask.status(), startedBody).toBe(201);
    expect((JSON.parse(startedBody) as { version: number }).version).toBe(assignedTaskVersion + 1);

    await context.addCookies([{ name: "sense_sid", value: submitterSession.secret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    await page.goto(`/reviews?taskId=${task.id}`);
    const workspace = page.locator(".review-workspace");
    await expect(workspace.getByRole("heading", { name: taskTitle })).toBeVisible();
    await workspace.getByLabel("Evidence type").selectOption("LINK");
    await workspace.getByLabel("HTTPS review link").fill("https://files.sensestudios.com/e2e/review-work");
    await workspace.getByLabel("Submission reason").fill("Submit the linked design task for independent review");
    await expect(workspace.getByRole("button", { name: "Submit for internal review" })).toBeEnabled();
    const submissionRequest = page.waitForResponse((response) => response.url().endsWith(`/api/v1/reviews/tasks/${task.id}/submit`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Submit for internal review" }).click();
    expect((await submissionRequest).status()).toBe(201);
    await expect(workspace.getByText("Work submitted for internal review. Client delivery waits for approval.")).toBeVisible();
    await page.reload();
    await expect(workspace.getByRole("heading", { name: taskTitle })).toBeVisible();
    await expect(workspace.getByRole("heading", { name: "Round 1" })).toBeVisible();
    await workspace.screenshot({ path: testInfo.outputPath("s13-review-submitted.png") });

    await context.clearCookies();
    await context.addCookies([{ name: "sense_sid", value: reviewerSession.secret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    await page.goto("/reviews");
    const reviewerWorkspace = page.locator(".review-workspace");
    await expect(reviewerWorkspace.getByRole("button", { name: new RegExp(taskTitle) })).toBeVisible();
    await reviewerWorkspace.getByRole("button", { name: new RegExp(taskTitle) }).click();
    await expect(reviewerWorkspace.getByRole("heading", { name: taskTitle })).toBeVisible();
    await reviewerWorkspace.getByLabel("Reason").last().fill("Begin independent review of submitted work");
    await reviewerWorkspace.getByRole("button", { name: "Start review" }).click();
    await expect(reviewerWorkspace.getByText("Review started.")).toBeVisible();
    await reviewerWorkspace.getByLabel("Escalation reason").fill("The review needs Project Lead attention before a decision");
    const escalationRequest = page.waitForResponse((response) => /\/api\/v1\/reviews\/rounds\/.+\/escalate$/.test(response.url()) && response.request().method() === "POST");
    await reviewerWorkspace.getByRole("button", { name: "Record escalation" }).click();
    expect((await escalationRequest).status()).toBe(201);
    await expect(reviewerWorkspace.getByText("Review escalation recorded.")).toBeVisible();
    const escalation = await db.query<{ id: string; actorId: string; recipientAccountId: string; reason: string; roundId: string }>(
      'SELECT id, "actorId", "recipientAccountId", reason, "roundId" FROM review_escalations WHERE "roundId" IN (SELECT id FROM review_rounds WHERE "taskId"=$1)', [task.id]
    );
    expect(escalation.rows).toHaveLength(1);
    expect(escalation.rows[0]).toMatchObject({ actorId: reviewerAccountId, recipientAccountId: managerAccountId, reason: "The review needs Project Lead attention before a decision" });
    const notification = await db.query<{ recipientAccountId: string; channel: string; category: string; mandatory: boolean; internalRoute: string }>(
      'SELECT n."recipientAccountId", n.channel::text, n.category, n.mandatory, n."internalRoute" FROM notifications n JOIN domain_events e ON e.id=n."eventId" WHERE e."eventName"=\'review.escalated\' AND e."subjectId"=$1', [escalation.rows[0]!.roundId]
    );
    expect(notification.rows).toEqual([{ recipientAccountId: managerAccountId, channel: "IN_APP", category: "review.escalated", mandatory: true, internalRoute: `/reviews?taskId=${task.id}&roundId=${escalation.rows[0]!.roundId}` }]);
    await page.goto(`/reviews?taskId=${task.id}`);
    await expect(reviewerWorkspace.getByRole("heading", { name: taskTitle })).toBeVisible();
    await page.reload();
    await expect(reviewerWorkspace.getByRole("heading", { name: taskTitle })).toBeVisible();
    const escalationHistory = reviewerWorkspace.locator(".review-escalation-history");
    await expect(escalationHistory).toContainText("Escalated to");
    await expect(escalationHistory).toContainText("The review needs Project Lead attention before a decision");
    const decisionForm = reviewerWorkspace.locator("form").filter({ hasText: "Record decision" });
    await expect(decisionForm).toBeVisible();
    await decisionForm.locator("select").nth(0).selectOption("CORRECTIONS_REQUIRED");
    await decisionForm.getByLabel("Decision comment").fill("Clarify the material schedule and dimension callouts");
    await decisionForm.locator("select").nth(1).selectOption("Critical");
    await decisionForm.locator("select").nth(2).selectOption(category.id);
    await decisionForm.getByLabel("Reason").fill("Record required corrections from the independent reviewer");
    await expect(decisionForm.getByRole("button", { name: "Save decision" })).toBeEnabled();
    const decisionRequest = page.waitForResponse((response) => /\/api\/v1\/reviews\/rounds\/.+\/decision$/.test(response.url()) && response.request().method() === "POST");
    await decisionForm.getByRole("button", { name: "Save decision" }).click();
    expect((await decisionRequest).status()).toBe(201);
    await expect(reviewerWorkspace.getByText("Corrections requested.")).toBeVisible();
    await expect(reviewerWorkspace.getByText("Critical", { exact: false })).toBeVisible();
    const decision = await db.query<{ status: string; severity: string; categoryName: string }>('SELECT r.status::text,r.severity::text,r."categoryName" FROM review_rounds r WHERE r."taskId"=$1', [task.id]);
    expect(decision.rows[0]).toMatchObject({ status: "CORRECTIONS_REQUIRED", severity: "CRITICAL" });

    await context.clearCookies();
    await context.addCookies([{ name: "sense_sid", value: managerSession.secret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    await page.goto(`/reviews?taskId=${task.id}`);
    const managerWorkspace = page.locator(".review-workspace");
    await expect(managerWorkspace.getByRole("heading", { name: taskTitle })).toBeVisible();
    await managerWorkspace.getByLabel("Correction owner").selectOption(correctionEmployeeId);
    await managerWorkspace.getByLabel("Reason").last().fill("Assign independent correction work to the project team");
    const correctionRequest = page.waitForResponse((response) => /\/api\/v1\/reviews\/rounds\/.+\/correction$/.test(response.url()) && response.request().method() === "POST");
    await managerWorkspace.getByRole("button", { name: "Create correction task" }).click();
    expect((await correctionRequest).status()).toBe(201);
    await expect(managerWorkspace.getByText("Correction task assigned.")).toBeVisible();
    await page.reload();
    await expect(managerWorkspace.getByRole("heading", { name: taskTitle })).toBeVisible();
    const correction = await db.query<{ correctionTaskId: string | null; title: string; status: string }>('SELECT r."correctionTaskId",t.title,t.status::text FROM review_rounds r JOIN tasks t ON t.id=r."correctionTaskId" WHERE r."taskId"=$1', [task.id]);
    expect(correction.rows).toHaveLength(1);
    expect(correction.rows[0]).toMatchObject({ title: `Correct: ${taskTitle}`, status: "NOT_STARTED" });
    await managerWorkspace.screenshot({ path: testInfo.outputPath("s13-correction-assigned.png") });
    const reloadedDecision = await db.query<{ status: string; correctionTaskId: string | null }>('SELECT status::text,"correctionTaskId" FROM review_rounds WHERE "taskId"=$1', [task.id]);
    expect(reloadedDecision.rows[0]).toMatchObject({ status: "CORRECTIONS_REQUIRED", correctionTaskId: correction.rows[0]!.correctionTaskId });
  } finally {
    await db.end();
  }
});
