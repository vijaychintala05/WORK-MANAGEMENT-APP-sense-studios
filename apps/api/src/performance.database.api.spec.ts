import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AccountKind, AccountState, PermissionEffect, PermissionScopeKind, ProjectDeliveryType, ProjectStatus, TaskPriority, TaskReviewRequirement, TaskType, Prisma } from "./generated/prisma/client.js";
import { DatabaseService } from "./database.service.js";
import { AuthorizationService } from "./authorization.service.js";
import { ApprovalService } from "./approval.service.js";
import { DocumentService } from "./document.service.js";
import { NotificationsService } from "./notifications.service.js";
import { RevisionService } from "./revision.service.js";
import { ReviewService } from "./review.service.js";
import { WorkforceService } from "./workforce.service.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { TurnkeyService } from "./turnkey.service.js";
import { SiteService } from "./site.service.js";
import { PerformanceService } from "./performance.service.js";
import { ProjectService, type ProjectActor } from "./project.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { TaskService } from "./task.service.js";
import { localCalendarDate } from "./task-recurrence-policy.js";
import type { RuntimeConfig } from "./config.js";
import type { PerformancePolicy } from "./performance-calculations.js";

const databaseUrl = process.env.S23_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const config: RuntimeConfig = {
  nodeEnv: "test", port: 4000,
  databaseUrl: databaseUrl ?? "postgresql://invalid:invalid@127.0.0.1/sense_s23_performance_test",
  webOrigin: "http://localhost:5173", ownerBootstrapEmail: undefined, ownerBootstrapSecret: undefined,
};
class FixtureRollback extends Error {}
type Person = { accountId: string; employeeId: string; actor: ProjectActor };
type Fixture = {
  organizationId: string; branchId: string; teamId: string; otherBranchId: string; otherTeamId: string;
  owner: ProjectActor; manager: Person; employee: Person; peer: Person; outsider: Person; deniedSelf: Person; portal: ProjectActor;
  database: DatabaseService; performance: PerformanceService; authorization: AuthorizationService;
  projects: ProjectService; workflow: ProjectWorkflowService; tasks: TaskService; reviews: ReviewService; documents: DocumentService; revisions: RevisionService; site: SiteService; tx: Prisma.TransactionClient;
  today: string; suffix: string;
};

function fixtureDatabase(tx: Prisma.TransactionClient, failPerformanceAudit = false): DatabaseService {
  const wrap = (target: Prisma.TransactionClient): Prisma.TransactionClient => new Proxy(target, {
    get(delegate, key) {
      if (key === "$transaction") return async (callback: (inner: Prisma.TransactionClient) => Promise<unknown>) => {
        await target.$executeRawUnsafe("SAVEPOINT s23_performance_command");
        try {
          const result = await callback(wrap(target));
          // The fixture holds one outer rollback transaction, so validate deferred source-history guards
          // at each nested service boundary to model their normal committed command boundaries.
          await target.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
          await target.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
          await target.$executeRawUnsafe("RELEASE SAVEPOINT s23_performance_command");
          return result;
        } catch (error) {
          await target.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s23_performance_command");
          await target.$executeRawUnsafe("RELEASE SAVEPOINT s23_performance_command");
          throw error;
        }
      };
      if (failPerformanceAudit && key === "auditEvent") {
        return new Proxy(Reflect.get(delegate, key, delegate) as object, {
          get(table, method) {
            if (method === "create") return async (args: { data?: { eventKey?: string } }) => {
              if (args.data?.eventKey === "employee_performance.changed" || args.data?.eventKey === "project_health.changed") throw new Error("Injected S23 audit failure");
              return Reflect.get(table, method, table).call(table, args);
            };
            return Reflect.get(table, method, table);
          }
        });
      }
      return Reflect.get(delegate, key, delegate) as unknown;
    }
  }) as Prisma.TransactionClient;
  return { prisma: wrap(tx) } as unknown as DatabaseService;
}

function command(reason: string, commandId = randomUUID()) { return { commandId, reason }; }
function plusDays(value: string, amount: number) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function policyFor(family: "EMPLOYEE" | "LEADER" | "DESIGN" | "TURNKEY", groupKey: string, effectiveFrom: string, label = `Fictional S23 ${family} test policy`): PerformancePolicy {
  const components: PerformancePolicy["components"] = family === "EMPLOYEE"
    ? [
        { metric: "REVIEW_FIRST_PASS", weight: 60, min: 0, max: 100, direction: "HIGHER", required: false },
        { metric: "TASK_ON_TIME", weight: 40, min: 0, max: 100, direction: "HIGHER", required: true },
      ]
    : family === "LEADER"
      ? [{ metric: "LEADER_REVIEW_TURNAROUND", weight: 100, min: 0, max: 1000, direction: "LOWER", required: true }]
      : family === "DESIGN"
        ? [{ metric: "PROJECT_TASK_ON_TIME", weight: 100, min: 0, max: 100, direction: "HIGHER", required: true }]
        : [{ metric: "SITE_PROGRESS", weight: 100, min: 0, max: 100, direction: "HIGHER", required: true }];
  return {
    family, groupKey, label, effectiveFrom, components,
    attendanceMaxWeight: 5, efficiencyMaxWeight: 5, strengthAt: 80, weaknessBelow: 50,
    thresholds: { criticalBelow: 40, delayedBelow: 60, atRiskBelow: 80 },
  };
}

databaseDescribe("S23 performance PostgreSQL acceptance", () => {
  let database: DatabaseService;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const s23 = url.port === "56433" && /^\/sense_s23_[a-z0-9_]+_test$/.test(url.pathname);
    const s25 = process.env.S25_E2E_ENABLED === "1" && url.port === "57433" && /^\/sense_s23_s25_[a-z0-9_]+_test$/.test(url.pathname);
    const s26 = process.env.S26_E2E_ENABLED === "1" && url.port === "57433" && /^\/sense_s23_s26_[a-z0-9_]+_test$/.test(url.pathname);
    const s27 = process.env.S27_E2E_ENABLED === "1" && url.port === "58440" && /^\/sense_s23_s27_[a-z0-9_]+_test$/.test(url.pathname);
    if (!/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || (!s23 && !s25 && !s26 && !s27)) {
      throw new Error("Performance acceptance requires an exact S23 or explicitly enabled exact S23/S25/S26/S27 loopback database");
    }
    database = new DatabaseService(config);
    const rows = await database.prisma.$queryRaw<Array<{ name: string; tableName: string | null }>>`
      SELECT current_database() AS name, to_regclass('public.performance_records')::text AS "tableName"`;
    if (rows[0]?.name !== url.pathname.slice(1)) throw new Error("S23_DATABASE_URL did not reach its exact named test database");
    if (!rows[0]?.tableName) throw new Error("S23 performance migrations must be deployed before PostgreSQL acceptance");
  });
  afterAll(async () => database?.onModuleDestroy());

  async function makeFixture(run: (f: Fixture) => Promise<void>) {
    try {
      await database.prisma.$transaction(async (tx) => {
        const suffix = randomUUID();
        const organization = await tx.organization.findFirst() ?? await tx.organization.create({ data: { name: `S23 performance ${suffix}` } });
        const branch = await tx.branch.create({ data: { organizationId: organization.id, name: `S23 branch ${suffix}` } });
        const team = await tx.team.create({ data: { organizationId: organization.id, branchId: branch.id, name: `S23 team ${suffix}` } });
        const otherBranch = await tx.branch.create({ data: { organizationId: organization.id, name: `S23 other branch ${suffix}` } });
        const otherTeam = await tx.team.create({ data: { organizationId: organization.id, branchId: otherBranch.id, name: `S23 other team ${suffix}` } });
        const ownerAccount = await tx.account.findFirst({ where: { kind: AccountKind.OWNER, state: AccountState.ACTIVE } })
          ?? await tx.account.create({ data: { normalizedEmail: `s23-owner-${suffix}@example.test`, kind: AccountKind.OWNER, state: AccountState.ACTIVE } });
        const makePerson = async (name: string, homeBranchId: string, homeTeamId: string, reportsToId?: string): Promise<Person> => {
          const account = await tx.account.create({ data: { normalizedEmail: `s23-${name}-${suffix}@example.test`, kind: AccountKind.STAFF, state: AccountState.ACTIVE } });
          const employee = await tx.employee.create({ data: { organizationId: organization.id, accountId: account.id, homeBranchId, homeTeamId, reportsToId: reportsToId ?? null, hiredAt: new Date("2026-01-01T00:00:00.000Z") } });
          return { accountId: account.id, employeeId: employee.id, actor: { accountId: account.id, organizationId: organization.id, kind: AccountKind.STAFF } };
        };
        const manager = await makePerson("manager", branch.id, team.id);
        const employee = await makePerson("employee", branch.id, team.id, manager.employeeId);
        const peer = await makePerson("peer", branch.id, team.id);
        const outsider = await makePerson("outsider", otherBranch.id, otherTeam.id);
        const deniedSelf = await makePerson("denied-self", branch.id, team.id);
        const portalAccount = await tx.account.create({ data: { normalizedEmail: `s23-portal-${suffix}@example.test`, kind: AccountKind.EXTERNAL, state: AccountState.ACTIVE } });
        await tx.employeePermissionOverride.createMany({ data: [
          { organizationId: organization.id, employeeId: manager.employeeId, permissionKey: "performance.manage", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.TEAM, branchId: branch.id, teamId: team.id, reason: "S23 scoped performance manager fixture" },
          { organizationId: organization.id, employeeId: employee.employeeId, permissionKey: "performance.view", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.SELF, reason: "S23 own performance view fixture" },
          { organizationId: organization.id, employeeId: deniedSelf.employeeId, permissionKey: "performance.view", effect: PermissionEffect.DENY, scopeKind: PermissionScopeKind.SELF, reason: "S23 explicit own performance deny fixture" },
          { organizationId: organization.id, employeeId: outsider.employeeId, permissionKey: "performance.manage", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.TEAM, branchId: otherBranch.id, teamId: otherTeam.id, reason: "S23 unrelated branch manager fixture" },
          { organizationId: organization.id, employeeId: employee.employeeId, permissionKey: "project.manage", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: branch.id, reason: "S23 assigned Project Lead fixture" },
          { organizationId: organization.id, employeeId: employee.employeeId, permissionKey: "project.view", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: branch.id, reason: "S23 assigned Project Lead fixture" },
          ...["project.manage", "project.view", "site.view", "site.work"].map(permissionKey => ({ organizationId: organization.id, employeeId: manager.employeeId, permissionKey, effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: branch.id, reason: "S23 Turnkey health source fixture" })),
        ] });
        const serviceDb = fixtureDatabase(tx);
        const authorization = new AuthorizationService(serviceDb);
        const actor: ProjectActor = { accountId: ownerAccount.id, organizationId: organization.id, kind: AccountKind.OWNER };
        const projects = new ProjectService(serviceDb);
        const approvals = new ApprovalService(serviceDb);
        const workflow = new ProjectWorkflowService(serviceDb, authorization, approvals);
        const tasks = new TaskService(serviceDb, authorization, approvals);
        const documents = new DocumentService(serviceDb, authorization, { ...config, nasRoot: resolve(".env.s23-tools/nas") });
        const revisions = new RevisionService(serviceDb, authorization, documents);
        const notifications = new NotificationsService(serviceDb);
        const reviews = new ReviewService(serviceDb, authorization, documents, revisions, notifications);
        const workforce = new WorkforceService(serviceDb, authorization, approvals, notifications, { ...config, nasRoot: resolve(".env.s23-tools/nas") });
        const portalScope = new ClientPortalScopeService(serviceDb, authorization);
        const turnkey = new TurnkeyService(serviceDb, authorization, approvals, revisions, portalScope);
        const site = new SiteService(serviceDb, authorization, documents, turnkey, workforce);
        const organizationRow = await tx.organization.findUniqueOrThrow({ where: { id: organization.id } });
        const today = localCalendarDate(new Date(), organizationRow.timezone);
        await run({
          organizationId: organization.id, branchId: branch.id, teamId: team.id, otherBranchId: otherBranch.id, otherTeamId: otherTeam.id,
          owner: actor, manager, employee, peer, outsider, deniedSelf,
          portal: { accountId: portalAccount.id, organizationId: organization.id, kind: AccountKind.EXTERNAL },
          database: serviceDb, performance: new PerformanceService(serviceDb, authorization, revisions, approvals, workforce), authorization, projects, workflow, tasks, reviews, documents, revisions, site, tx, today, suffix,
        });
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        throw new FixtureRollback();
      }, { timeout: 60_000 });
    } catch (error) { if (!(error instanceof FixtureRollback)) throw error; }
  }

  async function savepointRejects(tx: Prisma.TransactionClient, action: () => Promise<unknown>) {
    await tx.$executeRawUnsafe("SAVEPOINT s23_expected_constraint_failure");
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s23_expected_constraint_failure");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT s23_expected_constraint_failure");
    expect(caught).toBeDefined();
  }

  async function approvePolicy(f: Fixture, policy: PerformancePolicy) {
    const draft = await f.performance.command(f.owner, { ...command("Create fictional Owner-entered policy"), operation: "POLICY_CREATE", policy });
    const approved = await f.performance.command(f.owner, { ...command("Approve fictional Owner-entered policy"), operation: "POLICY_APPROVE", id: draft.id, expectedVersion: draft.version });
    return { draft, approved };
  }

  async function assignGroup(f: Fixture, person: Person, family: "EMPLOYEE" | "LEADER", groupKey: string, effectiveFrom = f.today) {
    return f.performance.command(f.owner, { ...command("Assign explicit test role group"), operation: "ASSIGN_GROUP", employeeId: person.employeeId, family, groupKey, effectiveFrom });
  }

  async function createProject(f: Fixture, deliveryType: ProjectDeliveryType, ownerEmployeeId?: string) {
    const project = (await f.projects.create(f.owner, { branchId: f.branchId, title: `S23 ${deliveryType} ${f.suffix}`, deliveryType, scopes: ["S23 acceptance fixture"], reason: "Create isolated S23 source project" })).project;
    if (ownerEmployeeId) {
      await f.tx.projectAssignment.create({ data: { organizationId: f.organizationId, projectId: project.id, employeeId: ownerEmployeeId, grantedById: f.owner.accountId, grantReason: "Assign S23 source task owner" } });
    }
    return project;
  }

  it("requires explicit Owner policy setup, returns insufficient snapshots, and preserves cycle/score history", async () => {
    await makeFixture(async (f) => {
      const before = await f.tx.performanceRecord.count({ where: { organizationId: f.organizationId, kind: { in: ["SCORE", "HEALTH"] } } });
      const snapshotCommand = { ...command("Try score before policy"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.employee.employeeId, family: "EMPLOYEE", from: f.today, to: f.today };
      await expect(f.performance.command(f.owner, snapshotCommand)).rejects.toMatchObject({ status: 409 });
      expect(await f.tx.performanceRecord.count({ where: { organizationId: f.organizationId, kind: { in: ["SCORE", "HEALTH"] } } })).toBe(before);
      await expect(f.performance.command(f.manager.actor, { ...command("Staff cannot create scoring policy"), operation: "POLICY_CREATE", policy: policyFor("EMPLOYEE", "fictional-team", f.today) })).rejects.toMatchObject({ status: 403 });

      const input = { ...command("Create fictional approved-policy draft", "00000000-0000-4000-8000-000000000123"), operation: "POLICY_CREATE", policy: policyFor("EMPLOYEE", `fictional-${f.suffix}`, f.today) };
      const draft = await f.performance.command(f.owner, input);
      const retry = await f.performance.command(f.owner, input);
      expect(retry.id).toBe(draft.id);
      await expect(f.performance.command(f.owner, { ...input, reason: "Changed payload with same command identity" })).rejects.toMatchObject({ status: 409 });
      const approved = await f.performance.command(f.owner, { ...command("Approve exact fictional policy"), operation: "POLICY_APPROVE", id: draft.id, expectedVersion: draft.version });
      await assignGroup(f, f.employee, "EMPLOYEE", `fictional-${f.suffix}`);

      const score = await f.performance.command(f.owner, snapshotCommand);
      const frozen = await f.tx.performanceRecord.findUniqueOrThrow({ where: { id: score.id } });
      expect(score).toMatchObject({ kind: "SCORE", state: "ACTIVE", version: 1 });
      expect(score.data).toMatchObject({ family: "EMPLOYEE", policyId: approved.id, policyVersion: approved.version, status: "INSUFFICIENT_EVIDENCE", score: null, missing: ["TASK_ON_TIME"] });

      const cycle = await f.performance.command(f.owner, { ...command("Create matching review cycle"), operation: "CYCLE_CREATE", employeeId: f.employee.employeeId, frequency: "WEEKLY", from: f.today, to: f.today, scoreId: score.id, goals: ["Fictional test goal"], developmentActions: ["Fictional test development action"] });
      const commented = await f.performance.command(f.manager.actor, { ...command("Add manager comment and action"), operation: "CYCLE_COMMENT", id: cycle.id, expectedVersion: cycle.version, text: "Evidence was insufficient this week", goals: ["Keep source evidence current"], developmentActions: ["Review approved evidence next week"] });
      const acknowledged = await f.performance.command(f.employee.actor, { ...command("Own acknowledgement does not approve score"), operation: "CYCLE_ACKNOWLEDGE", id: cycle.id, expectedVersion: commented.version, text: "I acknowledge this review" });
      const finalized = await f.performance.command(f.owner, { ...command("Owner finalizes exact frozen snapshot"), operation: "CYCLE_FINALIZE", id: cycle.id, expectedVersion: acknowledged.version });
      const acknowledgedAfterFinalize = await f.performance.command(f.employee.actor, { ...command("Own acknowledgement after finalization"), operation: "CYCLE_ACKNOWLEDGE", id: cycle.id, expectedVersion: finalized.version, text: "I also acknowledge the finalized record" });
      expect(acknowledgedAfterFinalize.data).toMatchObject({ goals: ["Keep source evidence current"], developmentActions: ["Review approved evidence next week"], finalizedBy: f.owner.accountId });
      expect((acknowledgedAfterFinalize.data as { acknowledgements: unknown[] }).acknowledgements).toHaveLength(2);
      expect((await f.tx.performanceRecord.findUniqueOrThrow({ where: { id: score.id } })).data).toEqual(frozen.data);
      expect(await f.tx.performanceVersion.count({ where: { recordId: cycle.id } })).toBe(5);

      const nextDay = plusDays(f.today, 1);
      await approvePolicy(f, policyFor("EMPLOYEE", `fictional-${f.suffix}`, nextDay, "Fictional future policy version"));
      expect((await f.tx.performanceRecord.findUniqueOrThrow({ where: { id: score.id } })).data).toEqual(frozen.data);
      expect(await f.tx.performanceVersion.count({ where: { recordId: score.id } })).toBe(1);

      await savepointRejects(f.tx, () => f.tx.$executeRaw`UPDATE performance_records SET data = '{"score":100}'::jsonb WHERE id = ${score.id}::uuid`);
      await savepointRejects(f.tx, () => f.tx.$executeRaw`UPDATE performance_versions SET reason = 'tampered' WHERE "recordId" = ${score.id}::uuid`);
      await savepointRejects(f.tx, () => f.tx.$executeRaw`UPDATE performance_receipts SET "payloadHash" = repeat('0',64) WHERE "actorId" = ${f.owner.accountId}::uuid AND "commandId" = ${input.commandId}::uuid`);
      await savepointRejects(f.tx, () => f.tx.$executeRaw`UPDATE performance_records SET data = jsonb_set(data,'{goals}','["tampered"]'::jsonb), version=version+1 WHERE id = ${cycle.id}::uuid`);
      expect(acknowledged.id).toBe(cycle.id);
    });
  });

  it("separates employee, Team Leader, Design and Turnkey snapshots and enforces current read scope", async () => {
    await makeFixture(async (f) => {
      const employeeGroup = `employee-${f.suffix}`, leaderGroup = `leader-${f.suffix}`;
      await approvePolicy(f, policyFor("EMPLOYEE", employeeGroup, f.today));
      await approvePolicy(f, policyFor("LEADER", leaderGroup, f.today));
      await approvePolicy(f, policyFor("DESIGN", "DESIGN", f.today));
      await approvePolicy(f, policyFor("TURNKEY", "TURNKEY", f.today));
      await assignGroup(f, f.employee, "EMPLOYEE", employeeGroup);
      await assignGroup(f, f.employee, "LEADER", leaderGroup);

      const employeeScore = await f.performance.command(f.owner, { ...command("Capture employee test score"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.employee.employeeId, family: "EMPLOYEE", from: f.today, to: f.today });
      const leaderScore = await f.performance.command(f.owner, { ...command("Capture separate Team Leader test score"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.employee.employeeId, family: "LEADER", from: f.today, to: f.today });
      const design = await createProject(f, ProjectDeliveryType.DESIGN);
      const turnkey = await createProject(f, ProjectDeliveryType.TURNKEY);
      const designHealth = await f.performance.command(f.owner, { ...command("Capture Design health"), operation: "PROJECT_SNAPSHOT", projectId: design.id, from: f.today, to: f.today });
      const turnkeyHealth = await f.performance.command(f.owner, { ...command("Capture Turnkey health"), operation: "PROJECT_SNAPSHOT", projectId: turnkey.id, from: f.today, to: f.today });
      expect(employeeScore.data).toMatchObject({ family: "EMPLOYEE", status: "INSUFFICIENT_EVIDENCE", score: null });
      expect(leaderScore.data).toMatchObject({ family: "LEADER", status: "INSUFFICIENT_EVIDENCE", score: null, components: [expect.objectContaining({ metric: "LEADER_REVIEW_TURNAROUND", raw: null })] });
      expect(designHealth.data).toMatchObject({ family: "DESIGN", status: "INSUFFICIENT_EVIDENCE", healthStatus: null });
      expect(turnkeyHealth.data).toMatchObject({ family: "TURNKEY", status: "INSUFFICIENT_EVIDENCE", healthStatus: null });

      await expect(f.performance.employee(f.employee.actor, f.peer.employeeId)).rejects.toMatchObject({ status: 403 });
      await expect(f.performance.employee(f.outsider.actor, f.employee.employeeId)).rejects.toMatchObject({ status: 403 });
      await expect(f.performance.employee(f.portal, f.employee.employeeId)).rejects.toMatchObject({ status: 403 });
      await expect(f.performance.employee(f.deniedSelf.actor, f.deniedSelf.employeeId)).rejects.toMatchObject({ status: 403 });
      await expect(f.performance.employee(f.manager.actor, f.employee.employeeId)).resolves.toMatchObject({ canManage: true, employee: { id: f.employee.employeeId } });
      await expect(f.performance.employee(f.employee.actor, f.employee.employeeId)).resolves.toMatchObject({ canManage: false, employee: { id: f.employee.employeeId } });
      // The peer has no performance.view grant; intrinsic own access remains available absent an explicit deny.
      await expect(f.performance.employee(f.peer.actor, f.peer.employeeId)).resolves.toMatchObject({ canManage: false, employee: { id: f.peer.employeeId } });
      await expect(f.performance.context(f.manager.actor)).resolves.toMatchObject({ employees: expect.arrayContaining([expect.objectContaining({ id: f.employee.employeeId, canManage: true })]) });
      await expect(f.performance.project(f.employee.actor, design.id)).rejects.toMatchObject({ status: 403 });
    });
  });

  it("records real-source delay corrections and measures late days after external duration and approved extension", async () => {
    await makeFixture(async (f) => {
      const group = `employee-${f.suffix}`;
      await approvePolicy(f, policyFor("EMPLOYEE", group, f.today));
      await assignGroup(f, f.employee, "EMPLOYEE", group);
      const project = await createProject(f, ProjectDeliveryType.DESIGN, f.employee.employeeId);
      const currentProject = await f.tx.project.findUniqueOrThrow({ where: { id: project.id } });
      const ledProject = await f.workflow.lead(f.owner, project.id, { employeeId: f.employee.employeeId, expectedVersion: currentProject.version, reason: "Assign eligible S23 source task lead" });
      await f.workflow.status(f.owner, project.id, { toStatus: ProjectStatus.ACTIVE, expectedVersion: ledProject.version, reason: "Activate isolated delay acceptance project" });
      const tasks: Array<{ id: string; sourceId: string }> = [];
      const originalDeadline = plusDays(f.today, -5);
      for (const [index, extend] of [false, true].entries()) {
        const task = await f.tasks.create(f.owner, {
          projectId: project.id, ownerEmployeeId: f.employee.employeeId, title: `S23 delayed task ${index}`,
          type: TaskType.PROJECT, priority: TaskPriority.HIGH, targetDate: originalDeadline,
          estimatedHours: 1, reviewRequirement: TaskReviewRequirement.NONE, reason: "Create task with explicit original target date",
        });
        await f.tasks.changeCommittedDate(f.owner, task.id, { expectedVersion: task.version, committedDueDate: originalDeadline, reason: "Record committed original deadline evidence" });
        if (extend) {
          const employee = await f.tx.employee.findUniqueOrThrow({ where: { id: f.employee.employeeId } });
          const request = await f.tasks.requestExtension(f.employee.actor, task.id, { expectedVersion: 2, proposedDate: plusDays(f.today, -3), approverAccountId: f.owner.accountId, reason: "Fictional approved two-day external extension" });
          await f.tasks.decideExtension(f.owner, task.id, request.approvalId, { outcome: "APPROVED", reason: "Approve exact revised test deadline" });
          expect(employee.id).toBe(f.employee.employeeId);
        }
        const current = await f.tx.task.findUniqueOrThrow({ where: { id: task.id } });
        await f.tasks.transition(f.owner, task.id, { toState: "IN_PROGRESS", expectedVersion: current.version, reason: "Start source task" });
        const started = await f.tx.task.findUniqueOrThrow({ where: { id: task.id } });
        await f.tasks.transition(f.owner, task.id, { toState: "COMPLETED", expectedVersion: started.version, reason: "Complete source task on capture date" });
        const source = await f.tx.taskStatusChange.findFirstOrThrow({ where: { taskId: task.id, toStatus: "COMPLETED" } });
        tasks.push({ id: task.id, sourceId: source.id });
      }
      await f.tx.projectAssignment.create({ data: { organizationId: f.organizationId, projectId: project.id, employeeId: f.peer.employeeId, grantedById: f.owner.accountId, grantReason: "Assign independent S23 review evidence source" } });
      await f.tx.employeePermissionOverride.createMany({ data: [
        { organizationId: f.organizationId, employeeId: f.peer.employeeId, permissionKey: "project.view", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: f.branchId, reason: "S23 reviewer project source scope" },
        { organizationId: f.organizationId, employeeId: f.peer.employeeId, permissionKey: "review.decide", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: f.branchId, reason: "S23 reviewer decision scope" },
      ] });
      const qualityTask = await f.tasks.create(f.owner, {
        projectId: project.id, ownerEmployeeId: f.employee.employeeId, title: `S23 independently reviewed task ${f.suffix}`,
        type: TaskType.PROJECT, priority: TaskPriority.HIGH, targetDate: f.today,
        estimatedHours: 1, reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create real review-quality metric source",
      });
      const assigned = await f.reviews.assignReviewer(f.owner, qualityTask.id, { employeeId: f.peer.employeeId, expectedVersion: qualityTask.version, reason: "Assign independent reviewer for quality metric" });
      await f.tasks.transition(f.employee.actor, qualityTask.id, { toState: "IN_PROGRESS", expectedVersion: assigned.version, reason: "Start reviewed quality task" });
      const submitted = await f.reviews.submit(f.employee.actor, qualityTask.id, { reviewUrl: "https://files.sensestudios.com/performance/quality-source", expectedVersion: (await f.tx.task.findUniqueOrThrow({ where: { id: qualityTask.id } })).version, reason: "Submit real quality source for review" });
      const reviewRound = submitted.rounds[0]!;
      await f.reviews.start(f.peer.actor, reviewRound.id, "Begin independent quality source review");
      await f.reviews.decision(f.peer.actor, reviewRound.id, { kind: "APPROVED", reason: "Approve real quality evidence source" });
      await f.reviews.complete(f.employee.actor, qualityTask.id, { expectedVersion: (await f.tx.task.findUniqueOrThrow({ where: { id: qualityTask.id } })).version, reason: "Complete independently approved task" });
      const leaderGroup = `leader-${f.suffix}`;
      await approvePolicy(f, policyFor("LEADER", leaderGroup, f.today));
      await assignGroup(f, f.peer, "LEADER", leaderGroup);
      const leaderScore = await f.performance.command(f.owner, { ...command("Score real independent reviewer turnaround"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.peer.employeeId, family: "LEADER", from: f.today, to: f.today });
      expect(leaderScore.data).toMatchObject({ family: "LEADER", status: "SCORED", score: expect.any(Number) });
      expect((leaderScore.data as { score: number }).score).toBeGreaterThan(0);
      expect((leaderScore.data as { score: number }).score).toBeLessThanOrEqual(100);
      await expect(f.performance.employee(f.peer.actor, f.peer.employeeId)).resolves.toMatchObject({ canManage: false, snapshots: expect.arrayContaining([expect.objectContaining({ id: leaderScore.id, data: expect.objectContaining({ family: "LEADER", status: "SCORED" }) })]) });
      await expect(f.performance.employee(f.peer.actor, f.employee.employeeId)).rejects.toMatchObject({ status: 403 });
      await expect(f.performance.command(f.peer.actor, { ...command("Reviewer cannot generate employee score"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.peer.employeeId, family: "EMPLOYEE", from: f.today, to: f.today })).rejects.toMatchObject({ status: 403 });
      const designGroupPolicy = policyFor("DESIGN", "DESIGN", f.today);
      await approvePolicy(f, designGroupPolicy);
      await approvePolicy(f, policyFor("TURNKEY", "TURNKEY", f.today));
      const attribution = async (item: { id: string; sourceId: string }, supersedesId?: string, days = 2) => f.performance.command(f.owner, {
        ...command("Owner allocates fictional two-day external delay to actual task status evidence"), operation: "DELAY_RECORD", projectId: project.id,
        delay: { cause: "CLIENT", days, sourceKind: "TASK_STATUS", sourceId: item.sourceId, employeeId: f.employee.employeeId, external: true,
          from: plusDays(f.today, days === 6 ? -5 : -4), to: plusDays(f.today, days === 6 ? 0 : -3), summary: "Fictional Owner-reviewed source-linked delay allocation", supersedesId: supersedesId ?? null },
      });
      const first = await attribution(tasks[0]!);
      const extended = await attribution(tasks[1]!);
      const initialScore = await f.performance.command(f.owner, { ...command("Retain score before corrected delay evidence"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.employee.employeeId, family: "EMPLOYEE", from: f.today, to: f.today });
      const initialFrozen = await f.tx.performanceRecord.findUniqueOrThrow({ where: { id: initialScore.id } });
      const correction = await attribution(tasks[0]!, first.id, 6);
      expect(correction).toMatchObject({ kind: "DELAY", version: 1, data: expect.objectContaining({ sourceId: tasks[0]!.sourceId, sourceTaskId: tasks[0]!.id, days: 6, supersedesId: first.id, sourceVersion: expect.any(Number) }) });
      expect(await f.tx.performanceRecord.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ version: 1, data: expect.objectContaining({ days: 2, supersedesId: null }) });
      expect(await f.performance.project(f.owner, project.id)).toMatchObject({ delayTotalDays: 8, delays: expect.arrayContaining([expect.objectContaining({ id: correction.id }), expect.objectContaining({ id: extended.id })]) });

      const score = await f.performance.command(f.owner, { ...command("Score after applying exact deadline and delay evidence"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.employee.employeeId, family: "EMPLOYEE", from: f.today, to: f.today });
      const data = score.data as { status: string; score: number | null; components: Array<{ metric: string; raw: number | null; evidence: Array<{ values: Record<string, unknown> }> }>; excluded: Array<{ taskId: string; attributionIds: string[] }> };
      const onTime = data.components.find(component => component.metric === "TASK_ON_TIME");
      expect(data.status).toBe("SCORED");
      expect(data.score).toBeGreaterThan(0);
      expect(data.score).toBeLessThan(100);
      expect(onTime?.raw).toBe(66.6667);
      expect(onTime?.evidence.map(e => e.values)).toEqual(expect.arrayContaining([
        expect.objectContaining({ lateDays: 5, externalDays: 6, residualLateDays: 0 }),
        expect.objectContaining({ lateDays: 3, externalDays: 0, residualLateDays: 3, extensionApprovalId: expect.any(String) }),
      ]));
      const initialData = initialScore.data as { components: Array<{ metric: string; raw: number | null; evidence: Array<{ values: Record<string, unknown> }> }> };
      const initialOnTime = initialData.components.find(component => component.metric === "TASK_ON_TIME");
      expect(initialOnTime?.raw).toBe(33.3333);
      expect(initialOnTime?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ values: expect.objectContaining({ lateDays: 5, externalDays: 2, residualLateDays: 3 }) })]));
      expect(data.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: tasks[0]!.id, attributionIds: [correction.id] })]));
      expect(extended.projectId).toBe(project.id);
      expect(await f.tx.performanceRecord.findUniqueOrThrow({ where: { id: initialScore.id } })).toMatchObject({ data: initialFrozen.data, version: 1 });
      expect(score.data).toMatchObject({ previousSnapshotId: initialScore.id, scoreChange: expect.any(Number) });
      expect((score.data as { scoreChange: number }).scoreChange).not.toBe(0);
      const health = await f.performance.command(f.owner, { ...command("Capture real Design health evidence"), operation: "PROJECT_SNAPSHOT", projectId: project.id, from: f.today, to: f.today });
      expect(health.data).toMatchObject({ family: "DESIGN", status: "SCORED", score: expect.any(Number), healthStatus: expect.any(String) });
      const turnkeyProject = await createProject(f, ProjectDeliveryType.TURNKEY, f.manager.employeeId);
      const turnkeyCurrent = await f.tx.project.findUniqueOrThrow({ where: { id: turnkeyProject.id } });
      const turnkeyLead = await f.workflow.lead(f.owner, turnkeyProject.id, { employeeId: f.manager.employeeId, expectedVersion: turnkeyCurrent.version, reason: "Assign scoped S23 site lead" });
      await f.workflow.status(f.owner, turnkeyProject.id, { toStatus: ProjectStatus.ACTIVE, expectedVersion: turnkeyLead.version, reason: "Activate S23 Turnkey project" });
      const siteVersion = async () => f.site.detail(f.manager.actor, turnkeyProject.id).then(detail => detail.version as number);
      const packageRow = await f.site.createPackage(f.manager.actor, turnkeyProject.id, { expectedVersion: await siteVersion(), reason: "Create persisted S23 package progress source", title: "Fictional site package", date: f.today, tomorrowPlan: "Continue recorded work", plannedPercent: "100", plannedQuantity: "1", unit: "lot", critical: false });
      await f.site.progress(f.manager.actor, packageRow.id, { expectedVersion: await siteVersion(), reason: "Record factual S23 package progress", actualPercent: "75", actualQuantity: "0.75", qualityStatus: "PASSED", materialStatus: "Available", blockers: "", tomorrowPlan: "Continue recorded work", photoIds: [] });
      const turnkeyHealth = await f.performance.command(f.owner, { ...command("Capture factual Turnkey site health"), operation: "PROJECT_SNAPSHOT", projectId: turnkeyProject.id, from: f.today, to: f.today });
      expect(turnkeyHealth.data).toMatchObject({ family: "TURNKEY", status: "SCORED", score: 75, healthStatus: "At Risk" });
      await expect(f.performance.employee(f.employee.actor, f.employee.employeeId)).resolves.toMatchObject({ snapshots: expect.arrayContaining([expect.objectContaining({ id: score.id, data: expect.objectContaining({ status: "SCORED" }) })]) });

      let revocationProject = await f.tx.project.findUniqueOrThrow({ where: { id: project.id } });
      await f.workflow.assignment(f.owner, project.id, { employeeId: f.manager.employeeId, expectedVersion: revocationProject.version, reason: "Assign replacement lead before source access revocation" });
      revocationProject = await f.tx.project.findUniqueOrThrow({ where: { id: project.id } });
      const replacementLead = await f.workflow.lead(f.owner, project.id, { employeeId: f.manager.employeeId, expectedVersion: revocationProject.version, reason: "Transfer project lead before source access revocation" });
      await f.workflow.revokeAssignment(f.owner, project.id, f.employee.employeeId, { expectedVersion: replacementLead.version, reason: "Revoke current project source access through workflow" });
      const restricted = await f.performance.employee(f.employee.actor, f.employee.employeeId);
      expect(restricted.snapshots).toEqual(expect.arrayContaining([expect.objectContaining({ id: score.id, data: expect.objectContaining({ status: "ACCESS_RESTRICTED", score: null }) })]));
    });
  });

  it("rolls back score/version writes when canonical audit emission fails", async () => {
    await makeFixture(async (f) => {
      const before = await f.tx.performanceRecord.count({ where: { organizationId: f.organizationId } });
      const versionsBefore = await f.tx.performanceVersion.count({ where: { organizationId: f.organizationId } });
      const receiptsBefore = await f.tx.performanceReceipt.count({ where: { organizationId: f.organizationId } });
      const brokenDb = fixtureDatabase(f.tx, true);
      const brokenService = new PerformanceService(brokenDb, new AuthorizationService(brokenDb));
      await expect(brokenService.command(f.owner, { ...command("Force S23 event rollback"), operation: "POLICY_CREATE", policy: policyFor("EMPLOYEE", `failure-${f.suffix}`, f.today) })).rejects.toThrow("Injected S23 audit failure");
      expect(await f.tx.performanceRecord.count({ where: { organizationId: f.organizationId } })).toBe(before);
      expect(await f.tx.performanceVersion.count({ where: { organizationId: f.organizationId } })).toBe(versionsBefore);
      expect(await f.tx.performanceReceipt.count({ where: { organizationId: f.organizationId } })).toBe(receiptsBefore);
    });
  });

  it("keeps a historical status source attributed to its original owner after a valid open-task reassignment", async () => {
    await makeFixture(async (f) => {
      const project = await createProject(f, ProjectDeliveryType.DESIGN, f.employee.employeeId);
      await f.tx.projectAssignment.create({ data: { organizationId: f.organizationId, projectId: project.id, employeeId: f.peer.employeeId, grantedById: f.owner.accountId, grantReason: "Assign eligible reassignment target" } });
      await f.tx.employeePermissionOverride.create({ data: { organizationId: f.organizationId, employeeId: f.peer.employeeId, permissionKey: "project.view", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: f.branchId, reason: "Grant current target employee project view" } });
      const current = await f.tx.project.findUniqueOrThrow({ where: { id: project.id } });
      const led = await f.workflow.lead(f.owner, project.id, { employeeId: f.employee.employeeId, expectedVersion: current.version, reason: "Appoint original owner as project lead" });
      await f.workflow.status(f.owner, project.id, { toStatus: ProjectStatus.ACTIVE, expectedVersion: led.version, reason: "Activate historical source project" });
      const task = await f.tasks.create(f.owner, { projectId: project.id, ownerEmployeeId: f.employee.employeeId, title: `S23 pre-reassignment source ${f.suffix}`, type: TaskType.PROJECT, priority: TaskPriority.HIGH, targetDate: f.today, estimatedHours: 1, reviewRequirement: TaskReviewRequirement.NONE, reason: "Create open task before historical source attribution" });
      await f.tasks.transition(f.employee.actor, task.id, { toState: "IN_PROGRESS", expectedVersion: task.version, reason: "Original owner starts source task" });
      const source = await f.tx.taskStatusChange.findFirstOrThrow({ where: { taskId: task.id, toStatus: "IN_PROGRESS" } });
      const currentTask = await f.tx.task.findUniqueOrThrow({ where: { id: task.id } });
      await f.tasks.reassign(f.owner, task.id, { newOwnerEmployeeId: f.peer.employeeId, expectedVersion: currentTask.version, reason: "Reassign still-open task after original status evidence", acknowledgeOverload: true });

      const allocation = { cause: "INTERNAL_TEAM", days: 1, sourceKind: "TASK_STATUS", sourceId: source.id, employeeId: f.employee.employeeId, external: false, from: f.today, to: f.today, summary: "Owner-reviewed historical source remains with its original worker", supersedesId: null };
      const recorded = await f.performance.command(f.owner, { ...command("Retain source owner from status history"), operation: "DELAY_RECORD", projectId: project.id, delay: allocation });
      expect(recorded.data).toMatchObject({ sourceId: source.id, sourceTaskId: task.id, employeeId: f.employee.employeeId });
      await expect(f.performance.command(f.owner, { ...command("Current task owner cannot inherit older status source"), operation: "DELAY_RECORD", projectId: project.id, delay: { ...allocation, employeeId: f.peer.employeeId } })).rejects.toMatchObject({ status: 400 });
      expect((await f.performance.project(f.owner, project.id)).delays).toEqual(expect.arrayContaining([expect.objectContaining({ id: recorded.id, employeeId: f.employee.employeeId })]));
    });
  });

  it("counts only the named Leader's actual extension decisions, not Owner-withdrawn requests", async () => {
    await makeFixture(async (f) => {
      const group = `leader-extension-${f.suffix}`;
      await approvePolicy(f, { ...policyFor("LEADER", group, f.today), components: [{ metric: "LEADER_EXTENSION_TURNAROUND", weight: 100, min: 0, max: 1000, direction: "LOWER", required: true }] });
      await assignGroup(f, f.manager, "LEADER", group);
      await f.tx.employeePermissionOverride.createMany({ data: ["task.assign", "task.deadline_change"].map(permissionKey => ({ organizationId: f.organizationId, employeeId: f.manager.employeeId, permissionKey, effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: f.branchId, reason: "S23 named Leader extension decision scope" })) });
      const project = await createProject(f, ProjectDeliveryType.DESIGN, f.employee.employeeId);
      let projectRow = await f.tx.project.findUniqueOrThrow({ where: { id: project.id } });
      await f.workflow.assignment(f.owner, project.id, { employeeId: f.manager.employeeId, expectedVersion: projectRow.version, reason: "Assign scoped Leader for extension decisions" });
      projectRow = await f.tx.project.findUniqueOrThrow({ where: { id: project.id } });
      const lead = await f.workflow.lead(f.owner, project.id, { employeeId: f.manager.employeeId, expectedVersion: projectRow.version, reason: "Appoint named Leader for extension decisions" });
      await f.workflow.status(f.owner, project.id, { toStatus: ProjectStatus.ACTIVE, expectedVersion: lead.version, reason: "Activate extension source project" });

      const createRequest = async (label: string) => {
        const task = await f.tasks.create(f.owner, { projectId: project.id, ownerEmployeeId: f.employee.employeeId, title: `S23 ${label} ${f.suffix}`, type: TaskType.PROJECT, priority: TaskPriority.HIGH, targetDate: f.today, estimatedHours: 1, reviewRequirement: TaskReviewRequirement.NONE, reason: `Create ${label} source task` });
        await f.tasks.changeCommittedDate(f.owner, task.id, { expectedVersion: task.version, committedDueDate: f.today, reason: `Record ${label} committed date` });
        const request = await f.tasks.requestExtension(f.employee.actor, task.id, { expectedVersion: 2, proposedDate: plusDays(f.today, 1), approverAccountId: f.manager.accountId, reason: `Employee requests ${label} deadline extension` });
        return { task, request };
      };
      const withdrawn = await createRequest("withdrawn");
      await f.tasks.withdrawExtension(f.owner, withdrawn.task.id, withdrawn.request.approvalId, "Owner withdraws without a Leader decision");
      const withdrawnOnlyScore = await f.performance.command(f.owner, { ...command("No Owner-withdrawn request may satisfy Leader evidence"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.manager.employeeId, family: "LEADER", from: f.today, to: f.today });
      expect(withdrawnOnlyScore.data).toMatchObject({ family: "LEADER", status: "INSUFFICIENT_EVIDENCE", score: null });
      expect((withdrawnOnlyScore.data as { components: Array<{ metric: string; raw: number | null; evidence: unknown[] }> }).components.find(item => item.metric === "LEADER_EXTENSION_TURNAROUND")).toMatchObject({ raw: null, evidence: [] });
      const approved = await createRequest("approved");
      await f.tasks.decideExtension(f.manager.actor, approved.task.id, approved.request.approvalId, { outcome: "APPROVED", reason: "Named Leader approves exact extension" });

      const score = await f.performance.command(f.owner, { ...command("Score only actual named Leader extension decisions"), operation: "EMPLOYEE_SNAPSHOT", employeeId: f.manager.employeeId, family: "LEADER", from: f.today, to: f.today });
      expect(score.data).toMatchObject({ family: "LEADER", status: "SCORED" });
      const component = (score.data as { components: Array<{ metric: string; raw: number | null; evidence: Array<{ id: string }> }> }).components.find(item => item.metric === "LEADER_EXTENSION_TURNAROUND");
      expect(component?.raw).not.toBeNull();
      expect(component?.evidence.map(item => item.id)).toEqual([approved.request.approvalId]);
      expect(component?.evidence.map(item => item.id)).not.toContain(withdrawn.request.approvalId);
      expect(await f.tx.approvalDecision.count({ where: { requestId: withdrawn.request.approvalId } })).toBe(0);
      expect(await f.tx.approvalDecision.findFirst({ where: { requestId: approved.request.approvalId } })).toMatchObject({ deciderId: f.manager.accountId });
    });
  });

  it("serializes exact concurrent command replay to one receipt and one history version", async () => {
    const organization = await database.prisma.organization.findFirst() ?? await database.prisma.organization.create({ data: { name: `S23 concurrency ${randomUUID()}` } });
    const owner = await database.prisma.account.findFirst({ where: { kind: AccountKind.OWNER, state: AccountState.ACTIVE } })
      ?? await database.prisma.account.create({ data: { normalizedEmail: `s23-concurrent-owner-${randomUUID()}@example.test`, kind: AccountKind.OWNER, state: AccountState.ACTIVE } });
    const actor: ProjectActor = { accountId: owner.id, organizationId: organization.id, kind: AccountKind.OWNER };
    const secondDatabase = new DatabaseService(config);
    try {
    const secondTarget = await secondDatabase.prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (secondTarget[0]?.name !== new URL(databaseUrl!).pathname.slice(1)) throw new Error("Concurrent S23 client resolved to a different target database");
    const service = new PerformanceService(database, new AuthorizationService(database));
    const secondService = new PerformanceService(secondDatabase, new AuthorizationService(secondDatabase));
    const timezone = organization.timezone;
    const today = localCalendarDate(new Date(), timezone);
    const input = { ...command("Concurrent exact S23 policy replay"), operation: "POLICY_CREATE", policy: policyFor("EMPLOYEE", `concurrent-${randomUUID()}`, today) };
    const [first, second] = await Promise.all([service.command(actor, input), secondService.command(actor, input)]);
    expect(first.id).toBe(second.id);
    expect(await database.prisma.performanceReceipt.count({ where: { actorId: owner.id, commandId: input.commandId } })).toBe(1);
    expect(await database.prisma.performanceVersion.count({ where: { recordId: first.id } })).toBe(1);
    await expect(service.command(actor, { ...input, reason: "Concurrent replay with changed body" })).rejects.toMatchObject({ status: 409 });
    } finally { await secondDatabase.onModuleDestroy(); }
  });

  it("rechecks session expiry after waiting on the organization advisory lock", async () => {
    const organization = await database.prisma.organization.findFirst() ?? await database.prisma.organization.create({ data: { name: `S23 session lock ${randomUUID()}` } });
    const owner = await database.prisma.account.findFirst({ where: { kind: AccountKind.OWNER, state: AccountState.ACTIVE } })
      ?? await database.prisma.account.create({ data: { normalizedEmail: `s23-session-owner-${randomUUID()}@example.test`, kind: AccountKind.OWNER, state: AccountState.ACTIVE } });
    const sessionId = randomUUID(), now = new Date();
    await database.prisma.session.create({ data: { id: sessionId, accountId: owner.id, tokenHash: randomUUID(), csrfTokenHash: randomUUID(), createdAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + 60_000) } });
    const actor = { accountId: owner.id, organizationId: organization.id, kind: AccountKind.OWNER, sessionId } as ProjectActor & { sessionId: string };
    const commandId = randomUUID(), input = { ...command("Reject a session that expires behind lock" , commandId), operation: "POLICY_CREATE", policy: policyFor("EMPLOYEE", `expiry-${randomUUID()}`, localCalendarDate(new Date(), organization.timezone)) };
    const blockerDatabase = new DatabaseService(config);
    let release!: () => void;
    let locked!: () => void;
    const lockedSignal = new Promise<void>(resolveLock => { locked = resolveLock; });
    const releaseSignal = new Promise<void>(resolveRelease => { release = resolveRelease; });
    let pendingCommand: Promise<unknown> | undefined;
    const blocker = blockerDatabase.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organization.id + ":performance"},0))`;
      locked();
      await releaseSignal;
    }, { timeout: 30_000 });
    try {
      await lockedSignal;
      pendingCommand = new PerformanceService(database, new AuthorizationService(database)).command(actor, input);
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await database.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%pg_advisory_xact_lock%'`;
        if (Number(rows[0]?.count ?? 0) > 0) { waiting = true; break; }
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      expect(waiting).toBe(true);
      await database.prisma.session.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      release();
      await expect(pendingCommand).rejects.toMatchObject({ status: 403 });
      expect(await database.prisma.performanceReceipt.count({ where: { actorId: owner.id, commandId } })).toBe(0);
    } finally {
      release();
      await pendingCommand?.catch(() => undefined);
      await blocker.catch(() => undefined);
      await blockerDatabase.onModuleDestroy();
    }
  });
});
