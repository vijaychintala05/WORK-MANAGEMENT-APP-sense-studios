import { reviewRoutingTestTarget, verifyReviewRoutingTestDatabase } from "./review-routing-test-target.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { jest } from "@jest/globals";
import { UnauthorizedException } from "@nestjs/common";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { AccountKind, Prisma, PrismaClient, TaskReviewRequirement, TaskStatus, type Account, type Employee } from "./generated/prisma/client.js";
import { DatabaseService } from "./database.service.js";
import { AuthorizationService } from "./authorization.service.js";
import { ApprovalService } from "./approval.service.js";
import { TaskService } from "./task.service.js";
import { ProjectService } from "./project.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { DocumentService } from "./document.service.js";
import { RevisionService } from "./revision.service.js";
import { ReviewService } from "./review.service.js";
import { NotificationsService } from "./notifications.service.js";
import { OrganizationService } from "./organization.service.js";
import { IdentityService } from "./identity.service.js";
import { MyWorkService, orderAttention } from "./my-work.service.js";
import { ClientPortalAccessService } from "./client-portal-access.service.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { ClientPortalIdentityService, type ActiveClientPortalSession } from "./client-portal-identity.service.js";
import { ClientReviewService } from "./client-review.service.js";
import { BrevoEmailAdapter } from "./brevo-email.js";
import { recordProjectEvent } from "./project-events.js";
import { localCalendarDate } from "./task-recurrence-policy.js";
import { MW_I02_URL, assertMWI02LiveIdentity, loadMWI02Target, type MWI02Target } from "./mw-i02-disposable-test-target.js";
import { loadRecoveryTestTarget, verifyRecoveryTestDatabase, type RecoveryTestBinding } from "./recovery-test-target.js";
import type { RuntimeConfig } from "./config.js";
import type { ProjectActor } from "./project.service.js";
import { isS27DisposableTestTarget } from "./s27-disposable-test-target.js";

// Prepared source only. Never infer authorization from Jest invocation or an
// arbitrary *_test name; the exact approved run and live identity are required.
const ciParity = process.env.GITHUB_ACTIONS === "true" && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") && process.env.S27_EXPECTED_MIGRATIONS === "119";
const reviewFeature = !!process.env.SENSE_REVIEW_ROUTING_TEST_RUN;
const parityDescribe = reviewFeature || process.env.SENSE_RECOVERY_TEST_MANIFEST || process.env.MW_I02_ENABLED === "1" || ciParity ? describe : describe.skip;
jest.setTimeout(60_000);
const why = "MW-I02 isolated parity persistence acceptance";
const dayAfter = (day: string) => new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
function barrier() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}
function transactionDatabase(tx: Prisma.TransactionClient): DatabaseService {
  return { prisma: new Proxy(tx, { get(target, key) {
    if (key === "$transaction") return async (work: (inner: Prisma.TransactionClient) => Promise<unknown>) => work(tx);
    return Reflect.get(target, key, target);
  } }) } as unknown as DatabaseService;
}

parityDescribe("MW-I02 exact-run composed queue and committed subtask invariants", () => {
  let database: DatabaseService, target: MWI02Target, config: RuntimeConfig, pool: Pool;
  let recovery: RecoveryTestBinding | undefined;
  let reviewBinding: ReturnType<typeof reviewRoutingTestTarget> | undefined;
  let ciIdentity: Record<string, unknown> | undefined;
  let queryCount = 0, queryDurationMs = 0, observedActive = 0, observedWaiting = 0;
  const observePool = () => {
    observedActive = Math.max(observedActive, pool.totalCount - pool.idleCount);
    observedWaiting = Math.max(observedWaiting, pool.waitingCount);
  };
  async function verifyTarget() {
    if (reviewBinding) { await verifyReviewRoutingTestDatabase(database.prisma, reviewBinding); return; }
    if (recovery) { await verifyRecoveryTestDatabase(database.prisma, recovery); return; }
    if (ciParity) {
      assert.ok(isS27DisposableTestTarget("S27_PARITY_DATABASE_URL", process.env.S27_PARITY_DATABASE_URL), "Exact CI parity manifest required");
      const rows = await database.prisma.$queryRaw<Array<Record<string, unknown>>>`SELECT current_database() AS database,current_user AS username,inet_server_port() AS port,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,pg_postmaster_start_time()::text AS started`;
      const url = new URL(process.env.S27_PARITY_DATABASE_URL!);
      assert.equal(rows[0]?.database,url.pathname.slice(1));assert.equal(rows[0]?.port,Number(url.port));assert.equal(rows[0]?.username,url.username);
      if (ciIdentity) assert.deepEqual(rows[0],ciIdentity,"CI parity server identity changed"); else ciIdentity=rows[0];
      return;
    }
    const current = loadMWI02Target();
    assert.deepEqual(current, target, "Manifest or created marker changed during the parity stage");
    const identity = await database.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS address,
      inet_server_port() AS port, (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      current_setting('data_directory') AS data_directory, to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS server_started_at`;
    assertMWI02LiveIdentity(target, identity[0]);
  }
  beforeAll(async () => {
    if (reviewFeature) reviewBinding = reviewRoutingTestTarget(resolve(process.cwd(), "../.."), "S27_PARITY_DATABASE_URL");
    else if (process.env.SENSE_RECOVERY_TEST_MANIFEST) recovery = loadRecoveryTestTarget(process.env, resolve(process.cwd(), "../.."), "RECOVERY_PARITY_DATABASE_URL");
    else if (ciParity) assert.ok(isS27DisposableTestTarget("S27_PARITY_DATABASE_URL", process.env.S27_PARITY_DATABASE_URL), "Exact CI parity manifest required before connection");
    else target = loadMWI02Target(); // Filesystem checks precede even a connection.
    const databaseUrl = reviewBinding?.url ?? recovery?.url ?? (ciParity ? process.env.S27_PARITY_DATABASE_URL! : MW_I02_URL);
    const nasRoot = reviewBinding ? resolve(process.env.NAS_ROOT!, "parity") : recovery ? resolve(process.env.SENSE_RECOVERY_TEST_MANIFEST!, "../files/parity") : ciParity ? resolve(process.env.NAS_ROOT!, "parity") : resolve(target.runDir, "nas", "parity");
    if (reviewBinding) mkdirSync(nasRoot, { recursive: true });
    config = { nodeEnv: "test", databaseUrl, port: 59542, webOrigin: "http://localhost:59543", nasRoot, emailVerificationSecret: "mw-i02-inert-email-no-provider" } as RuntimeConfig;
    // Real adapter instrumentation is restricted to this exact disposable suite.
    // Query text, parameters, titles, credentials and evidence are never logged.
    pool = new Pool({ connectionString: databaseUrl, options: "-c timezone=UTC", max: 10, application_name: "mw-i02-parity-measurement" });
    pool.on("acquire", observePool);
    const client = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }), log: [{ emit: "event", level: "query" }] });
    client.$on("query", event => { queryCount += 1; queryDurationMs += event.duration; observePool(); });
    database = { prisma: client, onModuleDestroy: () => client.$disconnect() } as unknown as DatabaseService;
    await verifyTarget();
    const migrations = await database.prisma.$queryRaw<Array<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>>`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
    const root = resolve(process.cwd(), "prisma/migrations");
    const source = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(source).toHaveLength(reviewBinding ? 120 : recovery || ciParity ? 119 : 118); expect(migrations.map(row => row.migration_name)).toEqual(source);
    for (const migration of migrations) {
      expect(migration.finished_at).not.toBeNull(); expect(migration.rolled_back_at).toBeNull();
      expect(migration.checksum).toBe(createHash("sha256").update(readFileSync(resolve(root, migration.migration_name, "migration.sql"))).digest("hex"));
    }
  });
  afterAll(async () => { await database?.onModuleDestroy(); });

  async function fixture() {
    await verifyTarget(); // Recheck exact OID/system/marker before each fixture write.
    const prisma = database.prisma, suffix = randomUUID(), token = `MWP-${suffix.slice(0, 8)}`;
    // The application has one canonical organization. Add only run-isolated
    // branches/accounts/projects; do not change accepted browser fixture rows.
    const org = await prisma.organization.findFirstOrThrow();
    const ownerAccount = await prisma.account.findFirstOrThrow({ where: { kind: "OWNER", state: "ACTIVE" } });
    const owner: ProjectActor = { organizationId: org.id, accountId: ownerAccount.id, kind: AccountKind.OWNER };
    const branch = await prisma.branch.create({ data: { organizationId: org.id, name: `${token} branch` } });
    const team = await prisma.team.create({ data: { organizationId: org.id, branchId: branch.id, name: `${token} team` } });
    const people: Array<{ label: "manager" | "worker" | "reviewer" | "outsider"; account: Account; employee: Employee; actor: ProjectActor }> = [];
    for (const label of ["manager", "worker", "reviewer", "outsider"] as const) {
      const account = await prisma.account.create({ data: { normalizedEmail: `${label}-${suffix}@example.test`, kind: "STAFF", state: "ACTIVE" } });
      const employee = await prisma.employee.create({ data: { organizationId: org.id, accountId: account.id, homeBranchId: branch.id, homeTeamId: team.id, hiredAt: new Date("2026-01-01") } });
      for (const permissionKey of ["project.view", "document.view", ...(label === "manager" || label === "reviewer" ? ["project.manage", "task.assign", "task.deadline_change"] : []), ...(label === "reviewer" ? ["review.decide"] : [])]) {
        await prisma.employeePermissionOverride.create({ data: { organizationId: org.id, employeeId: employee.id, permissionKey, effect: "ALLOW", scopeKind: "BRANCH", branchId: branch.id, reason: why } });
      }
      people.push({ label, account, employee, actor: { organizationId: org.id, accountId: account.id, kind: AccountKind.STAFF } });
    }
    const person = (label: typeof people[number]["label"]) => people.find(row => row.label === label)!;
    const authorization = new AuthorizationService(database), approvals = new ApprovalService(database);
    const tasks = new TaskService(database, authorization, approvals), projects = new ProjectService(database);
    const workflows = new ProjectWorkflowService(database, authorization, approvals);
    const documents = new DocumentService(database, authorization, config), revisions = new RevisionService(database, authorization, documents);
    const reviews = new ReviewService(database, authorization, documents, revisions, new NotificationsService(database));
    const work = new MyWorkService(database, tasks, reviews, approvals);
    const created = await projects.create(owner, { branchId: branch.id, title: `${token} project`, deliveryType: "DESIGN", scopes: ["Architecture"], reason: why });
    for (const row of people) {
      const current = await prisma.project.findUniqueOrThrow({ where: { id: created.project.id } });
      await workflows.assignment(owner, current.id, { employeeId: row.employee.id, expectedVersion: current.version, reason: why });
    }
    let current = await prisma.project.findUniqueOrThrow({ where: { id: created.project.id } });
    await workflows.lead(owner, current.id, { employeeId: person("manager").employee.id, expectedVersion: current.version, reason: why });
    current = await prisma.project.findUniqueOrThrow({ where: { id: current.id } });
    await workflows.status(owner, current.id, { toStatus: "ACTIVE", expectedVersion: current.version, reason: why });
    const today = localCalendarDate(new Date(), org.timezone);
    const input = { title: `${token} task`, type: "PROJECT" as const, priority: "HIGH" as const, projectId: current.id, targetDate: today, ownerEmployeeId: person("worker").employee.id, reason: why };
    return { prisma, org, owner, person, authorization, approvals, workflows, tasks, documents, revisions, reviews, work, token, today, input };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  it("intersects team and employee drill-down with current authorized task visibility", async () => {
    const f = await fixture();
    const task = await f.tasks.create(f.owner, f.input);
    const worker = f.person("worker"), outsider = f.person("outsider");
    const teamId = worker.employee.homeTeamId;
    const ownerView = await f.tasks.list(f.owner, "all", 0, 50, { teamId, ownerEmployeeId: worker.employee.id });
    expect(ownerView.items.some(row => row.id === task.id)).toBe(true);
    const otherTeam = await f.prisma.team.create({ data: { organizationId: f.org.id, branchId: worker.employee.homeBranchId, name: `${f.token} other team` } });
    expect((await f.tasks.list(f.owner, "all", 0, 50, { teamId: otherTeam.id, ownerEmployeeId: worker.employee.id })).total).toBe(0);
    // Same Team and project membership alone do not grant another person's task.
    expect((await f.tasks.list(outsider.actor, "all", 0, 50, { teamId, ownerEmployeeId: worker.employee.id })).total).toBe(0);
    const manager = f.person("manager");
    expect((await f.tasks.list(manager.actor, "all", 0, 50, { teamId, ownerEmployeeId: worker.employee.id })).items.some(row => row.id === task.id)).toBe(true);
    const setup = await f.tasks.setup(f.owner);
    expect(setup.employees.find(row => row.id === worker.employee.id)).toMatchObject({ homeTeamId: teamId });
  });
  async function start(f: Fixture, id: string, actor = f.owner) {
    const task = await f.prisma.task.findUniqueOrThrow({ where: { id } });
    return f.tasks.transition(actor, id, { toState: "IN_PROGRESS", expectedVersion: task.version, reason: why });
  }
  async function finishChild(f: Fixture, id: string) {
    await start(f, id);
    const task = await f.prisma.task.findUniqueOrThrow({ where: { id } });
    await f.tasks.transition(f.owner, id, { toState: "COMPLETED", expectedVersion: task.version, reason: why });
  }
  async function submit(f: Fixture, id: string, revisionId?: string) {
    let task = await f.prisma.task.findUniqueOrThrow({ where: { id } });
    await f.reviews.assignReviewer(f.person("manager").actor, id, { employeeId: f.person("reviewer").employee.id, expectedVersion: task.version, reason: why });
    await start(f, id, f.person("worker").actor);
    task = await f.prisma.task.findUniqueOrThrow({ where: { id } });
    const detail = await f.reviews.submit(f.person("worker").actor, id, { expectedVersion: task.version, ...(revisionId ? { revisionId } : { reviewUrl: `https://files.sensestudios.com/parity/${id}` }), reason: why });
    return detail.rounds.at(-1)!.id;
  }
  async function approve(f: Fixture, roundId: string) {
    await f.reviews.start(f.person("reviewer").actor, roundId, why);
    return f.reviews.decision(f.person("reviewer").actor, roundId, { kind: "APPROVED", comment: why, reason: why });
  }
  async function extension(f: Fixture) {
    const task = await f.tasks.create(f.owner, { ...f.input, title: `${f.token} deadline decision` });
    await f.tasks.changeCommittedDate(f.person("manager").actor, task.id, { expectedVersion: task.version, committedDueDate: f.today, reason: why });
    const current = await f.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const request = await f.tasks.requestExtension(f.person("worker").actor, task.id, { expectedVersion: current.version, proposedDate: dayAfter(f.today), approverAccountId: f.person("reviewer").account.id, reason: why });
    return { taskId: task.id, requestId: request.approvalId };
  }

  it("composes real eligible tasks, rounds and decisions beyond one page with exact counts and filters", async () => {
    const f = await fixture(), ids: string[] = [];
    for (let index = 0; index < 30; index++) ids.push((await f.tasks.create(f.owner, { ...f.input, ownerEmployeeId: f.person("reviewer").employee.id, title: `${f.token} own ${index}`, priority: index % 2 ? "LOW" : "HIGH" })).id);
    const reviewing = await f.tasks.create(f.owner, { ...f.input, title: `${f.token} assigned review`, reviewRequirement: TaskReviewRequirement.INTERNAL });
    const roundId = await submit(f, reviewing.id), decision = await extension(f);
    // In-progress future work has no attention predicate; unrelated peers have
    // no actor-owned obligation even when their Target is today.
    const future = await f.tasks.create(f.owner, { ...f.input, title: `${f.token} future`, targetDate: dayAfter(f.today), ownerEmployeeId: f.person("reviewer").employee.id });
    await start(f, future.id);
    const began = process.hrtime.bigint(), memoryBefore = process.memoryUsage().heapUsed, queriesBefore = queryCount, durationBefore = queryDurationMs;
    observedActive = 0; observedWaiting = 0;
    const first = await f.work.attention(f.person("reviewer").actor, { offset: 0, limit: 25 });
    const second = await f.work.attention(f.person("reviewer").actor, { offset: 25, limit: 25 });
    expect(first.sourceCounts).toEqual({ task: { status: "ready", total: 30 }, review: { status: "ready", total: 1 }, approval: { status: "ready", total: 1 } });
    expect(first.totalItems).toBe(32); expect(first.hasMore).toBe(true); expect(second.items).toHaveLength(7); expect(second.hasMore).toBe(false);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map(row => `${row.source}:${row.sourceId}`)).size).toBe(32);
    expect(all.map(row => row.sourceId)).toEqual(orderAttention([...all], first.timezone).map(row => row.sourceId));
    expect(all.filter(row => row.source === "task").map(row => row.sourceId).sort()).toEqual(ids.sort());
    expect(all.find(row => row.sourceId === roundId)).toMatchObject({ source: "review", taskId: reviewing.id, roundId });
    expect(all.at(-1)).toMatchObject({ source: "approval", requestId: decision.requestId, deadline: null });
    const filtered = await f.work.attention(f.person("reviewer").actor, { q: f.token, status: "NOT_STARTED", offset: 0, limit: 100 });
    expect(filtered.source).toBe("task"); expect(filtered.totalItems).toBe(30); expect(filtered.sourceCounts.review).toEqual({ status: "excluded" });
    const project = await f.work.attention(f.person("reviewer").actor, { q: f.token, projectId: f.input.projectId, offset: 0, limit: 100 });
    expect(project.totalItems).toBe(31); expect(project.sourceCounts.approval).toEqual({ status: "ready", total: 0 });
    const search = await f.work.attention(f.person("reviewer").actor, { q: "deadline extension", offset: 0, limit: 100 });
    expect(search.totalItems).toBe(1); expect(search.items[0]?.requestId).toBe(decision.requestId);
    const outsider = await f.work.attention(f.person("outsider").actor, { q: f.token, offset: 0, limit: 100 });
    expect(outsider.totalItems).toBe(0);
    const owner = await f.work.attention(f.owner, { q: f.token, offset: 0, limit: 100 });
    expect(owner.sourceCounts.task).toEqual({ status: "ready", total: 0 });
    // Aggregate numbers only; no titles, credentials, query text or evidence.
    process.stdout.write(`${JSON.stringify({ suite: "mw-i02-composer", eligibleRows: 32, pages: 2, queryCount: queryCount - queriesBefore, queryDurationMs: queryDurationMs - durationBefore, observedPeakPoolActive: observedActive, observedPeakPoolWaiting: observedWaiting, elapsedMs: Number(process.hrtime.bigint() - began) / 1e6, heapDeltaBytes: process.memoryUsage().heapUsed - memoryBefore })}\n`);
    for (let index = 0; index < 128; index++) await f.tasks.create(f.owner, { ...f.input, ownerEmployeeId: f.person("reviewer").employee.id, title: `${f.token} scale ${index}` });
    const scaleBegan = process.hrtime.bigint(), scaleMemory = process.memoryUsage().heapUsed, scaleQueries = queryCount, scaleDuration = queryDurationMs;
    observedActive = 0; observedWaiting = 0;
    const scaled = await f.work.attention(f.person("reviewer").actor, { offset: 0, limit: 25 });
    expect(scaled.totalItems).toBe(160); expect(scaled.sourceCounts.task).toEqual({ status: "ready", total: 158 });
    process.stdout.write(`${JSON.stringify({ suite: "mw-i02-composer-scale", eligibleRows: 160, returnedRows: scaled.items.length, queryCount: queryCount - scaleQueries, queryDurationMs: queryDurationMs - scaleDuration, observedPeakPoolActive: observedActive, observedPeakPoolWaiting: observedWaiting, elapsedMs: Number(process.hrtime.bigint() - scaleBegan) / 1e6, heapDeltaBytes: process.memoryUsage().heapUsed - scaleMemory, budgetStatus: "measurement-only; no invented production latency budget" })}\n`);
  }, 180_000);

  it("holds one real RepeatableRead snapshot across canonical concurrent insert/review-start/decision-resolution", async () => {
    const f = await fixture();
    await f.tasks.create(f.owner, { ...f.input, ownerEmployeeId: f.person("reviewer").employee.id });
    const task = await f.tasks.create(f.owner, { ...f.input, title: `${f.token} review`, reviewRequirement: TaskReviewRequirement.INTERNAL });
    const roundId = await submit(f, task.id), decision = await extension(f);
    const read = barrier(), resume = barrier(), original = f.tasks.actionableInTransaction.bind(f.tasks);
    const hook = jest.spyOn(f.tasks, "actionableInTransaction").mockImplementation(async (...args) => {
      const rows = await original(...args); read.release(); await resume.promise; return rows;
    });
    const pending = f.work.attention(f.person("reviewer").actor, { offset: 0, limit: 100 });
    try {
      await Promise.race([read.promise, pending]);
      await f.prisma.$transaction(async tx => {
        // A bounded timeout exposes accidental lock coupling instead of leaving
        // the paused reader and writer waiting on each other indefinitely.
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        const writer = transactionDatabase(tx), authorization = new AuthorizationService(writer), approvals = new ApprovalService(writer);
        const tasks = new TaskService(writer, authorization, approvals);
        const documents = new DocumentService(writer, authorization, config);
        const revisions = new RevisionService(writer, authorization, documents);
        const reviews = new ReviewService(writer, authorization, documents, revisions, new NotificationsService(writer));
        await tasks.create(f.owner, { ...f.input, title: `${f.token} committed after read`, ownerEmployeeId: f.person("reviewer").employee.id });
        await reviews.start(f.person("reviewer").actor, roundId, why);
        await tasks.decideExtension(f.person("reviewer").actor, decision.taskId, decision.requestId, { outcome: "REJECTED", reason: why });
      }, { timeout: 10_000 });
    } finally { resume.release(); hook.mockRestore(); }
    const old = await pending;
    expect(old.sourceCounts.task).toEqual({ status: "ready", total: 1 });
    expect(old.items.find(row => row.roundId === roundId)?.reason).toBe("review_start_required");
    expect(old.items.some(row => row.requestId === decision.requestId)).toBe(true);
    const fresh = await f.work.attention(f.person("reviewer").actor, { offset: 0, limit: 100 });
    expect(fresh.sourceCounts.task).toEqual({ status: "ready", total: 2 });
    expect(fresh.items.find(row => row.roundId === roundId)?.reason).toBe("review_decision_required");
    expect(fresh.sourceCounts.approval).toEqual({ status: "ready", total: 0 });
  });

  it("commits immutable child links and both canonical audit/events, with independent child access", async () => {
    const f = await fixture();
    const parent = await f.tasks.create(f.owner, { ...f.input, collaborators: [{ employeeId: f.person("outsider").employee.id }] });
    const child = await f.tasks.createSubtask(f.owner, parent.id, { ...f.input, title: `${f.token} real child`, targetDate: dayAfter(f.today), expectedParentVersion: 1 });
    expect(child.parentVersion).toBe(2);
    const link = await f.prisma.taskSubtaskLink.findUniqueOrThrow({ where: { childTaskId_organizationId: { childTaskId: child.task.id, organizationId: f.org.id } } });
    expect(link.parentTaskId).toBe(parent.id); expect(child.task.targetDate.toISOString().slice(0, 10)).toBe(dayAfter(f.today));
    const hidden = await f.tasks.subtasks(f.person("outsider").actor, parent.id);
    expect(hidden.items).toEqual([]); expect(hidden.completionBlocked).toBe(true); expect(hidden.canCreate).toBe(false);
    await expect(f.tasks.detail(f.person("outsider").actor, child.task.id)).rejects.toMatchObject({ status: 403 });
    expect(await f.prisma.auditEvent.count({ where: { organizationId: f.org.id, subjectId: child.task.id, eventKey: "task.created" } })).toBe(1);
    expect(await f.prisma.domainEvent.count({ where: { organizationId: f.org.id, subjectId: parent.id, eventName: "task.updated" } })).toBeGreaterThan(0);
    await expect(f.prisma.taskSubtaskLink.delete({ where: { id: link.id } })).rejects.toThrow("immutable");
  });

  it.each(["missing-parent", "forged-reason"])("rejects %s evidence at actual commit, leaving no child relation", async mode => {
    const f = await fixture(), parent = await f.tasks.create(f.owner, f.input), child = await f.tasks.create(f.owner, { ...f.input, title: `${f.token} forged child` });
    await expect(f.prisma.$transaction(async tx => {
      await recordProjectEvent(tx, { organizationId: f.org.id, actorId: f.owner.accountId, eventName: "task.created", subjectType: "task", subjectId: child.id, reason: why, after: { parentTaskId: parent.id, projectId: f.input.projectId } });
      if (mode === "forged-reason") await recordProjectEvent(tx, { organizationId: f.org.id, actorId: f.owner.accountId, eventName: "task.updated", subjectType: "task", subjectId: parent.id, reason: "Different forged reason", after: { subtaskAction: "created", childTaskId: child.id } });
      await tx.taskSubtaskLink.create({ data: { organizationId: f.org.id, projectId: f.input.projectId, parentTaskId: parent.id, childTaskId: child.id, createdById: f.owner.accountId, reason: why } });
    })).rejects.toThrow("canonical child and parent evidence");
    expect(await f.prisma.taskSubtaskLink.count({ where: { childTaskId: child.id } })).toBe(0);
  });

  it("blocks internal-review completion until the committed child completes", async () => {
    const f = await fixture(), parent = await f.tasks.create(f.owner, { ...f.input, reviewRequirement: TaskReviewRequirement.INTERNAL });
    const child = await f.tasks.createSubtask(f.owner, parent.id, { ...f.input, expectedParentVersion: 1 });
    await approve(f, await submit(f, parent.id));
    let row = await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
    await expect(f.reviews.complete(f.person("worker").actor, parent.id, { expectedVersion: row.version, reason: why })).rejects.toThrow("Complete all subtasks");
    await finishChild(f, child.task.id);
    row = await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
    await f.reviews.complete(f.person("worker").actor, parent.id, { expectedVersion: row.version, reason: why });
    expect((await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(TaskStatus.COMPLETED);
    await expect(f.prisma.task.update({ where: { id: child.task.id }, data: { status: "IN_PROGRESS", version: { increment: 1 } } })).rejects.toThrow("remain completed");
  });

  it("blocks Primary Client completion until the committed child completes after retained final approval", async () => {
    const f = await fixture(), projectId = f.input.projectId;
    const parent = await f.tasks.create(f.owner, { ...f.input, reviewRequirement: TaskReviewRequirement.BOTH });
    const child = await f.tasks.createSubtask(f.owner, parent.id, { ...f.input, expectedParentVersion: 1 });
    const folder = await f.documents.createFolder(f.owner, projectId, { name: `${f.token} client evidence`, confidential: false, reason: why });
    const bytes = Buffer.from("%PDF-1.7\nMW-I02 internally approved exact drawing\n%%EOF\n"), sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await f.documents.startUpload(f.owner, projectId, { folderId: folder.id, fileName: `${f.token}.pdf`, mimeType: "application/pdf", sizeBytes: bytes.byteLength, confidential: false, viewOnly: false, reason: why });
    await f.documents.writeChunk(f.owner, upload.uploadId, 0, bytes, sha256);
    const file = await f.documents.finalize(f.owner, upload.uploadId);
    const drawing = await f.revisions.createDrawing(f.owner, projectId, { documentNumber: f.token, title: `${f.token} drawing`, fileId: file.id, reason: why });
    const revisionId = drawing.revisions[0]!.id;
    await approve(f, await submit(f, parent.id, revisionId));
    const clientAccess = new ClientPortalAccessService(database), email = `${f.token.toLowerCase()}-primary@example.test`;
    const project = await f.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    await clientAccess.setPrimary(f.owner, projectId, { email, expectedProjectVersion: project.version, expectedPrimaryGrantId: null, reason: why });
    const client = await f.prisma.account.findUniqueOrThrow({ where: { normalizedEmail: email } });
    const csrfToken = randomBytes(32).toString("base64url");
    const session = await f.prisma.clientPortalSession.create({ data: { accountId: client.id, tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"), csrfTokenHash: createHash("sha256").update(csrfToken).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60_000), ipAddress: "127.0.0.1", userAgent: "MW-I02 inert client ceremony transport" } });
    const credential = await f.prisma.passkeyCredential.create({ data: { credentialId: `${f.token}-${randomUUID()}`, accountId: client.id, publicKey: randomBytes(65), counter: 0n, transports: ["internal"] } });
    const active: ActiveClientPortalSession = { row: session, account: client, csrfToken };
    const scope = new ClientPortalScopeService(database, f.authorization);
    const identity = new ClientPortalIdentityService(database, new BrevoEmailAdapter({ apiKey: undefined, senderEmail: undefined, senderName: undefined }), config);
    const clients = new ClientReviewService(database, scope, identity, f.documents, f.revisions);
    const task = await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
    const published = await clients.createPackage(f.owner, projectId, { title: `${f.token} exact client package`, reason: why, items: [{ taskId: parent.id, expectedTaskVersion: task.version, revisionId, label: "R0 Architecture" }] });
    const item = await clients.beginReview(active, published.items[0]!.id, { expectedVersion: 1, reason: why });
    // Reuse the S14 persistence layer's inert cryptographic transport seam.
    // Real session/grant/binding/one-time-consumption and domain policies remain;
    // this case does not claim browser/passkey authentication acceptance.
    const verification = jest.spyOn(identity, "verifyApprovalWithinTransaction").mockImplementation(async (tx, current, ceremonyId, _response, binding) => {
      const ceremony = await tx.clientPortalCeremony.findUnique({ where: { id: ceremonyId } });
      const now = new Date();
      if (!ceremony || ceremony.accountId !== current.account.id || ceremony.sessionId !== current.row.id || ceremony.consumedAt || ceremony.expiresAt <= now || canonical(ceremony.binding) !== canonical(binding)) throw new UnauthorizedException("Approval verification failed");
      const consumed = await tx.clientPortalCeremony.updateMany({ where: { id: ceremonyId, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw new UnauthorizedException("Approval verification failed");
      return { accountId: client.id, credentialId: credential.id };
    });
    try {
      const options = await clients.approvalOptions(active, item.itemId, { expectedVersion: item.version, signatureName: "MW-I02 Primary Client", consent: true, comment: why });
      await clients.decide(active, item.itemId, { kind: "APPROVED", expectedVersion: item.version, signatureName: "MW-I02 Primary Client", consent: true, comment: why, reason: why, ceremonyId: options.ceremonyId, response: { id: credential.credentialId } as never });
      let current = await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
      await expect(clients.completeTask(f.person("manager").actor, parent.id, { expectedVersion: current.version, reason: why })).rejects.toThrow();
      const final = await clients.finalOptions(active, published.id, { expectedVersion: 1, signatureName: "MW-I02 Primary Client", consent: true, comment: why });
      await clients.finalApprove(active, published.id, { expectedVersion: 1, signatureName: "MW-I02 Primary Client", consent: true, comment: why, reason: why, ceremonyId: final.ceremonyId, response: { id: credential.credentialId } as never });
      expect(await f.prisma.clientFinalApproval.findUniqueOrThrow({ where: { packageId: published.id } })).toMatchObject({ accountId: client.id, credentialId: credential.id });
      expect(await f.prisma.revisionApprovalFact.findUniqueOrThrow({ where: { revisionId_kind: { revisionId, kind: "CLIENT" } } })).toMatchObject({ projectId, revisionId });
      current = await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
      await expect(clients.completeTask(f.person("manager").actor, parent.id, { expectedVersion: current.version, reason: why })).rejects.toThrow("Complete all subtasks");
      await finishChild(f, child.task.id);
      current = await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
      await clients.completeTask(f.person("manager").actor, parent.id, { expectedVersion: current.version, reason: why });
      expect((await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(TaskStatus.COMPLETED);
    } finally { verification.mockRestore(); }
  });

  it("serializes child creation behind parent completion and rejects the stale child command", async () => {
    const f = await fixture(), parent = await f.tasks.create(f.owner, f.input);
    await start(f, parent.id);
    const locked = barrier(), resume = barrier();
    const completing = f.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$queryRaw`SELECT id FROM tasks WHERE id=${parent.id}::uuid FOR UPDATE`;
      locked.release(); await resume.promise;
      const scoped = transactionDatabase(tx), tasks = new TaskService(scoped, new AuthorizationService(scoped), new ApprovalService(scoped));
      await tasks.transition(f.owner, parent.id, { toState: "COMPLETED", expectedVersion: 2, reason: why });
    }, { timeout: 15_000 });
    await Promise.race([locked.promise, completing]);
    const inserting = f.tasks.createSubtask(f.owner, parent.id, { ...f.input, title: `${f.token} racing child`, expectedParentVersion: 2 });
    // Observe the rejection immediately so a fast conflict is never unhandled.
    const rejected = expect(inserting).rejects.toThrow();
    resume.release(); await completing; await rejected;
    expect((await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(TaskStatus.COMPLETED);
    expect(await f.prisma.taskSubtaskLink.count({ where: { parentTaskId: parent.id } })).toBe(0);
  });

  it("serializes parent completion behind committed child creation and blocks it", async () => {
    const f = await fixture(), parent = await f.tasks.create(f.owner, f.input);
    await start(f, parent.id);
    const inserted = barrier(), resume = barrier();
    const inserting = f.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      const scoped = transactionDatabase(tx), tasks = new TaskService(scoped, new AuthorizationService(scoped), new ApprovalService(scoped));
      await tasks.createSubtask(f.owner, parent.id, { ...f.input, expectedParentVersion: 2 });
      inserted.release(); await resume.promise;
    }, { timeout: 15_000 });
    await Promise.race([inserted.promise, inserting]);
    const completing = f.tasks.transition(f.owner, parent.id, { toState: "COMPLETED", expectedVersion: 3, reason: why });
    const rejected = expect(completing).rejects.toThrow("Complete all subtasks");
    resume.release(); await inserting; await rejected;
    expect((await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(TaskStatus.IN_PROGRESS);
    expect(await f.prisma.taskSubtaskLink.count({ where: { parentTaskId: parent.id } })).toBe(1);
  });

  it("allows one of two child commands with the same parent version and rolls back the loser", async () => {
    const f = await fixture(), parent = await f.tasks.create(f.owner, f.input);
    const commands = await Promise.allSettled([0, 1].map(index => f.tasks.createSubtask(f.owner, parent.id, { ...f.input, title: `${f.token} competing child ${index}`, expectedParentVersion: 1 })));
    expect(commands.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(commands.filter(row => row.status === "rejected")).toHaveLength(1);
    expect(await f.prisma.taskSubtaskLink.count({ where: { parentTaskId: parent.id } })).toBe(1);
    expect(await f.prisma.task.count({ where: { projectId: f.input.projectId, title: { startsWith: `${f.token} competing child` } } })).toBe(1);
    expect((await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).version).toBe(2);
  });

  it("serializes concurrent dependency edits against the committed parent-child completion edge", async () => {
    const f = await fixture(), parent = await f.tasks.create(f.owner, f.input);
    const child = await f.tasks.createSubtask(f.owner, parent.id, { ...f.input, expectedParentVersion: 1 });
    const middle = await f.tasks.create(f.owner, { ...f.input, title: `${f.token} middle dependency` });
    // Parent depends on its child's completion. Either explicit edge is valid
    // alone, but together child -> middle -> parent closes that completion cycle.
    const commands = await Promise.allSettled([
      f.tasks.addDependency(f.owner, child.task.id, { predecessorTaskId: middle.id, expectedVersion: 1, reason: why }),
      f.tasks.addDependency(f.owner, middle.id, { predecessorTaskId: parent.id, expectedVersion: 1, reason: why })
    ]);
    expect(commands.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(commands.filter(row => row.status === "rejected")).toHaveLength(1);
    expect(await f.prisma.taskDependency.count({ where: { organizationId: f.org.id, removedAt: null, dependentTaskId: { in: [child.task.id, middle.id] } } })).toBe(1);
  });

  it("does not treat a canonically stopped child as completed", async () => {
    const f = await fixture(), parent = await f.tasks.create(f.owner, f.input);
    const child = await f.tasks.createSubtask(f.owner, parent.id, { ...f.input, expectedParentVersion: 1 });
    const project = await f.prisma.project.findUniqueOrThrow({ where: { id: f.input.projectId } });
    await f.tasks.cancelProject(f.owner, project.id, { expectedVersion: project.version, reason: why });
    expect((await f.prisma.task.findUniqueOrThrow({ where: { id: child.task.id } })).status).toBe(TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION);
    await expect(f.prisma.task.update({ where: { id: parent.id }, data: { status: TaskStatus.COMPLETED, version: { increment: 1 } } })).rejects.toThrow("Complete all subtasks");
  });

  it("persists Owner-configured creation presentation without granting permissions", async () => {
    const f = await fixture(), worker = f.person("worker");
    const organization = new OrganizationService(database, new IdentityService(database, config), f.authorization, f.workflows, f.tasks, new NotificationsService(database));
    const before = await f.tasks.setup(worker.actor);
    expect(before.creationProfile).toMatchObject({ variant: "EMPLOYEE", resolution: "GENERIC_FALLBACK" });
    const site = await organization.createJobRole(f.owner.accountId, f.org.id, `${f.token} Site presentation`, why);
    const leader = await organization.createJobRole(f.owner.accountId, f.org.id, `${f.token} Leader presentation`, why);
    const set = { organizationId: f.org.id, reason: why, expectedCreationPresentation: null };
    await organization.setJobRoleCreationPresentation(f.owner.accountId, site.id, { ...set, creationPresentation: "SITE" });
    await organization.setJobRoleCreationPresentation(f.owner.accountId, leader.id, { ...set, creationPresentation: "LEADER" });
    await expect(organization.setJobRoleCreationPresentation(worker.account.id, site.id, { ...set, expectedCreationPresentation: "SITE", creationPresentation: "LEADER" })).rejects.toMatchObject({ status: 403 });
    await expect(organization.setJobRoleCreationPresentation(f.owner.accountId, site.id, { ...set, creationPresentation: "EMPLOYEE" })).rejects.toMatchObject({ status: 409 });
    await organization.setEmployeeJobRoles(f.owner.accountId, worker.employee.id, { organizationId: f.org.id, jobRoleIds: [site.id], reason: why });
    const after = await f.tasks.setup(worker.actor);
    expect(after.creationProfile).toMatchObject({ variant: "SITE", resolution: "CONFIGURED_ROLE" });
    expect(after.canAssign).toBe(before.canAssign);
    expect(await f.prisma.rolePermission.count({ where: { roleId: { in: [site.id, leader.id] } } })).toBe(0);
    await organization.setEmployeeJobRoles(f.owner.accountId, worker.employee.id, { organizationId: f.org.id, jobRoleIds: [site.id, leader.id], reason: why });
    expect((await f.tasks.setup(worker.actor)).creationProfile).toMatchObject({ variant: "EMPLOYEE", resolution: "AMBIGUOUS" });
    expect((await f.tasks.setup(f.owner)).creationProfile).toMatchObject({ variant: "OWNER", resolution: "ACCOUNT_KIND" });
  });

  it.each(["parent-first", "child-first"])("preserves completion under the %s child-reopen race", async order => {
    const f = await fixture(), parent = await f.tasks.create(f.owner, f.input);
    const child = await f.tasks.createSubtask(f.owner, parent.id, { ...f.input, expectedParentVersion: 1 });
    await start(f, parent.id); await finishChild(f, child.task.id);
    const reached = barrier(), resume = barrier();
    if (order === "parent-first") {
      const completing = f.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$queryRaw`SELECT id FROM tasks WHERE id=${parent.id}::uuid FOR UPDATE`;
        reached.release(); await resume.promise;
        const scoped = transactionDatabase(tx);
        await new TaskService(scoped, new AuthorizationService(scoped), new ApprovalService(scoped)).transition(f.owner, parent.id, { toState: "COMPLETED", expectedVersion: 3, reason: why });
      }, { timeout: 15_000 });
      await Promise.race([reached.promise, completing]);
      const rejected = expect(f.prisma.task.update({ where: { id: child.task.id }, data: { status: "IN_PROGRESS", version: { increment: 1 } } })).rejects.toThrow("remain completed");
      resume.release(); await completing; await rejected;
      expect((await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(TaskStatus.COMPLETED);
      expect((await f.prisma.task.findUniqueOrThrow({ where: { id: child.task.id } })).status).toBe(TaskStatus.COMPLETED);
    } else {
      // Completed tasks are immutable even before their parent completes.
      // Hold the child lock, reject the alternate write, then let the parent
      // observe the still-completed child after that transaction commits.
      const reopening = f.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$queryRaw`SELECT id FROM tasks WHERE id=${child.task.id}::uuid FOR UPDATE`;
        await tx.$executeRawUnsafe('SAVEPOINT rejected_reopen');
        await expect(tx.task.update({ where: { id: child.task.id }, data: { status: "IN_PROGRESS", version: { increment: 1 } } })).rejects.toThrow("Terminal tasks cannot change");
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rejected_reopen');
        reached.release(); await resume.promise;
      }, { timeout: 15_000 });
      await Promise.race([reached.promise, reopening]);
      const completing = f.tasks.transition(f.owner, parent.id, { toState: "COMPLETED", expectedVersion: 3, reason: why });
      resume.release(); await reopening; await completing;
      expect((await f.prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(TaskStatus.COMPLETED);
      expect((await f.prisma.task.findUniqueOrThrow({ where: { id: child.task.id } })).status).toBe(TaskStatus.COMPLETED);
    }
  });
});
