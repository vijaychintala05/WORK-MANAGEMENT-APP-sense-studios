import { approvedWorkMatches, submittedEvidence } from "./review-work-evidence.js";
import { ConflictException, ForbiddenException, Injectable, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { AccountKind, Prisma, TaskReviewRequirement, TaskStatus } from "./generated/prisma/client.js";
import { DatabaseService } from "./database.service.js";
import { ClientReviewService } from "./client-review.service.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { recordProjectEvent } from "./project-events.js";
import type { ProjectActor } from "./project.service.js";

class RoutingBlocked extends Error {
  constructor(readonly publicMessage: string) { super("Review routing blocked"); }
}

/** A failed publication never rolls back a valid internal review decision. */
@Injectable()
export class ReviewRoutingService implements OnModuleInit, OnModuleDestroy {
  private deliveryTimer: ReturnType<typeof setInterval> | undefined;
  private delivering = false;
  onModuleInit() {
    // Canonical staging runs the API without the separate general worker.
    // This dispatcher handles only persisted, approved client routing intents.
    this.deliveryTimer = setInterval(() => {
      if (this.delivering) return;
      this.delivering = true;
      void this.runBatch().catch(() => console.error("Review routing delivery failed")).finally(() => { this.delivering = false; });
    }, 5_000);
    this.deliveryTimer.unref();
  }
  onModuleDestroy() { if (this.deliveryTimer) clearInterval(this.deliveryTimer); }

  constructor(private readonly database: DatabaseService, private readonly clients: ClientReviewService, private readonly scope: ClientPortalScopeService) {}

  async configure(actor: ProjectActor, taskId: string, input: { expectedVersion: number; internal: boolean; client: boolean; reason: string }) {
    return this.database.prisma.$transaction(async tx => {
      const preview = await tx.task.findFirst({ where: { id: taskId, organizationId: actor.organizationId } });
      if (!preview?.projectId) throw new ConflictException("A project task is required");
      await this.scope.staffAuthority(tx, actor, preview.projectId, "manage");
      await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id"=${taskId}::uuid FOR UPDATE`;
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      const latest = await tx.reviewSubmission.findFirst({ where: { taskId }, orderBy: { roundNumber: "desc" } });
      const approved = !!latest && task.status === TaskStatus.INTERNAL_APPROVED && task.reviewRequirement === TaskReviewRequirement.BOTH && input.client && !!submittedEvidence(latest.taskSnapshot) && approvedWorkMatches(task, latest.taskSnapshot) && (await tx.reviewRound.findUnique({ where: { submissionId: latest.id } }))?.status === "APPROVED";
      const initial = !latest && ([TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS] as TaskStatus[]).includes(task.status);
      if (task.version !== input.expectedVersion || task.requiresReassignment || !initial && !approved) throw new ConflictException("Configure requirements before submission, or reauthorize the unchanged internally approved work");
      if (task.reviewRequirement !== TaskReviewRequirement.BOTH || !input.client) throw new ConflictException("Review requirements are fixed when the task is created. This command only authorizes automatic client routing for BOTH tasks");
      const reviewRequirement = task.reviewRequirement;
      const now = new Date();
      const revoked = await tx.taskReviewRoutingAuthorization.findMany({ where: { taskId, revokedAt: null }, select: { id: true } });
      await tx.taskReviewRoutingAuthorization.updateMany({ where: { taskId, revokedAt: null }, data: { revokedAt: now } });
      const updated = await tx.task.update({ where: { id: taskId, version: task.version }, data: { version: { increment: 1 } } });
      const authorization = input.client ? await tx.taskReviewRoutingAuthorization.create({ data: { organizationId: actor.organizationId, projectId: task.projectId!, taskId, authorizedById: actor.accountId, reason: input.reason } }) : null;
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.updated", subjectType: "task", subjectId: taskId, reason: input.reason, before: { version: task.version, reviewRequirement: task.reviewRequirement }, after: { projectId: task.projectId, version: updated.version, reviewRequirement, routingAuthorizationId: authorization?.id ?? null, revokedRoutingAuthorizations: Object.fromEntries(revoked.map(row => [row.id, now.toISOString()])) } });
      if (approved && authorization && latest && !await tx.clientReviewItem.findUnique({ where: { workSubmissionId: latest.id } })) {
        const attempt = await tx.taskReviewRoutingAttempt.create({ data: { organizationId: actor.organizationId, projectId: task.projectId!, taskId, submissionId: latest.id, authorizationId: authorization.id } });
        await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "review.routing_changed", subjectType: "review_routing", subjectId: attempt.id, reason: input.reason, after: { projectId: task.projectId, taskId, submissionId: latest.id, authorizationId: authorization.id, status: "PENDING", blockedReason: null } });
      }
      return { version: updated.version, reviewRequirement };
    }, { timeout: 30_000 });
  }

  async revoke(actor: ProjectActor, taskId: string, reason: string) {
    return this.database.prisma.$transaction(async tx => {
      const task = await tx.task.findFirstOrThrow({ where: { id: taskId, organizationId: actor.organizationId } });
      if (!task.projectId) throw new ConflictException("A project task is required");
      await this.scope.staffAuthority(tx, actor, task.projectId, "manage");
      await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id"=${taskId}::uuid FOR UPDATE`;
      const now = new Date();
      const revoked = await tx.taskReviewRoutingAuthorization.findMany({ where: { taskId, revokedAt: null }, select: { id: true } });
      await tx.taskReviewRoutingAuthorization.updateMany({ where: { taskId, revokedAt: null }, data: { revokedAt: now } });
      const updated = await tx.task.update({ where: { id: taskId }, data: { version: { increment: 1 } } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.updated", subjectType: "task", subjectId: taskId, reason, after: { projectId: task.projectId, version: updated.version, automaticClientRouting: "REVOKED", revokedRoutingAuthorizations: Object.fromEntries(revoked.map(row => [row.id, now.toISOString()])) } });
      return { revoked: true };
    });
  }

  async retry(actor: ProjectActor, taskId: string) {
    const attempt = await this.database.prisma.$transaction(async tx => {
      const task = await tx.task.findFirstOrThrow({ where: { id: taskId, organizationId: actor.organizationId } });
      if (!task.projectId) throw new ConflictException("A project task is required");
      await this.scope.staffAuthority(tx, actor, task.projectId, "manage");
      const latest = await tx.reviewSubmission.findFirst({ where: { taskId }, orderBy: { roundNumber: "desc" } });
      const found = latest ? await tx.taskReviewRoutingAttempt.findFirst({ where: { submissionId: latest.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) : null;
      if (!found) throw new ConflictException("No approved submission is awaiting automatic client routing");
      return found;
    });
    await this.deliver(attempt.id);
    return { attempted: true };
  }

  private async state(tx: Prisma.TransactionClient, id: string, status: "PENDING" | "BLOCKED" | "SENT", actorId: string, blockedReason?: string) {
    const attempt = await tx.taskReviewRoutingAttempt.update({ where: { id }, data: { status, blockedReason: status === "BLOCKED" ? blockedReason ?? "Check the task and evidence access, then retry client routing." : null } });
    await recordProjectEvent(tx, { organizationId: attempt.organizationId, actorId, eventName: "review.routing_changed", subjectType: "review_routing", subjectId: id, reason: "Automatic client routing delivery status", after: { projectId: attempt.projectId, taskId: attempt.taskId, submissionId: attempt.submissionId, authorizationId: attempt.authorizationId, status, blockedReason: attempt.blockedReason } });
  }

  async runBatch() {
    const attempts = await this.database.prisma.taskReviewRoutingAttempt.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 25 });
    for (const attempt of attempts) await this.deliver(attempt.id);
  }

  private async deliver(id: string) {
    try {
      await this.database.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "task_review_routing_attempts" WHERE "id"=${id}::uuid FOR UPDATE`;
        const attempt = await tx.taskReviewRoutingAttempt.findUniqueOrThrow({ where: { id } });
        if (attempt.status === "SENT") return;
        let authorization = await tx.taskReviewRoutingAuthorization.findUniqueOrThrow({ where: { id: attempt.authorizationId } });
        if (authorization.revokedAt) throw new RoutingBlocked("AUTHORIZATION_REVOKED: Automatic client routing was revoked. Ask an authorized project manager to review the configuration.");
        const published = await tx.clientReviewItem.findUnique({ where: { workSubmissionId: attempt.submissionId } });
        if (published) {
          const publication = await tx.clientReviewPackage.findUniqueOrThrow({ where: { id: published.packageId } });
          await this.state(tx, id, "SENT", publication.createdById); return;
        }
        const account = await tx.account.findUniqueOrThrow({ where: { id: authorization.authorizedById } });
        if (![AccountKind.OWNER, AccountKind.STAFF].includes(account.kind as "OWNER" | "STAFF")) throw new ConflictException("Publishing authorization is unavailable");
        const actor = { accountId: account.id, organizationId: attempt.organizationId, kind: account.kind } as ProjectActor;
        try { await this.scope.staffAuthority(tx, actor, attempt.projectId, "manage"); }
        catch (error) { if (error instanceof ForbiddenException) throw new RoutingBlocked("PUBLISHER_ACCESS: The saved publisher no longer has access. An authorized project manager must review publishing authorization."); throw error; }
        await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id"=${attempt.taskId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "task_review_routing_authorizations" WHERE "id"=${attempt.authorizationId}::uuid FOR SHARE`;
        authorization = await tx.taskReviewRoutingAuthorization.findUniqueOrThrow({ where: { id: attempt.authorizationId } });
        if (authorization.revokedAt) throw new RoutingBlocked("AUTHORIZATION_REVOKED: Automatic client routing was revoked. Ask an authorized project manager to review the configuration.");
        const now = new Date();
        const primary = await tx.clientPortalGrant.findFirst({ where: { projectId: attempt.projectId, organizationId: attempt.organizationId, primary: true, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
        if (!primary || (await tx.account.findUnique({ where: { id: primary.accountId } }))?.state !== "ACTIVE") throw new RoutingBlocked("PRIMARY_CLIENT_REQUIRED: Ask the Owner to appoint an active Primary Client for this project, then retry client routing.");
        await tx.$queryRaw`SELECT "id" FROM "client_portal_grants" WHERE "id"=${primary.id}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT "id" FROM "accounts" WHERE "id"=${primary.accountId}::uuid FOR SHARE`;
        const currentPrimary = await tx.clientPortalGrant.findUniqueOrThrow({ where: { id: primary.id } });
        const clock = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;
        if (currentPrimary.revokedAt || !currentPrimary.primary || currentPrimary.expiresAt && currentPrimary.expiresAt <= clock || (await tx.account.findUniqueOrThrow({ where: { id: primary.accountId } })).state !== "ACTIVE") throw new RoutingBlocked("PRIMARY_CLIENT_CHANGED: Ask the Owner to check the current Primary Client and expiry, then retry client routing.");
        const task = await tx.task.findUniqueOrThrow({ where: { id: attempt.taskId } });
        const submission = await tx.reviewSubmission.findUniqueOrThrow({ where: { id: attempt.submissionId } });
        if (task.status !== TaskStatus.INTERNAL_APPROVED || task.reviewRequirement !== TaskReviewRequirement.BOTH) throw new RoutingBlocked("WORK_NOT_READY: This task is no longer internally approved and ready for client review. Check its latest review and task state.");
        await this.clients.createPackageWithin(tx, actor, attempt.projectId, { title: task.title, reason: "Automatically route the internally approved work under saved publishing authorization", items: [{ taskId: task.id, expectedTaskVersion: task.version, workSubmissionId: submission.id, ...(submission.revisionId ? { revisionId: submission.revisionId } : {}), label: task.title }] });
        await this.state(tx, id, "SENT", actor.accountId);
      }, { timeout: 30_000 });
    } catch (error) {
      // Never copy arbitrary error details or submitted URLs into operational logs.
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && (["P2034", "P2002"].includes(error.code) || error.code === "P2010" && ["40P01", "40001"].includes(String(error.meta?.code)));
      await this.database.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "task_review_routing_attempts" WHERE "id"=${id}::uuid FOR UPDATE`;
        const attempt = await tx.taskReviewRoutingAttempt.findUniqueOrThrow({ where: { id } });
        if (attempt.status === "SENT") return;
        const authorization = await tx.taskReviewRoutingAuthorization.findUniqueOrThrow({ where: { id: attempt.authorizationId } });
        const message = error instanceof RoutingBlocked ? error.publicMessage : error instanceof ForbiddenException ? "EVIDENCE_ACCESS: Check that the saved publisher can read the evidence and that files are non-confidential PDFs or images, then retry." : "WORK_OR_PROJECT_CHANGED: Check the project is active and the latest approved work still matches this task, then retry.";
        await this.state(tx, id, retryable ? "PENDING" : "BLOCKED", authorization.authorizedById, message);
      });
    }
  }
}
