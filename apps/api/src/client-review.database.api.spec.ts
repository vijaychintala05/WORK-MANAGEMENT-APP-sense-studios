import { ReviewRoutingService } from "./review-routing.service.js";
import "reflect-metadata";
import { jest } from "@jest/globals";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedException } from "@nestjs/common";
import { AccountKind, ClientItemDecisionKind, ClientReviewItemStatus, ClientRevisionCategory, PermissionEffect, PermissionScopeKind, RevisionApprovalKind, TaskReviewRequirement } from "./generated/prisma/client.js";
import { AuthorizationService } from "./authorization.service.js";
import { BrevoEmailAdapter } from "./brevo-email.js";
import { ClientPortalIdentityService, type ActiveClientPortalSession } from "./client-portal-identity.service.js";
import { ClientPortalAccessService } from "./client-portal-access.service.js";
import { ClientPortalFilesService } from "./client-portal-files.service.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { ClientReviewService } from "./client-review.service.js";
import { DatabaseService } from "./database.service.js";
import { DocumentService } from "./document.service.js";
import { NotificationsService } from "./notifications.service.js";
import { ProjectService } from "./project.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { RevisionService } from "./revision.service.js";
import { ReviewService } from "./review.service.js";
import { TaskService } from "./task.service.js";
import { ApprovalService } from "./approval.service.js";
import type { ProjectActor } from "./project.service.js";
import type { RuntimeConfig } from "./config.js";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "./s27-disposable-test-target.js";

const databaseUrl = process.env.S14_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
jest.setTimeout(45_000);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

databaseDescribe("S14 client review PostgreSQL acceptance", () => {
  let database: DatabaseService;
  let nasRoot: string;
  let config: RuntimeConfig;

  beforeAll(async () => {
    nasRoot = await mkdtemp(join(tmpdir(), "sense-s14-client-review-"));
    config = { nodeEnv: "test", port: 4000, databaseUrl: databaseUrl!, webOrigin: "http://localhost:5173", ownerBootstrapEmail: undefined, ownerBootstrapSecret: undefined, nasRoot, emailVerificationSecret: "s14-client-review-test-hmac-secret" };
    database = new DatabaseService(config);
    const rows = await database.prisma.$queryRaw<Array<{ name: string; port: number }>>`SELECT current_database() AS name, inet_server_port() AS port`;
    const s14 = /^sense_s14_[a-z0-9_]*_test$/.test(rows[0]?.name ?? "") && rows[0]?.port === 56434;
    const target = new URL(databaseUrl!);
    const s25 = process.env.S25_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(target.hostname) && /^sense_s14_s25_[a-z0-9_]+_test$/.test(rows[0]?.name ?? "") && rows[0]?.port === 56436 && target.port === "56436";
    const s26 = process.env.S26_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(target.hostname) && /^sense_s14_s26_[a-z0-9_]+_test$/.test(rows[0]?.name ?? "") && rows[0]?.port === 56436 && target.port === "56436";
    const s27Legacy = process.env.S27_E2E_ENABLED === "1" && ["localhost", "127.0.0.1"].includes(target.hostname) && /^sense_s14_s27_[a-z0-9_]+_test$/.test(rows[0]?.name ?? "") && rows[0]?.port === 56436 && target.port === "56436";
    const s27Disposable = isS27DisposableTestTarget("S14_DATABASE_URL", databaseUrl);
    const s27 = s27Legacy || s27Disposable;
    if (s27Disposable && !matchesS27DisposableServer(databaseUrl!, rows[0]!.name, rows[0]!.port)) throw new Error("S14 disposable server mismatch");
    if (!s14 && !s25 && !s26 && !s27) throw new Error("Client review tests require the dedicated local S14 database or explicitly enabled exact S14/S25/S26/S27 target");
  });

  afterAll(async () => { await database?.onModuleDestroy(); });

  it("publishes exact internally approved evidence, consumes failed and successful step-up, and creates CLIENT evidence only at Primary final approval", async () => {
    const prisma = database.prisma;
    const suffix = randomUUID();
    // The deployed test schema has one canonical organization row. Reuse it and
    // isolate this fixture with fresh branch/team/project/account identifiers.
    const organization = await prisma.organization.findFirstOrThrow();
    const branch = await prisma.branch.create({ data: { organizationId: organization.id, name: `S14 client review branch ${suffix}` } });
    const team = await prisma.team.create({ data: { organizationId: organization.id, branchId: branch.id, name: `S14 client review team ${suffix}` } });
    const ownerAccount = await prisma.account.findFirstOrThrow({ where: { kind: AccountKind.OWNER, state: "ACTIVE" } });
    const owner: ProjectActor = { accountId: ownerAccount.id, organizationId: organization.id, kind: AccountKind.OWNER };
    const managerAccount = await prisma.account.create({ data: { normalizedEmail: `s14-client-manager-${suffix}@example.test`, kind: AccountKind.STAFF, state: "ACTIVE" } });
    const submitterAccount = await prisma.account.create({ data: { normalizedEmail: `s14-client-submitter-${suffix}@example.test`, kind: AccountKind.STAFF, state: "ACTIVE" } });
    const reviewerAccount = await prisma.account.create({ data: { normalizedEmail: `s14-client-reviewer-${suffix}@example.test`, kind: AccountKind.STAFF, state: "ACTIVE" } });
    const manager = await prisma.employee.create({ data: { organizationId: organization.id, accountId: managerAccount.id, homeBranchId: branch.id, homeTeamId: team.id, hiredAt: new Date("2026-01-01T00:00:00Z") } });
    const submitter = await prisma.employee.create({ data: { organizationId: organization.id, accountId: submitterAccount.id, homeBranchId: branch.id, homeTeamId: team.id, hiredAt: new Date("2026-01-01T00:00:00Z") } });
    const reviewer = await prisma.employee.create({ data: { organizationId: organization.id, accountId: reviewerAccount.id, homeBranchId: branch.id, homeTeamId: team.id, hiredAt: new Date("2026-01-01T00:00:00Z") } });
    for (const employee of [manager, submitter, reviewer]) {
      for (const permissionKey of ["project.view", "document.view", ...(employee.id === manager.id ? ["project.manage", "task.assign"] : []), ...(employee.id === reviewer.id ? ["review.decide"] : [])]) {
        await prisma.employeePermissionOverride.create({ data: { organizationId: organization.id, employeeId: employee.id, permissionKey, effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: branch.id, reason: "S14 client review PG acceptance" } });
      }
    }

    const authorization = new AuthorizationService(database);
    const projects = new ProjectService(database);
    const workflows = new ProjectWorkflowService(database, authorization, new ApprovalService(database));
    const tasks = new TaskService(database, authorization);
    const documents = new DocumentService(database, authorization, config);
    const revisions = new RevisionService(database, authorization, documents);
    const notifications = new NotificationsService(database);
    const reviews = new ReviewService(database, authorization, documents, revisions, notifications);
    const scope = new ClientPortalScopeService(database, authorization);
    const portalFiles = new ClientPortalFilesService(database, scope, config);
    const email = new BrevoEmailAdapter(config);
    const portalIdentity = new ClientPortalIdentityService(database, email, config);
    const clientReviews = new ClientReviewService(database, scope, portalIdentity, documents, revisions);
    const managerActor: ProjectActor = { accountId: managerAccount.id, organizationId: organization.id, kind: AccountKind.STAFF };
    const submitterActor: ProjectActor = { accountId: submitterAccount.id, organizationId: organization.id, kind: AccountKind.STAFF };
    const reviewerActor: ProjectActor = { accountId: reviewerAccount.id, organizationId: organization.id, kind: AccountKind.STAFF };

    const created = await projects.create(owner, { branchId: branch.id, title: `S14 client review ${suffix.slice(0, 8)}`, deliveryType: "DESIGN", scopes: ["Architecture"], reason: "Create S14 client review acceptance project" });
    for (const employee of [manager, submitter, reviewer]) {
      const current = await prisma.project.findUniqueOrThrow({ where: { id: created.project.id }, select: { version: true } });
      await workflows.assignment(owner, created.project.id, { employeeId: employee.id, expectedVersion: current.version, reason: "Assign S14 client review project" });
    }
    let projectVersion = (await prisma.project.findUniqueOrThrow({ where: { id: created.project.id } })).version;
    await workflows.lead(owner, created.project.id, { employeeId: manager.id, expectedVersion: projectVersion, reason: "Set client review project lead" });
    projectVersion = (await prisma.project.findUniqueOrThrow({ where: { id: created.project.id } })).version;
    await workflows.status(owner, created.project.id, { toStatus: "ACTIVE", expectedVersion: projectVersion, reason: "Activate client review project" });

    const folder = await documents.createFolder(owner, created.project.id, { name: "Client review evidence", confidential: false, reason: "Create client review evidence folder" });
    const bytes = Buffer.from("%PDF-1.7\nS14 internally approved client review drawing\n%%EOF\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await documents.startUpload(owner, created.project.id, { folderId: folder.id, fileName: `S14-${suffix.slice(0, 8)}.pdf`, mimeType: "application/pdf", sizeBytes: bytes.byteLength, confidential: false, viewOnly: false, reason: "Upload exact client review drawing" });
    await documents.writeChunk(owner, upload.uploadId, 0, bytes, sha256);
    const file = await documents.finalize(owner, upload.uploadId);
    const drawing = await revisions.createDrawing(owner, created.project.id, { documentNumber: `S14-${suffix.slice(0, 8)}`, title: "Client approval exact revision", fileId: file.id, reason: "Register client review R0" });
    const task = await tasks.create(owner, { projectId: created.project.id, ownerEmployeeId: submitter.id, title: "Submit exact drawing for client review", type: "PROJECT", priority: "HIGH", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.BOTH, reason: "Create both internal and client review task" });
    await reviews.assignReviewer(managerActor, task.id, { employeeId: reviewer.id, expectedVersion: 1, reason: "Assign independent internal reviewer" });
    await tasks.transition(submitterActor, task.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start drawing submission" });
    const internal = await reviews.submit(submitterActor, task.id, { expectedVersion: 3, revisionId: drawing.revisions[0]!.id, reason: "Submit exact R0 for independent internal review" });
    const roundId = internal.rounds[0]!.id;
    await reviews.start(reviewerActor, roundId, "Begin independent internal review");
    await reviews.decision(reviewerActor, roundId, { kind: "APPROVED", comment: "Exact drawing internally approved", reason: "Approve exact R0 internally" });
    const internallyApproved = await prisma.documentRevision.findUniqueOrThrow({ where: { id: drawing.revisions[0]!.id } });
    expect(internallyApproved).toMatchObject({ state: "APPROVED", isCurrent: true, sha256 });

    const clientEmail = `s14-primary-${suffix}@example.test`;
    const clientAccess = new ClientPortalAccessService(database);
    const currentProject = await prisma.project.findUniqueOrThrow({ where: { id: created.project.id }, select: { version: true } });
    const primaryGrant = await clientAccess.setPrimary(owner, created.project.id, { email: clientEmail, expectedProjectVersion: currentProject.version, expectedPrimaryGrantId: null, reason: "Owner appoints Primary Client for acceptance" });
    const client = await prisma.account.findUniqueOrThrow({ where: { normalizedEmail: clientEmail } });
    const clientSecret = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const session = await prisma.clientPortalSession.create({ data: { accountId: client.id, tokenHash: createHash("sha256").update(clientSecret).digest("hex"), csrfTokenHash: createHash("sha256").update(csrfToken).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60_000), ipAddress: "127.0.0.1", userAgent: "S14 test client" } });
    const credential = await prisma.passkeyCredential.create({ data: { credentialId: `S14-${suffix}`, accountId: client.id, publicKey: randomBytes(65), counter: 0n, transports: ["internal"] } });
    const active: ActiveClientPortalSession = { row: session, account: client, csrfToken };

    const published = await clientReviews.createPackage(owner, created.project.id, { title: "Exact R0 client review", reason: "Publish internally approved R0 for client review", items: [{ taskId: task.id, expectedTaskVersion: (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version, revisionId: drawing.revisions[0]!.id, label: "R0 · Architecture" }] });
    expect(published.items).toHaveLength(1);
    const itemId = published.items[0]!.id;
    expect(await prisma.revisionApprovalFact.findUnique({ where: { revisionId_kind: { revisionId: drawing.revisions[0]!.id, kind: RevisionApprovalKind.CLIENT } } })).toBeNull();

    const clientList = await clientReviews.portalList(active, created.project.id);
    expect(clientList.packages[0]?.items[0]).toMatchObject({ id: itemId, label: "R0 · Architecture", permissions: { view: true, comment: true, review: true, approve: true, download: true }, revision: { id: drawing.revisions[0]!.id, mimeType: "application/pdf" } });
    await expect(clientReviews.portalList({ ...active, account: { ...client, id: randomUUID() } }, created.project.id)).rejects.toThrow();
    const started = await clientReviews.beginReview(active, itemId, { expectedVersion: 1, reason: "Start client review" });
    expect(started).toMatchObject({ status: ClientReviewItemStatus.IN_REVIEW, version: 2 });
    await clientReviews.decide(active, itemId, { kind: ClientItemDecisionKind.REVISION_REQUIRED, expectedVersion: 2, comment: "Please correct the entrance dimensions", reason: "Request a documented client correction" });
    expect(await prisma.revisionApprovalFact.findUnique({ where: { revisionId_kind: { revisionId: drawing.revisions[0]!.id, kind: RevisionApprovalKind.CLIENT } } })).toBeNull();
    const classification = await clientReviews.classify(owner, itemId, { category: ClientRevisionCategory.PREFERENCE_NEW_REQUIREMENT, expectedVersion: 3, reason: "Classify the requested entrance change" });
    expect(classification.category).toBe("PREFERENCE_NEW_REQUIREMENT");
    const correction = await clientReviews.assignCorrection(owner, itemId, { ownerEmployeeId: manager.id, reason: "Assign the requested drawing correction" });
    await tasks.transition(managerActor, correction.task.id, { toState: "IN_PROGRESS", expectedVersion: correction.task.version, reason: "Start the assigned correction" });
    await tasks.transition(managerActor, correction.task.id, { toState: "COMPLETED", expectedVersion: correction.task.version + 1, reason: "Complete the assigned drawing correction" });
    const currentTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const resumed = await clientReviews.resumeCorrection(owner, itemId, { expectedTaskVersion: currentTask.version, reason: "Resume after completed client correction" });
    expect(resumed.status).toBe("IN_PROGRESS");

    const r1Bytes = Buffer.from("%PDF-1.7\nS14 corrected R1 after client correction\n%%EOF\n", "utf8");
    const r1Hash = createHash("sha256").update(r1Bytes).digest("hex");
    const r1Upload = await documents.startUpload(owner, created.project.id, { folderId: folder.id, fileName: `S14-${suffix.slice(0, 8)}-R1.pdf`, mimeType: "application/pdf", sizeBytes: r1Bytes.byteLength, confidential: false, viewOnly: false, reason: "Upload corrected R1 drawing" });
    await documents.writeChunk(owner, r1Upload.uploadId, 0, r1Bytes, r1Hash);
    const r1File = await documents.finalize(owner, r1Upload.uploadId);
    const drawingVersion = (await prisma.drawingRecord.findUniqueOrThrow({ where: { id: drawing.id }, select: { version: true } })).version;
    await revisions.appendRevision(owner, drawing.id, { fileId: r1File.id, series: "R", expectedVersion: drawingVersion, reason: "Register the corrected R1 revision" });
    const r1 = await prisma.documentRevision.findFirstOrThrow({ where: { drawingId: drawing.id, fileId: r1File.id } });
    const resubmissionTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, select: { version: true } });
    await reviews.submit(submitterActor, task.id, { expectedVersion: resubmissionTask.version, revisionId: r1.id, reason: "Submit corrected R1 for independent internal review" });
    const correctedSubmission = await prisma.reviewSubmission.findFirstOrThrow({ where: { taskId: task.id }, orderBy: { roundNumber: "desc" } });
    const correctedRound = await prisma.reviewRound.findUniqueOrThrow({ where: { submissionId: correctedSubmission.id } });
    await reviews.start(reviewerActor, correctedRound.id, "Review corrected R1 independently");
    await reviews.decision(reviewerActor, correctedRound.id, { kind: "APPROVED", comment: "Corrected R1 meets internal requirements", reason: "Approve corrected R1 internally" });
    expect(await prisma.documentRevision.findUniqueOrThrow({ where: { id: r1.id } })).toMatchObject({ state: "APPROVED", isCurrent: true, sha256: r1Hash });
    const correctedPackage = await clientReviews.createPackage(owner, created.project.id, { title: "Corrected R1 client review", reason: "Publish the internally approved corrected R1", items: [{ taskId: task.id, expectedTaskVersion: (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version, revisionId: r1.id, label: "R1 · Architecture" }] });
    const correctedItemId = correctedPackage.items[0]!.id;
    await expect(clientReviews.resumeCorrection(owner, itemId, { expectedTaskVersion: (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version, reason: "Reject stale correction from an older review item" })).rejects.toThrow();
    await expect(clientReviews.finalOptions(active, published.id, { expectedVersion: 1, signatureName: "Primary Client", consent: true, comment: "Must not approve the rejected R0 package" })).rejects.toThrow();
    await expect(revisions.issue(owner, created.project.id, { revisionIds: [drawing.revisions[0]!.id], recipientAccountIds: [client.id], purpose: "Reject stale R0 issue", reason: "R0 is superseded and lacks final client approval", acknowledgementRequired: true })).rejects.toThrow();
    const correctedReview = await clientReviews.beginReview(active, correctedItemId, { expectedVersion: 1, reason: "Start review of corrected R1" });

    const mockConsumeAndVerify = jest.spyOn(portalIdentity, "verifyApprovalWithinTransaction").mockImplementation(async (tx, currentSession, ceremonyId, _response, binding) => {
      const ceremony = await tx.clientPortalCeremony.findUnique({ where: { id: ceremonyId } });
      if (!ceremony || ceremony.accountId !== currentSession.account.id || ceremony.sessionId !== currentSession.row.id || ceremony.consumedAt || ceremony.expiresAt <= new Date()) throw new UnauthorizedException("Approval verification failed");
      const consumed = await tx.clientPortalCeremony.updateMany({ where: { id: ceremonyId, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
      if (consumed.count !== 1 || canonical(ceremony.binding) !== canonical(binding)) throw new UnauthorizedException("Approval verification failed");
      return { accountId: client.id, credentialId: credential.id };
    });
    try {
      const invalidOptions = await clientReviews.approvalOptions(active, correctedItemId, { expectedVersion: correctedReview.version, signatureName: "Primary Client", consent: true, comment: "Approve corrected R1" });
      await expect(clientReviews.decide(active, correctedItemId, { kind: ClientItemDecisionKind.APPROVED, expectedVersion: correctedReview.version, signatureName: "Primary Client", consent: true, comment: "Changed after step-up", reason: "Reject changed approval binding", ceremonyId: invalidOptions.ceremonyId, response: { id: credential.credentialId } as never })).rejects.toThrow(/Approval verification failed/);
      expect((await prisma.clientPortalCeremony.findUniqueOrThrow({ where: { id: invalidOptions.ceremonyId } })).consumedAt).not.toBeNull();
      expect(await prisma.clientItemDecision.findUnique({ where: { itemId: correctedItemId } })).toBeNull();
      expect((await prisma.clientReviewItem.findUniqueOrThrow({ where: { id: correctedItemId } })).status).toBe(ClientReviewItemStatus.IN_REVIEW);

      const approveOptions = await clientReviews.approvalOptions(active, correctedItemId, { expectedVersion: correctedReview.version, signatureName: "Primary Client", consent: true, comment: "Approve corrected R1" });
      await clientReviews.decide(active, correctedItemId, { kind: ClientItemDecisionKind.APPROVED, expectedVersion: correctedReview.version, signatureName: "Primary Client", consent: true, comment: "Approve corrected R1", reason: "Approve corrected item with current passkey step-up", ceremonyId: approveOptions.ceremonyId, response: { id: credential.credentialId } as never }, "127.0.0.1", "S14 test browser");
      expect(await prisma.revisionApprovalFact.findUnique({ where: { revisionId_kind: { revisionId: drawing.revisions[0]!.id, kind: RevisionApprovalKind.CLIENT } } })).toBeNull();
      expect(await prisma.clientItemDecision.findUniqueOrThrow({ where: { itemId: correctedItemId } })).toMatchObject({ accountId: client.id, kind: ClientItemDecisionKind.APPROVED, signatureName: "Primary Client", consent: true, credentialId: credential.id });
      await expect(prisma.clientItemDecision.update({ where: { itemId: correctedItemId }, data: { comment: "Tampered after approval" } })).rejects.toThrow();
      const approvedTaskBeforeFinal = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      await expect(clientReviews.completeTask(managerActor, task.id, { expectedVersion: approvedTaskBeforeFinal.version, reason: "Reject completion before Primary final approval" })).rejects.toThrow();

      const finalOptions = await clientReviews.finalOptions(active, correctedPackage.id, { expectedVersion: 1, signatureName: "Primary Client", consent: true, comment: "Approve corrected R1 package" });
      await clientReviews.finalApprove(active, correctedPackage.id, { expectedVersion: 1, signatureName: "Primary Client", consent: true, comment: "Approve corrected R1 package", reason: "Primary Client final package approval", ceremonyId: finalOptions.ceremonyId, response: { id: credential.credentialId } as never }, "127.0.0.1", "S14 test browser");
      expect(await prisma.revisionApprovalFact.findUniqueOrThrow({ where: { revisionId_kind: { revisionId: r1.id, kind: RevisionApprovalKind.CLIENT } } })).toMatchObject({ projectId: created.project.id, revisionId: r1.id });
      expect(await prisma.clientFinalApproval.findUniqueOrThrow({ where: { packageId: correctedPackage.id } })).toMatchObject({ accountId: client.id, credentialId: credential.id, signatureName: "Primary Client", consent: true });
      const issued = await revisions.issue(owner, created.project.id, { revisionIds: [r1.id], recipientAccountIds: [client.id], purpose: "S14 exact client issue", reason: "Issue after both exact approvals", acknowledgementRequired: true });
      expect(issued.id).toBeTruthy();
      const handover = await portalFiles.handover(active, created.project.id);
      expect(handover.issues[0]).toMatchObject({ id: issued.id, acknowledgementRequired: true, acknowledgedAt: null, canAcknowledge: true, items: [{ itemId: correctedItemId, revisionId: r1.id, sha256: r1Hash }] });
      const acknowledged = await portalFiles.acknowledge(active, issued.id, { note: "Received the formally issued drawing", reason: "Primary Client acknowledges S14 test delivery" });
      expect(acknowledged.acknowledgedAt).toBeInstanceOf(Date);
      expect((await portalFiles.handover(active, created.project.id)).issues[0]).toMatchObject({ id: issued.id, canAcknowledge: false, acknowledgedAt: acknowledged.acknowledgedAt });
      const taskBeforeCompletion = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      await clientReviews.completeTask(managerActor, task.id, { expectedVersion: taskBeforeCompletion.version, reason: "Complete after retained Primary final approval" });
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("COMPLETED");
      await expect(clientReviews.decide(active, correctedItemId, { kind: ClientItemDecisionKind.APPROVED, expectedVersion: correctedReview.version, signatureName: "Primary Client", consent: true, comment: "Repeat", reason: "Reject repeated immutable item decision", ceremonyId: approveOptions.ceremonyId, response: { id: credential.credentialId } as never })).rejects.toThrow();


      // Prospective generic files and links use the same real approval/signature persistence.
      const routing = new ReviewRoutingService(database, clientReviews, scope);
      for (const kind of ["LINK", "FILE"] as const) {
        const workTask = await tasks.create(owner, { projectId: created.project.id, ownerEmployeeId: submitter.id, title: `Approve ${kind} work`, type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: "BOTH", reason: "Authorize exact work routing" });
        await reviews.assignReviewer(managerActor, workTask.id, { employeeId: reviewer.id, expectedVersion: 1, reason: "Assign independent work reviewer" });
        await tasks.transition(submitterActor, workTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start work with evidence" });
        const submitted = await reviews.submit(submitterActor, workTask.id, { expectedVersion: 3, ...(kind === "LINK" ? { reviewUrl: `https://files.sensestudios.com/approved/${workTask.id}?version=1` } : { fileId: r1File.id }), reason: "Submit exact work evidence" });
        await reviews.start(reviewerActor, submitted.rounds[0]!.id, "Inspect exact submitted evidence");
        await reviews.decision(reviewerActor, submitted.rounds[0]!.id, { kind: "APPROVED", reason: "Approve exact submitted evidence" });
        await routing.runBatch();
        const publishedWork = await prisma.clientReviewItem.findFirstOrThrow({ where: { taskId: workTask.id } });
        expect(publishedWork.workSubmissionId).toBeTruthy();
        const clientWork = (await clientReviews.portalList(active, created.project.id)).packages.flatMap(pack => pack.items).find(item => item.id === publishedWork.id);
        expect(clientWork).toMatchObject({ workEvidence: { kind } });
        if (kind === "FILE") {
          const opened = await portalFiles.stream(active, publishedWork.id, false);
          const content: Buffer[] = []; for await (const chunk of opened.stream) content.push(Buffer.from(chunk));
          expect(Buffer.concat(content)).toEqual(r1Bytes);
        }
        await clientReviews.beginReview(active, publishedWork.id, { expectedVersion: 1, reason: "Start client work review" });
        const binding = { expectedVersion: 2, signatureName: "Primary Client", consent: true as const, comment: `Approve ${kind} work` };
        const step = await clientReviews.approvalOptions(active, publishedWork.id, binding);
        await clientReviews.decide(active, publishedWork.id, { ...binding, kind: "APPROVED", ceremonyId: step.ceremonyId, response: { id: credential.credentialId } as never, reason: "Approve exact work item" });
        expect((await reviews.confirmedDrawings(owner, created.project.id)).items.some(item => item.taskId === workTask.id)).toBe(false);
        const finalBinding = { expectedVersion: 1, signatureName: "Primary Client", consent: true as const, comment: `Finally approve ${kind} work` };
        const finalStep = await clientReviews.finalOptions(active, publishedWork.packageId, finalBinding);
        await clientReviews.finalApprove(active, publishedWork.packageId, { ...finalBinding, ceremonyId: finalStep.ceremonyId, response: { id: credential.credentialId } as never, reason: "Primary Client final work approval" });
        const confirmedWork = (await reviews.confirmedDrawings(owner, created.project.id)).items.filter(item => item.taskId === workTask.id);
        expect(confirmedWork).toHaveLength(1);
        expect(confirmedWork[0]).toMatchObject({ kind, ...(kind === "LINK" ? { url: `https://files.sensestudios.com/approved/${workTask.id}?version=1`, fileId: null } : { fileId: r1File.id, url: null }) });
        await routing.retry(owner, workTask.id);
        expect((await reviews.confirmedDrawings(owner, created.project.id)).items.filter(item => item.taskId === workTask.id)).toHaveLength(1);
        await clientReviews.completeTask(managerActor, workTask.id, { expectedVersion: (await prisma.task.findUniqueOrThrow({ where: { id: workTask.id } })).version, reason: "Complete finally approved work" });
      }
      const currentGrant = await prisma.clientPortalGrant.findUniqueOrThrow({ where: { id: primaryGrant.grant.id } });
      const currentProjectVersion = (await prisma.project.findUniqueOrThrow({ where: { id: created.project.id }, select: { version: true } })).version;
      await tasks.cancelProject(owner, created.project.id, { expectedVersion: currentProjectVersion, reason: "Cancel after issued client handover", clientAccessEndTimes: [{ grantId: currentGrant.id, expectedVersion: currentGrant.version, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }] });
      const cancelledList = await clientReviews.portalList(active, created.project.id);
      expect(cancelledList.project.status).toBe("CANCELLED");
      expect(cancelledList.packages).toHaveLength(1);
      expect(cancelledList.packages[0]).toMatchObject({ id: correctedPackage.id, status: "APPROVED", items: [{ id: correctedItemId, permissions: { view: true, comment: false, review: false, approve: false, download: true }, revision: { id: r1.id, state: "ISSUED" } }] });
      expect(cancelledList.ownApprovalHistory.itemDecisions.map((row) => row.itemId)).toEqual(expect.arrayContaining([itemId, correctedItemId]));
      expect(cancelledList.ownApprovalHistory.finalApprovals.map((row) => row.packageId)).toContain(correctedPackage.id);
      const cancelledItem = cancelledList.packages[0]!.items[0] as Record<string, unknown>;
      expect(cancelledItem).not.toHaveProperty("task");
      expect(cancelledItem).not.toHaveProperty("comments");
      expect(cancelledItem.revision).not.toHaveProperty("sha256");
      const stream = await portalFiles.stream(active, correctedItemId, false);
      const streamChunks: Buffer[] = [];
      for await (const chunk of stream.stream) streamChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      expect(Buffer.concat(streamChunks)).toEqual(r1Bytes);
      await expect(clientReviews.comment(active, correctedItemId, { text: "New comment after cancellation", reason: "Reject post-cancellation comment" })).rejects.toThrow();
      await expect(portalFiles.acknowledge(active, issued.id, { note: "Late acknowledgement", reason: "Reject post-cancellation acknowledgement" })).rejects.toThrow();
    } finally {
      mockConsumeAndVerify.mockRestore();
      void primaryGrant;
    }
  });
});
