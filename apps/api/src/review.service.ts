import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { workEvidence, submittedEvidence } from "./review-work-evidence.js";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { AccountKind, AccountState, EmployeeState, InternalReviewSeverity, InternalReviewStatus, NotificationChannel, Prisma, ProjectStatus, RevisionApprovalKind, TaskPriority, TaskReviewRequirement, TaskStatus, TaskType } from "./generated/prisma/client.js";
import { DatabaseService } from "./database.service.js";
import { AuthorizationService } from "./authorization.service.js";
import { withAuthorizationReadTime } from "./authorization-read-context.js";
import { DocumentService } from "./document.service.js";
import { RevisionService } from "./revision.service.js";
import { NotificationsService } from "./notifications.service.js";
import { recordProjectEvent } from "./project-events.js";
import { assertSubtasksCompleted } from "./task-subtask-policy.js";
import type { ProjectActor } from "./project.service.js";

type Tx = Prisma.TransactionClient;
type Annotation = { page: number; x: number; y: number; text: string };
type CommentInput = { comment: string; reason: string; annotations?: Annotation[] | undefined; markupFileId?: string | undefined };
type DecisionInput = { kind: "APPROVED" | "CORRECTIONS_REQUIRED"; comment?: string | undefined; reason: string; annotations?: Annotation[] | undefined; markupFileId?: string | undefined; severity?: string | undefined; categoryId?: string | undefined };

@Injectable()
export class ReviewService {
  constructor(private readonly database: DatabaseService, private readonly authorization: AuthorizationService, private readonly documents: DocumentService, private readonly revisions: RevisionService, private readonly notifications: NotificationsService) {}
  private get db() { return this.database.prisma; }
  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { timeout: 30_000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) throw new ConflictException("Review changed. Refresh and retry");
      throw error;
    }
  }
  private async account(tx: Tx, actor: ProjectActor) {
    await tx.$queryRaw`SELECT "id" FROM "accounts" WHERE "id"=${actor.accountId}::uuid FOR SHARE`;
    const row = await tx.account.findFirst({ where: { id: actor.accountId, kind: actor.kind, state: AccountState.ACTIVE }, include: { employee: true } });
    if (!row || actor.kind === AccountKind.STAFF && (!row.employee || row.employee.state !== EmployeeState.ACTIVE || row.employee.organizationId !== actor.organizationId)) throw new ForbiddenException("Permission denied");
    return row;
  }
  private async project(tx: Tx, actor: ProjectActor, projectId: string, write = false) {
    if (write) await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id"=${projectId}::uuid AND "organizationId"=${actor.organizationId}::uuid FOR SHARE`;
    const project = await tx.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const account = await this.account(tx, actor);
    if (actor.kind === AccountKind.STAFF) {
      const employee = account.employee!;
      const assignment = await tx.projectAssignment.findFirst({ where: { projectId, employeeId: employee.id, organizationId: actor.organizationId, revokedAt: null } });
      if (!assignment || employee.homeBranchId !== project.branchId && !assignment.crossBranchAuthorized) throw new ForbiddenException("Permission denied");
      await this.authorization.assertPermission(actor.accountId, "project.view", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
    }
    if (write && project.status !== ProjectStatus.ACTIVE) throw new ConflictException("Only Active projects accept internal review work");
    return { project, account };
  }
  private async manager(tx: Tx, actor: ProjectActor, project: { id: string; branchId: string; currentLeadEmployeeId: string | null }) {
    if (actor.kind === AccountKind.OWNER) return;
    const employee = await tx.employee.findUnique({ where: { accountId: actor.accountId } });
    if (!employee) throw new ForbiddenException("Project management permission required");
    if (project.currentLeadEmployeeId === employee.id) return;
    const scope = { kind: "BRANCH" as const, organizationId: actor.organizationId, branchId: project.branchId };
    await this.authorization.assertPermission(actor.accountId, "project.manage", scope, tx);
    await this.authorization.assertPermission(actor.accountId, "task.assign", scope, tx);
  }
  private async candidate(tx: Tx, actor: ProjectActor, project: { id: string; branchId: string }, employeeId: string, reviewer = false) {
    await tx.$queryRaw`SELECT "id" FROM "employees" WHERE "id"=${employeeId}::uuid FOR SHARE`;
    const row = await tx.employee.findFirst({ where: { id: employeeId, organizationId: actor.organizationId, state: EmployeeState.ACTIVE, account: { state: AccountState.ACTIVE } }, include: { account: true } });
    if (!row) throw new ConflictException("An active assigned employee is required");
    const assignment = await tx.projectAssignment.findFirst({ where: { projectId: project.id, employeeId, organizationId: actor.organizationId, revokedAt: null } });
    if (!assignment || row.homeBranchId !== project.branchId && !assignment.crossBranchAuthorized) throw new ForbiddenException("Employee has no current project assignment");
    const scope = { kind: "BRANCH" as const, organizationId: actor.organizationId, branchId: project.branchId };
    await this.authorization.assertPermission(row.accountId, "project.view", scope, tx);
    if (reviewer) await this.authorization.assertPermission(row.accountId, "review.decide", scope, tx);
    return row;
  }
  private async task(tx: Tx, actor: ProjectActor, id: string, write = false) {
    const preview = await tx.task.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!preview || !preview.projectId) throw new NotFoundException("Project task not found");
    const { project, account } = await this.project(tx, actor, preview.projectId, write);
    if (write) await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id"=${id}::uuid FOR UPDATE`;
    const row = await tx.task.findUniqueOrThrow({ where: { id } });
    if (row.projectId !== project.id) throw new NotFoundException("Project task not found");
    return { row, project, account };
  }
  private async round(tx: Tx, actor: ProjectActor, id: string, write = false) {
    const preview = await tx.reviewRound.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!preview) throw new NotFoundException("Review round not found");
    const context = await this.task(tx, actor, preview.taskId, write);
    if (write) await tx.$queryRaw`SELECT "id" FROM "review_rounds" WHERE "id"=${id}::uuid FOR UPDATE`;
    const row = await tx.reviewRound.findUniqueOrThrow({ where: { id } });
    const submission = await tx.reviewSubmission.findUniqueOrThrow({ where: { id: row.submissionId } });
    if (submission.projectId !== context.project.id || row.taskId !== context.row.id) throw new NotFoundException("Review round not found");
    if (submission.revisionId) await this.revisionAccess(tx, actor, submission.revisionId, context.project.id);
    const evidence = submittedEvidence(submission.taskSnapshot);
    if (evidence?.fileId) {
      const file = await this.documents.authorizeFile(tx, actor, evidence.fileId);
      if (file.document.projectId !== context.project.id || file.blob.id !== evidence.blobId || file.blob.sha256 !== evidence.sha256) throw new ConflictException("Exact submitted evidence is unavailable");
    }
    return { ...context, round: row, submission };
  }
  private async revisionAccess(tx: Tx, actor: ProjectActor, revisionId: string, projectId: string) {
    const revision = await tx.documentRevision.findFirst({ where: { id: revisionId, organizationId: actor.organizationId, projectId }, include: { drawing: true } });
    if (!revision) throw new NotFoundException("Revision not found in this project");
    await this.documents.authorizeFile(tx, actor, revision.fileId);
    return revision;
  }
  private async markup(tx: Tx, actor: ProjectActor, projectId: string, markupFileId?: string) {
    if (!markupFileId) return;
    const file = await this.documents.authorizeFile(tx, actor, markupFileId);
    if (file.document.projectId !== projectId || !(/pdf|image/.test(file.blob.mimeType))) throw new BadRequestException("Markup must be an accessible project PDF or image");
  }
  private async auditId(tx: Tx, domainEventId: string) {
    const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: domainEventId } });
    const value = (event.payload as Record<string, unknown>).auditEventId;
    if (typeof value !== "string") throw new ConflictException("Review audit evidence is unavailable");
    return value;
  }
  private async taskState(tx: Tx, actor: ProjectActor, task: { id: string; organizationId: string; status: TaskStatus; version: number }, to: TaskStatus, reason: string) {
    const updated = await tx.task.update({ where: { id: task.id, version: task.version }, data: { status: to, version: { increment: 1 } } });
    await tx.taskStatusChange.create({ data: { organizationId: task.organizationId, taskId: task.id, fromStatus: task.status, toStatus: to, actorId: actor.accountId, reason, taskVersion: updated.version } });
    await recordProjectEvent(tx, { organizationId: task.organizationId, actorId: actor.accountId, eventName: to === TaskStatus.COMPLETED ? "task.completed" : "task.updated", subjectType: "task", subjectId: task.id, reason, before: { status: task.status, version: task.version }, after: { status: to, version: updated.version } });
    return updated;
  }
  private approvedScopeMatches(row: { title: string; description: string | null; targetDate: Date; startDate: Date | null; estimatedHours: Prisma.Decimal | null; planItemId: string | null; tags: string[]; checklist: Prisma.JsonValue }, snapshot: Prisma.JsonValue): boolean {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
    const submitted = snapshot as Record<string, unknown>;
    return submitted.title === row.title && submitted.description === row.description && submitted.targetDate === row.targetDate.toISOString().slice(0, 10)
      && submitted.startDate === (row.startDate?.toISOString().slice(0, 10) ?? null)
      && submitted.estimatedHours === (row.estimatedHours === null ? null : Number(row.estimatedHours))
      && submitted.planItemId === row.planItemId
      && JSON.stringify(submitted.tags) === JSON.stringify(row.tags)
      && JSON.stringify(submitted.checklist) === JSON.stringify(row.checklist);
  }
  private async completedClientCorrection(tx: Tx, taskId: string): Promise<boolean> {
    const latest = await tx.clientReviewItem.findFirst({ where: { taskId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
    if (!latest || latest.status !== "REVISION_REQUIRED") return false;
    const correction = await tx.clientCorrection.findUnique({ where: { itemId: latest.id }, select: { correctionTaskId: true } });
    if (!correction) return false;
    const task = await tx.task.findUnique({ where: { id: correction.correctionTaskId }, select: { status: true } });
    return task?.status === TaskStatus.COMPLETED;
  }
  async categories(actor: ProjectActor) {
    return this.transaction(async (tx) => { await this.account(tx, actor); return { categories: await tx.reviewCategory.findMany({ where: { organizationId: actor.organizationId }, orderBy: { name: "asc" } }) }; });
  }
  async createCategory(actor: ProjectActor, input: { name: string; reason: string }) {
    return this.transaction(async (tx) => {
      await this.account(tx, actor);
      if (actor.kind !== AccountKind.OWNER) throw new ForbiddenException("Owner category administration required");
      const normalizedName = input.name.trim().toLocaleLowerCase("en-US");
      const row = await tx.reviewCategory.create({ data: { organizationId: actor.organizationId, name: input.name.trim(), normalizedName, createdById: actor.accountId } });
      await tx.reviewCategoryChange.create({ data: { organizationId: actor.organizationId, categoryId: row.id, actorId: actor.accountId, action: "CREATED", reason: input.reason } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.category_changed", subjectType: "review_category", subjectId: row.id, reason: input.reason, after: { categoryId: row.id, name: row.name, active: true } });
      return row;
    });
  }
  async setCategoryActive(actor: ProjectActor, id: string, input: { active: boolean; reason: string }) {
    return this.transaction(async (tx) => {
      await this.account(tx, actor);
      if (actor.kind !== AccountKind.OWNER) throw new ForbiddenException("Owner category administration required");
      const row = await tx.reviewCategory.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!row) throw new NotFoundException("Category not found");
      if (row.active === input.active) throw new ConflictException("Category is already in this state");
      const updated = await tx.reviewCategory.update({ where: { id }, data: { active: input.active } });
      await tx.reviewCategoryChange.create({ data: { organizationId: actor.organizationId, categoryId: id, actorId: actor.accountId, action: input.active ? "ACTIVATED" : "DEACTIVATED", reason: input.reason } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.category_changed", subjectType: "review_category", subjectId: id, reason: input.reason, before: { active: row.active }, after: { categoryId: id, name: row.name, active: input.active } });
      return updated;
    });
  }
  /** Named, current review obligations; generic task review phases are not obligations. */
  async actionable(actor: ProjectActor, offset = 0, limit = 25) {
    return this.db.$transaction(async tx => {
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { timezone: true } });
      const readAt = new Date();
      const result = await withAuthorizationReadTime(tx, readAt, () => this.actionableInTransaction(tx, actor, readAt, organization.timezone));
      return { ...result, items: result.items.slice(offset, offset + limit), offset, limit };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
  }

  async actionableInTransaction(tx: Prisma.TransactionClient, actor: ProjectActor, readAt: Date, _timezone: string) {
      void _timezone;
      const account = await this.account(tx, actor);
      const items = [];
      if (actor.kind === AccountKind.STAFF && account.employee) {
        const rounds = await tx.reviewRound.findMany({ where: { organizationId: actor.organizationId,
          reviewerEmployeeId: account.employee.id, status: { in: [InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW] }
        } });
        for (const candidate of rounds) {
          try {
            const { row, project, round, submission } = await this.round(tx, actor, candidate.id);
            if (project.status !== ProjectStatus.ACTIVE || row.requiresReassignment) continue;
            if (round.status === InternalReviewStatus.SUBMITTED ? row.status !== TaskStatus.SUBMITTED_INTERNAL_REVIEW : round.status !== InternalReviewStatus.IN_REVIEW || row.status !== TaskStatus.IN_INTERNAL_REVIEW) continue;
            const [latest, assignment] = await Promise.all([
              tx.reviewSubmission.findFirst({ where: { organizationId: actor.organizationId, taskId: row.id }, orderBy: [{ roundNumber: "desc" }, { id: "desc" }], select: { id: true } }),
              tx.reviewAssignment.findUnique({ where: { taskId: row.id } })
            ]);
            if (latest?.id !== submission.id || assignment?.reviewerEmployeeId !== round.reviewerEmployeeId) continue;
            await this.reviewerAuthority(tx, actor, project, round, submission.submittedById, row.primaryOwnerEmployeeId, account);
            items.push({ source: "review" as const, sourceId: round.id, roundId: round.id, taskId: row.id,
              title: row.title, project: { id: project.id, title: project.title }, responsibility: "assigned_reviewer" as const,
              reason: round.status === InternalReviewStatus.SUBMITTED ? "review_start_required" as const : "review_decision_required" as const,
              deadline: row.committedDueDate ?? row.targetDate,
              destination: `/reviews?taskId=${encodeURIComponent(row.id)}&roundId=${encodeURIComponent(round.id)}`, readAt });
          } catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException || error instanceof ConflictException)) throw error; }
        }
      }
      items.sort((a, b) => a.deadline.getTime() - b.deadline.getTime() || a.sourceId.localeCompare(b.sourceId));
      return { source: "review" as const, total: items.length, items, readAt };

  }
  async inbox(actor: ProjectActor, offset = 0, limit = 50, personal = false, filters: { historical?: boolean; projectId?: string; scope?: "mine" | "accessible"; queue?: "waiting" | "corrections" | "resubmitted" | "history"; q?: string; sort?: "project" | "due" } = {}) {
    return this.transaction(async (tx) => {
      const account = await this.account(tx, actor);
      if (personal && (!account.employee || account.employee.state !== EmployeeState.ACTIVE || account.employee.organizationId !== actor.organizationId)) return { total: 0, items: [] };
      const mine = filters.scope === "mine" || personal;
      const queue = filters.queue ?? (filters.historical ? "history" : undefined);
      if (mine && (!account.employee || account.employee.state !== EmployeeState.ACTIVE || account.employee.organizationId !== actor.organizationId)) return { total: 0, items: [] };
      const status = queue === "waiting" ? { in: [InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW] } : queue === "corrections" ? InternalReviewStatus.CORRECTIONS_REQUIRED : undefined;
      const reviewerOnly = mine || actor.kind === AccountKind.STAFF && filters.scope !== "accessible";
      const rounds = await tx.reviewRound.findMany({ where: { organizationId: actor.organizationId, ...(reviewerOnly ? { reviewerEmployeeId: account.employee!.id } : {}), ...(filters.projectId ? { projectId: filters.projectId } : {}), ...(status ? { status } : {}), ...(!queue && !filters.historical ? { status: { in: [InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW] } } : {}) }, orderBy: { id: "desc" } });
      const items: Array<{ roundId: string; taskId: string; taskTitle: string; projectId: string; projectTitle: string; roundNumber: number; status: InternalReviewStatus; dueDate: Date; reviewerName: string; submitterName: string; revisionLabel?: string }> = [];
      const search = filters.q?.trim().toLocaleLowerCase("en-US");
      for (const round of rounds) {
        try {
          const { row, project, submission } = await this.round(tx, actor, round.id);
          if (queue === "corrections" || queue === "resubmitted") {
            const latest = await tx.reviewSubmission.findFirst({ where: { taskId: row.id, projectId: project.id, organizationId: actor.organizationId }, orderBy: [{ roundNumber: "desc" }, { id: "desc" }], select: { id: true } });
            if (latest?.id !== submission.id) continue;
          }
          const active = project.status === ProjectStatus.ACTIVE && new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW]).has(row.status);
          if (!queue && !filters.historical && !active) continue;
          if (queue === "waiting" && !active) continue;
          if (queue === "corrections" && (project.status !== ProjectStatus.ACTIVE || row.status !== TaskStatus.CORRECTIONS_REQUIRED)) continue;
          if (queue === "resubmitted" && (!active || submission.roundNumber <= 1)) continue;
          if (personal && (row.primaryOwnerEmployeeId === round.reviewerEmployeeId || submission.submittedById === actor.accountId)) continue;
          if (reviewerOnly) await this.candidate(tx, actor, project, round.reviewerEmployeeId, true);
          const revision = submission.revisionId ? await tx.documentRevision.findUniqueOrThrow({ where: { id: submission.revisionId } }) : null;
          const reviewer = await tx.employee.findUnique({ where: { id: round.reviewerEmployeeId }, include: { account: { select: { normalizedEmail: true } } } });
          const submitter = await tx.account.findUnique({ where: { id: submission.submittedById }, select: { normalizedEmail: true } });
          const revisionLabel = revision ? `${revision.series}${revision.number}` : "";
          const reviewerName = reviewer?.account.normalizedEmail ?? ""; const submitterName = submitter?.normalizedEmail ?? "";
          if (search && ![row.title, project.title, revisionLabel, reviewerName, submitterName].some((value) => value.toLocaleLowerCase("en-US").includes(search))) continue;
          items.push({ roundId: round.id, taskId: row.id, taskTitle: row.title, projectId: project.id, projectTitle: project.title, roundNumber: submission.roundNumber, status: round.status, dueDate: row.committedDueDate ?? row.targetDate, reviewerName, submitterName, ...(revision ? { revisionLabel } : {}) });
        } catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
      }
      if (filters.sort) items.sort((a, b) => { const comparison = filters.sort === "project" ? a.projectTitle.localeCompare(b.projectTitle, "en-US", { sensitivity: "base" }) : a.dueDate.getTime() - b.dueDate.getTime(); return comparison || a.roundId.localeCompare(b.roundId); });
      return { total: items.length, items: items.slice(offset, offset + limit) };
    });
  }
  /** INT public minimal review assignment port; no confidential evidence is exported. */
  async calendarAssignments(actor:ProjectActor,tx:Tx) {
    const account=await this.account(tx,actor), result:Array<{id:string;date:Date;version:number;updatedAt:Date}>=[];
    if(!account.employee)return result;
    await tx.$queryRaw`SELECT "taskId" FROM review_assignments WHERE "organizationId"=${actor.organizationId}::uuid AND "reviewerEmployeeId"=${account.employee.id}::uuid FOR SHARE`;
    const assignments=await tx.reviewAssignment.findMany({where:{organizationId:actor.organizationId,reviewerEmployeeId:account.employee.id}});
    for(const assignment of assignments){
      try {
        await tx.$queryRaw`SELECT id FROM tasks WHERE id=${assignment.taskId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM review_rounds WHERE "taskId"=${assignment.taskId}::uuid ORDER BY id FOR SHARE`;
        const context=await this.task(tx,actor,assignment.taskId),round=await tx.reviewRound.findFirst({where:{taskId:assignment.taskId,reviewerEmployeeId:account.employee.id,status:{in:["SUBMITTED","IN_REVIEW"]}}});
        if(!round||context.project.status!=="ACTIVE"||!["SUBMITTED_INTERNAL_REVIEW","IN_INTERNAL_REVIEW"].includes(context.row.status)||context.row.primaryOwnerEmployeeId===account.employee.id)continue;
        await this.candidate(tx,actor,context.project,account.employee.id,true);
        const submission=await tx.reviewSubmission.findUniqueOrThrow({where:{id:round.submissionId}});
        if(submission.revisionId)await this.revisionAccess(tx,actor,submission.revisionId,context.project.id);
        result.push({id:assignment.taskId,date:context.row.committedDueDate??context.row.targetDate,version:context.row.version,updatedAt:assignment.assignedAt});
      }catch(error){if(!(error instanceof ForbiddenException||error instanceof NotFoundException))throw error;}
    }
    return result;
  }
  async detail(actor: ProjectActor, taskId: string) {
    return this.transaction(async (tx) => {
      const { row, project, account } = await this.task(tx, actor, taskId);
      const routing = await tx.taskReviewRoutingAttempt.findFirst({ where: { taskId }, orderBy: { createdAt: "desc" }, select: { status: true, blockedReason: true } });
      const routingAuthorization = await tx.taskReviewRoutingAuthorization.findFirst({ where: { taskId, revokedAt: null }, select: { id: true } });
      const assignment = await tx.reviewAssignment.findUnique({ where: { taskId } });
      const submissions = await tx.reviewSubmission.findMany({ where: { taskId }, orderBy: { roundNumber: "asc" } });
      const rounds = [];
      for (const submission of submissions) {
        if (submission.revisionId) await this.revisionAccess(tx, actor, submission.revisionId, project.id);
        const round = await tx.reviewRound.findUniqueOrThrow({ where: { submissionId: submission.id } });
        const reviewer = await tx.employee.findUniqueOrThrow({ where: { id: round.reviewerEmployeeId }, include: { account: true } });
        const submitter = await tx.account.findUniqueOrThrow({ where: { id: submission.submittedById } });
        const revision = submission.revisionId ? await tx.documentRevision.findUniqueOrThrow({ where: { id: submission.revisionId } }) : null;
        const work = submittedEvidence(submission.taskSnapshot);
        const evidence = revision || work?.fileId ? await this.documents.authorizeFile(tx, actor, revision?.fileId ?? work!.fileId!) : null;
        if (work?.fileId && (work.blobId !== evidence?.blob.id || work.sha256 !== evidence.blob.sha256)) throw new ConflictException("Exact submitted evidence is unavailable");
        const comments = [];
        for (const item of await tx.reviewComment.findMany({ where: { roundId: round.id }, orderBy: { createdAt: "asc" } })) {
          if (item.markupFileId) await this.markup(tx, actor, project.id, item.markupFileId);
          const author = await tx.account.findUniqueOrThrow({ where: { id: item.authorId } });
          comments.push({ id: item.id, authorName: author.normalizedEmail, comment: item.comment, annotations: item.annotations, markupFileId: item.markupFileId, createdAt: item.createdAt });
        }
        const escalations = await tx.reviewEscalation.findMany({ where: { roundId: round.id }, orderBy: { createdAt: "asc" } });
        rounds.push({ id: round.id, roundNumber: submission.roundNumber, status: round.status, taskVersion: submission.taskVersion, submittedAt: submission.submittedAt, submittedByName: submitter.normalizedEmail, taskSnapshot: submission.taskSnapshot, revisionId: submission.revisionId, revisionFileId: revision?.fileId ?? work?.fileId ?? null, revisionFileMimeType: evidence?.blob.mimeType ?? null, revisionFileName: evidence?.blob.fileName ?? null, revisionLabel: revision ? `${revision.series}${revision.number}` : null, reviewerName: reviewer.account.normalizedEmail, comments, escalations: escalations.map((item) => ({ id: item.id, recipientAccountId: item.recipientAccountId, reason: item.reason, createdAt: item.createdAt })), correctionTaskId: round.correctionTaskId, decision: round.decidedAt ? { kind: round.status, comment: round.decisionComment, severity: round.severity, categoryName: round.categoryName, decidedAt: round.decidedAt } : null, withdrawal: round.withdrawnAt ? { reason: round.withdrawalReason, at: round.withdrawnAt, actorId: round.withdrawnById } : null });
      }
      let configureClientRouting = false;
      try { await new ClientPortalScopeService(this.database, this.authorization).staffAuthority(tx, actor, project.id, "manage"); configureClientRouting = project.status === ProjectStatus.ACTIVE; } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      let assignReviewer = false;
      try { await this.manager(tx, actor, project); assignReviewer = project.status === ProjectStatus.ACTIVE; } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      const reviewerCandidates = [];
      const correctionOwnerCandidates = [];
      if (assignReviewer) for (const candidate of await tx.projectAssignment.findMany({ where: { projectId: project.id, revokedAt: null } })) {
        try { const eligible = await this.candidate(tx, actor, project, candidate.employeeId); const account = await tx.account.findUniqueOrThrow({ where: { id: eligible.accountId } }); correctionOwnerCandidates.push({ employeeId: candidate.employeeId, name: account.normalizedEmail }); await this.candidate(tx, actor, project, candidate.employeeId, true); if (candidate.employeeId !== row.primaryOwnerEmployeeId && eligible.accountId !== submissions.at(-1)?.submittedById) reviewerCandidates.push({ employeeId: candidate.employeeId, name: account.normalizedEmail }); }
        catch (error) { if (!(error instanceof ForbiddenException || error instanceof ConflictException)) throw error; }
      }
      const availableRevisions = [];
      const previousRevision = submissions.at(-1)?.revisionId ? await tx.documentRevision.findUniqueOrThrow({ where: { id: submissions.at(-1)!.revisionId! } }) : null;
      for (const revision of await tx.documentRevision.findMany({ where: { projectId: project.id, series: { in: ["R", "CR"] }, state: "WORKING", ...(previousRevision ? { drawingId: previousRevision.drawingId, ordinal: { gt: previousRevision.ordinal } } : {}) }, orderBy: { createdAt: "desc" } })) {
        try { await this.documents.authorizeFile(tx, actor, revision.fileId); availableRevisions.push({ id: revision.id, label: `${revision.series}${revision.number}`, state: revision.state }); }
        catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      }
      const availableMarkupFiles = [];
      for (const document of await tx.document.findMany({ where: { organizationId: actor.organizationId, projectId: project.id }, include: { blobs: { orderBy: { createdAt: "asc" }, take: 1 } }, orderBy: { createdAt: "desc" }, take: 200 })) {
        const blob = document.blobs[0];
        if (!blob || !/pdf|image/.test(blob.mimeType)) continue;
        try { await this.documents.authorizeFile(tx, actor, document.id); availableMarkupFiles.push({ id: document.id, fileName: blob.fileName, mimeType: blob.mimeType }); }
        catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
      }
      const latest = rounds.at(-1);
      const correctionComplete = !!latest?.correctionTaskId && (await tx.task.findUnique({ where: { id: latest.correctionTaskId }, select: { status: true } }))?.status === TaskStatus.COMPLETED;
      const owner = account.employee?.id === row.primaryOwnerEmployeeId;
      let reviewer = false;
      if (latest && actor.kind === AccountKind.STAFF) {
        try { await this.reviewerAuthority(tx, actor, project, await tx.reviewRound.findUniqueOrThrow({ where: { id: latest.id } }), submissions.at(-1)!.submittedById, row.primaryOwnerEmployeeId, account); reviewer = true; }
        catch (error) { if (!(error instanceof ForbiddenException || error instanceof ConflictException)) throw error; }
      }
      let planning = false;
      let deadline = false;
      if (reviewer) try { await this.planningAuthority(tx, actor, project); planning = true; await this.planningAuthority(tx, actor, project, true); deadline = true; }
      catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      const openRound = reviewer && !!latest && project.status === ProjectStatus.ACTIVE && !row.requiresReassignment && new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(latest.status as InternalReviewStatus) && new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW]).has(row.status);
      const priorSubmitter = submissions.at(-1) ? await tx.employee.findUnique({ where: { accountId: submissions.at(-1)!.submittedById } }) : null;
      const exitRecovery = priorSubmitter?.state === EmployeeState.EXITED && priorSubmitter.id !== row.primaryOwnerEmployeeId;
      const clientCorrectionResubmit = !!latest && row.status === TaskStatus.IN_PROGRESS && latest.status === InternalReviewStatus.APPROVED && await this.completedClientCorrection(tx, row.id);
      return {
        task: { id: row.id, title: row.title, status: row.status, version: row.version, priority: row.priority, committedDueDate: row.committedDueDate?.toISOString().slice(0, 10) ?? null, reviewRequirement: row.reviewRequirement, projectId: project.id },
        assignment: assignment ? { reviewerEmployeeId: assignment.reviewerEmployeeId, reviewerName: (await tx.employee.findUniqueOrThrow({ where: { id: assignment.reviewerEmployeeId }, include: { account: true } })).account.normalizedEmail } : null,
        rounds, categories: await tx.reviewCategory.findMany({ where: { organizationId: actor.organizationId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }), reviewerCandidates, correctionOwnerCandidates, availableRevisions, availableMarkupFiles, routing, automaticClientRouting: !!routingAuthorization,
        capabilities: {
          assignReviewer, configureClientRouting,
          submit: owner && project.status === ProjectStatus.ACTIVE && !!assignment && !row.requiresReassignment && (row.status === TaskStatus.IN_PROGRESS && (!latest || latest.status === InternalReviewStatus.WITHDRAWN || exitRecovery && (latest.status === InternalReviewStatus.APPROVED || latest.status === InternalReviewStatus.CORRECTIONS_REQUIRED && correctionComplete) || clientCorrectionResubmit) || row.status === TaskStatus.CORRECTIONS_REQUIRED && latest?.status === InternalReviewStatus.CORRECTIONS_REQUIRED && correctionComplete),
          start: openRound && latest?.status === InternalReviewStatus.SUBMITTED,
          comment: openRound,
          decide: openRound,
          escalate: openRound,
          withdraw: assignReviewer && project.status === ProjectStatus.ACTIVE && !row.requiresReassignment && row.status === TaskStatus.IN_PROGRESS && !!latest && new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(latest.status as InternalReviewStatus) && priorSubmitter?.state === EmployeeState.EXITED && priorSubmitter.id !== row.primaryOwnerEmployeeId,
          changePriority: openRound && planning,
          changeDeadline: openRound && deadline,
          assignCorrection: assignReviewer && !row.requiresReassignment && (row.status === TaskStatus.CORRECTIONS_REQUIRED || row.status === TaskStatus.IN_PROGRESS && exitRecovery) && latest?.status === InternalReviewStatus.CORRECTIONS_REQUIRED && !latest.correctionTaskId,
          complete: (owner || actor.kind === AccountKind.OWNER) && row.reviewRequirement === TaskReviewRequirement.INTERNAL && (row.status === TaskStatus.INTERNAL_APPROVED || row.status === TaskStatus.IN_PROGRESS && latest?.status === InternalReviewStatus.APPROVED && exitRecovery && this.approvedScopeMatches(row, submissions.at(-1)!.taskSnapshot)),
          manageCategories: actor.kind === AccountKind.OWNER
        }
      };
    });
  }
  async assignReviewer(actor: ProjectActor, taskId: string, input: { employeeId: string; expectedVersion: number; reason: string }) {
    await this.transaction(async (tx) => {
      const { row, project } = await this.task(tx, actor, taskId, true);
      await this.manager(tx, actor, project);
      if (row.version !== input.expectedVersion || row.requiresReassignment || !new Set<TaskStatus>([TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS, TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW, TaskStatus.CORRECTIONS_REQUIRED]).has(row.status)) throw new ConflictException("Task changed or is unavailable for reviewer assignment");
      if (!new Set<TaskReviewRequirement>([TaskReviewRequirement.INTERNAL, TaskReviewRequirement.BOTH]).has(row.reviewRequirement)) throw new ConflictException("Task does not require internal review");
      const reviewer = await this.candidate(tx, actor, project, input.employeeId, true);
      if (reviewer.id === row.primaryOwnerEmployeeId) throw new ConflictException("Task owner cannot review their own submission");
      const existing = await tx.reviewAssignment.findUnique({ where: { taskId } });
      if (existing?.reviewerEmployeeId === reviewer.id) throw new ConflictException("Reviewer is already assigned");
      const latest = await tx.reviewSubmission.findFirst({ where: { taskId }, orderBy: { roundNumber: "desc" } });
      if (latest?.submittedById === reviewer.accountId) throw new ConflictException("Submitter cannot become reviewer of their own round");
      if (existing) await tx.reviewAssignment.update({ where: { taskId }, data: { reviewerEmployeeId: reviewer.id, assignedById: actor.accountId, reason: input.reason, assignedAt: new Date() } });
      else await tx.reviewAssignment.create({ data: { organizationId: actor.organizationId, projectId: project.id, taskId, reviewerEmployeeId: reviewer.id, assignedById: actor.accountId, reason: input.reason } });
      await tx.reviewAssignmentChange.create({ data: { organizationId: actor.organizationId, projectId: project.id, taskId, oldReviewerEmployeeId: existing?.reviewerEmployeeId ?? null, newReviewerEmployeeId: reviewer.id, actorId: actor.accountId, reason: input.reason } });
      if (latest) { const round = await tx.reviewRound.findUniqueOrThrow({ where: { submissionId: latest.id } }); if (new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(round.status)) await tx.reviewRound.update({ where: { id: round.id }, data: { reviewerEmployeeId: reviewer.id } }); }
      await tx.task.update({ where: { id: taskId, version: row.version }, data: { version: { increment: 1 } } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.updated", subjectType: "task", subjectId: taskId, reason: input.reason, after: { version: row.version + 1, reviewerEmployeeId: reviewer.id } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.assigned", subjectType: "review", subjectId: taskId, reason: input.reason, after: { taskId, projectId: project.id, oldReviewerEmployeeId: existing?.reviewerEmployeeId ?? null, reviewerEmployeeId: reviewer.id } });
    });
    return this.detail(actor, taskId);
  }

  /** S27 read-only candidate source; reuses the ordinary reviewer eligibility and independence guards. */
  async assistanceReviewerCandidates(actor: ProjectActor, tx: Tx, taskId: string, currentTeamId: string, currentTeamBranchId: string, broaderSearch = false) {
    const { row, project } = await this.task(tx, actor, taskId);
    await this.manager(tx, actor, project);
    if (row.requiresReassignment || !new Set<TaskStatus>([TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS, TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW, TaskStatus.CORRECTIONS_REQUIRED]).has(row.status) || !new Set<TaskReviewRequirement>([TaskReviewRequirement.INTERNAL, TaskReviewRequirement.BOTH]).has(row.reviewRequirement)) throw new ConflictException("Task is not eligible for reviewer suggestions");
    const latest = await tx.reviewSubmission.findFirst({ where: { taskId, organizationId: actor.organizationId }, orderBy: [{ submittedAt: "desc" }, { id: "desc" }] });
    const assignments = await tx.projectAssignment.findMany({ where: { projectId: project.id, organizationId: actor.organizationId, revokedAt: null, ...(!broaderSearch ? { employee: { homeTeamId: currentTeamId, homeBranchId: currentTeamBranchId } } : {}) }, select: { employeeId: true }, orderBy: { employeeId: "asc" } });
    const candidates: Array<{ employeeId: string; label: string; teamId: string; branchId: string }> = [];
    for (const assignment of assignments) {
      if (assignment.employeeId === row.primaryOwnerEmployeeId) continue;
      try {
        const employee = await this.candidate(tx, actor, project, assignment.employeeId, true);
        if (latest?.submittedById === employee.accountId) continue;
        const account = await tx.account.findUnique({ where: { id: employee.accountId }, select: { normalizedEmail: true } });
        if (account) candidates.push({ employeeId: employee.id, label: employee.employeeCode || account.normalizedEmail, teamId: employee.homeTeamId, branchId: employee.homeBranchId });
      } catch (error) { if (!(error instanceof ForbiddenException) && !(error instanceof ConflictException)) throw error; }
    }
    return { task: { id: row.id, projectId: project.id, ownerEmployeeId: row.primaryOwnerEmployeeId, reviewRequirement: row.reviewRequirement, version: row.version }, candidates };
  }

  async assistanceOutcome(actor: ProjectActor, tx: Tx, taskId: string, employeeId: string, currentTeamId: string, currentTeamBranchId: string, broaderSearch = false) {
    const { row, project } = await this.task(tx, actor, taskId);
    await this.manager(tx, actor, project);
    if (!new Set<TaskReviewRequirement>([TaskReviewRequirement.INTERNAL, TaskReviewRequirement.BOTH]).has(row.reviewRequirement)) throw new ConflictException("Task no longer requires internal review");
    const assignment = await tx.reviewAssignment.findFirst({ where: { taskId, organizationId: actor.organizationId } });
    if (!assignment || assignment.reviewerEmployeeId !== employeeId) throw new ConflictException("Current reviewer assignment does not match the selected employee");
    const candidates = await this.assistanceReviewerCandidates(actor, tx, taskId, currentTeamId, currentTeamBranchId, broaderSearch);
    const current = candidates.candidates.find((candidate) => candidate.employeeId === employeeId);
    if (!current) throw new ConflictException("Current reviewer is no longer eligible");
    return { taskId, taskVersion: row.version, reviewerEmployeeId: employeeId, projectId: project.id };
  }
  async confirmedDrawings(actor: ProjectActor, projectId: string) {
    return this.transaction(async tx => {
      const { project } = await this.project(tx, actor, projectId);
      await this.authorization.assertPermission(actor.accountId, "document.view", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
      const approvals = await tx.clientFinalApproval.findMany({ where: { organizationId: actor.organizationId, projectId }, orderBy: { createdAt: "desc" } });
      const entries = [];
      for (const approval of approvals) {
        const snapshots = approval.itemSnapshot as Array<Record<string, unknown>>;
        for (const exact of snapshots) {
          const item = await tx.clientReviewItem.findFirst({ where: { id: String(exact.itemId), projectId, organizationId: actor.organizationId, packageId: approval.packageId } });
          if (!item) continue;
          const snapshot = item.snapshot as Record<string, unknown>;
          const work = submittedEvidence(snapshot);
          const fileId = work?.fileId ?? (typeof snapshot.fileId === "string" ? snapshot.fileId : null);
          if (!fileId && !work?.url) continue;
          try {
            if (fileId) { const file = await this.documents.authorizeFile(tx, actor, fileId); if (file.blob.id !== snapshot.blobId || file.blob.sha256 !== snapshot.sha256) continue; }
            entries.push({ id: `${approval.id}:${item.id}`, label: item.label, kind: work?.kind === "LINK" ? "LINK" : item.revisionId ? "DRAWING" : "FILE", fileId, url: work?.url ?? null, revisionId: item.revisionId, taskId: item.taskId, approvedAt: approval.createdAt, signatureName: approval.signatureName });
          } catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
        }
      }
      return { items: entries };
    });
  }

  async submit(actor: ProjectActor, taskId: string, input: { expectedVersion: number; reason: string; revisionId?: string | undefined; fileId?: string | undefined; reviewUrl?: string | undefined; annotations?: Annotation[] | undefined; markupFileId?: string | undefined }) {
    await this.transaction(async (tx) => {
      const { row, project, account } = await this.task(tx, actor, taskId, true);
      if ([input.revisionId, input.fileId, input.reviewUrl].filter(Boolean).length !== 1) throw new BadRequestException("Submit exactly one file, drawing revision or review link");
      if (row.version !== input.expectedVersion || row.requiresReassignment || !new Set<TaskStatus>([TaskStatus.IN_PROGRESS, TaskStatus.CORRECTIONS_REQUIRED]).has(row.status)) throw new ConflictException("Task changed or cannot be submitted");
      if (!new Set<TaskReviewRequirement>([TaskReviewRequirement.INTERNAL, TaskReviewRequirement.BOTH]).has(row.reviewRequirement) || account.employee?.id !== row.primaryOwnerEmployeeId) throw new ForbiddenException("Current task owner with internal review is required");
      const assignment = await tx.reviewAssignment.findUnique({ where: { taskId } });
      if (!assignment) throw new ConflictException("Assign a reviewer before submission");
      const reviewer = await this.candidate(tx, actor, project, assignment.reviewerEmployeeId, true);
      if (account.employee?.id === assignment.reviewerEmployeeId) throw new ConflictException("Submitter cannot review their own submission");
      const last = await tx.reviewSubmission.findFirst({ where: { taskId }, orderBy: { roundNumber: "desc" } });
      const prior = last ? await tx.reviewRound.findUniqueOrThrow({ where: { submissionId: last.id } }) : null;
      const priorSubmitter = last ? await tx.employee.findUnique({ where: { accountId: last.submittedById } }) : null;
      const exitRecovery = !!last && priorSubmitter?.state === EmployeeState.EXITED && priorSubmitter.id !== row.primaryOwnerEmployeeId;
      const clientCorrectionResubmit = !!last && row.status === TaskStatus.IN_PROGRESS && prior?.status === InternalReviewStatus.APPROVED && await this.completedClientCorrection(tx, row.id);
      if (last && row.status === TaskStatus.IN_PROGRESS && prior?.status !== InternalReviewStatus.WITHDRAWN && !(exitRecovery && new Set<InternalReviewStatus>([InternalReviewStatus.APPROVED, InternalReviewStatus.CORRECTIONS_REQUIRED]).has(prior!.status)) && !clientCorrectionResubmit) throw new ConflictException("A prior round requires management resolution before resubmission");
      if (row.status === TaskStatus.CORRECTIONS_REQUIRED) {
        if (!prior || prior.status !== InternalReviewStatus.CORRECTIONS_REQUIRED || !prior.correctionTaskId || (await tx.task.findUniqueOrThrow({ where: { id: prior.correctionTaskId } })).status !== TaskStatus.COMPLETED) throw new ConflictException("Complete the assigned correction task before resubmission");
      }
      if (row.status === TaskStatus.IN_PROGRESS && prior?.status === InternalReviewStatus.CORRECTIONS_REQUIRED && (!prior.correctionTaskId || (await tx.task.findUniqueOrThrow({ where: { id: prior.correctionTaskId } })).status !== TaskStatus.COMPLETED)) throw new ConflictException("Complete the assigned correction task before resubmission");
      let revision = null;
      if (input.revisionId) {
        revision = await this.revisionAccess(tx, actor, input.revisionId, project.id);
        await this.documents.authorizeFile(tx, { accountId: reviewer.accountId, organizationId: actor.organizationId, kind: AccountKind.STAFF }, revision.fileId);
        if (!(revision.series === "R" || revision.series === "CR") || revision.state !== "WORKING" || last?.revisionId === revision.id) throw new ConflictException("A new Working R or CR revision is required");
        if (last?.revisionId) { const old = await tx.documentRevision.findUniqueOrThrow({ where: { id: last.revisionId } }); if (old.drawingId !== revision.drawingId || revision.ordinal <= old.ordinal) throw new ConflictException("Revised submission must be a newer revision of the same drawing"); }
      } else if (last?.revisionId) throw new ConflictException("Revised drawing submission needs a new exact R or CR revision");
      const file = input.fileId ? await this.documents.authorizeFile(tx, actor, input.fileId) : null;
      if (file && file.document.projectId !== project.id) throw new ForbiddenException("Evidence must belong to this project");
      if (file) await this.documents.authorizeFile(tx, { accountId: reviewer.accountId, organizationId: actor.organizationId, kind: AccountKind.STAFF }, file.document.id);
      const evidence = workEvidence(revision ? { kind: "DRAWING", fileId: revision.fileId, blobId: revision.blobId, sha256: revision.sha256, url: null } : file ? { kind: "FILE", fileId: file.document.id, blobId: file.blob.id, sha256: file.blob.sha256, url: null } : { kind: "LINK", fileId: null, blobId: null, sha256: null, url: input.reviewUrl! });
      await this.markup(tx, actor, project.id, input.markupFileId);
      const updated = await this.taskState(tx, actor, row, TaskStatus.SUBMITTED_INTERNAL_REVIEW, input.reason);
      const submission = await tx.reviewSubmission.create({ data: { organizationId: actor.organizationId, projectId: project.id, taskId, ...(revision ? { revisionId: revision.id } : {}), taskVersion: updated.version, taskSnapshot: { workEvidence: evidence, title: row.title, description: row.description, ownerEmployeeId: row.primaryOwnerEmployeeId, priority: row.priority, targetDate: row.targetDate.toISOString().slice(0, 10), committedDueDate: row.committedDueDate?.toISOString().slice(0, 10) ?? null, startDate: row.startDate?.toISOString().slice(0, 10) ?? null, estimatedHours: row.estimatedHours === null ? null : Number(row.estimatedHours), planItemId: row.planItemId, tags: row.tags, checklist: row.checklist, ...(revision ? { revisionId: revision.id, sha256: revision.sha256 } : {}) }, roundNumber: (last?.roundNumber ?? 0) + 1, submittedById: actor.accountId, reason: input.reason } });
      const round = await tx.reviewRound.create({ data: { organizationId: actor.organizationId, projectId: project.id, taskId, submissionId: submission.id, reviewerEmployeeId: assignment.reviewerEmployeeId } });
      const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.requested", subjectType: "review", subjectId: round.id, reason: input.reason, after: { taskId, projectId: project.id, submissionId: submission.id, roundId: round.id, roundNumber: submission.roundNumber, ...(revision ? { drawingId: revision.drawingId, revisionId: revision.id, blobId: revision.blobId, sha256: revision.sha256 } : {}) } });
      if (revision) await this.revisions.consumeReviewState(tx, revision.id, await this.auditId(tx, eventId));
      if (input.annotations?.length || input.markupFileId) {
        const comment = await tx.reviewComment.create({ data: { organizationId: actor.organizationId, projectId: project.id, roundId: round.id, authorId: actor.accountId, comment: input.reason, annotations: input.annotations ?? [], markupFileId: input.markupFileId ?? null, reason: input.reason } });
        await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.commented", subjectType: "review", subjectId: round.id, reason: input.reason, after: { taskId, projectId: project.id, roundId: round.id, commentId: comment.id, markupFileId: input.markupFileId ?? null, annotationCount: input.annotations?.length ?? 0 } });
      }
    });
    return this.detail(actor, taskId);
  }
  async start(actor: ProjectActor, roundId: string, reason: string) {
    const taskId = await this.transaction(async (tx) => {
      const { row, project, round, submission, account } = await this.round(tx, actor, roundId, true);
      if (round.status !== InternalReviewStatus.SUBMITTED || row.status !== TaskStatus.SUBMITTED_INTERNAL_REVIEW) throw new ConflictException("Review is no longer awaiting start");
      await this.reviewerAuthority(tx, actor, project, round, submission.submittedById, row.primaryOwnerEmployeeId, account);
      await tx.reviewRound.update({ where: { id: roundId }, data: { status: InternalReviewStatus.IN_REVIEW, startedAt: new Date() } });
      await this.taskState(tx, actor, row, TaskStatus.IN_INTERNAL_REVIEW, reason);
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.started", subjectType: "review", subjectId: roundId, reason, after: { taskId: row.id, projectId: project.id, roundId } });
      return row.id;
    });
    return this.detail(actor, taskId);
  }
  private async reviewerAuthority(tx: Tx, actor: ProjectActor, project: { id: string; branchId: string }, round: { reviewerEmployeeId: string }, submittedById: string, taskOwnerEmployeeId: string, account: { employee: { id: string } | null }) {
    if (actor.kind !== AccountKind.STAFF || account.employee?.id !== round.reviewerEmployeeId || actor.accountId === submittedById || account.employee.id === taskOwnerEmployeeId) throw new ForbiddenException("Only the assigned independent reviewer may decide");
    await this.candidate(tx, actor, project, round.reviewerEmployeeId, true);
  }
  private async planningAuthority(tx: Tx, actor: ProjectActor, project: { branchId: string }, deadline = false) {
    const scope = { kind: "BRANCH" as const, organizationId: actor.organizationId, branchId: project.branchId };
    await this.authorization.assertPermission(actor.accountId, "project.manage", scope, tx);
    await this.authorization.assertPermission(actor.accountId, "task.assign", scope, tx);
    if (deadline) await this.authorization.assertPermission(actor.accountId, "task.deadline_change", scope, tx);
  }
  async escalate(actor: ProjectActor, roundId: string, reason: string) {
    const taskId = await this.transaction(async (tx) => {
      const { row, project, round, submission, account } = await this.round(tx, actor, roundId, true);
      if (!new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(round.status) || !new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW]).has(row.status)) throw new ConflictException("Only an open review may be escalated");
      await this.reviewerAuthority(tx, actor, project, round, submission.submittedById, row.primaryOwnerEmployeeId, account);
      let recipientAccountId: string | null = null;
      if (project.currentLeadEmployeeId) {
        try {
          const lead = await this.candidate(tx, actor, project, project.currentLeadEmployeeId);
          if (lead.accountId !== actor.accountId) recipientAccountId = lead.accountId;
        } catch (error) { if (!(error instanceof ForbiddenException || error instanceof ConflictException)) throw error; }
      }
      if (!recipientAccountId) {
        const owner = await tx.account.findFirst({ where: { kind: AccountKind.OWNER, state: AccountState.ACTIVE } });
        if (!owner) throw new ConflictException("No active escalation recipient is available");
        recipientAccountId = owner.id;
      }
      const escalation = await tx.reviewEscalation.create({ data: { organizationId: actor.organizationId, projectId: project.id, roundId, actorId: actor.accountId, recipientAccountId, reason } });
      const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.escalated", subjectType: "review", subjectId: roundId, reason, after: { escalationId: escalation.id, recipientAccountId, taskId: row.id, projectId: project.id, roundId } });
      await this.notifications.createForEvent(tx, { eventId, recipientAccountId, channel: NotificationChannel.IN_APP, category: "review.escalated", title: "Internal review needs attention", body: "An assigned internal review was escalated. Open it to check current access and details.", internalRoute: `/reviews?taskId=${row.id}&roundId=${roundId}`, mandatory: true });
      return row.id;
    });
    return this.detail(actor, taskId);
  }
  async withdraw(actor: ProjectActor, roundId: string, input: { reason: string }) {
    const taskId = await this.transaction(async (tx) => {
      const { row, project, round, submission } = await this.round(tx, actor, roundId, true);
      await this.manager(tx, actor, project);
      if (!new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(round.status) || row.status !== TaskStatus.IN_PROGRESS || row.requiresReassignment) throw new ConflictException("Review withdrawal requires completed owner reassignment");
      const submitter = await tx.employee.findUnique({ where: { accountId: submission.submittedById } });
      if (!submitter || submitter.state !== EmployeeState.EXITED || submitter.id === row.primaryOwnerEmployeeId) throw new ConflictException("Only a round interrupted by the submitting owner's exit may be withdrawn");
      const latest = await tx.reviewSubmission.findFirst({ where: { taskId: row.id }, orderBy: { roundNumber: "desc" } });
      if (latest?.id !== submission.id) throw new ConflictException("Only the latest open round may be withdrawn");
      await tx.reviewRound.update({ where: { id: roundId }, data: { status: InternalReviewStatus.WITHDRAWN, withdrawnAt: new Date(), withdrawnById: actor.accountId, withdrawalReason: input.reason } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.withdrawn", subjectType: "review", subjectId: roundId, reason: input.reason, after: { taskId: row.id, projectId: project.id, roundId, submissionId: submission.id, previousSubmitterId: submission.submittedById, replacementOwnerEmployeeId: row.primaryOwnerEmployeeId } });
      return row.id;
    });
    return this.detail(actor, taskId);
  }
  async changePriority(actor: ProjectActor, roundId: string, input: { priority: TaskPriority; expectedVersion: number; reason: string }) {
    const taskId = await this.transaction(async (tx) => {
      const { row, project, round, submission, account } = await this.round(tx, actor, roundId, true);
      if (!new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(round.status) || !new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW]).has(row.status) || row.version !== input.expectedVersion || row.requiresReassignment || row.priority === input.priority) throw new ConflictException("Review priority cannot change in this state or version");
      await this.reviewerAuthority(tx, actor, project, round, submission.submittedById, row.primaryOwnerEmployeeId, account);
      await this.planningAuthority(tx, actor, project);
      const updated = await tx.task.update({ where: { id: row.id, version: row.version }, data: { priority: input.priority, version: { increment: 1 } } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.updated", subjectType: "task", subjectId: row.id, reason: input.reason, before: { priority: row.priority, version: row.version }, after: { priority: updated.priority, version: updated.version, reviewRoundId: roundId } });
      return row.id;
    });
    return this.detail(actor, taskId);
  }
  async changeDeadline(actor: ProjectActor, roundId: string, input: { committedDueDate: string; expectedVersion: number; reason: string }) {
    const taskId = await this.transaction(async (tx) => {
      const { row, project, round, submission, account } = await this.round(tx, actor, roundId, true);
      if (!new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(round.status) || !new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW]).has(row.status) || row.version !== input.expectedVersion || row.requiresReassignment) throw new ConflictException("Review deadline cannot change in this state or version");
      await this.reviewerAuthority(tx, actor, project, round, submission.submittedById, row.primaryOwnerEmployeeId, account);
      await this.planningAuthority(tx, actor, project, true);
      const nextDate = new Date(`${input.committedDueDate}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.committedDueDate) || Number.isNaN(nextDate.getTime()) || nextDate.toISOString().slice(0, 10) !== input.committedDueDate) throw new BadRequestException("Committed due date is invalid");
      const oldDate = row.committedDueDate?.toISOString().slice(0, 10) ?? null;
      if (oldDate === input.committedDueDate) throw new ConflictException("Committed due date must change");
      const updated = await tx.task.update({ where: { id: row.id, version: row.version }, data: { committedDueDate: nextDate, version: { increment: 1 } } });
      await tx.taskCommittedDateChange.create({ data: { organizationId: actor.organizationId, taskId: row.id, oldDate: row.committedDueDate, newDate: nextDate, actorId: actor.accountId, reason: input.reason, taskVersion: updated.version } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.deadline_changed", subjectType: "task", subjectId: row.id, reason: input.reason, before: { committedDueDate: oldDate, version: row.version }, after: { committedDueDate: input.committedDueDate, version: updated.version, reviewRoundId: roundId } });
      return row.id;
    });
    return this.detail(actor, taskId);
  }
  async comment(actor: ProjectActor, roundId: string, input: CommentInput) {
    const taskId = await this.transaction(async (tx) => {
      const { row, project, round, submission, account } = await this.round(tx, actor, roundId, true);
      if (!new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(round.status) || !new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW]).has(row.status)) throw new ConflictException("Review comments are closed");
      await this.reviewerAuthority(tx, actor, project, round, submission.submittedById, row.primaryOwnerEmployeeId, account);
      await this.markup(tx, actor, project.id, input.markupFileId);
      const comment = await tx.reviewComment.create({ data: { organizationId: actor.organizationId, projectId: project.id, roundId, authorId: actor.accountId, comment: input.comment, annotations: input.annotations ?? [], markupFileId: input.markupFileId ?? null, reason: input.reason } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.commented", subjectType: "review", subjectId: roundId, reason: input.reason, after: { taskId: row.id, projectId: project.id, roundId, commentId: comment.id, markupFileId: input.markupFileId ?? null, annotationCount: input.annotations?.length ?? 0 } });
      return row.id;
    });
    return this.detail(actor, taskId);
  }
  async decision(actor: ProjectActor, roundId: string, input: DecisionInput) {
    const taskId = await this.transaction(async (tx) => {
      const { row, project, round, submission, account } = await this.round(tx, actor, roundId, true);
      if (!new Set<InternalReviewStatus>([InternalReviewStatus.SUBMITTED, InternalReviewStatus.IN_REVIEW]).has(round.status) || !new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW]).has(row.status)) throw new ConflictException("Review already decided or task changed");
      await this.reviewerAuthority(tx, actor, project, round, submission.submittedById, row.primaryOwnerEmployeeId, account);
      await this.markup(tx, actor, project.id, input.markupFileId);
      let category = null;
      if (input.kind === "CORRECTIONS_REQUIRED") {
        if (!input.severity || !input.categoryId || !input.comment?.trim()) throw new BadRequestException("Correction needs comment, severity and category");
        category = await tx.reviewCategory.findFirst({ where: { id: input.categoryId, organizationId: actor.organizationId, active: true } });
        if (!category) throw new ConflictException("Correction category is unavailable");
      } else if (input.severity || input.categoryId) throw new BadRequestException("Approval cannot carry correction severity or category");
      const decidedAt = new Date();
      await tx.reviewRound.update({ where: { id: roundId }, data: { status: input.kind, decidedAt, decidedById: actor.accountId, decisionComment: input.comment?.trim() || input.reason, ...(category ? { severity: input.severity as InternalReviewSeverity, categoryId: category.id, categoryName: category.name } : {}) } });
      if (input.comment || input.annotations?.length || input.markupFileId) {
        const comment = await tx.reviewComment.create({ data: { organizationId: actor.organizationId, projectId: project.id, roundId, authorId: actor.accountId, comment: input.comment?.trim() || input.reason, annotations: input.annotations ?? [], markupFileId: input.markupFileId ?? null, reason: input.reason } });
        await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.commented", subjectType: "review", subjectId: roundId, reason: input.reason, after: { taskId: row.id, projectId: project.id, roundId, commentId: comment.id, markupFileId: input.markupFileId ?? null, annotationCount: input.annotations?.length ?? 0 } });
      }
      const revision = submission.revisionId ? await this.revisionAccess(tx, actor, submission.revisionId, project.id) : null;
      const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: input.kind === "APPROVED" ? "review.approved" : "review.correction_requested", subjectType: "review", subjectId: roundId, reason: input.reason, after: { taskId: row.id, projectId: project.id, roundId, submissionId: submission.id, decision: input.kind, ...(category ? { severity: input.severity!, categoryId: category.id, categoryName: category.name } : {}), ...(revision ? { drawingId: revision.drawingId, revisionId: revision.id, blobId: revision.blobId, sha256: revision.sha256 } : {}) } });
      if (revision) { const auditId = await this.auditId(tx, eventId); if (input.kind === "APPROVED") await this.revisions.consumeApproval(tx, revision.id, auditId, RevisionApprovalKind.INTERNAL); else await this.revisions.consumeReviewState(tx, revision.id, auditId); }
      await this.taskState(tx, actor, row, input.kind === "APPROVED" ? TaskStatus.INTERNAL_APPROVED : TaskStatus.CORRECTIONS_REQUIRED, input.reason);
      if (input.kind === "APPROVED" && row.reviewRequirement === TaskReviewRequirement.BOTH && submittedEvidence(submission.taskSnapshot)) {
        const authorization = await tx.taskReviewRoutingAuthorization.findFirst({ where: { taskId: row.id, revokedAt: null }, orderBy: { createdAt: "desc" } });
        if (authorization) {
          const attempt = await tx.taskReviewRoutingAttempt.create({ data: { organizationId: actor.organizationId, projectId: project.id, taskId: row.id, submissionId: submission.id, authorizationId: authorization.id } });
          await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.routing_changed", subjectType: "review_routing", subjectId: attempt.id, reason: "Queue client routing after independent internal approval", after: { projectId: project.id, taskId: row.id, submissionId: submission.id, authorizationId: authorization.id, status: "PENDING", blockedReason: null } });
        }
      }
      return row.id;
    });
    return this.detail(actor, taskId);
  }
  async assignCorrection(actor: ProjectActor, roundId: string, input: { ownerEmployeeId: string; reason: string }) {
    const taskId = await this.transaction(async (tx) => {
      const { row, project, round, submission } = await this.round(tx, actor, roundId, true);
      await this.manager(tx, actor, project);
      const latest = await tx.reviewSubmission.findFirst({ where: { taskId: row.id }, orderBy: { roundNumber: "desc" } });
      const submitter = row.status === TaskStatus.IN_PROGRESS ? await tx.employee.findUnique({ where: { accountId: submission.submittedById } }) : null;
      const exitRecovery = row.status === TaskStatus.IN_PROGRESS && submitter?.state === EmployeeState.EXITED && submitter.id !== row.primaryOwnerEmployeeId;
      if (round.status !== InternalReviewStatus.CORRECTIONS_REQUIRED || round.correctionTaskId || row.requiresReassignment || latest?.id !== submission.id || row.status !== TaskStatus.CORRECTIONS_REQUIRED && !exitRecovery) throw new ConflictException("Correction is unavailable or assigned");
      const owner = await this.candidate(tx, actor, project, input.ownerEmployeeId);
      const correction = await tx.task.create({ data: { organizationId: actor.organizationId, projectId: project.id, title: `Correct: ${row.title}`.slice(0, 160), description: "Complete the correction recorded in the linked internal review. Request access if the exact drawing is restricted.", type: TaskType.CORRECTION, priority: row.priority, targetDate: row.targetDate, primaryOwnerEmployeeId: owner.id, createdById: actor.accountId, reviewRequirement: TaskReviewRequirement.NONE } });
      await tx.taskStatusChange.create({ data: { organizationId: actor.organizationId, taskId: correction.id, fromStatus: null, toStatus: TaskStatus.NOT_STARTED, actorId: actor.accountId, reason: input.reason, taskVersion: 1 } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.created", subjectType: "task", subjectId: correction.id, reason: input.reason, after: { taskId: correction.id, projectId: project.id, ownerEmployeeId: owner.id, type: TaskType.CORRECTION, priority: correction.priority, targetDate: correction.targetDate.toISOString().slice(0, 10), version: 1 } });
      await tx.reviewRound.update({ where: { id: roundId }, data: { correctionTaskId: correction.id } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.correction_assigned", subjectType: "review", subjectId: roundId, reason: input.reason, after: { taskId: row.id, projectId: project.id, roundId, correctionTaskId: correction.id, ownerEmployeeId: owner.id } });
      return row.id;
    });
    return this.detail(actor, taskId);
  }
  async complete(actor: ProjectActor, taskId: string, input: { expectedVersion: number; reason: string }) {
    await this.transaction(async (tx) => {
      const { row, account } = await this.task(tx, actor, taskId, true);
      if (row.version !== input.expectedVersion || !new Set<TaskStatus>([TaskStatus.INTERNAL_APPROVED, TaskStatus.IN_PROGRESS]).has(row.status) || row.reviewRequirement !== TaskReviewRequirement.INTERNAL || row.requiresReassignment) throw new ConflictException("Task is not ready for internal-review completion");
      if (actor.kind !== AccountKind.OWNER && account.employee?.id !== row.primaryOwnerEmployeeId) throw new ForbiddenException("Current task owner required");
      const latest = await tx.reviewSubmission.findFirst({ where: { taskId }, orderBy: { roundNumber: "desc" } });
      if (!latest || (await tx.reviewRound.findUniqueOrThrow({ where: { submissionId: latest.id } })).status !== InternalReviewStatus.APPROVED) throw new ConflictException("Latest internal review is not approved");
      if (row.status === TaskStatus.IN_PROGRESS) {
        const submitter = await tx.employee.findUnique({ where: { accountId: latest.submittedById } });
        if (submitter?.state !== EmployeeState.EXITED || submitter.id === row.primaryOwnerEmployeeId || !this.approvedScopeMatches(row, latest.taskSnapshot)) throw new ConflictException("Exit-reassigned work differs from its approved submission; submit a new round");
      }
      await assertSubtasksCompleted(tx, actor.organizationId, taskId);
      await this.taskState(tx, actor, row, TaskStatus.COMPLETED, input.reason);
    });
    return this.detail(actor, taskId);
  }
}
