import { assertClientEvidenceFile, submittedEvidence, approvedWorkMatches } from "./review-work-evidence.js";
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ClientItemDecisionKind, ClientReviewItemStatus, ClientReviewPackageStatus, ClientRevisionCategory, InternalReviewStatus, Prisma, ProjectStatus, RevisionApprovalKind, RevisionState, TaskReviewRequirement, TaskStatus, TaskType } from "./generated/prisma/client.js";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { DatabaseService } from "./database.service.js";
import { DocumentService } from "./document.service.js";
import { RevisionService } from "./revision.service.js";
import { ClientPortalIdentityService, type ActiveClientPortalSession } from "./client-portal-identity.service.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { recordProjectEvent } from "./project-events.js";
import { assertSubtasksCompleted } from "./task-subtask-policy.js";
import type { ProjectActor } from "./project.service.js";

type Tx = Prisma.TransactionClient;
type ItemSnapshot = {
  taskId: string; taskVersion: number; title: string; description: string | null; ownerEmployeeId: string; targetDate: string;
  startDate: string | null; estimatedHours: number | null; tags: string[]; checklist: Prisma.JsonValue; planItemId: string | null;
  reviewRequirement: string; revisionId: string | null; drawingId: string | null; fileId: string | null; blobId: string | null;
  workSubmissionId?: string; workEvidence?: import("./review-work-evidence.js").WorkEvidence;
  sha256: string | null; series: string | null; number: number | null;
};
type ItemInput = { taskId: string; expectedTaskVersion: number; revisionId?: string | undefined; workSubmissionId?: string | undefined; label: string };
type ItemBinding = { purpose: "CLIENT_ITEM_APPROVAL"; itemId: string; itemVersion: number; snapshot: Prisma.JsonValue; signatureName: string; consent: true; comment: string };
type FinalBinding = { purpose: "CLIENT_FINAL_APPROVAL"; packageId: string; packageVersion: number; items: unknown[]; signatureName: string; consent: true; comment: string };

const safeAgent = (value?: string): string | undefined => value ? value.slice(0, 512) : undefined;
const safeIp = (value?: string): string | undefined => value ? value.slice(0, 64) : undefined;
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const date = (value: Date | null): string | null => value?.toISOString().slice(0, 10) ?? null;

@Injectable()
export class ClientReviewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly scope: ClientPortalScopeService,
    private readonly portalIdentity: ClientPortalIdentityService,
    private readonly documents: DocumentService,
    private readonly revisions: RevisionService
  ) {}

  private get db() { return this.database.prisma; }

  private async tx<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { timeout: 30_000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) throw new ConflictException("Client review changed. Refresh and retry");
      throw error;
    }
  }

  private async staffProject(tx: Tx, actor: ProjectActor, projectId: string, mode: "manage" | "classify" | "correction") {
    return this.scope.staffAuthority(tx, actor, projectId, mode);
  }

  private async taskSnapshot(tx: Tx, projectId: string, taskId: string, revisionId?: string): Promise<{ task: Awaited<ReturnType<Tx["task"]["findUniqueOrThrow"]>>; revision: Awaited<ReturnType<Tx["documentRevision"]["findUniqueOrThrow"]>> | null; snapshot: ItemSnapshot }> {
    const task = await tx.task.findFirst({ where: { id: taskId, projectId } });
    if (!task) throw new NotFoundException("Project task not found");
    // Document revisions are project-scoped rather than task-related; bind the exact row explicitly.
    const exactRevision = revisionId ? await tx.documentRevision.findFirst({ where: { id: revisionId, projectId, organizationId: task.organizationId }, include: { drawing: true } }) : null;
    if (revisionId && !exactRevision) throw new NotFoundException("Revision not found in this project");
    const snapshot: ItemSnapshot = {
      taskId: task.id, taskVersion: task.version + 1, title: task.title, description: task.description,
      ownerEmployeeId: task.primaryOwnerEmployeeId, targetDate: date(task.targetDate)!, startDate: date(task.startDate),
      estimatedHours: task.estimatedHours === null ? null : Number(task.estimatedHours), tags: task.tags, checklist: task.checklist,
      planItemId: task.planItemId, reviewRequirement: task.reviewRequirement,
      revisionId: exactRevision?.id ?? null, drawingId: exactRevision?.drawingId ?? null, fileId: exactRevision?.fileId ?? null,
      blobId: exactRevision?.blobId ?? null, sha256: exactRevision?.sha256 ?? null, series: exactRevision?.series ?? null, number: exactRevision?.number ?? null
    };
    return { task, revision: exactRevision, snapshot };
  }

  private async taskStatus(tx: Tx, actorId: string, task: { id: string; organizationId: string; status: TaskStatus; version: number }, status: TaskStatus, reason: string, eventName: "task.updated" | "task.started" | "task.completed") {
    const updated = await tx.task.update({ where: { id: task.id, version: task.version }, data: { status, version: { increment: 1 } } });
    await tx.taskStatusChange.create({ data: { organizationId: task.organizationId, taskId: task.id, fromStatus: task.status, toStatus: status, actorId, reason, taskVersion: updated.version } });
    await recordProjectEvent(tx, { organizationId: task.organizationId, actorId, eventName, subjectType: "task", subjectId: task.id, reason, before: { status: task.status, version: task.version }, after: { status, version: updated.version } });
    return updated;
  }

  private async exactInternalApproval(tx: Tx, taskId: string, revisionId: string) {
    const submission = await tx.reviewSubmission.findFirst({ where: { taskId }, orderBy: { roundNumber: "desc" } });
    const round = submission ? await tx.reviewRound.findUnique({ where: { submissionId: submission.id } }) : null;
    const fact = await tx.revisionApprovalFact.findUnique({ where: { revisionId_kind: { revisionId, kind: RevisionApprovalKind.INTERNAL } } });
    return !!submission && submission.revisionId === revisionId && round?.status === InternalReviewStatus.APPROVED && !!fact;
  }

  private async latestItemForTask(tx: Tx, taskId: string, itemId: string) {
    const latest = await tx.clientReviewItem.findFirst({ where: { taskId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    return latest?.id === itemId;
  }

  private async clientSafeItem(tx: Tx, item: { id: string; packageId: string; taskId: string; revisionId: string | null; label: string; status: ClientReviewItemStatus; version: number; snapshot: Prisma.JsonValue; projectId: string; organizationId: string }, accountId: string, permission: { view: boolean; comment: boolean; review: boolean; approve: boolean; download: boolean }) {
    const task = await tx.task.findFirst({ where: { id: item.taskId, projectId: item.projectId, organizationId: item.organizationId }, select: { id: true, title: true, status: true } });
    const revision = item.revisionId ? await tx.documentRevision.findFirst({ where: { id: item.revisionId, projectId: item.projectId } }) : null;
    const blob = revision ? await tx.fileBlobMetadata.findFirst({ where: { id: revision.blobId, organizationId: item.organizationId }, select: { mimeType: true } }) : null;
    const decision = await tx.clientItemDecision.findUnique({ where: { itemId: item.id }, select: { id: true, kind: true, comment: true, createdAt: true } });
    const comments = await tx.clientReviewComment.findMany({ where: { itemId: item.id }, orderBy: { createdAt: "asc" }, select: { id: true, authorId: true, text: true, annotations: true, referenceId: true, createdAt: true } });
    const namedComments = [];
    for (const comment of comments) {
      const author = await tx.account.findUnique({ where: { id: comment.authorId }, select: { normalizedEmail: true } });
      namedComments.push({ id: comment.id, authorEmail: author?.normalizedEmail ?? "Client", text: comment.text, annotations: comment.annotations, referenceId: comment.referenceId, createdAt: comment.createdAt });
    }
    const ownHistory = await tx.clientFinalApproval.findMany({ where: { projectId: item.projectId, accountId }, select: { id: true, packageId: true, signatureName: true, createdAt: true, closedAt: true }, orderBy: { createdAt: "asc" } });
    return {
      id: item.id, packageId: item.packageId, taskId: item.taskId, revisionId: item.revisionId, label: item.label, status: item.status,
      version: item.version, task, revision: revision ? { id: revision.id, label: `${revision.series}${revision.number}`, mimeType: blob?.mimeType ?? null } : null,
      workEvidence: submittedEvidence(item.snapshot),
      permissions: { view: permission.view, comment: permission.comment, review: permission.review, approve: permission.approve, download: permission.download },
      decision, comments: namedComments, ownApprovalHistory: ownHistory
    };
  }

  async projectDetail(actor: ProjectActor, projectId: string) {
    return this.tx(async (tx) => {
      const { project } = await this.staffProject(tx, actor, projectId, "manage");
      const packages = await tx.clientReviewPackage.findMany({ where: { projectId, organizationId: actor.organizationId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
      const result = [];
      for (const reviewPackage of packages) {
        const items = await tx.clientReviewItem.findMany({ where: { packageId: reviewPackage.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        const rows = [];
        for (const item of items) {
          const classification = await tx.clientReviewClassification.findFirst({ where: { itemId: item.id }, orderBy: { version: "desc" } });
          const correction = await tx.clientCorrection.findUnique({ where: { itemId: item.id } });
          const revision = item.revisionId ? await tx.documentRevision.findUnique({ where: { id: item.revisionId } }) : null;
          const taskStatus = (await tx.task.findUniqueOrThrow({ where: { id: item.taskId }, select: { status: true } })).status;
          rows.push({ id: item.id, taskId: item.taskId, taskStatus, revisionId: item.revisionId, label: item.label, status: item.status, version: item.version, revision: revision ? { id: revision.id, label: `${revision.series}${revision.number}` } : null, classification: classification ? { category: classification.category, version: classification.version } : null, correctionTaskId: correction?.correctionTaskId ?? null });
        }
        result.push({ id: reviewPackage.id, title: reviewPackage.title, status: reviewPackage.status, version: reviewPackage.version, createdAt: reviewPackage.createdAt, items: rows });
      }
      const tasks = await tx.task.findMany({ where: { projectId, organizationId: actor.organizationId, reviewRequirement: { in: [TaskReviewRequirement.CLIENT, TaskReviewRequirement.BOTH] }, status: { in: [TaskStatus.IN_PROGRESS, TaskStatus.INTERNAL_APPROVED] }, requiresReassignment: false }, orderBy: [{ title: "asc" }, { id: "asc" }], select: { id: true, title: true, description: true, status: true, version: true, reviewRequirement: true, targetDate: true, primaryOwnerEmployeeId: true } });
      const eligibleTasks = [];
      for (const task of tasks) {
        const revisions = [];
        for (const revision of await tx.documentRevision.findMany({ where: { projectId, drawing: { projectId }, isCurrent: true }, orderBy: [{ drawingId: "asc" }, { ordinal: "desc" }] })) {
          const internal = await tx.revisionApprovalFact.findUnique({ where: { revisionId_kind: { revisionId: revision.id, kind: RevisionApprovalKind.INTERNAL } } });
          if (!internal) continue;
          try {
            const file = await this.documents.authorizeFile(tx, actor, revision.fileId, task.reviewRequirement === TaskReviewRequirement.CLIENT ? "document.client_review_select" : "document.view");
            if (/pdf|image/.test(file.blob.mimeType)) revisions.push({ id: revision.id, label: `${revision.series}${revision.number}`, state: revision.state, drawingId: revision.drawingId });
          } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
        }
        let approvedWork: { submissionId: string; revisionId: string | null; kind: string } | null = null;
        const latest = await tx.reviewSubmission.findFirst({ where: { taskId: task.id }, orderBy: { roundNumber: "desc" } });
        const work = latest ? submittedEvidence(latest.taskSnapshot) : null;
        if (latest && work && (await tx.reviewRound.findUnique({ where: { submissionId: latest.id } }))?.status === InternalReviewStatus.APPROVED) {
          try {
            if (work.fileId) await this.documents.authorizeFile(tx, actor, work.fileId);
            await assertClientEvidenceFile(tx, actor.organizationId, projectId, work);
            approvedWork = { submissionId: latest.id, revisionId: latest.revisionId, kind: work.kind };
          } catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
        }
        eligibleTasks.push({ ...task, targetDate: date(task.targetDate), revisions, approvedWork });
      }
      let canClassify = false;
      let canAssignCorrection = false;
      try { await this.staffProject(tx, actor, projectId, "classify"); canClassify = true; } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      try { await this.staffProject(tx, actor, projectId, "correction"); canAssignCorrection = true; } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      const correctionOwners = [];
      if (canAssignCorrection) for (const assignment of await tx.projectAssignment.findMany({ where: { projectId, organizationId: actor.organizationId, revokedAt: null }, orderBy: { employeeId: "asc" } })) {
        const employee = await tx.employee.findFirst({ where: { id: assignment.employeeId, organizationId: actor.organizationId, state: "ACTIVE", account: { state: "ACTIVE" } }, include: { account: { select: { normalizedEmail: true } } } });
        if (employee) correctionOwners.push({ employeeId: employee.id, name: employee.account.normalizedEmail });
      }
      return { project: { id: project.id, title: project.title, status: project.status }, packages: result, eligibleTasks, correctionOwners, capabilities: { manage: project.status === ProjectStatus.ACTIVE, classify: canClassify, assignCorrection: canAssignCorrection } };
    });
  }

  async createPackage(actor: ProjectActor, projectId: string, input: { title: string; reason: string; items: ItemInput[] }) {
    return this.tx(tx => this.createPackageWithin(tx, actor, projectId, input));
  }

  async createPackageWithin(tx: Tx, actor: ProjectActor, projectId: string, input: { title: string; reason: string; items: ItemInput[] }) {
      const { project } = await this.staffProject(tx, actor, projectId, "manage");
      if (project.status !== ProjectStatus.ACTIVE || !input.items.length || new Set(input.items.map((item) => item.taskId)).size !== input.items.length) throw new ConflictException("An Active project and distinct review tasks are required");
      const items = [...input.items].sort((a, b) => a.taskId.localeCompare(b.taskId));
      const resolved = [];
      for (const item of items) {
        await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id"=${item.taskId}::uuid FOR UPDATE`;
        const found = await this.taskSnapshot(tx, projectId, item.taskId, item.revisionId);
        const { task, revision } = found;
        let submission = item.workSubmissionId ? await tx.reviewSubmission.findFirst({ where: { id: item.workSubmissionId, taskId: task.id, projectId, organizationId: actor.organizationId } }) : null;
        if (!item.workSubmissionId && item.revisionId) {
          const latest = await tx.reviewSubmission.findFirst({ where: { taskId: task.id }, orderBy: { roundNumber: "desc" } });
          if (latest?.revisionId === item.revisionId && submittedEvidence(latest.taskSnapshot)) { submission = latest; item.workSubmissionId = latest.id; }
        }
        const evidence = submission ? submittedEvidence(submission.taskSnapshot) : null;
        if (evidence) await assertClientEvidenceFile(tx, actor.organizationId, projectId, evidence);
        if (item.workSubmissionId) {
          const latest = await tx.reviewSubmission.findFirst({ where: { taskId: task.id }, orderBy: { roundNumber: "desc" } });
          const round = submission ? await tx.reviewRound.findUnique({ where: { submissionId: submission.id } }) : null;
          if (!submission || latest?.id !== submission.id || !evidence || round?.status !== InternalReviewStatus.APPROVED || !approvedWorkMatches(task, submission.taskSnapshot) || submission.revisionId !== (revision?.id ?? null)) throw new ConflictException("Client review requires the exact latest internally approved work");
          if (evidence.fileId) {
            const file = await this.documents.authorizeFile(tx, actor, evidence.fileId);
            if (file.document.projectId !== projectId || file.blob.id !== evidence.blobId || file.blob.sha256 !== evidence.sha256 || file.document.confidential || !["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.blob.mimeType)) throw new ForbiddenException("Client evidence must be an accessible non-confidential PDF or image");
          }
          found.snapshot.workSubmissionId = submission.id;
          found.snapshot.workEvidence = evidence;
          if (!revision) Object.assign(found.snapshot, { fileId: evidence.fileId, blobId: evidence.blobId, sha256: evidence.sha256 });
        }
        if (!revision && !evidence) throw new ConflictException("A file or review link is required");
        if (task.version !== item.expectedTaskVersion || task.requiresReassignment || ![TaskStatus.IN_PROGRESS, TaskStatus.INTERNAL_APPROVED].includes(task.status as "IN_PROGRESS" | "INTERNAL_APPROVED")) throw new ConflictException("Task changed or is unavailable for client review");
        if (task.reviewRequirement === TaskReviewRequirement.BOTH) {
          if (task.status !== TaskStatus.INTERNAL_APPROVED || (!evidence && !revision) || (revision && !(await this.exactInternalApproval(tx, task.id, revision.id)))) throw new ConflictException("BOTH tasks require independent internal approval of this exact revision");
        } else if (task.reviewRequirement === TaskReviewRequirement.CLIENT) {
          if (task.status !== TaskStatus.IN_PROGRESS) throw new ConflictException("CLIENT tasks must be in progress");
          if (revision) {
            if (!revision.isCurrent || ![RevisionState.APPROVED, RevisionState.ISSUED].includes(revision.state as "APPROVED" | "ISSUED") || !(await this.exactInternalApproval(tx, task.id, revision.id))) throw new ConflictException("Client review requires current internally approved exact evidence");
            const file = await this.documents.authorizeFile(tx, actor, revision.fileId, "document.client_review_select");
            if (!/pdf|image/.test(file.blob.mimeType)) throw new ConflictException("Only PDF or image revisions may be published to client review");
          }
        } else throw new ConflictException("Task must require CLIENT or BOTH review");
        if (revision && task.reviewRequirement === TaskReviewRequirement.BOTH) {
          const file = await this.documents.authorizeFile(tx, actor, revision.fileId, "document.view");
          if (!/pdf|image/.test(file.blob.mimeType)) throw new ConflictException("Only PDF or image revisions may be published to client review");
        }
        resolved.push({ ...found, input: item });
      }

      const reviewPackage = await tx.clientReviewPackage.create({ data: { organizationId: actor.organizationId, projectId, title: input.title.trim(), createdById: actor.accountId, reason: input.reason } });
        const createdItems = [];
      for (const { task, revision, snapshot, input: itemInput } of resolved) {
        const updatedTask = await this.taskStatus(tx, actor.accountId, task, TaskStatus.SUBMITTED_CLIENT_REVIEW, input.reason, "task.updated");
        const exactSnapshot = { ...snapshot, taskVersion: updatedTask.version };
        const item = await tx.clientReviewItem.create({ data: { organizationId: actor.organizationId, projectId, packageId: reviewPackage.id, taskId: task.id, revisionId: revision?.id ?? null, ...(itemInput.workSubmissionId ? { workSubmissionId: itemInput.workSubmissionId } : {}), snapshot: json(exactSnapshot), label: itemInput.label.trim() } });
        const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "client.review_sent", subjectType: "client_review_item", subjectId: item.id, reason: input.reason, after: { itemId: item.id, packageId: reviewPackage.id, projectId, taskId: item.taskId, revisionId: item.revisionId, version: item.version, snapshot: exactSnapshot.workEvidence?.kind === "LINK" ? { ...exactSnapshot, workEvidence: { ...exactSnapshot.workEvidence, url: null } } : exactSnapshot } });
        const audit = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
        const auditEventId = (audit.payload as { auditEventId: string }).auditEventId;
        createdItems.push({ item, auditEventId });
      }
      const packageEventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "client.review_sent", subjectType: "client_review_package", subjectId: reviewPackage.id, reason: input.reason, after: { packageId: reviewPackage.id, projectId, version: reviewPackage.version, itemIds: createdItems.map(({ item }) => item.id) } });
      for (const { item, auditEventId } of createdItems) {
        // Keep the item audit row's canonical ID associated with its immutable publication data.
        void auditEventId;
        void item;
      }
      void packageEventId;
      return { id: reviewPackage.id, title: reviewPackage.title, status: reviewPackage.status, version: reviewPackage.version, createdAt: reviewPackage.createdAt, items: createdItems.map(({ item }) => ({ id: item.id, taskId: item.taskId, revisionId: item.revisionId, label: item.label, status: item.status, version: item.version })) };

  }

  async classify(actor: ProjectActor, itemId: string, input: { category: ClientRevisionCategory; expectedVersion: number; reason: string }) {
    return this.tx(async (tx) => {
      const preview = await tx.clientReviewItem.findFirst({ where: { id: itemId, organizationId: actor.organizationId } });
      if (!preview) throw new NotFoundException("Client review item not found");
      await this.staffProject(tx, actor, preview.projectId, "classify");
      await tx.$queryRaw`SELECT "id" FROM "client_review_items" WHERE "id"=${itemId}::uuid FOR UPDATE`;
      const item = await tx.clientReviewItem.findUniqueOrThrow({ where: { id: itemId } });
      if (item.version !== input.expectedVersion || item.status === ClientReviewItemStatus.WITHDRAWN) throw new ConflictException("Classification target changed or is unavailable");
      const revision = item.revisionId ? await tx.documentRevision.findUniqueOrThrow({ where: { id: item.revisionId } }) : null;
      const negative = item.status === ClientReviewItemStatus.REVISION_REQUIRED || item.status === ClientReviewItemStatus.REJECTED;
      if (revision?.series !== "CR" && !negative) throw new ConflictException("Only CR revisions or negative client decisions can be classified");
      const latest = await tx.clientReviewClassification.findFirst({ where: { itemId }, orderBy: { version: "desc" } });
      const version = (latest?.version ?? 0) + 1;
      const classificationId = randomUUID();
      const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "client.revision_classified", subjectType: "client_classification", subjectId: classificationId, reason: input.reason, ...(latest ? { before: { classificationId: latest.id, category: latest.category, version: latest.version } } : {}), after: { classificationId, itemId, projectId: item.projectId, category: input.category, version } });
      const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
      const auditEventId = (event.payload as { auditEventId: string }).auditEventId;
      const classification = await tx.clientReviewClassification.create({ data: { id: classificationId, organizationId: actor.organizationId, projectId: item.projectId, itemId, category: input.category, version, actorId: actor.accountId, reason: input.reason, auditEventId } });
      return classification;
    });
  }

  async assignCorrection(actor: ProjectActor, itemId: string, input: { ownerEmployeeId: string; reason: string }) {
    return this.tx(async (tx) => {
      const preview = await tx.clientReviewItem.findFirst({ where: { id: itemId, organizationId: actor.organizationId } });
      if (!preview) throw new NotFoundException("Client review item not found");
      const { project, account } = await this.staffProject(tx, actor, preview.projectId, "correction");
      await tx.$queryRaw`SELECT "id" FROM "client_review_items" WHERE "id"=${itemId}::uuid FOR UPDATE`;
      const item = await tx.clientReviewItem.findUniqueOrThrow({ where: { id: itemId } });
      if (item.status !== ClientReviewItemStatus.REVISION_REQUIRED || !(await this.latestItemForTask(tx, item.taskId, item.id)) || await tx.clientCorrection.findUnique({ where: { itemId } })) throw new ConflictException("Client correction is unavailable or already assigned");
      const classification = await tx.clientReviewClassification.findFirst({ where: { itemId }, orderBy: { version: "desc" } });
      if (!classification) throw new ConflictException("Classify the negative client decision before assigning correction work");
      await tx.$queryRaw`SELECT "id" FROM "employees" WHERE "id"=${input.ownerEmployeeId}::uuid FOR SHARE`;
      const employee = await tx.employee.findFirst({ where: { id: input.ownerEmployeeId, organizationId: actor.organizationId, state: "ACTIVE", account: { state: "ACTIVE" } } });
      if (!employee) throw new ConflictException("An active correction owner is required");
      const assignment = await tx.projectAssignment.findFirst({ where: { projectId: project.id, employeeId: employee.id, revokedAt: null } });
      if (!assignment || employee.homeBranchId !== project.branchId && !assignment.crossBranchAuthorized) throw new ForbiddenException("Correction owner lacks current project assignment");
      const linkedTask = await tx.task.findUniqueOrThrow({ where: { id: item.taskId } });
      const correction = await tx.task.create({ data: { organizationId: actor.organizationId, projectId: project.id, title: `Correct: ${linkedTask.title}`.slice(0, 160), description: `Client review correction (${classification?.category ?? "client request"}). Complete the linked correction before resuming the original task.`, type: TaskType.CORRECTION, priority: linkedTask.priority, targetDate: linkedTask.targetDate, primaryOwnerEmployeeId: employee.id, createdById: actor.accountId, reviewRequirement: TaskReviewRequirement.NONE } });
      await tx.taskStatusChange.create({ data: { organizationId: actor.organizationId, taskId: correction.id, fromStatus: null, toStatus: TaskStatus.NOT_STARTED, actorId: actor.accountId, reason: input.reason, taskVersion: 1 } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.created", subjectType: "task", subjectId: correction.id, reason: input.reason, after: { taskId: correction.id, projectId: project.id, ownerEmployeeId: employee.id, type: TaskType.CORRECTION, version: 1 } });
      const correctionId = randomUUID();
      const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "client.correction_assigned", subjectType: "client_correction", subjectId: correctionId, reason: input.reason, after: { correctionId, itemId, projectId: project.id, correctionTaskId: correction.id, ownerEmployeeId: employee.id } });
      const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
      const auditEventId = (event.payload as { auditEventId: string }).auditEventId;
      const link = await tx.clientCorrection.create({ data: { id: correctionId, organizationId: actor.organizationId, projectId: project.id, itemId, correctionTaskId: correction.id, actorId: actor.accountId, reason: input.reason, auditEventId } });
      void account;
      return { correction: link, task: correction };
    });
  }

  async resumeCorrection(actor: ProjectActor, itemId: string, input: { expectedTaskVersion: number; reason: string }) {
    return this.tx(async (tx) => {
      const preview = await tx.clientReviewItem.findFirst({ where: { id: itemId, organizationId: actor.organizationId } });
      if (!preview) throw new NotFoundException("Client review item not found");
      const { project } = await this.staffProject(tx, actor, preview.projectId, "correction");
      await tx.$queryRaw`SELECT "id" FROM "client_review_items" WHERE "id"=${itemId}::uuid FOR UPDATE`;
      const item = await tx.clientReviewItem.findUniqueOrThrow({ where: { id: itemId } });
      const correction = await tx.clientCorrection.findUnique({ where: { itemId } });
      if (item.status !== ClientReviewItemStatus.REVISION_REQUIRED || !(await this.latestItemForTask(tx, item.taskId, item.id)) || !correction) throw new ConflictException("Client correction is not assigned");
      const correctionTask = await tx.task.findUniqueOrThrow({ where: { id: correction.correctionTaskId } });
      if (correctionTask.status !== TaskStatus.COMPLETED) throw new ConflictException("Complete the linked correction task before resuming work");
      await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id"=${item.taskId}::uuid FOR UPDATE`;
      const task = await tx.task.findUniqueOrThrow({ where: { id: item.taskId } });
      if (task.version !== input.expectedTaskVersion || task.status !== TaskStatus.CLIENT_REVISION_REQUIRED || task.requiresReassignment || project.status !== ProjectStatus.ACTIVE) throw new ConflictException("Task changed or cannot resume client corrections");
      await this.taskStatus(tx, actor.accountId, task, TaskStatus.IN_PROGRESS, input.reason, "task.started");
      const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "client.correction_resumed", subjectType: "client_review_item", subjectId: item.id, reason: input.reason, before: { status: task.status, version: task.version }, after: { itemId, projectId: item.projectId, taskId: task.id, correctionTaskId: correctionTask.id, status: "IN_PROGRESS", taskVersion: task.version + 1, version: task.version + 1 } });
      void eventId;
      return { taskId: task.id, status: TaskStatus.IN_PROGRESS, version: task.version + 1 };
    });
  }

  async portalList(active: ActiveClientPortalSession, projectId: string) {
    return this.tx(async (tx) => {
      const { project } = await this.scope.authorizeProject(tx, active, projectId);
      const ownItemDecisions = await tx.clientItemDecision.findMany({ where: { projectId, accountId: active.account.id }, select: { id: true, itemId: true, kind: true, signatureName: true, comment: true, createdAt: true }, orderBy: { createdAt: "asc" } });
      const ownFinalApprovals = await tx.clientFinalApproval.findMany({ where: { projectId, accountId: active.account.id }, select: { id: true, packageId: true, signatureName: true, createdAt: true, closedAt: true }, orderBy: { createdAt: "asc" } });
      const ownApprovalHistory = { itemDecisions: ownItemDecisions, finalApprovals: ownFinalApprovals };
      const packages = await tx.clientReviewPackage.findMany({ where: { projectId, organizationId: project.organizationId, status: project.status === ProjectStatus.CANCELLED ? { in: [ClientReviewPackageStatus.WITHDRAWN, ClientReviewPackageStatus.APPROVED] } : { in: [ClientReviewPackageStatus.OPEN, ClientReviewPackageStatus.APPROVED] } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
      const result = [];
      for (const reviewPackage of packages) {
        const items = await tx.clientReviewItem.findMany({ where: { packageId: reviewPackage.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        const visible = [];
        for (const item of items) {
          try {
            const context = await this.scope.authorizeItem(tx, active, item.id, "view");
            if (project.status === ProjectStatus.CANCELLED) {
              const revision = item.revisionId ? await tx.documentRevision.findUnique({ where: { id: item.revisionId } }) : null;
              const blob = revision ? await tx.fileBlobMetadata.findFirst({ where: { id: revision.blobId, organizationId: project.organizationId }, select: { mimeType: true } }) : null;
              const issued = revision ? await tx.transmittalItem.findFirst({ where: { projectId, revisionId: revision.id }, include: { transmittal: { select: { issuedAt: true } } }, orderBy: { transmittal: { issuedAt: "asc" } } }) : null;
              visible.push({ id: item.id, label: item.label, status: item.status, permissions: { view: true, comment: false, review: false, approve: false, download: true }, revision: revision ? { id: revision.id, label: `${revision.series}${revision.number}`, mimeType: blob?.mimeType ?? null, state: revision.state, issuedAt: issued?.transmittal.issuedAt ?? null } : null, ownDecision: ownItemDecisions.find((decision) => decision.itemId === item.id) ?? null });
            } else visible.push(await this.clientSafeItem(tx, item, active.account.id, context.permission));
          } catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
        }
        if (visible.length) result.push({ id: reviewPackage.id, title: reviewPackage.title, status: reviewPackage.status, version: reviewPackage.version, items: visible });
      }
      return { project: { id: project.id, title: project.title, status: project.status }, packages: result, ownApprovalHistory };
    });
  }

  async portalDetail(active: ActiveClientPortalSession, itemId: string) {
    return this.tx(async (tx) => {
      const { item, project, permission } = await this.scope.authorizeItem(tx, active, itemId, "view");
      if (project.status === ProjectStatus.CANCELLED) {
        const revision = item.revisionId ? await tx.documentRevision.findUnique({ where: { id: item.revisionId } }) : null;
        const blob = revision ? await tx.fileBlobMetadata.findFirst({ where: { id: revision.blobId, organizationId: project.organizationId }, select: { mimeType: true } }) : null;
        const issued = revision ? await tx.transmittalItem.findFirst({ where: { projectId: project.id, revisionId: revision.id }, include: { transmittal: { select: { issuedAt: true } } }, orderBy: { transmittal: { issuedAt: "asc" } } }) : null;
        const ownDecision = await tx.clientItemDecision.findFirst({ where: { itemId, accountId: active.account.id }, select: { id: true, kind: true, signatureName: true, comment: true, createdAt: true } });
        return { id: item.id, label: item.label, status: item.status, permissions: { view: true, comment: false, review: false, approve: false, download: true }, revision: revision ? { id: revision.id, label: `${revision.series}${revision.number}`, mimeType: blob?.mimeType ?? null, state: revision.state, issuedAt: issued?.transmittal.issuedAt ?? null } : null, ownDecision };
      }
      return this.clientSafeItem(tx, item, active.account.id, permission);
    });
  }

  async comment(active: ActiveClientPortalSession, itemId: string, input: { text: string; annotations?: Array<{ page: number; x: number; y: number; text: string }> | undefined; referenceId?: string | undefined; reason: string }) {
    return this.tx(async (tx) => {
      const { project, item } = await this.scope.authorizeItem(tx, active, itemId, "comment", true);
      if (![ClientReviewItemStatus.PENDING, ClientReviewItemStatus.IN_REVIEW].includes(item.status as "PENDING" | "IN_REVIEW")) throw new ConflictException("This review no longer accepts comments");
      if (input.referenceId) {
        const reference = await tx.clientReference.findFirst({ where: { id: input.referenceId, itemId, accountId: active.account.id, projectId: project.id } });
        if (!reference) throw new NotFoundException("Client reference not found");
      }
      await this.scope.authorizeItem(tx, active, itemId, "comment", true);
      const commentId = randomUUID();
      const eventId = await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.commented", subjectType: "client_comment", subjectId: commentId, reason: input.reason, after: { commentId, itemId, projectId: project.id, authorId: active.account.id, text: input.text.trim(), annotations: input.annotations ?? [], referenceId: input.referenceId ?? null } });
      const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
      const auditEventId = (event.payload as { auditEventId: string }).auditEventId;
      return tx.clientReviewComment.create({ data: { id: commentId, organizationId: project.organizationId, projectId: project.id, itemId, authorId: active.account.id, text: input.text.trim(), annotations: json(input.annotations ?? []), referenceId: input.referenceId ?? null, auditEventId } });
    });
  }

  async beginReview(active: ActiveClientPortalSession, itemId: string, input: { expectedVersion: number; reason: string }) {
    return this.tx(async (tx) => {
      const { project } = await this.scope.authorizeItem(tx, active, itemId, "review", true);
      await tx.$queryRaw`SELECT "id" FROM "client_review_items" WHERE "id"=${itemId}::uuid FOR UPDATE`;
      const latest = await tx.clientReviewItem.findUniqueOrThrow({ where: { id: itemId } });
      await this.scope.authorizeItem(tx, active, itemId, "review", true);
      if (project.status !== ProjectStatus.ACTIVE || latest.version !== input.expectedVersion || latest.status !== ClientReviewItemStatus.PENDING) throw new ConflictException("Review item changed or is unavailable");
      const task = await tx.task.findUniqueOrThrow({ where: { id: latest.taskId } });
      if (task.status !== TaskStatus.SUBMITTED_CLIENT_REVIEW) throw new ConflictException("Task is no longer awaiting client review");
      await tx.clientReviewItem.update({ where: { id: latest.id, version: latest.version }, data: { status: ClientReviewItemStatus.IN_REVIEW, version: { increment: 1 } } });
      await this.taskStatus(tx, active.account.id, task, TaskStatus.IN_CLIENT_REVIEW, input.reason, "task.updated");
      await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.review_started", subjectType: "client_review_item", subjectId: latest.id, reason: input.reason, before: { status: latest.status, version: latest.version }, after: { itemId, packageId: latest.packageId, projectId: project.id, status: "IN_REVIEW", version: latest.version + 1 } });
      return { itemId, status: ClientReviewItemStatus.IN_REVIEW, version: latest.version + 1 };
    });
  }

  async approvalOptions(active: ActiveClientPortalSession, itemId: string, input: { expectedVersion: number; signatureName: string; consent: true; comment: string }) {
    const binding = await this.tx(async (tx) => {
      const { project, item, permission } = await this.scope.authorizeItem(tx, active, itemId, "approve");
      if (!permission || item.version !== input.expectedVersion || item.status !== ClientReviewItemStatus.IN_REVIEW || project.status !== ProjectStatus.ACTIVE) throw new ConflictException("Approval is unavailable for this item");
      return { purpose: "CLIENT_ITEM_APPROVAL" as const, itemId: item.id, itemVersion: item.version, snapshot: item.snapshot, signatureName: input.signatureName.trim(), consent: true as const, comment: input.comment.trim() };
    });
    return this.portalIdentity.approvalOptions(active, binding);
  }

  async finalOptions(active: ActiveClientPortalSession, packageId: string, input: { expectedVersion: number; signatureName: string; consent: true; comment: string }) {
    const binding = await this.tx(async (tx) => {
      const reviewPackage = await tx.clientReviewPackage.findUnique({ where: { id: packageId } });
      if (!reviewPackage) throw new NotFoundException("Client review package not found");
      const { project, grant } = await this.scope.authorizeProject(tx, active, reviewPackage.projectId);
      if (!grant.primary || project.status !== ProjectStatus.ACTIVE || reviewPackage.status !== ClientReviewPackageStatus.OPEN || reviewPackage.version !== input.expectedVersion) throw new ConflictException("Primary final approval is unavailable");
      const items = await this.finalItemSnapshot(tx, reviewPackage.id);
      await this.assertFinalReady(tx, project.id, items);
      return { purpose: "CLIENT_FINAL_APPROVAL" as const, packageId, packageVersion: reviewPackage.version, items, signatureName: input.signatureName.trim(), consent: true as const, comment: input.comment.trim() };
    });
    return this.portalIdentity.approvalOptions(active, binding);
  }

  private async finalItemSnapshot(tx: Tx, packageId: string) {
    const items = await tx.clientReviewItem.findMany({ where: { packageId }, orderBy: [{ id: "asc" }] });
    const snapshots = [];
    for (const item of items) {
      const decision = await tx.clientItemDecision.findUnique({ where: { itemId: item.id } });
      const snapshot = item.snapshot as ItemSnapshot;
      snapshots.push({ itemId: item.id, itemVersion: item.version, decisionId: decision?.id ?? null, taskId: item.taskId, revisionId: item.revisionId, drawingId: snapshot.drawingId, fileId: snapshot.fileId, blobId: snapshot.blobId, sha256: snapshot.sha256, ...(item.workSubmissionId ? { workSubmissionId: item.workSubmissionId, evidenceDigest: snapshot.workEvidence?.digest } : {}) });
    }
    return snapshots;
  }

  private async assertFinalReady(tx: Tx, projectId: string, snapshots: Array<Record<string, unknown>>) {
    if (!snapshots.length || snapshots.some((entry) => typeof entry.decisionId !== "string")) throw new ConflictException("Every package item must be approved before final approval");
    for (const entry of snapshots) {
      const item = await tx.clientReviewItem.findFirst({ where: { id: entry.itemId as string, projectId } });
      const decision = item ? await tx.clientItemDecision.findUnique({ where: { itemId: item.id } }) : null;
      if (!item || item.status !== ClientReviewItemStatus.APPROVED || decision?.kind !== ClientItemDecisionKind.APPROVED) throw new ConflictException("Every package item must be approved before final approval");
      const task = await tx.task.findUniqueOrThrow({ where: { id: item.taskId } });
      if (task.status !== TaskStatus.CLIENT_APPROVED) throw new ConflictException("Item task approval state is stale");
      const taskSnapshot = item.snapshot as ItemSnapshot;
      if (item.workSubmissionId) {
        const submission = await tx.reviewSubmission.findUniqueOrThrow({ where: { id: item.workSubmissionId } });
        const evidence = submittedEvidence(submission.taskSnapshot);
        const itemEvidence = submittedEvidence(item.snapshot);
        if (!evidence || evidence.digest !== itemEvidence?.digest || !approvedWorkMatches(task, submission.taskSnapshot)) throw new ConflictException("Approved work evidence changed");
      }
      if (taskSnapshot.title !== task.title || taskSnapshot.description !== task.description || taskSnapshot.ownerEmployeeId !== task.primaryOwnerEmployeeId || taskSnapshot.targetDate !== date(task.targetDate) || taskSnapshot.startDate !== date(task.startDate) || taskSnapshot.estimatedHours !== (task.estimatedHours === null ? null : Number(task.estimatedHours)) || taskSnapshot.planItemId !== task.planItemId || JSON.stringify(taskSnapshot.tags) !== JSON.stringify(task.tags) || JSON.stringify(taskSnapshot.checklist) !== JSON.stringify(task.checklist)) throw new ConflictException("Current task no longer matches the published review item");
      if (item.revisionId) {
        const revision = await tx.documentRevision.findFirst({ where: { id: item.revisionId, projectId } });
        const approval = await tx.revisionApprovalFact.findUnique({ where: { revisionId_kind: { revisionId: item.revisionId, kind: RevisionApprovalKind.INTERNAL } } });
        if (!revision || !revision.isCurrent || ![RevisionState.APPROVED, RevisionState.ISSUED].includes(revision.state as "APPROVED" | "ISSUED") || !approval || revision.blobId !== entry.blobId || revision.sha256 !== entry.sha256) throw new ConflictException("Current internally approved exact revision changed");
        if (revision.series === "CR" && !(await tx.clientReviewClassification.findFirst({ where: { itemId: item.id } }))) throw new ConflictException("Every CR revision requires classification before final approval");
      }
    }
  }

  async decide(active: ActiveClientPortalSession, itemId: string, input: { kind: ClientItemDecisionKind; expectedVersion: number; comment: string; reason: string; signatureName?: string | undefined; consent?: boolean | undefined; ceremonyId?: string | undefined; response?: AuthenticationResponseJSON | undefined }, ipAddress?: string, userAgent?: string) {
    let proofFailure = false;
    const result = await this.tx(async (tx) => {
      const { project, permission } = await this.scope.authorizeItem(tx, active, itemId, input.kind === ClientItemDecisionKind.APPROVED ? "approve" : "review", true);
      await tx.$queryRaw`SELECT "id" FROM "client_review_items" WHERE "id"=${itemId}::uuid FOR UPDATE`;
      const current = await tx.clientReviewItem.findUniqueOrThrow({ where: { id: itemId } });
      await this.scope.authorizeItem(tx, active, itemId, input.kind === ClientItemDecisionKind.APPROVED ? "approve" : "review", true);
      if (project.status !== ProjectStatus.ACTIVE || current.version !== input.expectedVersion || current.status !== ClientReviewItemStatus.IN_REVIEW || !permission || await tx.clientItemDecision.findUnique({ where: { itemId } })) throw new ConflictException("Review item changed or is unavailable");
      let credentialId: string | null = null;
      const signature = input.kind === ClientItemDecisionKind.APPROVED;
      if (signature) {
        if (!input.signatureName?.trim() || input.consent !== true || !input.ceremonyId || !input.response) throw new ForbiddenException("A signed passkey approval is required");
        const exactRevision = current.revisionId ? await tx.documentRevision.findUniqueOrThrow({ where: { id: current.revisionId } }) : null;
        if (exactRevision?.series === "CR" && !(await tx.clientReviewClassification.findFirst({ where: { itemId } }))) throw new ConflictException("Classify the CR revision before client approval");
        const binding: ItemBinding = { purpose: "CLIENT_ITEM_APPROVAL", itemId, itemVersion: current.version, snapshot: current.snapshot, signatureName: input.signatureName.trim(), consent: true, comment: input.comment.trim() };
        try { credentialId = (await this.portalIdentity.verifyApprovalWithinTransaction(tx, active, input.ceremonyId, input.response, binding)).credentialId; }
        catch (error) { if (error instanceof UnauthorizedException) { proofFailure = true; return { proofFailure: true as const }; } throw error; }
      }
      const kind = input.kind;
      const nextStatus = kind === ClientItemDecisionKind.APPROVED ? ClientReviewItemStatus.APPROVED : kind === ClientItemDecisionKind.REVISION_REQUIRED ? ClientReviewItemStatus.REVISION_REQUIRED : ClientReviewItemStatus.REJECTED;
      const task = await tx.task.findUniqueOrThrow({ where: { id: current.taskId } });
      const nextTaskStatus = kind === ClientItemDecisionKind.APPROVED ? TaskStatus.CLIENT_APPROVED : TaskStatus.CLIENT_REVISION_REQUIRED;
      const decisionId = randomUUID();
      const eventId = await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.item_decided", subjectType: "client_item_decision", subjectId: decisionId, reason: input.reason, before: { itemStatus: current.status, itemVersion: current.version, taskStatus: task.status }, after: { decisionId, itemId, packageId: current.packageId, projectId: project.id, kind, itemVersion: current.version + 1, version: current.version + 1, taskId: task.id, taskStatus: nextTaskStatus, ...(signature ? { signatureName: input.signatureName!.trim(), consent: true } : {}) } });
      const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
      const auditEventId = (event.payload as { auditEventId: string }).auditEventId;
      const decision = await tx.clientItemDecision.create({ data: { id: decisionId, organizationId: project.organizationId, projectId: project.id, itemId, accountId: active.account.id, kind, ...(signature ? { signatureName: input.signatureName!.trim(), consent: true, credentialId: credentialId! } : {}), comment: input.comment.trim(), ipAddress: safeIp(ipAddress) ?? null, userAgent: safeAgent(userAgent) ?? null, auditEventId } });
      await tx.clientReviewItem.update({ where: { id: itemId, version: current.version }, data: { status: nextStatus, version: { increment: 1 } } });
      await this.taskStatus(tx, active.account.id, task, nextTaskStatus, input.reason, "task.updated");
      return { decision, status: nextStatus, version: current.version + 1 };
    });
    if (proofFailure || (result as { proofFailure?: boolean }).proofFailure) throw new UnauthorizedException("Approval verification failed");
    return result;
  }

  async finalApprove(active: ActiveClientPortalSession, packageId: string, input: { expectedVersion: number; signatureName: string; consent: true; comment: string; reason: string; ceremonyId: string; response: AuthenticationResponseJSON }, ipAddress?: string, userAgent?: string) {
    let proofFailure = false;
    const result = await this.tx(async (tx) => {
      const reviewPackage = await tx.clientReviewPackage.findUnique({ where: { id: packageId } });
      if (!reviewPackage) throw new NotFoundException("Client review package not found");
      const { project, grant } = await this.scope.authorizeProject(tx, active, reviewPackage.projectId, true);
      // Follow the shared lock order: project/session/grant (above), then every
      // package task in stable order, then package/items, and finally the passkey
      // credential inside proof verification. This keeps revocation and task edits
      // serialized before consuming the one-use approval ceremony.
      const packageItems = await tx.clientReviewItem.findMany({ where: { packageId }, orderBy: [{ taskId: "asc" }, { id: "asc" }], select: { id: true, taskId: true, revisionId: true } });
      const revisionIds = [...new Set(packageItems.flatMap((item) => item.revisionId ? [item.revisionId] : []))].sort();
      const revisions = revisionIds.length ? await tx.documentRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, drawingId: true } }) : [];
      const drawingIds = [...new Set(revisions.map((revision) => revision.drawingId))].sort();
      for (const drawingId of drawingIds) await tx.$queryRaw`SELECT "id" FROM "drawing_records" WHERE "id"=${drawingId}::uuid FOR UPDATE`;
      for (const revisionId of revisionIds) await tx.$queryRaw`SELECT "id" FROM "document_revisions" WHERE "id"=${revisionId}::uuid FOR SHARE`;
      const taskIds = [...new Set(packageItems.map((item) => item.taskId))].sort();
      for (const taskId of taskIds) await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id"=${taskId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "client_review_packages" WHERE "id"=${packageId}::uuid FOR UPDATE`;
      const current = await tx.clientReviewPackage.findUniqueOrThrow({ where: { id: packageId } });
      if (!grant.primary || project.status !== ProjectStatus.ACTIVE || current.status !== ClientReviewPackageStatus.OPEN || current.version !== input.expectedVersion) throw new ConflictException("Primary final approval changed or is unavailable");
      for (const item of [...packageItems].sort((a, b) => a.id.localeCompare(b.id))) await tx.$queryRaw`SELECT "id" FROM "client_review_items" WHERE "id"=${item.id}::uuid FOR UPDATE`;
      const itemSnapshot = await this.finalItemSnapshot(tx, current.id);
      await this.assertFinalReady(tx, project.id, itemSnapshot);
      const binding: FinalBinding = { purpose: "CLIENT_FINAL_APPROVAL", packageId, packageVersion: current.version, items: itemSnapshot, signatureName: input.signatureName.trim(), consent: true, comment: input.comment.trim() };
      let proof: { accountId: string; credentialId: string };
      try { proof = await this.portalIdentity.verifyApprovalWithinTransaction(tx, active, input.ceremonyId, input.response, binding); }
      catch (error) { if (error instanceof UnauthorizedException) { proofFailure = true; return { proofFailure: true as const }; } throw error; }
      const finalApprovalId = randomUUID();
      const eventId = await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.final_approved", subjectType: "client_final_approval", subjectId: finalApprovalId, reason: input.reason, after: { finalApprovalId, packageId: current.id, projectId: project.id, itemSnapshot, signatureName: input.signatureName.trim(), consent: true } });
      const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
      const auditEventId = (event.payload as { auditEventId: string }).auditEventId;
      const finalApproval = await tx.clientFinalApproval.create({ data: { id: finalApprovalId, organizationId: project.organizationId, projectId: project.id, packageId: current.id, accountId: proof.accountId, signatureName: input.signatureName.trim(), consent: true, credentialId: proof.credentialId, ipAddress: safeIp(ipAddress) ?? null, userAgent: safeAgent(userAgent) ?? null, itemSnapshot: json(itemSnapshot), auditEventId } });
      const priorPackage = { status: current.status, version: current.version };
      await tx.clientReviewPackage.update({ where: { id: current.id, version: current.version }, data: { status: ClientReviewPackageStatus.APPROVED, version: { increment: 1 } } });
      await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.final_approved", subjectType: "client_review_package", subjectId: current.id, reason: input.reason, before: priorPackage, after: { packageId: current.id, projectId: project.id, version: current.version + 1, status: ClientReviewPackageStatus.APPROVED } });
      for (const entry of itemSnapshot) {
        if (typeof entry.revisionId !== "string") continue;
        const revision = await tx.documentRevision.findUniqueOrThrow({ where: { id: entry.revisionId } });
        const approvalEventId = await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.approved", subjectType: "client_review", subjectId: revision.id, reason: input.reason, after: { projectId: revision.projectId, drawingId: revision.drawingId, revisionId: revision.id, blobId: revision.blobId, sha256: revision.sha256, packageId: current.id, itemId: entry.itemId, finalApprovalId: finalApproval.id } });
        const approvalEvent = await tx.domainEvent.findUniqueOrThrow({ where: { id: approvalEventId } });
        await this.revisions.consumeApproval(tx, revision.id, (approvalEvent.payload as { auditEventId: string }).auditEventId, RevisionApprovalKind.CLIENT);
      }
      return { finalApproval, status: ClientReviewPackageStatus.APPROVED, version: current.version + 1 };
    });
    if (proofFailure || (result as { proofFailure?: boolean }).proofFailure) throw new UnauthorizedException("Approval verification failed");
    return result;
  }

  async completeTask(actor: ProjectActor, taskId: string, input: { expectedVersion: number; reason: string }) {
    return this.tx(async (tx) => {
      const preview = await tx.task.findFirst({ where: { id: taskId, organizationId: actor.organizationId, projectId: { not: null } } });
      if (!preview?.projectId) throw new NotFoundException("Project task not found");
      await this.staffProject(tx, actor, preview.projectId, "manage");
      await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id"=${taskId}::uuid FOR UPDATE`;
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      if (task.version !== input.expectedVersion || task.status !== TaskStatus.CLIENT_APPROVED || task.requiresReassignment) throw new ConflictException("Only an exactly approved client task can be completed");
      const items = await tx.clientReviewItem.findMany({ where: { taskId }, orderBy: { createdAt: "desc" } });
      let approved = false;
      for (const item of items) {
        const reviewPackage = await tx.clientReviewPackage.findUnique({ where: { id: item.packageId } });
        const final = await tx.clientFinalApproval.findUnique({ where: { packageId: item.packageId } });
        const itemSnapshot = (final?.itemSnapshot as Array<{ itemId?: string } | null> | undefined)?.find((entry) => entry?.itemId === item.id);
        const snapshot = item.snapshot as ItemSnapshot;
        if (item.status === ClientReviewItemStatus.APPROVED && reviewPackage?.status === ClientReviewPackageStatus.APPROVED && final && itemSnapshot && snapshot.title === task.title && snapshot.description === task.description && snapshot.ownerEmployeeId === task.primaryOwnerEmployeeId && snapshot.targetDate === date(task.targetDate) && snapshot.startDate === date(task.startDate) && snapshot.estimatedHours === (task.estimatedHours === null ? null : Number(task.estimatedHours)) && snapshot.planItemId === task.planItemId && JSON.stringify(snapshot.tags) === JSON.stringify(task.tags) && JSON.stringify(snapshot.checklist) === JSON.stringify(task.checklist)) { approved = true; break; }
      }
      if (!approved) throw new ConflictException("Final Primary Client package approval is required before completion");
      await assertSubtasksCompleted(tx, actor.organizationId, taskId);
      return this.taskStatus(tx, actor.accountId, task, TaskStatus.COMPLETED, input.reason, "task.completed");
    });
  }
}
