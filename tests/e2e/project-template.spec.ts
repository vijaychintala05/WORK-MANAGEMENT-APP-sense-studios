import { test, expect } from "@playwright/test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

test("Owner applies a versioned template and required milestone gates survive refresh", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  if (!process.env.DATABASE_URL) throw new Error("S08 browser acceptance requires a dedicated test database");
  const url = new URL(process.env.DATABASE_URL);
  if (!["localhost", "127.0.0.1", "db"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("S08 browser fixture requires a dedicated test database");
  const require = createRequire(resolve("apps/api/package.json"));
  const { Client } = require("pg") as typeof import("pg");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const suffix = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const csrf = createHmac("sha256", secret).update("csrf").digest("base64url");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const branchId = randomUUID(), teamId = randomUUID(), employeeId = randomUUID(), staffId = randomUUID(), sessionId = randomUUID();
  const templateName = `Residential template ${suffix.slice(0, 8)}`;
  const projectTitle = `Template project plan ${suffix.slice(0, 8)}`;
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(6092706)");
    // Identity is verified first in its own Playwright dependency project. These
    // business fixtures use the single ready test Owner without changing sessions
    // or credentials belonging to another journey.
    const existingOwner = await db.query<{ id: string }>("SELECT id FROM accounts WHERE kind='OWNER' AND state='ACTIVE'");
    const ownerId = existingOwner.rows[0]?.id ?? randomUUID();
    if (!existingOwner.rows[0]) {
      await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [ownerId, 's08-fixture-owner@example.test']);
      for (let index = 0; index < 2; index += 1) await db.query('INSERT INTO passkey_credentials(id,"credentialId","accountId","publicKey") VALUES($1,$2,$3,$4)', [randomUUID(), randomUUID(), ownerId, randomBytes(32)]);
      await db.query('INSERT INTO owner_recovery_codes(id,"accountId","codeHash","acknowledgedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [randomUUID(), ownerId, hash(randomUUID())]);
    }
    const org = await db.query<{ id: string }>("SELECT id FROM organizations LIMIT 1");
    const organizationId = org.rows[0]?.id ?? randomUUID();
    if (!org.rows[0]) await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [organizationId, "S08 browser fixture"]);
    await db.query('INSERT INTO branches(id,"organizationId",name,"updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP)', [branchId, organizationId, `S08 ${suffix}`]);
    await db.query('INSERT INTO teams(id,"organizationId","branchId",name,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)', [teamId, organizationId, branchId, "S08 delivery team"]);
    await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [staffId, `s08-lead-${suffix}@example.test`]);
    await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [employeeId, organizationId, staffId, branchId, teamId]);
    for (const permissionKey of ["project.view", "project.manage"]) await db.query('INSERT INTO employee_permission_overrides(id,"organizationId","employeeId","permissionKey",effect,"scopeKind","branchId",reason) VALUES($1,$2,$3,$4,\'ALLOW\',\'BRANCH\',$5,$6)', [randomUUID(), organizationId, employeeId, permissionKey, branchId, "S08 eligible lead fixture"]);
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [sessionId, ownerId, hash(secret), hash(csrf)]);
    await db.query("COMMIT");
    await context.addCookies([{ name: "sense_sid", value: secret, url: baseURL!, httpOnly: true, sameSite: "Strict" }]);
    await page.goto("/workspace");
    const workspace = page.locator(".project-workspace");
    await workspace.getByLabel("Project branch").selectOption(branchId);
    await workspace.getByText("Project template (optional)", { exact: true }).click();
    const templates = workspace.locator(".project-template-panel");
    await templates.getByRole("button", { name: "Create template", exact: true }).click();
    const form = templates.locator(".template-form");
    await form.getByLabel("Template name").fill(templateName);
    await form.getByLabel("Initial service scopes").fill("Architecture\nInterior design");
    await form.getByLabel("Planned folders").fill("Brief\nDesign/Working drawings");
    await form.getByLabel("File naming convention").fill("Project_Stage_Item_Revision");
    await form.getByRole("button", { name: "Add milestone" }).click();
    await form.getByLabel("Milestone 1 key").fill("BRIEF_APPROVED");
    await form.getByLabel("Milestone 1 name").fill("Brief approved");
    await form.getByLabel("Milestone 1 stage").selectOption("SITE_MEASUREMENT");
    await form.getByLabel("Required", { exact: true }).check();
    await form.getByLabel("Reason for change").fill("Create residential delivery baseline");
    await form.getByRole("button", { name: "Create template", exact: true }).click();
    await expect(templates.getByText("Template created.", { exact: true })).toBeVisible();
    await templates.getByLabel("Project template").selectOption({ label: `${templateName} · version 1` });
    const create = workspace.locator(".project-create-panel");
    await create.getByLabel("Project title").fill(projectTitle);
    await expect(create.getByLabel("Delivery type")).toHaveValue("DESIGN");
    await expect(create.getByLabel("Initial service scopes")).toHaveValue("Architecture\nInterior design");
    await create.getByLabel("Creation reason").fill("Apply the selected version");
    await create.getByRole("button", { name: "Create Draft project" }).click();
    await expect(workspace.getByText("Draft project created.", { exact: true })).toBeVisible();
    await expect(templates.getByLabel("Project template")).toHaveValue("");
    await workspace.getByRole("button", { name: new RegExp(projectTitle) }).click();
    await workspace.getByRole("button", { name: "Plan", exact: true }).click();
    const plan = workspace.getByRole("region", { name: "Project plan" });
    await expect(plan.getByText(`${templateName} · version 1`)).toBeVisible();
    await expect(plan.getByText("Design/Working drawings", { exact: true })).toBeVisible();
    await page.reload();
    await expect(workspace.getByLabel("Project branch")).toHaveValue(branchId);
    await expect(workspace.getByText("Loading projects…", { exact: true })).toBeHidden();
    await expect(workspace.getByRole("button", { name: new RegExp(projectTitle) })).toBeVisible();
    await workspace.getByRole("button", { name: new RegExp(projectTitle) }).click();
    await workspace.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(plan.getByText(`${templateName} · version 1`)).toBeVisible();
    await workspace.getByRole("button", { name: "Overview", exact: true }).click();
    const reason = workspace.getByLabel("Project action reason");
    await reason.fill("Assign eligible delivery lead");
    await workspace.getByRole("button", { name: "People", exact: true }).click();
    await workspace.getByLabel("Contributor", { exact: true }).selectOption(employeeId);
    await workspace.getByRole("button", { name: "Assign contributor" }).click();
    await expect(reason).toHaveValue("");
    await reason.fill("Appoint accountable Project Lead");
    await workspace.getByLabel("Project lead", { exact: true }).selectOption(employeeId);
    await workspace.getByRole("button", { name: "Set lead" }).click();
    await expect(reason).toHaveValue("");
    const status = workspace.getByLabel("New project status");
    await workspace.getByRole("button", { name: "Overview", exact: true }).click();
    await reason.fill("Activate templated delivery");
    await status.selectOption("ACTIVE");
    await workspace.getByRole("button", { name: "Change status" }).click();
    await workspace.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(plan.getByLabel("Reason for plan update")).toBeVisible();
    const projectId = (await db.query<{ id: string }>('SELECT id FROM projects WHERE title=$1 AND "createdById"=$2', [projectTitle, ownerId])).rows[0]!.id;
    await workspace.getByRole("button", { name: "Overview", exact: true }).click();
    await reason.fill("Required milestone must block completion");
    await status.selectOption("COMPLETED");
    const denial = page.waitForResponse((response) => response.url().includes(`/projects/${projectId}/status`) && response.request().method() === "POST");
    await workspace.getByRole("button", { name: "Change status" }).click();
    expect((await denial).status()).toBe(409);
    await workspace.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(plan.getByLabel("Reason for plan update")).toBeVisible();
    await plan.getByLabel("Reason for plan update").fill("Record completed brief milestone");
    await plan.locator("li").filter({ has: page.getByText("Brief approved", { exact: true }) }).getByRole("button", { name: "Mark complete" }).click();
    await expect(plan.locator("li").filter({ has: page.getByText("Brief approved", { exact: true }) }).getByText("Complete", { exact: true })).toBeVisible();
    await workspace.getByRole("button", { name: "Overview", exact: true }).click();
    await reason.fill("Complete delivery after required milestone");
    await status.selectOption("COMPLETED");
    await workspace.getByRole("button", { name: "Change status" }).click();
    await expect(workspace.locator(".project-detail-heading").getByText("COMPLETED", { exact: true })).toBeVisible();
    const persisted = await db.query<{ status: string; planCount: string; completed: boolean; overrideCount: string }>(`SELECT p.status::text,
      (SELECT count(*) FROM project_plans WHERE "projectId"=p.id)::text AS "planCount",
      EXISTS(SELECT 1 FROM project_plan_items WHERE "projectId"=p.id AND key='BRIEF_APPROVED' AND "completedAt" IS NOT NULL) AS completed,
      (SELECT count(*) FROM project_gate_overrides WHERE "projectId"=p.id)::text AS "overrideCount" FROM projects p WHERE p.id=$1`, [projectId]);
    expect(persisted.rows[0]).toEqual({ status: "COMPLETED", planCount: "1", completed: true, overrideCount: "0" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await workspace.getByRole("button", { name: "Plan", exact: true }).click();
    await plan.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("s08-plan.png") });
  } finally {
    await db.query("ROLLBACK");
    await db.query('UPDATE sessions SET "revokedAt"=CURRENT_TIMESTAMP WHERE id=$1', [sessionId]);
    await db.end();
  }
});
