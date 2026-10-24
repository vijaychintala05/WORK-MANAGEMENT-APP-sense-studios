import { test, expect } from "@playwright/test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

test("employee creates, refreshes, edits and completes a persisted self-task; unrelated task access is denied", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(!process.env.DATABASE_URL, "Dedicated local test database required");
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "db"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("Task browser fixture requires a dedicated test database");
  const require = createRequire(resolve("apps/api/package.json"));
  const { Client } = require("pg") as typeof import("pg");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const suffix = randomUUID();
  const sessionSecret = randomBytes(32).toString("base64url");
  const csrf = createHmac("sha256", sessionSecret).update("csrf").digest("base64url");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const branchId = randomUUID(), teamId = randomUUID();
  const accountId = randomUUID(), employeeId = randomUUID();
  const foreignAccountId = randomUUID(), foreignEmployeeId = randomUUID();
  const sessionId = randomUUID();
  const foreignSessionId = randomUUID();
  const ownerSessionId = randomUUID();
  const foreignSecret = randomBytes(32).toString("base64url");
  const ownerSecret = randomBytes(32).toString("base64url");
  const ownerCsrf = createHmac("sha256", ownerSecret).update("csrf").digest("base64url");
  const foreignCsrf = createHmac("sha256", foreignSecret).update("csrf").digest("base64url");
  const title = `E2E self-task ${suffix.slice(0, 8)}`;
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(6092706)");
    const existingOrg = await db.query<{ id: string }>("SELECT id FROM organizations LIMIT 1");
    const organizationId = existingOrg.rows[0]?.id ?? randomUUID();
    if (!existingOrg.rows[0]) await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [organizationId, "S09 task browser fixture"]);
    const existingOwner = await db.query<{ id: string }>("SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE' LIMIT 1");
    const ownerId = existingOwner.rows[0]?.id ?? randomUUID();
    if (!existingOwner.rows[0]) {
      await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [ownerId, `task-owner-${suffix}@example.test`]);
      await db.query('INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4),($5,$6,$3,$7)', [randomUUID(), randomUUID(), ownerId, randomBytes(32), randomUUID(), randomUUID(), randomBytes(32)]);
      await db.query('INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [randomUUID(), ownerId, hash(randomUUID())]);
    }
    await db.query('INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [branchId, organizationId, `S09 task ${suffix}`]);
    await db.query('INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)', [teamId, organizationId, branchId, `S09 task team ${suffix}`]);
    await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP),($3,$4,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [accountId, `task-${suffix}@example.test`, foreignAccountId, `task-other-${suffix}@example.test`]);
    await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP),($6,$2,$7,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [employeeId, organizationId, accountId, branchId, teamId, foreignEmployeeId, foreignAccountId]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [sessionId, accountId, hash(sessionSecret), hash(csrf)]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [foreignSessionId, foreignAccountId, hash(foreignSecret), hash(foreignCsrf)]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [ownerSessionId, ownerId, hash(ownerSecret), hash(ownerCsrf)]);
    await db.query("COMMIT");
    const unrelatedResponse = await page.request.post("/api/v1/tasks", { headers: { Cookie: `sense_sid=${foreignSecret}`, Origin: baseURL!, "X-CSRF-Token": foreignCsrf }, data: { title: `Private task ${suffix}`, type: "NON_PROJECT", priority: "LOW", targetDate: "2026-12-31", reason: "Unrelated employee task fixture" } });
    expect(unrelatedResponse.status()).toBe(201);
    const unrelatedTask = await unrelatedResponse.json() as { id: string };
    await context.addCookies([{ name: "sense_sid", value: sessionSecret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);

    await page.goto("/workspace");
    const workspace = page.locator(".task-workspace");
    await expect(workspace.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await workspace.getByRole("button", { name: "Create task", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create my task", exact: true });
    const form = dialog.getByRole("form", { name: "Create task" });
    await form.getByLabel("Task name").fill(title);
    await form.getByLabel("Target date").fill("2026-12-31");
    await form.getByLabel("Reason").fill("Capture planned independent work");
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(workspace.getByText("Task created.", { exact: true })).toBeVisible();
    await expect(workspace.getByRole("button", { name: new RegExp(title) })).toBeVisible();

    const persisted = await db.query<{ id: string; status: string; version: number; type: string }>(`SELECT id,status::text,type::text,version FROM tasks WHERE title=$1 AND "primaryOwnerEmployeeId"=$2`, [title, employeeId]);
    expect(persisted.rows).toHaveLength(1);
    const taskId = persisted.rows[0]!.id;
    await page.reload();
    await expect(workspace.getByRole("button", { name: new RegExp(title) })).toBeVisible();
    await expect(workspace.getByRole("heading", { name: title })).toBeVisible();
    await expect(workspace.locator(".task-eyebrow").filter({ hasText: "Non project" })).toBeVisible();
    const denied = await page.request.get(`/api/v1/tasks/${unrelatedTask.id}`);
    expect(denied.status()).toBe(403);

    // Standalone Tasks register uses the same persisted task and guarded commands.
    // Verify actual cell/People layout at full width and beside the detail panel.
    const originalViewport = page.viewportSize();
    for (const width of [1440, 1280, 1024, 783, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/tasks?scope=mine");
      const open = workspace.getByRole("button", { name: `Open task: ${title}`, exact: true });
      await expect(open).toBeVisible();
      await expect(workspace.getByLabel("Task scope")).toHaveCount(1);
      const row = open.locator("..");
      const assertLayout = async () => {
        const main = await open.boundingBox();
        const people = await row.locator(".task-people-trigger").boundingBox();
        expect(main && people).toBeTruthy();
        expect(main!.y + main!.height <= people!.y + 1 || main!.x + main!.width <= people!.x + 1).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await assertLayout();
      const titleBounds = await open.locator("strong").first().boundingBox();
      expect(titleBounds!.y + titleBounds!.height).toBeLessThan(844 - (width < 700 ? 76 : 0));
      const searchPadding = await workspace.getByLabel("Search tasks").evaluate(element => Number.parseFloat(getComputedStyle(element).paddingLeft));
      expect(searchPadding).toBeGreaterThanOrEqual(30);
      await page.screenshot({ path: testInfo.outputPath(`tasks-register-list-${width}.png`), fullPage: true });
      await open.click();
      const next = workspace.getByRole("region", { name: "Next step" });
      await expect(next.getByRole("button", { name: "Start task", exact: true })).toBeDisabled();
      await expect(next.getByText(/Enter a reason of at least 3 characters/)).toBeVisible();
      if (width >= 1024) await assertLayout();
      const actionBounds = await next.getByRole("button", { name: "Start task", exact: true }).boundingBox();
      expect(actionBounds!.y + actionBounds!.height).toBeLessThan(844 - (width < 700 ? 76 : 0));
      await page.screenshot({ path: testInfo.outputPath(`tasks-register-detail-${width}.png`), fullPage: true });
      await workspace.getByRole("button", { name: "Back to task list" }).click();
      await expect(open).toBeVisible();
    }
    await page.goto(`/tasks?scope=mine&taskId=${taskId}`);
    await expect(workspace.getByRole("region", { name: "Next step" })).toBeVisible();
    await workspace.getByLabel("Reason for change").fill("Begin the planned task work");
    const transition = page.waitForResponse((response) => response.url().endsWith(`/api/v1/tasks/${taskId}/state`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Start task" }).click();
    expect((await transition).status()).toBe(201);
    await expect(workspace.locator(".task-detail-heading .task-state")).toHaveText("In progress");
    const changed = await db.query<{ status: string; version: number; changeCount: string }>(`SELECT t.status::text,t.version,(SELECT count(*) FROM task_status_changes c WHERE c."taskId"=t.id)::text AS "changeCount" FROM tasks t WHERE t.id=$1`, [taskId]);
    expect(changed.rows[0]).toEqual({ status: "IN_PROGRESS", version: 2, changeCount: "2" });

    // Keep the existing legacy-route journey at its original project viewport.
    if (originalViewport) await page.setViewportSize(originalViewport);
    await page.goto(`/workspace?taskId=${taskId}`);
    await expect(workspace.locator(".task-detail-heading .task-state")).toHaveText("In progress");
    const waitingForm = workspace.getByRole("form", { name: "Wait on task" });
    await waitingForm.getByLabel("Reason for waiting").fill("Waiting for supplier access");
    await waitingForm.getByLabel("Delay cause").fill("Supplier credentials pending");
    await waitingForm.getByLabel("Known responsible party (optional)").fill("Supplier coordinator");
    const waited = page.waitForResponse((response) => response.url().endsWith(`/api/v1/tasks/${taskId}/wait`) && response.request().method() === "POST");
    await waitingForm.getByRole("button", { name: "Move to waiting" }).click();
    expect((await waited).status()).toBe(201);
    await expect(workspace.locator(".task-detail-heading .task-state")).toHaveText("Waiting");
    await expect(workspace.locator(".task-waiting-details").getByText("Supplier credentials pending", { exact: true })).toBeVisible();
    const waitingRow = await db.query<{ status: string; version: number; delayCause: string; responsibleParty: string | null }>(`SELECT t.status::text,t.version,c."delayCause",c."responsibleParty" FROM tasks t JOIN task_status_changes c ON c."taskId"=t.id AND c."taskVersion"=t.version WHERE t.id=$1`, [taskId]);
    expect(waitingRow.rows[0]).toMatchObject({ status: "WAITING", version: 3, delayCause: "Supplier credentials pending", responsibleParty: "Supplier coordinator" });

    await page.reload();
    await expect(workspace.locator(".task-detail-heading .task-state")).toHaveText("Waiting");
    await expect(workspace.locator(".task-waiting-details").getByText("Supplier credentials pending", { exact: true })).toBeVisible();
    await workspace.screenshot({ path: testInfo.outputPath("task-waiting.png") });
    await workspace.getByLabel("Reason for resuming").fill("Supplier access has been restored");
    const resumed = page.waitForResponse((response) => response.url().endsWith(`/api/v1/tasks/${taskId}/resume`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Resume task" }).click();
    expect((await resumed).status()).toBe(201);
    await expect(workspace.locator(".task-detail-heading .task-state")).toHaveText("In progress");
    const resumedRow = await db.query<{ status: string; version: number; delayCause: string; responsibleParty: string | null }>(`SELECT t.status::text,t.version,c."delayCause",c."responsibleParty" FROM tasks t JOIN task_status_changes c ON c."taskId"=t.id AND c."toStatus"='WAITING'::"TaskStatus" WHERE t.id=$1 ORDER BY c."taskVersion" DESC LIMIT 1`, [taskId]);
    expect(resumedRow.rows[0]).toMatchObject({ status: "IN_PROGRESS", version: 4, delayCause: "Supplier credentials pending", responsibleParty: "Supplier coordinator" });

    // The Owner sets the controlled commitment; the task owner stays responsible
    // for ordinary task edits and operational target dates.
    await context.addCookies([{ name: "sense_sid", value: ownerSecret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    await page.goto(`/workspace?taskId=${taskId}`);
    await expect(workspace.getByRole("heading", { name: title })).toBeVisible();
    await expect(workspace.getByRole("heading", { name: title })).toBeVisible();
    const commitmentForm = workspace.getByRole("form", { name: "Set committed due date" });
    await commitmentForm.getByLabel("Committed due date").fill("2026-11-15");
    await commitmentForm.getByLabel("Reason").fill("Owner confirms the client delivery commitment");
    const initialCommitment = page.waitForResponse((response) => response.url().endsWith(`/api/v1/tasks/${taskId}/committed-date`) && response.request().method() === "POST");
    await commitmentForm.getByRole("button", { name: "Set committed date" }).click();
    expect((await initialCommitment).status()).toBe(201);
    await expect(workspace.getByText("Committed due date set.", { exact: true })).toBeVisible();
    await page.goto(`/workspace?taskId=${taskId}`);
    await expect(workspace.getByRole("heading", { name: title })).toBeVisible();
    await expect(workspace.locator(".task-facts").getByText("2026-11-15", { exact: true })).toBeVisible();
    await expect(workspace.locator(".task-facts").getByText("2026-12-31", { exact: true })).toBeVisible();

    const changeCommitmentForm = workspace.getByRole("form", { name: "Set committed due date" });
    await changeCommitmentForm.getByLabel("Committed due date").fill("2026-11-30");
    await changeCommitmentForm.getByLabel("Reason").fill("Owner approved the revised client commitment");
    const revisedCommitment = page.waitForResponse((response) => response.url().endsWith(`/api/v1/tasks/${taskId}/committed-date`) && response.request().method() === "POST");
    await changeCommitmentForm.getByRole("button", { name: "Change committed date" }).click();
    expect((await revisedCommitment).status()).toBe(201);
    await expect(workspace.getByText("Committed due date updated.", { exact: true })).toBeVisible();
    await page.goto(`/workspace?taskId=${taskId}`);
    await expect(workspace.getByRole("heading", { name: title })).toBeVisible();
    await expect(workspace.locator(".task-facts").getByText("2026-11-30", { exact: true })).toBeVisible();
    await expect(workspace.locator(".task-history")).toContainText("Committed due date changed from 2026-11-15 to 2026-11-30: Owner approved the revised client commitment");

    await expect(workspace.getByRole("heading", { name: title })).toBeVisible();
    await expect(workspace.locator(".task-detail-heading .task-state")).toHaveText("In progress");
    await workspace.getByRole("button", { name: "Edit task", exact: true }).click();
    await workspace.getByLabel("Edit tags").fill("studio,brief");
    await workspace.getByLabel("Edit checklist").fill("[x] Confirm scope\n[ ] Prepare notes");
    await workspace.getByLabel("Target date").fill("2026-12-25");
    await workspace.getByLabel("Edit reason").fill("Add the checked scope and planning notes");
    await workspace.getByRole("button", { name: "Save task", exact: true }).click();
    await expect(workspace.getByText("Task details updated.", { exact: true })).toBeVisible();
    await expect(workspace.locator(".task-tags")).toContainText("studio");
    await expect(workspace.locator(".task-facts").getByText("2026-12-25", { exact: true })).toBeVisible();
    await expect(workspace.locator(".task-facts").getByText("2026-11-30", { exact: true })).toBeVisible();
    await workspace.getByLabel("Reason for change").fill("All deliverable work is finished");
    await workspace.getByRole("button", { name: "Complete task", exact: true }).click();
    await expect(workspace.locator(".task-detail-heading .task-state")).toHaveText("Completed");
    const finished = await db.query<{ status: string; version: number; tags: string[] }>('SELECT status::text,version,tags FROM tasks WHERE id=$1', [taskId]);
    expect(finished.rows[0]).toEqual({ status: "COMPLETED", version: 8, tags: ["studio", "brief"] });
    await page.goto(`/workspace?taskId=${taskId}`);
    await expect(workspace.getByRole("heading", { name: title })).toBeVisible();
    await expect(workspace.getByRole("heading", { name: title })).toBeVisible();
    await expect(workspace.locator(".task-detail-heading .task-state")).toHaveText("Completed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await workspace.screenshot({ path: testInfo.outputPath("task-completed.png") });
  } finally {
    await db.query('UPDATE sessions SET "revokedAt"=CURRENT_TIMESTAMP WHERE id=$1', [sessionId]);
    await db.query('UPDATE sessions SET "revokedAt"=CURRENT_TIMESTAMP WHERE id=$1', [foreignSessionId]);
    await db.query('UPDATE sessions SET "revokedAt"=CURRENT_TIMESTAMP WHERE id=$1', [ownerSessionId]);
    await db.end();
  }
});
