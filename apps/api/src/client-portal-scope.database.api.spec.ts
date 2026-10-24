import { ReviewService } from "./review.service.js";
import { NotificationsService } from "./notifications.service.js";
import "reflect-metadata";
import { jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseService } from "./database.service.js";
import { AuthorizationService } from "./authorization.service.js";
import { ProjectService, type ProjectActor } from "./project.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { ApprovalService } from "./approval.service.js";
import { TaskService } from "./task.service.js";
import { DocumentService } from "./document.service.js";
import { RevisionService } from "./revision.service.js";
import { ClientPortalAccessService } from "./client-portal-access.service.js";
import { ClientPortalIdentityService, type ActiveClientPortalSession } from "./client-portal-identity.service.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { ClientPortalFilesService } from "./client-portal-files.service.js";
import { ClientReviewService } from "./client-review.service.js";
import type { BrevoEmailAdapter } from "./brevo-email.js";
import type { RuntimeConfig } from "./config.js";
import { recordProjectEvent } from "./project-events.js";

const url = process.env.S14_DATABASE_URL;
jest.setTimeout(40_000);
(url ? describe : describe.skip)("S14 current portal scope and private references PostgreSQL", () => {
  let database: DatabaseService;
  let config: RuntimeConfig;
  let scope: ClientPortalScopeService;
  let files: ClientPortalFilesService;
  let identity: ClientPortalIdentityService;
  let access: ClientPortalAccessService;
  let reviews: ClientReviewService;
  let internalReviews: ReviewService;
  let tasks: TaskService;
  let projects: ProjectService;
  let workflows: ProjectWorkflowService;
  let owner: ProjectActor;
  const codes = new Map<string, string>();
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_test") || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("Dedicated local S14 test database required");
    const nasRoot = await mkdtemp(join(tmpdir(), "sense-s14-scope-"));
    config = { nodeEnv: "test", port: 4000, webOrigin: "http://localhost:5173", databaseUrl: url, nasRoot, emailVerificationSecret: "s14-scope-isolated-code-secret-20261001", ownerBootstrapEmail: undefined, ownerBootstrapSecret: undefined };
    database = new DatabaseService(config);
    const authorization = new AuthorizationService(database);
    scope = new ClientPortalScopeService(database, authorization);
    files = new ClientPortalFilesService(database, scope, config);
    const mail = { send: async (email: string, content: { textContent: string }) => { codes.set(email, content.textContent.match(/code is (\d{6})/)![1]!); } } as unknown as BrevoEmailAdapter;
    identity = new ClientPortalIdentityService(database, mail, config);
    access = new ClientPortalAccessService(database);
    projects = new ProjectService(database);
    workflows = new ProjectWorkflowService(database, authorization, new ApprovalService(database));
    tasks = new TaskService(database, authorization);
    const documents = new DocumentService(database, authorization, config);
    const revisions = new RevisionService(database, authorization, documents);
    reviews = new ClientReviewService(database, scope, identity, documents, revisions);
    internalReviews = new ReviewService(database, authorization, documents, revisions, new NotificationsService(database));
    const org = await database.prisma.organization.findFirst() ?? await database.prisma.organization.create({ data: { name: "S14 scope acceptance" } });
    const account = await database.prisma.account.findFirst({ where: { kind: "OWNER", state: "ACTIVE" } }) ?? await database.prisma.account.create({ data: { normalizedEmail: `scope-owner-${randomUUID()}@example.test`, kind: "OWNER", state: "ACTIVE" } });
    owner = { accountId: account.id, organizationId: org.id, kind: "OWNER" };
  });
  afterAll(async () => { await database?.onModuleDestroy(); });
  async function signIn(email: string): Promise<ActiveClientPortalSession> {
    await identity.requestCode(email);
    const session = await identity.verifyCode(email, codes.get(email)!);
    return identity.session(session.secret);
  }
  async function fixture() {
    const suffix = randomUUID();
    const branch = await database.prisma.branch.create({ data: { organizationId: owner.organizationId, name: `Scope ${suffix}` } });
    const team = await database.prisma.team.create({ data: { organizationId: owner.organizationId, branchId: branch.id, name: "Review" } });
    const account = await database.prisma.account.create({ data: { normalizedEmail: `scope-worker-${suffix}@example.test`, kind: "STAFF", state: "ACTIVE" } });
    const employee = await database.prisma.employee.create({ data: { organizationId: owner.organizationId, accountId: account.id, homeBranchId: branch.id, homeTeamId: team.id, hiredAt: new Date("2026-01-01Z") } });
    for (const permissionKey of ["project.view", "project.manage", "task.assign"]) await database.prisma.employeePermissionOverride.create({ data: { organizationId: owner.organizationId, employeeId: employee.id, permissionKey, effect: "ALLOW", scopeKind: "BRANCH", branchId: branch.id, reason: "Scoped acceptance employee permissions" } });
    const created = await projects.create(owner, { branchId: branch.id, title: "S14 scoped review", deliveryType: "DESIGN", scopes: ["Architecture"], reason: "Scope acceptance fixture" });
    await workflows.assignment(owner, created.project.id, { employeeId: employee.id, expectedVersion: 1, reason: "Assign scope reviewer" });
    let project = await database.prisma.project.findUniqueOrThrow({ where: { id: created.project.id } });
    await workflows.lead(owner, project.id, { employeeId: employee.id, expectedVersion: project.version, reason: "Assign scope lead" });
    project = await database.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    await workflows.status(owner, project.id, { toStatus: "ACTIVE", expectedVersion: project.version, reason: "Activate scope fixture" });
    const email = `scope-client-${suffix}@example.test`;
    project = await database.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const appointed = await access.setPrimary(owner, project.id, { email, expectedProjectVersion: project.version, expectedPrimaryGrantId: null, reason: "Owner appoints scope Primary" });
    const primary = await signIn(email);
    const task = await tasks.create(owner, { projectId: project.id, ownerEmployeeId: employee.id, title: "Client review brief", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: "CLIENT", reason: "Create client only review task" });
    const reviewerAccount = await database.prisma.account.create({ data: { normalizedEmail: `scope-reviewer-${suffix}@example.test`, kind: "STAFF", state: "ACTIVE" } });
    const reviewer = await database.prisma.employee.create({ data: { organizationId: owner.organizationId, accountId: reviewerAccount.id, homeBranchId: branch.id, homeTeamId: team.id, hiredAt: new Date("2026-01-01Z") } });
    for (const permissionKey of ["project.view", "document.view", "review.decide"]) await database.prisma.employeePermissionOverride.create({ data: { organizationId: owner.organizationId, employeeId: reviewer.id, permissionKey, effect: "ALLOW", scopeKind: "BRANCH", branchId: branch.id, reason: "Independent scope fixture reviewer permissions" } });
    await workflows.assignment(owner, project.id, { employeeId: reviewer.id, expectedVersion: (await database.prisma.project.findUniqueOrThrow({ where: { id: project.id } })).version, reason: "Assign independent scope evidence reviewer" });
    const submitterActor: ProjectActor = { accountId: account.id, organizationId: owner.organizationId, kind: "STAFF" };
    const reviewerActor: ProjectActor = { accountId: reviewerAccount.id, organizationId: owner.organizationId, kind: "STAFF" };
    await internalReviews.assignReviewer(owner, task.id, { employeeId: reviewer.id, expectedVersion: task.version, reason: "Appoint independent scope reviewer" });
    const started = await tasks.transition(owner, task.id, { expectedVersion: task.version + 1, toState: "IN_PROGRESS", reason: "Start client brief" });
    const submit = async (version: number, round: number) => {
      const sent = await internalReviews.submit(submitterActor, task.id, { expectedVersion: version, reviewUrl: `https://files.sensestudios.com/scoped/${task.id}?round=${round}`, reason: "Submit exact scoped work for internal review" });
      const latest = sent.rounds.at(-1)!;
      await internalReviews.start(reviewerActor, latest.id, "Inspect exact scoped work independently");
      await internalReviews.decision(reviewerActor, latest.id, { kind: "APPROVED", reason: "Approve exact scoped evidence independently" });
      return database.prisma.reviewSubmission.findFirstOrThrow({ where: { taskId: task.id }, orderBy: { roundNumber: "desc" } });
    };
    const submission = await submit(started.version, 1);
    await reviews.createPackage(owner, project.id, { title: "Scoped brief package", reason: "Publish exact client brief", items: [{ taskId: task.id, expectedTaskVersion: (await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version, workSubmissionId: submission.id, label: "Brief" }] });
    const item = await database.prisma.clientReviewItem.findFirstOrThrow({ where: { taskId: task.id } });
    return { project: await database.prisma.project.findUniqueOrThrow({ where: { id: project.id } }), primary, item, grant: appointed.grant, submit };
  }
  it("Primary invitations give no item access until explicit delegation, with immutable grants and no project leakage", async () => {
    const f = await fixture();
    const email = `scope-additional-${randomUUID()}@example.test`;
    const invited = await scope.invite(f.primary, f.project.id, { email, reason: "Invite item contributor" });
    const additional = await signIn(email);
    await expect(database.prisma.$transaction((tx) => scope.authorizeItem(tx, additional, f.item.id, "view"))).rejects.toMatchObject({ status: 403 });
    await scope.setItemGrant(f.primary, { itemId: f.item.id, portalGrantId: invited.id, expectedVersion: 0, view: true, comment: true, review: true, approve: false, download: false, reason: "Delegate precise item comments" });
    await expect(database.prisma.$transaction((tx) => scope.authorizeItem(tx, additional, f.item.id, "comment"))).resolves.toHaveProperty("item.id", f.item.id);
    await expect(database.prisma.$transaction((tx) => scope.authorizeItem(tx, additional, f.item.id, "approve"))).rejects.toMatchObject({ status: 403 });
    await expect(scope.invite(additional, f.project.id, { email: `denied-${randomUUID()}@example.test`, reason: "Denied additional invitation" })).rejects.toMatchObject({ status: 403 });
    const other = await fixture();
    await expect(database.prisma.$transaction((tx) => scope.authorizeItem(tx, additional, other.item.id, "view"))).rejects.toMatchObject({ status: 403 });
    await expect(database.prisma.clientItemGrant.updateMany({ where: { itemId: f.item.id }, data: { approve: true } })).rejects.toThrow();
  });
  it("validates private PDF references, omits storage identifiers and ends access immediately on revocation", async () => {
    const f = await fixture();
    const reference = await files.reference(f.primary, f.item.id, { name: "reference.pdf", mime: "application/pdf", reason: "Attach private client reference", bytes: Buffer.from("%PDF-1.7\nPrivate reference\n%%EOF") });
    expect(reference).not.toHaveProperty("storageKey");
    const opened = await files.referenceStream(f.primary, reference.id);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toContain("Private reference");
    await expect(files.reference(f.primary, f.item.id, { name: "unsafe.pdf", mime: "application/pdf", reason: "Reject disguised executable", bytes: Buffer.from("MZmalicious executable") })).rejects.toMatchObject({ status: 400 });
    await access.changeAccess(owner, f.grant.id, { expectedVersion: f.grant.version, revoke: true, reason: "End client scope immediately" });
    await expect(files.referenceStream(f.primary, reference.id)).rejects.toMatchObject({ status: 403 });
  });
  it("allows explicit Additional Client item approval while keeping Primary final authority", async () => {
    const f = await fixture();
    const email = `delegated-approver-${randomUUID()}@example.test`;
    const invited = await scope.invite(f.primary, f.project.id, { email, reason: "Invite explicitly delegated approver" });
    const additional = await signIn(email);
    await reviews.beginReview(f.primary, f.item.id, { expectedVersion: f.item.version, reason: "Primary starts the delegated approval review" });
    await scope.setItemGrant(f.primary, { itemId: f.item.id, portalGrantId: invited.id, expectedVersion: 0, view: true, comment: false, review: false, approve: true, download: false, reason: "Delegate this exact item approval only" });
    const credential = await database.prisma.passkeyCredential.create({ data: { accountId: additional.account.id, credentialId: `delegated-proof-${randomUUID()}`, publicKey: Buffer.from("isolated permission fixture") } });
    const verifier = jest.spyOn(identity, "verifyApprovalWithinTransaction").mockResolvedValue({ accountId: additional.account.id, credentialId: credential.id });
    try {
      await reviews.decide(additional, f.item.id, { expectedVersion: f.item.version + 1, kind: "APPROVED", signatureName: "Delegated Client", consent: true, comment: "Approve only delegated item", reason: "Explicit delegated item approval", ceremonyId: randomUUID(), response: {} as never });
      expect(await database.prisma.clientItemDecision.findUnique({ where: { itemId: f.item.id } })).toMatchObject({ accountId: additional.account.id, kind: "APPROVED" });
      expect(await database.prisma.clientFinalApproval.findUnique({ where: { packageId: f.item.packageId } })).toBeNull();
      await expect(reviews.finalOptions(additional, f.item.packageId, { expectedVersion: 1, signatureName: "Delegated Client", consent: true, comment: "Attempt overall approval" })).rejects.toThrow(/Primary/);
      const approvedTask = await database.prisma.task.findUniqueOrThrow({ where: { id: f.item.taskId } });
      await expect(reviews.completeTask(owner, f.item.taskId, { expectedVersion: approvedTask.version, reason: "Attempt completion before Primary final" })).rejects.toThrow(/Final Primary/);
    } finally { verifier.mockRestore(); }
  });
  it("canonical audit delivery cannot confer a missing exact-item review capability", async () => {
    const f = await fixture();
    const invited = await scope.invite(f.primary, f.project.id, { email: `scope-ungranted-${randomUUID()}@example.test`, reason: "Invite without exact item authority" });
    const portal = await database.prisma.clientPortalGrant.findUniqueOrThrow({ where: { id: invited.id } });
    await expect(database.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUniqueOrThrow({ where: { id: f.item.taskId } });
      await tx.clientReviewItem.update({ where: { id: f.item.id }, data: { status: "IN_REVIEW", version: { increment: 1 } } });
      await recordProjectEvent(tx, { organizationId: f.item.organizationId, actorId: portal.accountId, eventName: "client.review_started", subjectType: "client_review_item", subjectId: f.item.id, reason: "Attempt canonical unauthorized review", after: { itemId: f.item.id, packageId: f.item.packageId, projectId: f.project.id, version: 2, status: "IN_REVIEW" } });
      await tx.task.update({ where: { id: task.id }, data: { status: "IN_CLIENT_REVIEW", version: { increment: 1 } } });
      await tx.taskStatusChange.create({ data: { organizationId: task.organizationId, taskId: task.id, actorId: portal.accountId, fromStatus: task.status, toStatus: "IN_CLIENT_REVIEW", taskVersion: task.version + 1, reason: "Attempt canonical unauthorized review" } });
      await recordProjectEvent(tx, { organizationId: task.organizationId, actorId: portal.accountId, eventName: "task.updated", subjectType: "task", subjectId: task.id, reason: "Attempt canonical unauthorized review", before: { status: task.status, version: task.version }, after: { status: "IN_CLIENT_REVIEW", version: task.version + 1 } });
    })).rejects.toThrow(/current exact actor authority/);
    expect((await database.prisma.clientReviewItem.findUniqueOrThrow({ where: { id: f.item.id } })).status).toBe("PENDING");
  });
  it("cannot reuse a historical completed correction for a newer client revision request", async () => {
    const f = await fixture();
    await reviews.beginReview(f.primary, f.item.id, { expectedVersion: 1, reason: "Review first client brief" });
    await reviews.decide(f.primary, f.item.id, { kind: "REVISION_REQUIRED", expectedVersion: 2, comment: "Revise first brief", reason: "First exact client revision request" });
    await reviews.classify(owner, f.item.id, { category: "PREFERENCE_NEW_REQUIREMENT", expectedVersion: 3, reason: "Classify first client revision request" });
    const task = await database.prisma.task.findUniqueOrThrow({ where: { id: f.item.taskId } });
    const correction = await reviews.assignCorrection(owner, f.item.id, { ownerEmployeeId: task.primaryOwnerEmployeeId, reason: "Assign first exact correction" });
    const started = await tasks.transition(owner, correction.task.id, { expectedVersion: 1, toState: "IN_PROGRESS", reason: "Start first correction" });
    await tasks.transition(owner, correction.task.id, { expectedVersion: started.version, toState: "COMPLETED", reason: "Complete first correction" });
    const resumed = await reviews.resumeCorrection(owner, f.item.id, { expectedTaskVersion: task.version, reason: "Resume after first exact correction" });
    const secondSubmission = await f.submit(resumed.version, 2);
    await reviews.createPackage(owner, f.project.id, { title: "Second immutable brief", reason: "Submit second exact client brief", items: [{ taskId: task.id, expectedTaskVersion: (await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version, workSubmissionId: secondSubmission.id, label: "Revised brief" }] });
    const newer = await database.prisma.clientReviewItem.findFirstOrThrow({ where: { taskId: task.id, id: { not: f.item.id } } });
    await reviews.beginReview(f.primary, newer.id, { expectedVersion: newer.version, reason: "Review second client brief" });
    await reviews.decide(f.primary, newer.id, { kind: "REVISION_REQUIRED", expectedVersion: 2, comment: "Revise second brief", reason: "Second exact client revision request" });
    const current = await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    await expect(reviews.resumeCorrection(owner, f.item.id, { expectedTaskVersion: current.version, reason: "Attempt obsolete completed correction reuse" })).rejects.toThrow();
    expect((await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("CLIENT_REVISION_REQUIRED");
  });
  it("SQL Primary authority samples expiry after a blocked portal grant lock", async () => {
    const f = await fixture();
    await access.changeAccess(owner, f.grant.id, { expectedVersion: f.grant.version, expiresAt: new Date(Date.now() + 1_000).toISOString(), reason: "Bounded authority expiry race" });
    let locked!: () => void;
    let release!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const lockReleased = new Promise<void>((resolve) => { release = resolve; });
    const blocker = database.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "client_portal_grants" WHERE "id"=${f.grant.id}::uuid FOR UPDATE`;
      locked();
      await lockReleased;
    });
    await lockReady;
    try {
      const waiting = database.prisma.$transaction((tx) => tx.$queryRaw<{ allowed: boolean }[]>`SELECT s14_primary_authority(${f.primary.account.id}::uuid,${f.project.id}::uuid,false) AS allowed`);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      release();
      await blocker;
      expect((await waiting)[0]!.allowed).toBe(false);
    } finally { release(); await blocker; }
  });
  it("final SQL approval rejects task content changed after a valid exact item decision", async () => {
    const f = await fixture();
    const credential = await database.prisma.passkeyCredential.create({ data: { accountId: f.primary.account.id, credentialId: `scope-proof-${randomUUID()}`, publicKey: Buffer.from("isolated SQL fixture"), label: "SQL evidence fixture" } });
    const verifier = jest.spyOn(identity, "verifyApprovalWithinTransaction").mockResolvedValue({ accountId: f.primary.account.id, credentialId: credential.id });
    try {
      await reviews.beginReview(f.primary, f.item.id, { expectedVersion: f.item.version, reason: "Begin exact task SQL review" });
      const item = await database.prisma.clientReviewItem.findUniqueOrThrow({ where: { id: f.item.id } });
      await reviews.decide(f.primary, item.id, { expectedVersion: item.version, kind: "APPROVED", signatureName: "Primary SQL fixture", consent: true, comment: "Approve immutable brief", reason: "Approve exact task SQL fixture", ceremonyId: randomUUID(), response: {} as never });
      const decision = await database.prisma.clientItemDecision.findUniqueOrThrow({ where: { itemId: item.id } });
      const attempt = (changeTitle: boolean) => database.prisma.$transaction(async (tx) => {
        if (changeTitle) await tx.task.update({ where: { id: item.taskId }, data: { title: "Different task after approval", version: { increment: 1 } } });
        const [batch] = await tx.$queryRaw<{ snapshot: object }[]>`SELECT s14_final_item_snapshot(${item.packageId}::uuid) AS snapshot`;
        await tx.clientFinalApproval.create({ data: { organizationId: item.organizationId, projectId: item.projectId, packageId: item.packageId, accountId: f.primary.account.id, credentialId: credential.id, signatureName: "Primary SQL fixture", consent: true, itemSnapshot: batch!.snapshot, auditEventId: decision.auditEventId } });
        // Probe the immediate guard only; no fabricated final audit is committed.
        throw new Error("Valid exact task passed immediate final guard");
      });
      await expect(attempt(false)).rejects.toThrow("Valid exact task passed immediate final guard");
      await expect(attempt(true)).rejects.toThrow(/current exact approved task content/);
      expect((await database.prisma.task.findUniqueOrThrow({ where: { id: item.taskId } })).title).toBe("Client review brief");
      expect(await database.prisma.clientFinalApproval.findUnique({ where: { packageId: item.packageId } })).toBeNull();
    } finally { verifier.mockRestore(); }
  });
  it("cancellation requires individual future end times and withdraws review/task state atomically", async () => {
    const f = await fixture();
    await expect(tasks.cancelProject(owner, f.project.id, { expectedVersion: f.project.version, reason: "Attempt without individual access expiry" })).rejects.toThrow(/future end time/);
    expect((await database.prisma.clientReviewItem.findUniqueOrThrow({ where: { id: f.item.id } })).status).toBe("PENDING");
    await tasks.cancelProject(owner, f.project.id, { expectedVersion: f.project.version, reason: "Owner cancels with individual access period", clientAccessEndTimes: [{ grantId: f.grant.id, expectedVersion: f.grant.version, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }] });
    expect((await database.prisma.clientReviewItem.findUniqueOrThrow({ where: { id: f.item.id } })).status).toBe("WITHDRAWN");
    expect((await database.prisma.task.findUniqueOrThrow({ where: { id: f.item.taskId } })).status).toBe("STOPPED_DUE_TO_PROJECT_CANCELLATION");
    await expect(scope.invite(f.primary, f.project.id, { email: `closed-${randomUUID()}@example.test`, reason: "Denied cancelled invitation" })).rejects.toMatchObject({ status: 409 });
    await expect(database.prisma.$transaction((tx) => scope.authorizeItem(tx, f.primary, f.item.id, "view"))).rejects.toMatchObject({ status: 403 });
  });
  it("rejects a retained session after idle expiry and requires current Primary authority for delegation", async () => {
    const f = await fixture();
    const email = `new-primary-${randomUUID()}@example.test`;
    await access.setPrimary(owner, f.project.id, { email, expectedProjectVersion: f.project.version, expectedPrimaryGrantId: f.grant.id, expectedPrimaryGrantVersion: f.grant.version, reason: "Owner replaces Primary authority" });
    await expect(scope.invite(f.primary, f.project.id, { email: `denied-${randomUUID()}@example.test`, reason: "Denied superseded Primary invitation" })).rejects.toMatchObject({ status: 403 });
    const current = await signIn(email);
    await database.prisma.clientPortalSession.update({ where: { id: current.row.id }, data: { lastUsedAt: new Date(Date.now() - 31 * 60_000) } });
    await expect(scope.projects(current)).rejects.toMatchObject({ status: 403 });
  });
  it("rolls back invitation identity, access and evidence together when the audit write fails", async () => {
    const f = await fixture();
    const email = `audit-rollback-${randomUUID()}@example.test`;
    const facade = { prisma: { $transaction: (run: (tx: import("./generated/prisma/client.js").Prisma.TransactionClient) => Promise<unknown>) => database.prisma.$transaction(async (tx) => {
      const injected = new Proxy(tx, { get(target, key) {
        if (key === "auditEvent") return new Proxy(target.auditEvent, { get(delegate, method) { if (method === "create") return async () => { throw new Error("Injected S14 audit failure"); }; return Reflect.get(delegate, method); } });
        return Reflect.get(target, key);
      } });
      return run(injected);
    }) } } as unknown as DatabaseService;
    const broken = new ClientPortalScopeService(facade, new AuthorizationService(database));
    await expect(broken.invite(f.primary, f.project.id, { email, reason: "Prove atomic client invitation rollback" })).rejects.toThrow("Injected S14 audit failure");
    expect(await database.prisma.account.findUnique({ where: { normalizedEmail: email } })).toBeNull();
    expect(await database.prisma.clientPortalGrant.count({ where: { projectId: f.project.id } })).toBe(1);
  });
  it.each(["absolute", "idle"] as const)("denies %s session expiry after a portal grant lock wait", async (deadline) => {
    const f = await fixture();
    const expires = new Date(Date.now() + 800);
    await database.prisma.clientPortalSession.update({ where: { id: f.primary.row.id }, data: deadline === "absolute" ? { expiresAt: expires } : { lastUsedAt: new Date(expires.getTime() - 30 * 60_000) } });
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const blocker = database.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM client_portal_grants WHERE "id"=${f.grant.id}::uuid FOR UPDATE`;
      locked(); await released;
    });
    await ready;
    let pid = 0;
    const pending = database.prisma.$transaction(async (tx) => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      return scope.authorizeProject(tx, f.primary, f.project.id, true);
    }).then(() => ({ accepted: true, status: 0 }), (error: { status?: number }) => ({ accepted: false, status: error.status }));
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (pid) waiting = (await database.prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${pid}`)[0]?.waiting === true;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now() + 30)));
      release(); await blocker;
      await expect(pending).resolves.toEqual({ accepted: false, status: 403 });
    } finally { release(); await blocker; await pending; }
  });
  it.each(["begin", "decision"] as const)("rejects expired session after %s waits for the item lock", async (command) => {
    const f = await fixture();
    if (command === "decision") await reviews.beginReview(f.primary, f.item.id, { expectedVersion: f.item.version, reason: "Start before expiry regression" });
    const item = await database.prisma.clientReviewItem.findUniqueOrThrow({ where: { id: f.item.id } });
    const expires = new Date(Date.now() + 800);
    await database.prisma.clientPortalSession.update({ where: { id: f.primary.row.id }, data: { expiresAt: expires } });
    let locked!: () => void, release!: () => void, checked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const authorized = new Promise<void>((resolve) => { checked = resolve; });
    const original = scope.authorizeItem.bind(scope);
    const authorization = jest.spyOn(scope, "authorizeItem").mockImplementation(async (...args) => { const result = await original(...args); checked(); return result; });
    const blocker = database.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM client_review_items WHERE "id"=${item.id}::uuid FOR UPDATE`;
      locked(); await released;
    });
    await ready;
    const pending = (command === "begin"
      ? reviews.beginReview(f.primary, item.id, { expectedVersion: item.version, reason: "Deny start after session deadline" })
      : reviews.decide(f.primary, item.id, { kind: "REVISION_REQUIRED", expectedVersion: item.version, comment: "Need a correction", reason: "Deny decision after session deadline" })
    ).then(() => ({ accepted: true, status: 0 }), (error: { status?: number }) => ({ accepted: false, status: error.status }));
    try {
      await authorized;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now() + 30)));
      release(); await blocker;
      await expect(pending).resolves.toEqual({ accepted: false, status: 403 });
      expect(await database.prisma.clientReviewItem.findUnique({ where: { id: item.id } })).toMatchObject({ status: item.status, version: item.version });
      expect(await database.prisma.clientItemDecision.count({ where: { itemId: item.id } })).toBe(0);
    } finally { release(); await blocker; await pending; authorization.mockRestore(); }
  });
});
