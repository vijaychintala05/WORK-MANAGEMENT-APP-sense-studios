import { expect, type Page } from "@playwright/test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";

/** Real independent review through existing commands; SQL creates fixture identities only. */
export async function approveFixtureWork(input: { page: Page; db: Client; origin: string; ownerHeaders: Record<string, string>; projectId: string; taskId: string; workerAccountId: string; workerEmployeeId: string; manualPublication: boolean }) {
  const { page, db, origin, ownerHeaders, projectId, taskId, workerAccountId, workerEmployeeId } = input;
  const suffix = randomUUID(), reviewerAccountId = randomUUID(), reviewerEmployeeId = randomUUID();
  const employee = (await db.query<{ organizationId: string; homeBranchId: string; homeTeamId: string }>('SELECT "organizationId","homeBranchId","homeTeamId" FROM employees WHERE id=$1', [workerEmployeeId])).rows[0]!;
  await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'STAFF\',\'ACTIVE\',CURRENT_TIMESTAMP)', [reviewerAccountId, `review-fixture-${suffix}@example.test`]);
  await db.query('INSERT INTO employees(id,"organizationId","accountId","homeBranchId","homeTeamId","hiredAt","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_TIMESTAMP)', [reviewerEmployeeId, employee.organizationId, reviewerAccountId, employee.homeBranchId, employee.homeTeamId]);
  for (const permissionKey of ["project.view", "document.view", "review.decide"]) await db.query('INSERT INTO employee_permission_overrides(id,"organizationId","employeeId","permissionKey",effect,"scopeKind","branchId",reason) VALUES($1,$2,$3,$4,\'ALLOW\',\'BRANCH\',$5,$6)', [randomUUID(), employee.organizationId, reviewerEmployeeId, permissionKey, employee.homeBranchId, "Independent evidence review browser fixture"]);
  const command = async (path: string, data: unknown, headers = ownerHeaders) => {
    const result = await page.request.post(path, { headers, data });
    expect(result.status(), await result.text()).toBe(201);
    return result.json();
  };
  const version = async () => (await db.query<{ version: number }>('SELECT version FROM tasks WHERE id=$1', [taskId])).rows[0]!.version;
  await command(`/api/v1/projects/${projectId}/assignments`, { employeeId: reviewerEmployeeId, expectedVersion: (await db.query<{ version: number }>('SELECT version FROM projects WHERE id=$1', [projectId])).rows[0]!.version, reason: "Assign independent browser evidence reviewer" });
  if (input.manualPublication) await command(`/api/v1/reviews/tasks/${taskId}/routing/revoke`, { reason: "Use explicit authorized manual publication for this regression journey" });
  await command(`/api/v1/reviews/tasks/${taskId}/reviewer`, { employeeId: reviewerEmployeeId, expectedVersion: await version(), reason: "Appoint independent evidence reviewer" });
  const headers = async (accountId: string) => {
    const secret = randomBytes(32).toString("base64url");
    const csrf = createHmac("sha256", secret).update("csrf").digest("base64url");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    await db.query('INSERT INTO sessions(id,"accountId","tokenHash","csrfTokenHash","expiresAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval \'1 hour\')', [randomUUID(), accountId, hash(secret), hash(csrf)]);
    return { Cookie: `sense_sid=${secret}`, Origin: origin, "X-CSRF-Token": csrf };
  };
  const workerHeaders = await headers(workerAccountId), reviewerHeaders = await headers(reviewerAccountId);
  const submitted = await command(`/api/v1/reviews/tasks/${taskId}/submit`, { expectedVersion: await version(), reviewUrl: `https://files.sensestudios.com/browser/${taskId}`, reason: "Submit required work link for independent internal review" }, workerHeaders) as { rounds: Array<{ id: string }> };
  const roundId = submitted.rounds.at(-1)!.id;
  await command(`/api/v1/reviews/rounds/${roundId}/start`, { reason: "Review exact submitted evidence independently" }, reviewerHeaders);
  await command(`/api/v1/reviews/rounds/${roundId}/decision`, { kind: "APPROVED", reason: "Approve exact submitted work before client review" }, reviewerHeaders);
  const submission = (await db.query<{ id: string }>('SELECT id FROM review_submissions WHERE "taskId"=$1 ORDER BY "roundNumber" DESC LIMIT 1', [taskId])).rows[0]!;
  return { submissionId: submission.id, version: await version() };
}
