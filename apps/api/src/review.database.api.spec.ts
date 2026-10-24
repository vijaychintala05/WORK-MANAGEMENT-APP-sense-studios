import { recordProjectEvent } from "./project-events.js";
import { ReviewRoutingService } from "./review-routing.service.js";
import { ClientReviewService } from "./client-review.service.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { ClientPortalAccessService } from "./client-portal-access.service.js";
import { ClientPortalIdentityService } from "./client-portal-identity.service.js";
import { BrevoEmailAdapter } from "./brevo-email.js";
import "reflect-metadata";
import { jest } from "@jest/globals";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountKind, DocumentResourceKind, PermissionEffect, PermissionScopeKind, TaskReviewRequirement, TaskStatus } from "./generated/prisma/client.js";
import { AuthorizationService } from "./authorization.service.js";
import { DatabaseService } from "./database.service.js";
import { DocumentService } from "./document.service.js";
import { ProjectService } from "./project.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { ReviewService } from "./review.service.js";
import { IdentityService } from "./identity.service.js";
import { OrganizationService } from "./organization.service.js";
import { NotificationsService } from "./notifications.service.js";
import { RevisionService } from "./revision.service.js";
import { TaskService } from "./task.service.js";
import { ApprovalService } from "./approval.service.js";
import type { ProjectActor } from "./project.service.js";
import type { RuntimeConfig } from "./config.js";

const databaseUrl = process.env.S13_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

type Fixture = {
  database: DatabaseService;
  organizationId: string;
  projectId: string;
  owner: ProjectActor;
  manager: ProjectActor;
  submitter: ProjectActor;
  reviewer: ProjectActor;
  correctionOwner: ProjectActor;
  exitingCorrectionSubmitter: ProjectActor;
  exitingApprovedSubmitter: ProjectActor;
  exitingEditedSubmitter: ProjectActor;
  employeeIds: { manager: string; submitter: string; reviewer: string; correctionOwner: string; exitingCorrectionSubmitter: string; exitingApprovedSubmitter: string; exitingEditedSubmitter: string };
  reviewerDecideGrantId: string;
  projects: ProjectService;
  workflows: ProjectWorkflowService;
  tasks: TaskService;
  documents: DocumentService;
  revisions: RevisionService;
  reviews: ReviewService;
  organization: OrganizationService;
  upload(name: string, content: string, confidential?: boolean): Promise<{ id: string; sha256: string }>;
};

async function makeFixture(database: DatabaseService, nasRoot: string): Promise<Fixture> {
  const prisma = database.prisma;
  const suffix = randomUUID();
  const organization = await prisma.organization.findFirst() ?? await prisma.organization.create({ data: { name: `S13 review org ${suffix}` } });
  const branch = await prisma.branch.create({ data: { organizationId: organization.id, name: `S13 review branch ${suffix}` } });
  const team = await prisma.team.create({ data: { organizationId: organization.id, branchId: branch.id, name: `S13 review team ${suffix}` } });
  const ownerAccount = await prisma.account.findFirst({ where: { kind: AccountKind.OWNER, state: "ACTIVE" } }) ?? await prisma.account.create({ data: { normalizedEmail: `s13-owner-${suffix}@example.test`, kind: AccountKind.OWNER, state: "ACTIVE" } });
  const people = await Promise.all(["manager", "submitter", "reviewer", "correction", "exit-corrections", "exit-approved", "exit-edited"].map(async (label) => {
    const account = await prisma.account.create({ data: { normalizedEmail: `s13-${label}-${suffix}@example.test`, kind: AccountKind.STAFF, state: "ACTIVE" } });
    const employee = await prisma.employee.create({ data: { organizationId: organization.id, accountId: account.id, homeBranchId: branch.id, homeTeamId: team.id, hiredAt: new Date("2026-01-01T00:00:00Z") } });
    return { label, account, employee };
  }));
  const byLabel = Object.fromEntries(people.map((person) => [person.label, person])) as Record<string, typeof people[number]>;
  let reviewerDecideGrantId = "";
  for (const person of people) {
    const permissions = ["project.view", "document.view", ...(person.label === "manager" ? ["project.manage", "task.assign"] : []), ...(person.label === "reviewer" ? ["review.decide"] : [])];
    for (const permissionKey of permissions) {
      const grant = await prisma.employeePermissionOverride.create({ data: { organizationId: organization.id, employeeId: person.employee.id, permissionKey, effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: branch.id, reason: "S13 database acceptance grant" } });
      if (person.label === "reviewer" && permissionKey === "review.decide") reviewerDecideGrantId = grant.id;
    }
  }

  const config: RuntimeConfig = { nodeEnv: "test", port: 4000, databaseUrl: databaseUrl!, webOrigin: "http://localhost:5173", ownerBootstrapEmail: undefined, ownerBootstrapSecret: undefined, nasRoot };
  const authorization = new AuthorizationService(database);
  const projects = new ProjectService(database);
  const workflows = new ProjectWorkflowService(database, authorization, new ApprovalService(database));
  const tasks = new TaskService(database, authorization);
  const documents = new DocumentService(database, authorization, config);
  const revisions = new RevisionService(database, authorization, documents);
  const notifications = new NotificationsService(database);
  const reviews = new ReviewService(database, authorization, documents, revisions, notifications);
  const identity = new IdentityService(database, config);
  const organizationService = new OrganizationService(database, identity, authorization, workflows, tasks, notifications);
  const owner: ProjectActor = { accountId: ownerAccount.id, organizationId: organization.id, kind: AccountKind.OWNER };
  const manager: ProjectActor = { accountId: byLabel.manager.account.id, organizationId: organization.id, kind: AccountKind.STAFF };
  const submitter: ProjectActor = { accountId: byLabel.submitter.account.id, organizationId: organization.id, kind: AccountKind.STAFF };
  const reviewer: ProjectActor = { accountId: byLabel.reviewer.account.id, organizationId: organization.id, kind: AccountKind.STAFF };
  const correctionOwner: ProjectActor = { accountId: byLabel.correction.account.id, organizationId: organization.id, kind: AccountKind.STAFF };
  const exitingCorrectionSubmitter: ProjectActor = { accountId: byLabel["exit-corrections"].account.id, organizationId: organization.id, kind: AccountKind.STAFF };
  const exitingApprovedSubmitter: ProjectActor = { accountId: byLabel["exit-approved"].account.id, organizationId: organization.id, kind: AccountKind.STAFF };
  const exitingEditedSubmitter: ProjectActor = { accountId: byLabel["exit-edited"].account.id, organizationId: organization.id, kind: AccountKind.STAFF };
  const created = await projects.create(owner, { branchId: branch.id, title: `S13 review project ${suffix}`, deliveryType: "DESIGN", scopes: ["Architecture"], reason: "Create S13 review acceptance project" });
  for (const person of people) {
    const current = await prisma.project.findUniqueOrThrow({ where: { id: created.project.id }, select: { version: true } });
    await workflows.assignment(owner, created.project.id, { employeeId: person.employee.id, expectedVersion: current.version, reason: `Assign S13 ${person.label}` });
  }
  let current = await prisma.project.findUniqueOrThrow({ where: { id: created.project.id }, select: { version: true } });
  await workflows.lead(owner, created.project.id, { employeeId: byLabel.manager.employee.id, expectedVersion: current.version, reason: "Set assigned manager as Project Lead" });
  current = await prisma.project.findUniqueOrThrow({ where: { id: created.project.id }, select: { version: true } });
  await workflows.status(owner, created.project.id, { toStatus: "ACTIVE", expectedVersion: current.version, reason: "Activate S13 review acceptance project" });
  const folder = await documents.createFolder(owner, created.project.id, { name: "Review acceptance evidence", confidential: false, reason: "Create S13 evidence folder" });
  const upload = async (name: string, content: string, confidential = false) => {
    const bytes = Buffer.from(content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const started = await documents.startUpload(owner, created.project.id, { folderId: folder.id, fileName: `${name}-${randomUUID()}.pdf`, mimeType: "application/pdf", sizeBytes: bytes.byteLength, confidential, viewOnly: false, reason: `Upload S13 evidence ${name}` });
    await documents.writeChunk(owner, started.uploadId, 0, bytes, sha256);
    const file = await documents.finalize(owner, started.uploadId);
    return { id: file.id, sha256 };
  };
  return { database, organizationId: organization.id, projectId: created.project.id, owner, manager, submitter, reviewer, correctionOwner, exitingCorrectionSubmitter, exitingApprovedSubmitter, exitingEditedSubmitter, employeeIds: { manager: byLabel.manager.employee.id, submitter: byLabel.submitter.employee.id, reviewer: byLabel.reviewer.employee.id, correctionOwner: byLabel.correction.employee.id, exitingCorrectionSubmitter: byLabel["exit-corrections"].employee.id, exitingApprovedSubmitter: byLabel["exit-approved"].employee.id, exitingEditedSubmitter: byLabel["exit-edited"].employee.id }, reviewerDecideGrantId, projects, workflows, tasks, documents, revisions, reviews, organization: organizationService, upload };
}

databaseDescribe("S13 review workflow PostgreSQL acceptance", () => {
  let database: DatabaseService;
  let nasRoot: string;

  beforeAll(async () => {
    nasRoot = await mkdtemp(join(tmpdir(), "sense-s13-review-files-"));
    database = new DatabaseService({ nodeEnv: "test", port: 4000, databaseUrl: databaseUrl!, webOrigin: "http://localhost:5173", ownerBootstrapEmail: undefined, ownerBootstrapSecret: undefined, nasRoot });
    const rows = await database.prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (!/_test$/i.test(rows[0]?.name ?? "")) throw new Error("S13 checks require a dedicated database ending in _test");
  });

  afterAll(async () => { await database?.onModuleDestroy(); });

  it("reviews an exact CR revision internally while preserving reuse, drawing, and client-issue gates", async () => {
    const fixture = await makeFixture(database, nasRoot);
    const category = await fixture.reviews.createCategory(fixture.owner, { name: `CR review ${randomUUID().slice(0, 8)}`, reason: "Configure CR review regression category" });
    const initialFile = await fixture.upload("cr-initial-r0", "%PDF-1.7\nInitial drawing content\n%%EOF\n");
    const drawing = await fixture.revisions.createDrawing(fixture.owner, fixture.projectId, { documentNumber: `CR-${randomUUID().slice(0, 8)}`, title: "Client review drawing", fileId: initialFile.id, reason: "Register initial drawing for CR review" });
    const otherFile = await fixture.upload("cr-other-r0", "%PDF-1.7\nDifferent drawing content\n%%EOF\n");
    const otherDrawing = await fixture.revisions.createDrawing(fixture.owner, fixture.projectId, { documentNumber: `CRX-${randomUUID().slice(0, 8)}`, title: "Other drawing", fileId: otherFile.id, reason: "Register second drawing for cross-drawing rejection" });
    const task = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Review CR exact revision", type: "PROJECT", priority: "HIGH", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create CR review acceptance task" });
    await fixture.reviews.assignReviewer(fixture.manager, task.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign independent CR reviewer" });
    await fixture.tasks.transition(fixture.submitter, task.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start CR review task" });
    let taskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version;
    const first = await fixture.reviews.submit(fixture.submitter, task.id, { expectedVersion: taskVersion, revisionId: drawing.revisions[0]!.id, reason: "Submit initial R0 before client review" });
    const firstRoundId = first.rounds[0]!.id;
    await fixture.reviews.start(fixture.reviewer, firstRoundId, "Start review before CR resubmission");
    await fixture.reviews.decision(fixture.reviewer, firstRoundId, { kind: "CORRECTIONS_REQUIRED", severity: "MAJOR", categoryId: category.id, comment: "Revise for client review", reason: "Require a CR drawing revision" });
    const correction = await fixture.reviews.assignCorrection(fixture.manager, firstRoundId, { ownerEmployeeId: fixture.employeeIds.correctionOwner, reason: "Assign work required before CR resubmission" });
    const correctionTaskId = correction.rounds[0]!.correctionTaskId!;
    await fixture.tasks.transition(fixture.correctionOwner, correctionTaskId, { toState: "IN_PROGRESS", expectedVersion: 1, reason: "Start CR preparation correction" });
    await fixture.tasks.transition(fixture.correctionOwner, correctionTaskId, { toState: "COMPLETED", expectedVersion: 2, reason: "Complete CR preparation correction" });

    const wrongDrawingFile = await fixture.upload("cr-cross-drawing", "%PDF-1.7\nCR for a different drawing\n%%EOF\n");
    const wrongDrawingRecord = await database.prisma.drawingRecord.findUniqueOrThrow({ where: { id: otherDrawing.id } });
    const wrongDrawingAppend = await fixture.revisions.appendRevision(fixture.owner, otherDrawing.id, { fileId: wrongDrawingFile.id, series: "CR", expectedVersion: wrongDrawingRecord.version, reason: "Append CR revision on separate drawing" });
    const wrongDrawingCr = wrongDrawingAppend.revisions.find((revision) => revision.label === "CR1")!;
    taskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version;
    await expect(fixture.reviews.submit(fixture.submitter, task.id, { expectedVersion: taskVersion, revisionId: wrongDrawingCr.id, reason: "Reject a CR revision belonging to another drawing" })).rejects.toThrow(/same drawing/);
    expect((await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("CORRECTIONS_REQUIRED");
    expect(await database.prisma.reviewSubmission.count({ where: { taskId: task.id } })).toBe(1);

    const crFile = await fixture.upload("cr-exact-file", "%PDF-1.7\nDistinct exact CR drawing content\n%%EOF\n");
    expect(crFile.sha256).not.toBe(initialFile.sha256);
    const currentDrawing = await database.prisma.drawingRecord.findUniqueOrThrow({ where: { id: drawing.id } });
    const appended = await fixture.revisions.appendRevision(fixture.owner, drawing.id, { fileId: crFile.id, series: "CR", expectedVersion: currentDrawing.version, reason: "Append exact client review CR revision" });
    const crRevision = appended.revisions.find((revision) => revision.label === "CR1")!;
    const detail = await fixture.reviews.detail(fixture.submitter, task.id);
    expect(detail.availableRevisions).toContainEqual({ id: crRevision.id, label: "CR1", state: "WORKING" });
    taskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version;
    const resubmitted = await fixture.reviews.submit(fixture.submitter, task.id, { expectedVersion: taskVersion, revisionId: crRevision.id, reason: "Submit exact CR1 for independent internal review" });
    const round = resubmitted.rounds.find((item) => item.revisionId === crRevision.id)!;
    expect(round).toMatchObject({ revisionFileId: crFile.id, revisionFileMimeType: "application/pdf" });
    expect(round.revisionFileName).toBeTruthy();
    await expect(fixture.reviews.inbox(fixture.owner, 0, 50, true)).resolves.toMatchObject({ total: 0, items: [] });
    await expect(fixture.reviews.inbox(fixture.submitter, 0, 50, true)).resolves.toMatchObject({ total: 0, items: [] });
    const inbox = await fixture.reviews.inbox(fixture.reviewer, 0, 1, true);
    expect(inbox.total).toBeGreaterThanOrEqual(1);
    expect(inbox.items).toHaveLength(1);
    const beyond = await fixture.reviews.inbox(fixture.reviewer, inbox.total, 1, true);
    expect(beyond.total).toBe(inbox.total);
    expect(beyond.items).toEqual([]);
    expect(round).toMatchObject({ revisionId: crRevision.id, revisionLabel: "CR1", status: "SUBMITTED" });
    const exactSubmission = await database.prisma.reviewSubmission.findUniqueOrThrow({ where: { id: (await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: round.id } })).submissionId } });
    expect(exactSubmission.taskSnapshot).toMatchObject({ revisionId: crRevision.id, sha256: crFile.sha256 });
    expect(await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: crRevision.id } })).toMatchObject({ fileId: crFile.id, sha256: crFile.sha256, state: "SUBMITTED" });

    await fixture.reviews.start(fixture.reviewer, round.id, "Start exact CR1 internal review");
    const approved = await fixture.reviews.decision(fixture.reviewer, round.id, { kind: "APPROVED", comment: "CR1 passes internal review", reason: "Approve exact CR1 internally" });
    expect(approved.rounds.find((item) => item.id === round.id)).toMatchObject({ status: "APPROVED", revisionId: crRevision.id, revisionLabel: "CR1" });
    const history = await fixture.reviews.inbox(fixture.reviewer, 0, 50, false, { historical: true, projectId: fixture.projectId });
    expect(history.items.map(item => item.roundId)).toContain(round.id);
    expect((await fixture.reviews.inbox(fixture.reviewer)).items.map(item => item.roundId)).not.toContain(round.id);
    await expect(fixture.reviews.inbox(fixture.reviewer, 0, 50, false, { historical: true, projectId: randomUUID() })).resolves.toMatchObject({ total: 0, items: [] });
    expect(await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: crRevision.id } })).toMatchObject({ fileId: crFile.id, sha256: crFile.sha256, state: "APPROVED", isCurrent: true });
    expect(await database.prisma.revisionApprovalFact.findMany({ where: { revisionId: crRevision.id } })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "INTERNAL" })]));
    await expect(fixture.revisions.issue(fixture.owner, fixture.projectId, { revisionIds: [crRevision.id], recipientAccountIds: [fixture.owner.accountId], purpose: "Client review delivery", reason: "Check mandatory client approval gate for CR", acknowledgementRequired: false })).rejects.toThrow(/client approval/i);

    const reuseTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Reject reuse of approved CR", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create CR reuse rejection task" });
    await fixture.reviews.assignReviewer(fixture.manager, reuseTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer for CR reuse rejection" });
    await fixture.tasks.transition(fixture.submitter, reuseTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start CR reuse rejection task" });
    taskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: reuseTask.id } })).version;
    await expect(fixture.reviews.submit(fixture.submitter, reuseTask.id, { expectedVersion: taskVersion, revisionId: crRevision.id, reason: "Reject reuse of the approved CR1 revision" })).rejects.toThrow(/Working R or CR/);
    expect(await database.prisma.reviewSubmission.count({ where: { taskId: reuseTask.id } })).toBe(0);
  });

  it("assigns a pending correction after submitter exit and denies stale rounds", async () => {
    const fixture = await makeFixture(database, nasRoot);
    const category = await fixture.reviews.createCategory(fixture.owner, { name: `Exit issue ${randomUUID().slice(0, 8)}`, reason: "Configure pending exit correction category" });
    const task = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.exitingCorrectionSubmitter, title: "Assign correction after submitting owner exits", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create pending correction exit regression task" });
    await fixture.reviews.assignReviewer(fixture.manager, task.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign independent exit regression reviewer" });
    await fixture.tasks.transition(fixture.exitingCorrectionSubmitter, task.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start pending correction exit task" });
    const submitted = await fixture.reviews.submit(fixture.exitingCorrectionSubmitter, task.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: 3, reason: "Submit before pending correction owner exit" });
    const roundId = submitted.rounds[0]!.id;
    await fixture.reviews.decision(fixture.reviewer, roundId, { kind: "CORRECTIONS_REQUIRED", severity: "MAJOR", categoryId: category.id, comment: "Correct coordination before resubmission", reason: "Request correction before submitting owner exits" });
    const decision = await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: roundId } });
    await fixture.organization.finalizeEmployeeExit(fixture.owner.accountId, fixture.employeeIds.exitingCorrectionSubmitter, "Finalize exit before correction is assigned");
    await expect(fixture.reviews.assignCorrection(fixture.manager, roundId, { ownerEmployeeId: fixture.employeeIds.correctionOwner, reason: "Attempt correction before reassignment" })).rejects.toThrow(/Only Active projects|Correction is unavailable/);
    const waiting = await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    await fixture.tasks.reassign(fixture.manager, task.id, { newOwnerEmployeeId: fixture.employeeIds.correctionOwner, expectedVersion: waiting.version, reason: "Reassign task with pending correction decision" });
    expect((await fixture.reviews.detail(fixture.manager, task.id)).capabilities.assignCorrection).toBe(true);
    const assigned = await fixture.reviews.assignCorrection(fixture.manager, roundId, { ownerEmployeeId: fixture.employeeIds.correctionOwner, reason: "Assign latest pending correction after owner exit" });
    const correctionId = assigned.rounds[0]!.correctionTaskId!;
    expect(await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: roundId } })).toMatchObject({ status: decision.status, decidedAt: decision.decidedAt, decidedById: decision.decidedById, decisionComment: decision.decisionComment, severity: decision.severity, categoryId: decision.categoryId, correctionTaskId: correctionId });
    await fixture.tasks.transition(fixture.correctionOwner, correctionId, { toState: "IN_PROGRESS", expectedVersion: 1, reason: "Start correction assigned after exit" });
    await fixture.tasks.transition(fixture.correctionOwner, correctionId, { toState: "COMPLETED", expectedVersion: 2, reason: "Complete correction assigned after exit" });
    const replacement = await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const revised = await fixture.reviews.submit(fixture.correctionOwner, task.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: replacement.version, reason: "Resubmit corrected work after exit recovery" });
    const latestId = revised.rounds.at(-1)!.id;
    await fixture.reviews.decision(fixture.reviewer, latestId, { kind: "CORRECTIONS_REQUIRED", severity: "MINOR", categoryId: category.id, comment: "Resolve final correction", reason: "Request second round correction" });
    await expect(fixture.reviews.assignCorrection(fixture.manager, roundId, { ownerEmployeeId: fixture.employeeIds.correctionOwner, reason: "Attempt assignment against stale correction round" })).rejects.toThrow(/Correction is unavailable/);
    await fixture.reviews.assignCorrection(fixture.manager, latestId, { ownerEmployeeId: fixture.employeeIds.correctionOwner, reason: "Assign current second round correction" });
    expect(await database.prisma.reviewRound.count({ where: { taskId: task.id } })).toBe(2);
  });

  it("persists Owner category, independent approval, task completion, correction and an exact revised R round", async () => {
    const fixture = await makeFixture(database, nasRoot);
    const category = await fixture.reviews.createCategory(fixture.owner, { name: `S13 issue ${randomUUID().slice(0, 8)}`, reason: "Create a configurable correction category" });

    const approvalTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Approve design package", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create task requiring internal approval" });
    await fixture.reviews.assignReviewer(fixture.manager, approvalTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign authorized independent reviewer" });
    await fixture.tasks.transition(fixture.submitter, approvalTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start assigned design task" });
    let approvalTaskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: approvalTask.id } })).version;
    const approvalSubmission = await fixture.reviews.submit(fixture.submitter, approvalTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: approvalTaskVersion, reason: "Submit design work for internal review" });
    const approvalRoundId = approvalSubmission.rounds[0]!.id;
    const countsBeforeSelfDecision = {
      audits: await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } }),
      events: await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } }),
      comments: await database.prisma.reviewComment.count({ where: { roundId: approvalRoundId } })
    };
    await expect(fixture.reviews.decision(fixture.submitter, approvalRoundId, { kind: "APPROVED", comment: "Attempt self-review", reason: "Attempt to approve own submission" })).rejects.toThrow(/assigned independent reviewer/);
    expect(await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(countsBeforeSelfDecision.audits);
    expect(await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(countsBeforeSelfDecision.events);
    expect(await database.prisma.reviewComment.count({ where: { roundId: approvalRoundId } })).toBe(countsBeforeSelfDecision.comments);
    const foreignProject = await fixture.projects.create(fixture.owner, { branchId: (await database.prisma.project.findUniqueOrThrow({ where: { id: fixture.projectId } })).branchId, title: `S13 restricted project ${randomUUID()}`, deliveryType: "DESIGN", scopes: ["Architecture"], reason: "Create project for foreign-scope ID checks" });
    const foreignProjectVersion = (await database.prisma.project.findUniqueOrThrow({ where: { id: foreignProject.project.id } })).version;
    await fixture.workflows.assignment(fixture.owner, foreignProject.project.id, { employeeId: fixture.employeeIds.correctionOwner, expectedVersion: foreignProjectVersion, reason: "Assign correction owner only to restricted project" });
    const foreignTask = await fixture.tasks.create(fixture.owner, { projectId: foreignProject.project.id, ownerEmployeeId: fixture.employeeIds.correctionOwner, title: "Restricted project task", type: "PROJECT", priority: "LOW", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create task in a project unavailable to submitter" });
    await expect(fixture.reviews.detail(fixture.submitter, foreignTask.id)).rejects.toThrow(/Permission denied/);
    await expect(fixture.reviews.submit(fixture.submitter, foreignTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: 1, reason: "Attempt to submit another project task" })).rejects.toThrow(/Permission denied/);

    await fixture.reviews.start(fixture.reviewer, approvalRoundId, "Begin the assigned independent review");
    const approved = await fixture.reviews.decision(fixture.reviewer, approvalRoundId, { kind: "APPROVED", comment: "Design package meets requirements", reason: "Approve exact submitted work" });
    expect(approved.rounds[0]).toMatchObject({ status: "APPROVED", decision: { kind: "APPROVED" } });
    approvalTaskVersion = approved.task.version;
    const approvedTaskBeforeEdit = await database.prisma.task.findUniqueOrThrow({ where: { id: approvalTask.id } });
    await expect(fixture.tasks.edit(fixture.submitter, approvalTask.id, {
      expectedVersion: approvalTaskVersion,
      reason: "Attempt to change task after its submitted snapshot was approved",
      title: "Changed design package after approval",
      description: "Altered after approval",
      targetDate: "2027-01-31",
      priority: "CRITICAL",
      checklist: [{ label: "Changed after approval", checked: false }]
    })).rejects.toThrow(/Task cannot be edited in this state/);
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: approvalTask.id } })).toMatchObject({
      title: approvedTaskBeforeEdit.title,
      description: approvedTaskBeforeEdit.description,
      targetDate: approvedTaskBeforeEdit.targetDate,
      priority: approvedTaskBeforeEdit.priority,
      checklist: approvedTaskBeforeEdit.checklist,
      status: TaskStatus.INTERNAL_APPROVED,
      version: approvedTaskBeforeEdit.version
    });
    const completed = await fixture.reviews.complete(fixture.submitter, approvalTask.id, { expectedVersion: approvalTaskVersion, reason: "Complete internally approved task" });
    expect(completed.task.status).toBe(TaskStatus.COMPLETED);

    const reassignedTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Reviewer independence after reassignment", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create reassignment independence task" });
    await fixture.reviews.assignReviewer(fixture.manager, reassignedTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer before reassignment" });
    await fixture.tasks.transition(fixture.submitter, reassignedTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start task before review" });
    const reassignedTaskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: reassignedTask.id } })).version;
    const reassignedSubmission = await fixture.reviews.submit(fixture.submitter, reassignedTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: reassignedTaskVersion, reason: "Submit before reviewer becomes owner" });
    const reassignedRoundId = reassignedSubmission.rounds[0]!.id;
    const beforeOwnershipChange = await database.prisma.reviewSubmission.findFirstOrThrow({ where: { taskId: reassignedTask.id } });
    expect(beforeOwnershipChange.submittedById).toBe(fixture.submitter.accountId);
    expect((beforeOwnershipChange.taskSnapshot as { ownerEmployeeId: string }).ownerEmployeeId).toBe(fixture.employeeIds.submitter);
    const beforeReassign = await database.prisma.task.findUniqueOrThrow({ where: { id: reassignedTask.id } });
    await fixture.tasks.reassign(fixture.manager, reassignedTask.id, { newOwnerEmployeeId: fixture.employeeIds.reviewer, expectedVersion: beforeReassign.version, reason: "Reassign submitted task to its named reviewer" });
    const afterReassign = await database.prisma.task.findUniqueOrThrow({ where: { id: reassignedTask.id } });
    expect(afterReassign.primaryOwnerEmployeeId).toBe(fixture.employeeIds.reviewer);
    expect(afterReassign.primaryOwnerEmployeeId).not.toBe((beforeOwnershipChange.taskSnapshot as { ownerEmployeeId: string }).ownerEmployeeId);
    const beforeDeniedActions = {
      audits: await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } }),
      events: await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } }),
      comments: await database.prisma.reviewComment.count({ where: { roundId: reassignedRoundId } })
    };
    await expect(fixture.reviews.start(fixture.reviewer, reassignedRoundId, "Attempt review after becoming task owner")).rejects.toThrow(/assigned independent reviewer/);
    await expect(fixture.reviews.comment(fixture.reviewer, reassignedRoundId, { comment: "Attempt comment after becoming task owner", reason: "Attempt reviewer comment after reassignment" })).rejects.toThrow(/assigned independent reviewer/);
    await expect(fixture.reviews.decision(fixture.reviewer, reassignedRoundId, { kind: "APPROVED", comment: "Attempt decision after becoming task owner", reason: "Attempt reviewer decision after reassignment" })).rejects.toThrow(/assigned independent reviewer/);
    expect(await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(beforeDeniedActions.audits);
    expect(await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(beforeDeniedActions.events);
    expect(await database.prisma.reviewComment.count({ where: { roundId: reassignedRoundId } })).toBe(beforeDeniedActions.comments);
    expect((await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: reassignedRoundId } })).status).toBe("SUBMITTED");

    const firstFile = await fixture.upload("correction-r0", "%PDF-1.7\nS13 first drawing submission\n%%EOF\n");
    const drawing = await fixture.revisions.createDrawing(fixture.owner, fixture.projectId, { documentNumber: `S13-${randomUUID().slice(0, 8)}`, title: "Correction loop drawing", fileId: firstFile.id, reason: "Register initial exact R revision" });
    const correctionTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Revise drawing dimensions", type: "PROJECT", priority: "HIGH", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create drawing task requiring internal review" });
    await fixture.reviews.assignReviewer(fixture.manager, correctionTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer for drawing task" });
    await fixture.tasks.transition(fixture.submitter, correctionTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start drawing task" });
    let correctionTaskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: correctionTask.id } })).version;
    let correctionSubmission = await fixture.reviews.submit(fixture.submitter, correctionTask.id, { expectedVersion: correctionTaskVersion, revisionId: drawing.revisions[0]!.id, reason: "Submit exact R0 drawing for internal review" });
    const firstRoundId = correctionSubmission.rounds[0]!.id;
    await fixture.reviews.start(fixture.reviewer, firstRoundId, "Begin drawing review");
    correctionSubmission = await fixture.reviews.decision(fixture.reviewer, firstRoundId, { kind: "CORRECTIONS_REQUIRED", severity: "MAJOR", categoryId: category.id, comment: "Dimension leader overlaps the wall note", annotations: [{ page: 1, x: 0.42, y: 0.31, text: "Move dimension leader" }], reason: "Request a documented drawing correction" });
    expect(correctionSubmission.rounds[0]).toMatchObject({ status: "CORRECTIONS_REQUIRED", revisionId: drawing.revisions[0]!.id, decision: { severity: "MAJOR", categoryName: category.name } });
    const assignedCorrection = await fixture.reviews.assignCorrection(fixture.manager, firstRoundId, { ownerEmployeeId: fixture.employeeIds.correctionOwner, reason: "Assign the correction to the designated employee" });
    const correctionTaskId = assignedCorrection.rounds[0]!.correctionTaskId!;
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: correctionTaskId } })).toMatchObject({ type: "CORRECTION", primaryOwnerEmployeeId: fixture.employeeIds.correctionOwner, reviewRequirement: "NONE" });
    await fixture.tasks.transition(fixture.correctionOwner, correctionTaskId, { toState: "IN_PROGRESS", expectedVersion: 1, reason: "Start assigned drawing correction" });
    await fixture.tasks.transition(fixture.correctionOwner, correctionTaskId, { toState: "COMPLETED", expectedVersion: 2, reason: "Complete assigned drawing correction" });

    const nextFile = await fixture.upload("correction-r1", "%PDF-1.7\nS13 revised drawing after correction\n%%EOF\n");
    const currentDrawing = await database.prisma.drawingRecord.findUniqueOrThrow({ where: { id: drawing.id } });
    const nextDrawing = await fixture.revisions.appendRevision(fixture.owner, drawing.id, { fileId: nextFile.id, series: "R", expectedVersion: currentDrawing.version, reason: "Append immutable revised R1 drawing" });
    const revised = nextDrawing.revisions.find((revision) => revision.label === "R1")!;
    correctionTaskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: correctionTask.id } })).version;
    const secondSubmission = await fixture.reviews.submit(fixture.submitter, correctionTask.id, { expectedVersion: correctionTaskVersion, revisionId: revised.id, reason: "Resubmit exact revised R1 after correction" });
    const secondRoundId = secondSubmission.rounds.find((round) => round.revisionId === revised.id)!.id;
    await fixture.reviews.start(fixture.reviewer, secondRoundId, "Review the revised R1 drawing");
    const final = await fixture.reviews.decision(fixture.reviewer, secondRoundId, { kind: "APPROVED", comment: "Revised dimension is clear", reason: "Approve the exact revised R1 drawing" });
    expect(final.rounds.map((round) => round.revisionId)).toEqual([drawing.revisions[0]!.id, revised.id]);
    expect(final.rounds.map((round) => round.status)).toEqual(["CORRECTIONS_REQUIRED", "APPROVED"]);
    const r1 = await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: revised.id } });
    expect(r1).toMatchObject({ sha256: nextFile.sha256, state: "APPROVED", isCurrent: true });
    expect(await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: drawing.revisions[0]!.id } })).toMatchObject({ state: "REVIEWED", isCurrent: false });
    expect(await database.prisma.reviewSubmission.findMany({ where: { taskId: correctionTask.id }, orderBy: { roundNumber: "asc" } })).toMatchObject([
      { roundNumber: 1, revisionId: drawing.revisions[0]!.id }, { roundNumber: 2, revisionId: revised.id }
    ]);
    expect(await database.prisma.reviewComment.findFirstOrThrow({ where: { roundId: firstRoundId } })).toMatchObject({ annotations: [{ page: 1, x: 0.42, y: 0.31, text: "Move dimension leader" }] });

    const rollbackTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Rollback assertion task", type: "PROJECT", priority: "LOW", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create rollback assertion task" });
    await fixture.reviews.assignReviewer(fixture.manager, rollbackTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer for rollback assertion" });
    await fixture.tasks.transition(fixture.submitter, rollbackTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start rollback assertion task" });
    const beforeInvalidVersion = { task: await database.prisma.task.findUniqueOrThrow({ where: { id: rollbackTask.id } }), submissions: await database.prisma.reviewSubmission.count({ where: { taskId: rollbackTask.id } }), audit: await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } }), events: await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } }) };
    await expect(fixture.reviews.submit(fixture.submitter, rollbackTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: beforeInvalidVersion.task.version, reason: "x".repeat(1001) })).rejects.toThrow();
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: rollbackTask.id } })).toMatchObject({ status: beforeInvalidVersion.task.status, version: beforeInvalidVersion.task.version });
    expect(await database.prisma.reviewSubmission.count({ where: { taskId: rollbackTask.id } })).toBe(beforeInvalidVersion.submissions);
    expect(await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(beforeInvalidVersion.audit);
    expect(await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(beforeInvalidVersion.events);

    const confidentialFile = await fixture.upload("confidential-review-r0", "%PDF-1.7\nS13 confidential drawing\n%%EOF\n", true);
    const confidentialDrawing = await fixture.revisions.createDrawing(fixture.owner, fixture.projectId, { documentNumber: `S13-C-${randomUUID().slice(0, 8)}`, title: "Confidential review drawing", fileId: confidentialFile.id, reason: "Register Confidential exact R revision" });
    await fixture.documents.grant(fixture.owner, fixture.projectId, { resourceKind: DocumentResourceKind.FILE, resourceId: confidentialFile.id, employeeId: fixture.employeeIds.submitter, reason: "Grant exact Confidential file access to the submitting task owner" });
    const confidentialTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Confidential drawing review", type: "PROJECT", priority: "HIGH", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create Confidential drawing review task" });
    await fixture.reviews.assignReviewer(fixture.manager, confidentialTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer without Confidential file access" });
    await fixture.tasks.transition(fixture.submitter, confidentialTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start Confidential drawing task" });
    const confidentialTaskBefore = await database.prisma.task.findUniqueOrThrow({ where: { id: confidentialTask.id } });
    const confidentialBefore = {
      submissions: await database.prisma.reviewSubmission.count({ where: { taskId: confidentialTask.id } }),
      auditEvents: await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } }),
      domainEvents: await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } }),
      comments: await database.prisma.reviewComment.count({ where: { organizationId: fixture.organizationId } })
    };
    await expect(fixture.reviews.submit(fixture.submitter, confidentialTask.id, { expectedVersion: confidentialTaskBefore.version, revisionId: confidentialDrawing.revisions[0]!.id, reason: "Submit Confidential revision to named reviewer" })).rejects.toThrow(/Confidential file access is not granted/);
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: confidentialTask.id } })).toMatchObject({ status: confidentialTaskBefore.status, version: confidentialTaskBefore.version });
    expect(await database.prisma.reviewSubmission.count({ where: { taskId: confidentialTask.id } })).toBe(confidentialBefore.submissions);
    expect(await database.prisma.reviewRound.count({ where: { taskId: confidentialTask.id } })).toBe(0);
    expect(await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(confidentialBefore.auditEvents);
    expect(await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(confidentialBefore.domainEvents);
    expect(await database.prisma.reviewComment.count({ where: { organizationId: fixture.organizationId } })).toBe(confidentialBefore.comments);

    const escalationTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Escalation and planning authorities", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create review escalation and planning permission task" });
    await fixture.reviews.assignReviewer(fixture.manager, escalationTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer for escalation and planning checks" });
    await fixture.tasks.transition(fixture.submitter, escalationTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start escalation acceptance task" });
    const escalationTaskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: escalationTask.id } })).version;
    const escalationSubmission = await fixture.reviews.submit(fixture.submitter, escalationTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: escalationTaskVersion, reason: "Submit task before escalation and planning checks" });
    const escalationRoundId = escalationSubmission.rounds[0]!.id;
    await fixture.reviews.start(fixture.reviewer, escalationRoundId, "Start open round for escalation" );
    await expect(fixture.reviews.escalate(fixture.manager, escalationRoundId, "Attempt escalation as a nonreviewer")).rejects.toThrow(/assigned independent reviewer/);
    const escalationReason = "Escalate the open round to the assigned Project Lead";
    const auditCountBeforeEscalation = await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } });
    const eventCountBeforeEscalation = await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } });
    const escalation = await fixture.reviews.escalate(fixture.reviewer, escalationRoundId, escalationReason);
    const escalationRow = await database.prisma.reviewEscalation.findFirstOrThrow({ where: { roundId: escalationRoundId } });
    expect(escalationRow).toMatchObject({ actorId: fixture.reviewer.accountId, recipientAccountId: fixture.manager.accountId, reason: escalationReason });
    const escalationEvent = await database.prisma.domainEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId, eventName: "review.escalated", subjectId: escalationRoundId, actorId: fixture.reviewer.accountId } });
    expect((escalationEvent.payload as { auditEventId?: string }).auditEventId).toBeTruthy();
    const escalationAuditId = (escalationEvent.payload as { auditEventId: string }).auditEventId;
    const escalationAudit = await database.prisma.auditEvent.findUniqueOrThrow({ where: { id: escalationAuditId } });
    expect(escalationAudit).toMatchObject({ organizationId: fixture.organizationId, eventKey: "review.escalated", subjectType: "review", subjectId: escalationRoundId, actorId: fixture.reviewer.accountId, reason: escalationReason });
    expect(await database.prisma.notification.findFirstOrThrow({ where: { eventId: escalationEvent.id, recipientAccountId: fixture.manager.accountId } })).toMatchObject({ category: "review.escalated", mandatory: true, internalRoute: `/reviews?taskId=${escalationTask.id}&roundId=${escalationRoundId}` });
    expect(await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(auditCountBeforeEscalation + 1);
    expect(await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(eventCountBeforeEscalation + 1);
    expect(escalation.rounds.find((round) => round.id === escalationRoundId)?.escalations).toHaveLength(1);

    const planningTask = await database.prisma.task.findUniqueOrThrow({ where: { id: escalationTask.id } });
    const auditCountBeforeDeniedPlanning = await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } });
    const eventCountBeforeDeniedPlanning = await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } });
    await expect(fixture.reviews.changePriority(fixture.reviewer, escalationRoundId, { priority: "HIGH", expectedVersion: planningTask.version, reason: "Attempt priority change without planning authority" })).rejects.toThrow(/Permission denied/);
    await expect(fixture.reviews.changeDeadline(fixture.reviewer, escalationRoundId, { committedDueDate: "2026-11-15", expectedVersion: planningTask.version, reason: "Attempt deadline change without planning authority" })).rejects.toThrow(/Permission denied/);
    await expect(fixture.reviews.changePriority(fixture.manager, escalationRoundId, { priority: "HIGH", expectedVersion: planningTask.version, reason: "Attempt priority change as nonreviewer" })).rejects.toThrow(/assigned independent reviewer/);
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: escalationTask.id } })).toMatchObject({ priority: "MEDIUM", committedDueDate: null, version: planningTask.version });
    expect(await database.prisma.taskCommittedDateChange.count({ where: { taskId: escalationTask.id } })).toBe(0);
    expect(await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(auditCountBeforeDeniedPlanning);
    expect(await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(eventCountBeforeDeniedPlanning);

    const projectBranchId = (await database.prisma.project.findUniqueOrThrow({ where: { id: fixture.projectId } })).branchId;
    await database.prisma.employeePermissionOverride.createMany({ data: ["project.manage", "task.assign"].map((permissionKey) => ({ organizationId: fixture.organizationId, employeeId: fixture.employeeIds.reviewer, permissionKey, effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: projectBranchId, reason: "Grant named reviewer project planning authority for S13 acceptance" })) });
    const priorityBefore = await database.prisma.task.findUniqueOrThrow({ where: { id: escalationTask.id } });
    const priorityChanged = await fixture.reviews.changePriority(fixture.reviewer, escalationRoundId, { priority: "HIGH", expectedVersion: priorityBefore.version, reason: "Raise open review task priority with granted planning authority" });
    expect(priorityChanged.task).toMatchObject({ priority: "HIGH", version: priorityBefore.version + 1 });
    const priorityEvent = await database.prisma.domainEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId, eventName: "task.updated", subjectId: escalationTask.id, actorId: fixture.reviewer.accountId }, orderBy: { occurredAt: "desc" } });
    expect(priorityEvent.payload).toMatchObject({ auditEventId: expect.any(String) });
    const priorityAudit = await database.prisma.auditEvent.findUniqueOrThrow({ where: { id: (priorityEvent.payload as { auditEventId: string }).auditEventId } });
    expect(priorityAudit).toMatchObject({ eventKey: "task.updated", subjectId: escalationTask.id, actorId: fixture.reviewer.accountId, reason: "Raise open review task priority with granted planning authority", before: { priority: "MEDIUM", version: priorityBefore.version }, after: { priority: "HIGH", version: priorityBefore.version + 1, reviewRoundId: escalationRoundId } });

    const priorityAfter = await database.prisma.task.findUniqueOrThrow({ where: { id: escalationTask.id } });
    await expect(fixture.reviews.changeDeadline(fixture.reviewer, escalationRoundId, { committedDueDate: "2026-11-15", expectedVersion: priorityAfter.version, reason: "Deadline still requires its separate grant" })).rejects.toThrow(/Permission denied/);
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: escalationTask.id } })).toMatchObject({ priority: "HIGH", committedDueDate: null, version: priorityAfter.version });
    await database.prisma.employeePermissionOverride.create({ data: { organizationId: fixture.organizationId, employeeId: fixture.employeeIds.reviewer, permissionKey: "task.deadline_change", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: projectBranchId, reason: "Grant separate task deadline authority for S13 acceptance" } });
    const deadlineBefore = await database.prisma.task.findUniqueOrThrow({ where: { id: escalationTask.id } });
    const deadlineInput = { committedDueDate: "2026-11-15", expectedVersion: deadlineBefore.version, reason: "Set committed date with separate deadline authority" };
    const deadlineChanged = await fixture.reviews.changeDeadline(fixture.reviewer, escalationRoundId, deadlineInput);
    expect(deadlineChanged.task).toMatchObject({ committedDueDate: "2026-11-15", version: deadlineBefore.version + 1 });
    expect(await database.prisma.taskCommittedDateChange.findFirstOrThrow({ where: { taskId: escalationTask.id } })).toMatchObject({ oldDate: null, newDate: new Date("2026-11-15T00:00:00.000Z"), actorId: fixture.reviewer.accountId, reason: deadlineInput.reason, taskVersion: deadlineBefore.version + 1 });
    const deadlineEvent = await database.prisma.domainEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId, eventName: "task.deadline_changed", subjectId: escalationTask.id, actorId: fixture.reviewer.accountId } });
    expect(deadlineEvent.payload).toMatchObject({ auditEventId: expect.any(String) });
    expect(await database.prisma.auditEvent.findUniqueOrThrow({ where: { id: (deadlineEvent.payload as { auditEventId: string }).auditEventId } })).toMatchObject({ eventKey: "task.deadline_changed", subjectId: escalationTask.id, actorId: fixture.reviewer.accountId, reason: deadlineInput.reason, before: { committedDueDate: null, version: deadlineBefore.version }, after: { committedDueDate: deadlineInput.committedDueDate, version: deadlineBefore.version + 1, reviewRoundId: escalationRoundId } });

    const revokedGrantTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Reviewer grant revocation", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create grant revocation review task" });
    await fixture.reviews.assignReviewer(fixture.manager, revokedGrantTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer before grant revocation" });
    await fixture.tasks.transition(fixture.submitter, revokedGrantTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start task before grant revocation" });
    const revokedGrantTaskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: revokedGrantTask.id } })).version;
    const revokedGrantSubmission = await fixture.reviews.submit(fixture.submitter, revokedGrantTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: revokedGrantTaskVersion, reason: "Submit before reviewer grant revocation" });
    const revokedGrantRoundId = revokedGrantSubmission.rounds[0]!.id;
    await fixture.reviews.start(fixture.reviewer, revokedGrantRoundId, "Start while review.decide grant is active");
    const reviewerGrant = await database.prisma.employeePermissionOverride.findUniqueOrThrow({ where: { id: fixture.reviewerDecideGrantId } });
    expect(reviewerGrant).toMatchObject({ permissionKey: "review.decide", effect: PermissionEffect.ALLOW, revokedAt: null });
    await database.prisma.employeePermissionOverride.update({ where: { id: reviewerGrant.id }, data: { revokedAt: new Date(), revokedById: fixture.owner.accountId, revocationReason: "Revoke review authority during open S13 round" } });
    const beforeRevokedActions = {
      task: await database.prisma.task.findUniqueOrThrow({ where: { id: revokedGrantTask.id } }),
      round: await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: revokedGrantRoundId } }),
      audits: await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } }),
      events: await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } }),
      comments: await database.prisma.reviewComment.count({ where: { roundId: revokedGrantRoundId } })
    };
    await expect(fixture.reviews.comment(fixture.reviewer, revokedGrantRoundId, { comment: "Attempt comment after grant revocation", reason: "Attempt comment with revoked review grant" })).rejects.toThrow(/Permission denied/);
    await expect(fixture.reviews.decision(fixture.reviewer, revokedGrantRoundId, { kind: "APPROVED", comment: "Attempt decision after grant revocation", reason: "Attempt decision with revoked review grant" })).rejects.toThrow(/Permission denied/);
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: revokedGrantTask.id } })).toMatchObject({ status: beforeRevokedActions.task.status, version: beforeRevokedActions.task.version });
    expect(await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: revokedGrantRoundId } })).toMatchObject({ status: beforeRevokedActions.round.status, startedAt: beforeRevokedActions.round.startedAt, decidedAt: beforeRevokedActions.round.decidedAt });
    expect(await database.prisma.reviewComment.count({ where: { roundId: revokedGrantRoundId } })).toBe(beforeRevokedActions.comments);
    expect(await database.prisma.auditEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(beforeRevokedActions.audits);
    expect(await database.prisma.domainEvent.count({ where: { organizationId: fixture.organizationId } })).toBe(beforeRevokedActions.events);

    const currentBranchId = (await database.prisma.project.findUniqueOrThrow({ where: { id: fixture.projectId } })).branchId;
    await database.prisma.employeePermissionOverride.create({ data: { organizationId: fixture.organizationId, employeeId: fixture.employeeIds.reviewer, permissionKey: "review.decide", effect: PermissionEffect.ALLOW, scopeKind: PermissionScopeKind.BRANCH, branchId: currentBranchId, reason: "Restore reviewer authority for isolated employee-exit withdrawal scenario" } });

    const correctionsExitTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.exitingCorrectionSubmitter, title: "Correction recovery after submitter exit", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create corrections exit recovery task" });
    await fixture.reviews.assignReviewer(fixture.manager, correctionsExitTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer for corrections exit recovery" });
    await fixture.tasks.transition(fixture.exitingCorrectionSubmitter, correctionsExitTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start correction recovery work" });
    const correctionsExitTaskVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: correctionsExitTask.id } })).version;
    const correctionsExitSubmission = await fixture.reviews.submit(fixture.exitingCorrectionSubmitter, correctionsExitTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: correctionsExitTaskVersion, reason: "Submit work that will require correction" });
    const correctionsExitRoundId = correctionsExitSubmission.rounds[0]!.id;
    await fixture.reviews.start(fixture.reviewer, correctionsExitRoundId, "Start correction recovery review");
    const correctedExitSubmission = await fixture.reviews.decision(fixture.reviewer, correctionsExitRoundId, { kind: "CORRECTIONS_REQUIRED", severity: "MODERATE", categoryId: category.id, comment: "Clarify the scope note", reason: "Request correction before submitter exit" });
    const oldCorrectionDecision = await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: correctionsExitRoundId } });
    const correctionExitAssignment = await fixture.reviews.assignCorrection(fixture.manager, correctionsExitRoundId, { ownerEmployeeId: fixture.employeeIds.correctionOwner, reason: "Assign correction for exit recovery task" });
    const correctionExitTaskId = correctionExitAssignment.rounds.find((round) => round.id === correctionsExitRoundId)!.correctionTaskId!;
    await fixture.organization.finalizeEmployeeExit(fixture.owner.accountId, fixture.employeeIds.exitingCorrectionSubmitter, "Finalize submitter exit after corrections were requested");
    const correctionsWaiting = await database.prisma.task.findUniqueOrThrow({ where: { id: correctionsExitTask.id } });
    expect(correctionsWaiting).toMatchObject({ status: "WAITING", requiresReassignment: true });
    await fixture.tasks.reassign(fixture.manager, correctionsExitTask.id, { newOwnerEmployeeId: fixture.employeeIds.correctionOwner, expectedVersion: correctionsWaiting.version, reason: "Assign correction-loop task to replacement owner" });
    const correctionTaskState = await database.prisma.task.findUniqueOrThrow({ where: { id: correctionExitTaskId } });
    expect(correctionTaskState.primaryOwnerEmployeeId).toBe(fixture.employeeIds.correctionOwner);
    await fixture.tasks.transition(fixture.correctionOwner, correctionExitTaskId, { toState: "IN_PROGRESS", expectedVersion: correctionTaskState.version, reason: "Begin assigned correction after exit" });
    const correctionInProgress = await database.prisma.task.findUniqueOrThrow({ where: { id: correctionExitTaskId } });
    await fixture.tasks.transition(fixture.correctionOwner, correctionExitTaskId, { toState: "COMPLETED", expectedVersion: correctionInProgress.version, reason: "Complete correction after submitter exit" });
    const correctionsReplacement = await database.prisma.task.findUniqueOrThrow({ where: { id: correctionsExitTask.id } });
    const correctionsExitRoundTwo = await fixture.reviews.submit(fixture.correctionOwner, correctionsExitTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: correctionsReplacement.version, reason: "Replacement owner resubmits after completing correction" });
    expect(correctedExitSubmission.rounds.find((round) => round.id === correctionsExitRoundId)).toMatchObject({ status: "CORRECTIONS_REQUIRED", decision: { kind: "CORRECTIONS_REQUIRED", severity: "MODERATE", categoryName: category.name } });
    expect(await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: correctionsExitRoundId } })).toMatchObject({ status: oldCorrectionDecision.status, decisionComment: oldCorrectionDecision.decisionComment, severity: oldCorrectionDecision.severity, categoryId: oldCorrectionDecision.categoryId });
    expect(correctionsExitRoundTwo.rounds.map((round) => ({ id: round.id, roundNumber: round.roundNumber, status: round.status }))).toEqual([
      { id: correctionsExitRoundId, roundNumber: 1, status: "CORRECTIONS_REQUIRED" },
      { id: expect.any(String), roundNumber: 2, status: "SUBMITTED" }
    ]);

    const approvedExitTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.exitingApprovedSubmitter, title: "Complete approved snapshot after submitter exit", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, checklist: [{ label: "Approved item", checked: true }], reason: "Create approved snapshot exit task" });
    await fixture.reviews.assignReviewer(fixture.manager, approvedExitTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer for approved snapshot exit task" });
    await fixture.tasks.transition(fixture.exitingApprovedSubmitter, approvedExitTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start approved snapshot task" });
    const approvedExitVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: approvedExitTask.id } })).version;
    const approvedExitSubmission = await fixture.reviews.submit(fixture.exitingApprovedSubmitter, approvedExitTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: approvedExitVersion, reason: "Submit exact task snapshot before owner exit" });
    const approvedExitRoundId = approvedExitSubmission.rounds[0]!.id;
    await fixture.reviews.start(fixture.reviewer, approvedExitRoundId, "Review snapshot before owner exit");
    const approvedExitReview = await fixture.reviews.decision(fixture.reviewer, approvedExitRoundId, { kind: "APPROVED", comment: "Submitted task snapshot approved", reason: "Approve exact task snapshot before owner exit" });
    const approvedSnapshot = (await database.prisma.reviewSubmission.findFirstOrThrow({ where: { taskId: approvedExitTask.id } })).taskSnapshot;
    await fixture.organization.finalizeEmployeeExit(fixture.owner.accountId, fixture.employeeIds.exitingApprovedSubmitter, "Finalize submitter exit after internal approval");
    const approvedWaitingTask = await database.prisma.task.findUniqueOrThrow({ where: { id: approvedExitTask.id } });
    expect(approvedWaitingTask).toMatchObject({ status: "WAITING", requiresReassignment: true });
    await fixture.tasks.reassign(fixture.manager, approvedExitTask.id, { newOwnerEmployeeId: fixture.employeeIds.correctionOwner, expectedVersion: approvedWaitingTask.version, reason: "Reassign approved unchanged snapshot after submitter exit" });
    const approvedReassignedTask = await database.prisma.task.findUniqueOrThrow({ where: { id: approvedExitTask.id } });
    expect(approvedReassignedTask).toMatchObject({ status: "IN_PROGRESS", requiresReassignment: false, primaryOwnerEmployeeId: fixture.employeeIds.correctionOwner });
    expect((await database.prisma.reviewSubmission.findFirstOrThrow({ where: { taskId: approvedExitTask.id } })).taskSnapshot).toEqual(approvedSnapshot);
    const completedApprovedExit = await fixture.reviews.complete(fixture.correctionOwner, approvedExitTask.id, { expectedVersion: approvedReassignedTask.version, reason: "Complete unchanged internally approved snapshot after reassignment" });
    expect(approvedExitReview.rounds[0]).toMatchObject({ status: "APPROVED" });
    expect(completedApprovedExit.task.status).toBe("COMPLETED");

    const editedExitTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.exitingEditedSubmitter, title: "Approved snapshot that requires a new review", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, checklist: [{ label: "Original scope", checked: false }], reason: "Create post-approval edit exit task" });
    await fixture.reviews.assignReviewer(fixture.manager, editedExitTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer for edited snapshot recovery task" });
    await fixture.tasks.transition(fixture.exitingEditedSubmitter, editedExitTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start edited snapshot recovery task" });
    const editedExitVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: editedExitTask.id } })).version;
    const editedExitSubmission = await fixture.reviews.submit(fixture.exitingEditedSubmitter, editedExitTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: editedExitVersion, reason: "Submit snapshot that will later be changed" });
    const editedExitRoundId = editedExitSubmission.rounds[0]!.id;
    await fixture.reviews.start(fixture.reviewer, editedExitRoundId, "Review snapshot before edited-owner exit");
    await fixture.reviews.decision(fixture.reviewer, editedExitRoundId, { kind: "APPROVED", comment: "Original scope approved", reason: "Approve original task snapshot before exit" });
    const editedSnapshot = (await database.prisma.reviewSubmission.findFirstOrThrow({ where: { taskId: editedExitTask.id } })).taskSnapshot;
    await fixture.organization.finalizeEmployeeExit(fixture.owner.accountId, fixture.employeeIds.exitingEditedSubmitter, "Finalize submitter exit after approval before scope edit");
    const editedWaitingTask = await database.prisma.task.findUniqueOrThrow({ where: { id: editedExitTask.id } });
    await fixture.tasks.reassign(fixture.manager, editedExitTask.id, { newOwnerEmployeeId: fixture.employeeIds.correctionOwner, expectedVersion: editedWaitingTask.version, reason: "Reassign approved task before replacement scope edit" });
    const editedReassignedTask = await database.prisma.task.findUniqueOrThrow({ where: { id: editedExitTask.id } });
    await fixture.tasks.edit(fixture.correctionOwner, editedExitTask.id, { expectedVersion: editedReassignedTask.version, reason: "Record replacement owner's substantive scope change", title: "Expanded scope after prior approval", description: "New work added after the old submission", targetDate: "2026-12-31", priority: "MEDIUM", checklist: [{ label: "Expanded scope", checked: false }] });
    const changedTask = await database.prisma.task.findUniqueOrThrow({ where: { id: editedExitTask.id } });
    expect((await database.prisma.reviewSubmission.findFirstOrThrow({ where: { taskId: editedExitTask.id } })).taskSnapshot).toEqual(editedSnapshot);
    await expect(fixture.reviews.complete(fixture.correctionOwner, editedExitTask.id, { expectedVersion: changedTask.version, reason: "Attempt completion after approved task scope changed" })).rejects.toThrow(/differs from its approved submission/);
    const replacementReview = await fixture.reviews.submit(fixture.correctionOwner, editedExitTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: changedTask.version, reason: "Submit changed replacement scope for a new review" });
    expect(replacementReview.rounds.map((round) => ({ id: round.id, roundNumber: round.roundNumber, status: round.status }))).toEqual([
      { id: editedExitRoundId, roundNumber: 1, status: "APPROVED" },
      { id: expect.any(String), roundNumber: 2, status: "SUBMITTED" }
    ]);
    expect((await database.prisma.reviewSubmission.findMany({ where: { taskId: editedExitTask.id }, orderBy: { roundNumber: "asc" } })).map((submission) => submission.taskSnapshot)).toEqual([
      editedSnapshot,
      expect.objectContaining({ title: "Expanded scope after prior approval", checklist: [{ label: "Expanded scope", checked: false }] })
    ]);

    const withdrawalTask = await fixture.tasks.create(fixture.owner, { projectId: fixture.projectId, ownerEmployeeId: fixture.employeeIds.submitter, title: "Withdraw interrupted review after owner exit", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: TaskReviewRequirement.INTERNAL, reason: "Create employee exit review withdrawal task" });
    await fixture.reviews.assignReviewer(fixture.manager, withdrawalTask.id, { employeeId: fixture.employeeIds.reviewer, expectedVersion: 1, reason: "Assign reviewer before submitter exit" });
    await fixture.tasks.transition(fixture.submitter, withdrawalTask.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start work before submitter exit" });
    const beforeExitVersion = (await database.prisma.task.findUniqueOrThrow({ where: { id: withdrawalTask.id } })).version;
    const interruptedSubmission = await fixture.reviews.submit(fixture.submitter, withdrawalTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: beforeExitVersion, reason: "Submit before employee exit" });
    const interruptedRoundId = interruptedSubmission.rounds[0]!.id;
    const originalSubmission = await database.prisma.reviewSubmission.findFirstOrThrow({ where: { taskId: withdrawalTask.id } });
    const originalRound = await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: interruptedRoundId } });
    await fixture.organization.finalizeEmployeeExit(fixture.owner.accountId, fixture.employeeIds.submitter, "Finalize submitter exit and require task handover");
    const waitingTask = await database.prisma.task.findUniqueOrThrow({ where: { id: withdrawalTask.id } });
    expect(waitingTask).toMatchObject({ status: "WAITING", requiresReassignment: true, primaryOwnerEmployeeId: fixture.employeeIds.submitter });
    await fixture.tasks.reassign(fixture.manager, withdrawalTask.id, { newOwnerEmployeeId: fixture.employeeIds.correctionOwner, expectedVersion: waitingTask.version, reason: "Reassign interrupted review work after owner exit" });
    const reassignedWithdrawalTask = await database.prisma.task.findUniqueOrThrow({ where: { id: withdrawalTask.id } });
    expect(reassignedWithdrawalTask).toMatchObject({ status: "IN_PROGRESS", requiresReassignment: false, primaryOwnerEmployeeId: fixture.employeeIds.correctionOwner });
    const withdrawalReason = "Withdraw the old round after the submitting employee exited";
    const withdrawn = await fixture.reviews.withdraw(fixture.manager, interruptedRoundId, { reason: withdrawalReason });
    expect(withdrawn.rounds.find((round) => round.id === interruptedRoundId)).toMatchObject({ status: "WITHDRAWN", withdrawal: { reason: withdrawalReason, actorId: fixture.manager.accountId } });
    expect(await database.prisma.reviewSubmission.findUniqueOrThrow({ where: { id: originalSubmission.id } })).toMatchObject({ submittedById: originalSubmission.submittedById, roundNumber: 1, taskVersion: originalSubmission.taskVersion, taskSnapshot: originalSubmission.taskSnapshot });
    expect(await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: interruptedRoundId } })).toMatchObject({ status: "WITHDRAWN", reviewerEmployeeId: originalRound.reviewerEmployeeId, withdrawnById: fixture.manager.accountId, withdrawalReason });
    const withdrawnEvent = await database.prisma.domainEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId, eventName: "review.withdrawn", subjectId: interruptedRoundId, actorId: fixture.manager.accountId } });
    expect(await database.prisma.auditEvent.findUniqueOrThrow({ where: { id: (withdrawnEvent.payload as { auditEventId: string }).auditEventId } })).toMatchObject({ eventKey: "review.withdrawn", subjectId: interruptedRoundId, actorId: fixture.manager.accountId, reason: withdrawalReason });
    const replacementSubmission = await fixture.reviews.submit(fixture.correctionOwner, withdrawalTask.id, { reviewUrl: "https://files.sensestudios.com/review/test-round", expectedVersion: reassignedWithdrawalTask.version, reason: "Submit replacement work after old round withdrawal" });
    expect(replacementSubmission.rounds.map((round) => ({ id: round.id, roundNumber: round.roundNumber, status: round.status }))).toEqual([
      { id: interruptedRoundId, roundNumber: 1, status: "WITHDRAWN" },
      { id: expect.any(String), roundNumber: 2, status: "SUBMITTED" }
    ]);
  });
  it("requires evidence, waits for independent internal approval, blocks missing clients and retries without duplicate publication", async () => {
    const f = await makeFixture(database, nasRoot);
    const authorization = new AuthorizationService(database);
    const scope = new ClientPortalScopeService(database, authorization);
    const config: RuntimeConfig = { nodeEnv: "test", port: 4000, databaseUrl: databaseUrl!, webOrigin: "http://localhost:5173", ownerBootstrapEmail: undefined, ownerBootstrapSecret: undefined, nasRoot, emailVerificationSecret: "routing-test-email-proof-secret" };
    const identity = new ClientPortalIdentityService(database, new BrevoEmailAdapter(config), config);
    const clients = new ClientReviewService(database, scope, identity, f.documents, f.revisions);
    const routing = new ReviewRoutingService(database, clients, scope);
    await expect(f.tasks.create(f.submitter, { projectId: f.projectId, title: "Unauthorized publication", type: "PROJECT", priority: "LOW", targetDate: "2026-12-31", reviewRequirement: "CLIENT", reason: "Must require publisher authority" })).rejects.toThrow();
    const task = await f.tasks.create(f.owner, { projectId: f.projectId, ownerEmployeeId: f.employeeIds.submitter, title: "Review link evidence", type: "PROJECT", priority: "MEDIUM", targetDate: "2026-12-31", reviewRequirement: "CLIENT", reason: "Authorize internal then client review" });
    expect(task.reviewRequirement).toBe("BOTH");
    await f.reviews.assignReviewer(f.manager, task.id, { employeeId: f.employeeIds.reviewer, expectedVersion: 1, reason: "Appoint independent reviewer" });
    await f.tasks.transition(f.submitter, task.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Begin approved review task" });
    await expect(f.reviews.submit(f.submitter, task.id, { expectedVersion: 3, reason: "Reject task text without evidence" })).rejects.toThrow(/file|link/i);
    expect(await database.prisma.reviewSubmission.count({ where: { taskId: task.id } })).toBe(0);
    const internal = await f.reviews.submit(f.submitter, task.id, { expectedVersion: 3, reviewUrl: "https://files.sensestudios.com/review/first-floor?v=1", reason: "Submit exact work link" });
    await routing.runBatch();
    expect(await database.prisma.clientReviewItem.count({ where: { taskId: task.id } })).toBe(0);
    await f.reviews.start(f.reviewer, internal.rounds[0]!.id, "Start independent review");
    await f.reviews.decision(f.reviewer, internal.rounds[0]!.id, { kind: "APPROVED", reason: "Approve exact submitted work" });
    await routing.runBatch();
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "INTERNAL_APPROVED" });
    expect(await database.prisma.taskReviewRoutingAttempt.findFirst({ where: { taskId: task.id } })).toMatchObject({ status: "BLOCKED" });
    const project = await database.prisma.project.findUniqueOrThrow({ where: { id: f.projectId } });
    await new ClientPortalAccessService(database).setPrimary(f.owner, f.projectId, { email: `routing-client-${randomUUID()}@example.test`, expectedProjectVersion: project.version, expectedPrimaryGrantId: null, reason: "Appoint required Primary Client" });
    await Promise.all([routing.retry(f.owner, task.id), routing.retry(f.owner, task.id)]);
    expect(await database.prisma.taskReviewRoutingAttempt.findFirst({ where: { taskId: task.id } })).toMatchObject({ status: "SENT" });
    const items = await database.prisma.clientReviewItem.findMany({ where: { taskId: task.id } });
    expect(items).toHaveLength(1);
    expect(items[0]!.workSubmissionId).toBeTruthy();
    expect(items[0]!.snapshot).toMatchObject({ workEvidence: { kind: "LINK", url: "https://files.sensestudios.com/review/first-floor?v=1" } });
    const audit = await database.prisma.auditEvent.findFirstOrThrow({ where: { subjectId: items[0]!.id, eventKey: "client.review_sent" } });
    expect(JSON.stringify(audit.after)).not.toContain("https://");
    expect((await f.reviews.confirmedDrawings(f.owner, f.projectId)).items).toHaveLength(0);
    await routing.retry(f.owner, task.id);
    expect(await database.prisma.clientReviewItem.count({ where: { taskId: task.id } })).toBe(1);

    const authorizationRow = await database.prisma.taskReviewRoutingAuthorization.findFirstOrThrow({ where: { taskId: task.id, revokedAt: null } });
    await expect(database.prisma.$transaction(async tx => {
      await tx.taskReviewRoutingAuthorization.update({ where: { id: authorizationRow.id }, data: { revokedAt: new Date() } });
      const updated = await tx.task.update({ where: { id: task.id }, data: { version: { increment: 1 } } });
      await recordProjectEvent(tx, { organizationId: f.organizationId, actorId: f.owner.accountId, eventName: "task.updated", subjectType: "task", subjectId: task.id, reason: "Ordinary task edit cannot prove authorization revocation", after: { projectId: f.projectId, version: updated.version } });
    })).rejects.toThrow(/canonical.*publisher|Routing authorization/i);
    expect((await database.prisma.taskReviewRoutingAuthorization.findUniqueOrThrow({ where: { id: authorizationRow.id } })).revokedAt).toBeNull();
    const confidential = await f.documents.createFolder(f.owner, f.projectId, { name: `Confidential ${randomUUID()}`, confidential: true, reason: "Configure restricted folder for evidence test" });
    const child = await f.documents.createFolder(f.owner, f.projectId, { name: `Ordinary child ${randomUUID()}`, parentId: confidential.id, confidential: false, reason: "Ordinary file still inherits Confidential ancestry" });
    for (const employeeId of [f.employeeIds.submitter, f.employeeIds.reviewer]) await f.documents.grant(f.owner, f.projectId, { resourceKind: "FOLDER", resourceId: confidential.id, employeeId, reason: "Allow internal review of restricted evidence" });
    const bytes = Buffer.from("%PDF-1.7\nRestricted internal evidence\n%%EOF\n");
    const upload = await f.documents.startUpload(f.owner, f.projectId, { folderId: child.id, fileName: "restricted.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, confidential: false, viewOnly: false, reason: "Upload ordinary file inside restricted ancestry" });
    await f.documents.writeChunk(f.owner, upload.uploadId, 0, bytes, createHash("sha256").update(bytes).digest("hex"));
    const restrictedFile = await f.documents.finalize(f.owner, upload.uploadId);
    const restricted = await f.tasks.create(f.owner, { projectId: f.projectId, ownerEmployeeId: f.employeeIds.submitter, title: "Internal Confidential evidence", type: "PROJECT", priority: "LOW", targetDate: "2026-12-31", reviewRequirement: "BOTH", reason: "Test Confidential ancestry cannot be published" });
    await f.reviews.assignReviewer(f.manager, restricted.id, { employeeId: f.employeeIds.reviewer, expectedVersion: 1, reason: "Appoint independent confidential reviewer" });
    await f.tasks.transition(f.submitter, restricted.id, { toState: "IN_PROGRESS", expectedVersion: 2, reason: "Start private review work" });
    const restrictedRound = await f.reviews.submit(f.submitter, restricted.id, { expectedVersion: 3, fileId: restrictedFile.id, reason: "Submit file for internal-only access" });
    await f.reviews.start(f.reviewer, restrictedRound.rounds[0]!.id, "Inspect restricted file internally");
    await f.reviews.decision(f.reviewer, restrictedRound.rounds[0]!.id, { kind: "APPROVED", reason: "Approve restricted evidence internally" });
    await routing.runBatch();
    expect(await database.prisma.clientReviewItem.count({ where: { taskId: restricted.id } })).toBe(0);
    expect(await database.prisma.taskReviewRoutingAttempt.findFirst({ where: { taskId: restricted.id } })).toMatchObject({ status: "BLOCKED", blockedReason: expect.stringContaining("EVIDENCE_ACCESS") });
    const guarded = await f.tasks.create(f.owner, { projectId: f.projectId, ownerEmployeeId: f.employeeIds.submitter, title: "Revocation before publication", type: "PROJECT", priority: "LOW", targetDate: "2026-12-31", reviewRequirement: "BOTH", reason: "Configure explicit publication authorization" });
    const configured = await routing.configure(f.manager, guarded.id, { expectedVersion: 1, internal: false, client: true, reason: "Project Lead authorizes client routing" });
    expect(configured.reviewRequirement).toBe("BOTH");
    await f.reviews.assignReviewer(f.manager, guarded.id, { employeeId: f.employeeIds.reviewer, expectedVersion: configured.version, reason: "Appoint independent reviewer for guarded work" });
    const guardedTask = await database.prisma.task.findUniqueOrThrow({ where: { id: guarded.id } });
    await f.tasks.transition(f.submitter, guarded.id, { toState: "IN_PROGRESS", expectedVersion: guardedTask.version, reason: "Start guarded work" });
    const guardedCurrent = await database.prisma.task.findUniqueOrThrow({ where: { id: guarded.id } });
    const guardedInternal = await f.reviews.submit(f.submitter, guarded.id, { expectedVersion: guardedCurrent.version, reviewUrl: "https://files.sensestudios.com/guarded", reason: "Submit guarded work evidence" });
    await f.reviews.start(f.reviewer, guardedInternal.rounds[0]!.id, "Inspect guarded work independently");
    await f.reviews.decision(f.reviewer, guardedInternal.rounds[0]!.id, { kind: "APPROVED", reason: "Approve guarded work independently" });
    await routing.revoke(f.owner, guarded.id, "Owner revokes automatic publication before delivery");
    await routing.runBatch();
    expect(await database.prisma.clientReviewItem.count({ where: { taskId: guarded.id } })).toBe(0);
    expect(await database.prisma.taskReviewRoutingAttempt.findFirst({ where: { taskId: guarded.id } })).toMatchObject({ status: "BLOCKED", blockedReason: expect.stringContaining("AUTHORIZATION_REVOKED") });
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: guarded.id } })).toMatchObject({ status: "INTERNAL_APPROVED" });
    const beforeReauthorization = await database.prisma.task.findUniqueOrThrow({ where: { id: guarded.id } });
    await routing.configure(f.manager, guarded.id, { expectedVersion: beforeReauthorization.version, internal: true, client: true, reason: "Current project lead reauthorizes exact approved work" });
    await routing.runBatch();
    expect(await database.prisma.clientReviewItem.count({ where: { taskId: guarded.id } })).toBe(1);
    expect(await database.prisma.taskReviewRoutingAuthorization.count({ where: { taskId: guarded.id } })).toBe(3);
    expect(await database.prisma.taskReviewRoutingAttempt.count({ where: { taskId: guarded.id, status: "SENT" } })).toBe(1);


  });

});
