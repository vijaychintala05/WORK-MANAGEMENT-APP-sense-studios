import { assertClientEvidenceFile, submittedEvidence } from "./review-work-evidence.js";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { AccountKind, AccountState, EmployeeState, Prisma, ProjectStatus } from "./generated/prisma/client.js";
import { DatabaseService } from "./database.service.js";
import { AuthorizationService } from "./authorization.service.js";
import type { ActiveClientPortalSession } from "./client-portal-identity.service.js";
import type { ProjectActor } from "./project.service.js";
import { recordProjectEvent } from "./project-events.js";

type Tx = Prisma.TransactionClient;
export type ClientCapability = "view" | "comment" | "review" | "approve" | "download";
const flags = { view: true, comment: true, review: true, approve: true, download: true };
export type ClientGrantInput = typeof flags & { itemId: string; portalGrantId: string; expectedVersion: number; reason: string };

/** Every business consumer checks current authority inside its persistence transaction. */
@Injectable()
export class ClientPortalScopeService {
  constructor(private readonly database: DatabaseService, private readonly authorization: AuthorizationService) {}

  private async currentSession(tx: Tx, active: ActiveClientPortalSession, write = false) {
    if (write) {
      await tx.$queryRaw`SELECT "id" FROM "accounts" WHERE "id"=${active.account.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "client_portal_sessions" WHERE "id"=${active.row.id}::uuid FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT "id" FROM "accounts" WHERE "id"=${active.account.id}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "client_portal_sessions" WHERE "id"=${active.row.id}::uuid FOR SHARE`;
    }
    const account = await tx.account.findUnique({ where: { id: active.account.id } });
    const session = await tx.clientPortalSession.findUnique({ where: { id: active.row.id } });
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;
    if (!account || account.kind !== AccountKind.CLIENT || account.state !== AccountState.ACTIVE || !session || session.accountId !== account.id || session.revokedAt || session.expiresAt <= now! || session.lastUsedAt.getTime() + 30 * 60_000 <= now!.getTime()) throw new ForbiddenException("Client access ended. Sign in again");
    return account;
  }

  async authorizeProject(tx: Tx, active: ActiveClientPortalSession, projectId: string, write = false) {
    await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id"=${projectId}::uuid FOR SHARE`;
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found");
    await this.currentSession(tx, active, write);
    await tx.$queryRaw`SELECT "id" FROM "client_portal_grants" WHERE "projectId"=${projectId}::uuid AND "accountId"=${active.account.id}::uuid FOR SHARE`;
    const grant = await tx.clientPortalGrant.findUnique({ where: { projectId_accountId: { projectId, accountId: active.account.id } } });
    // A grant lock may outlive either the absolute or idle session deadline.
    await this.currentSession(tx, active, write);
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;
    if (!grant || grant.organizationId !== project.organizationId || grant.revokedAt || grant.expiresAt && grant.expiresAt <= now!) throw new ForbiddenException("Project access ended");
    if (write && project.status !== ProjectStatus.ACTIVE) throw new ConflictException("Only Active projects accept client review work");
    return { project, grant };
  }

  async authorizeItem(tx: Tx, active: ActiveClientPortalSession, itemId: string, action: ClientCapability, write = false) {
    const preview = await tx.clientReviewItem.findUnique({ where: { id: itemId } });
    if (!preview) throw new NotFoundException("Review item not found");
    const context = await this.authorizeProject(tx, active, preview.projectId, write);
    if (!context.grant.primary) await tx.$queryRaw`SELECT "id" FROM "client_item_grants" WHERE "portalGrantId"=${context.grant.id}::uuid AND "itemId"=${itemId}::uuid FOR SHARE`;
    const permission = context.grant.primary ? flags : await tx.clientItemGrant.findUnique({ where: { portalGrantId_itemId: { portalGrantId: context.grant.id, itemId } } });
    if (!permission || !permission.view || !permission[action]) throw new ForbiddenException("This item permission is required");
    if (preview.organizationId !== context.project.organizationId) throw new NotFoundException("Review item not found");
    const evidence = submittedEvidence(preview.snapshot);
    if (evidence) await assertClientEvidenceFile(tx, context.project.organizationId, context.project.id, evidence);
    if (evidence?.fileId) {
      const blob = await tx.fileBlobMetadata.findFirst({ where: { id: evidence.blobId!, documentId: evidence.fileId, organizationId: context.project.organizationId, sha256: evidence.sha256! }, include: { document: true } });
      if (!blob || blob.document.projectId !== context.project.id || blob.document.confidential || !["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(blob.mimeType) || action === "download" && blob.document.viewOnly) throw new ForbiddenException("This evidence is unavailable with current file access");
    }
    if (context.project.status === ProjectStatus.CANCELLED) {
      if (!["view", "download"].includes(action) || !preview.revisionId) throw new ForbiddenException("Cancelled projects allow previously issued files only");
      const closed = await tx.projectStatusChange.findFirst({ where: { projectId: context.project.id, toStatus: ProjectStatus.CANCELLED }, orderBy: { occurredAt: "asc" } });
      const issued = await tx.transmittalItem.findFirst({ where: { revisionId: preview.revisionId, projectId: context.project.id, transmittal: { issuedAt: { lte: closed?.occurredAt ?? new Date(0) } } } });
      if (!issued) throw new ForbiddenException("This file was not issued before cancellation");
    }
    // Permission-row waits may outlive the grant/session deadline. Sample the
    // current clock again with the same transaction locks held.
    const current = await this.authorizeProject(tx, active, preview.projectId, write);
    return { ...current, item: preview, permission };
  }

  async staffAuthority(tx: Tx, actor: ProjectActor, projectId: string, mode: "manage" | "classify" | "correction") {
    if (![AccountKind.OWNER, AccountKind.STAFF].includes(actor.kind as "OWNER" | "STAFF")) throw new ForbiddenException("Internal authority required");
    await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id"=${projectId}::uuid AND "organizationId"=${actor.organizationId}::uuid FOR SHARE`;
    const project = await tx.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    await tx.$queryRaw`SELECT "id" FROM "accounts" WHERE "id"=${actor.accountId}::uuid FOR SHARE`;
    const account = await tx.account.findFirst({ where: { id: actor.accountId, kind: actor.kind, state: AccountState.ACTIVE }, include: { employee: true } });
    if (!account) throw new ForbiddenException("Internal authority ended");
    if (actor.kind === AccountKind.STAFF) {
      const employee = account.employee;
      if (!employee || employee.state !== EmployeeState.ACTIVE || employee.organizationId !== actor.organizationId) throw new ForbiddenException("Active employee required");
      await tx.$queryRaw`SELECT "id" FROM "employees" WHERE "id"=${employee.id}::uuid FOR SHARE`;
      if ((await tx.employee.findUnique({ where: { id: employee.id } }))?.state !== EmployeeState.ACTIVE) throw new ForbiddenException("Active employee required");
      const assignment = await tx.projectAssignment.findFirst({ where: { projectId, employeeId: employee.id, revokedAt: null, organizationId: actor.organizationId } });
      if (!assignment || employee.homeBranchId !== project.branchId && !assignment.crossBranchAuthorized) throw new ForbiddenException("Current project assignment required");
      const scope = { kind: "BRANCH" as const, organizationId: actor.organizationId, branchId: project.branchId };
      await this.authorization.assertPermission(actor.accountId, "project.view", scope, tx);
      if (mode === "classify" || project.currentLeadEmployeeId !== employee.id) await this.authorization.assertPermission(actor.accountId, mode === "manage" ? "client.review_manage" : mode === "classify" ? "client.revision_classify" : "client.correction_assign", scope, tx);
    }
    return { project, account };
  }

  async projects(active: ActiveClientPortalSession) {
    return this.database.prisma.$transaction(async (tx) => {
      const grants = await tx.clientPortalGrant.findMany({ where: { accountId: active.account.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: { projectId: "asc" } });
      if (grants.length === 0) await this.currentSession(tx, active);
      const projects = [];
      for (const grant of grants) {
        const { project } = await this.authorizeProject(tx, active, grant.projectId);
        projects.push({ id: project.id, title: project.title, status: project.status, primary: grant.primary, expiresAt: grant.expiresAt, grantId: grant.id, version: grant.version });
      }
      return { projects };
    });
  }

  async invite(active: ActiveClientPortalSession, projectId: string, input: { email: string; reason: string }) {
    return this.database.prisma.$transaction(async (tx) => {
      const { project, grant } = await this.authorizeProject(tx, active, projectId, true);
      if (!grant.primary) throw new ForbiddenException("Primary Client invitation authority required");
      const account = await tx.account.upsert({ where: { normalizedEmail: input.email.trim().toLowerCase() }, create: { normalizedEmail: input.email.trim().toLowerCase(), kind: AccountKind.CLIENT, state: AccountState.ACTIVE }, update: {} });
      if (account.kind !== AccountKind.CLIENT || account.state !== AccountState.ACTIVE) throw new ConflictException("This email cannot be used as a client identity");
      if (await tx.clientPortalGrant.findUnique({ where: { projectId_accountId: { projectId, accountId: account.id } } })) throw new ConflictException("This client already has a project access record");
      const row = await tx.clientPortalGrant.create({ data: { organizationId: project.organizationId, projectId, accountId: account.id, invitedById: active.account.id, reason: input.reason } });
      const access = { primary: false, expiresAt: null, revokedAt: null };
      const eventId = await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.access_changed", subjectType: "client_access", subjectId: row.id, reason: input.reason, before: { access: {} }, after: { projectId, accountId: account.id, version: row.version, access } });
      const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
      await tx.clientPortalGrantChange.create({ data: { organizationId: project.organizationId, projectId, grantId: row.id, grantVersion: row.version, actorId: active.account.id, reason: input.reason, before: {}, after: access, auditEventId: (event.payload as { auditEventId: string }).auditEventId } });
      await this.authorizeProject(tx, active, projectId, true);
      return { id: row.id, email: account.normalizedEmail, version: row.version };
    }, { timeout: 30_000 });
  }

  async access(active: ActiveClientPortalSession, projectId: string) {
    return this.database.prisma.$transaction(async (tx) => {
      const { grant } = await this.authorizeProject(tx, active, projectId);
      if (!grant.primary) throw new ForbiddenException("Primary Client access administration required");
      const grants = await tx.clientPortalGrant.findMany({ where: { projectId, primary: false, revokedAt: null }, orderBy: { id: "asc" } });
      const users = [];
      for (const row of grants) {
        const account = await tx.account.findUniqueOrThrow({ where: { id: row.accountId } });
        const items = await tx.clientItemGrant.findMany({ where: { portalGrantId: row.id } });
        users.push({ id: row.id, email: account.normalizedEmail, expiresAt: row.expiresAt, version: row.version, items: items.map((item) => ({ itemId: item.itemId, version: item.version, view: item.view, comment: item.comment, review: item.review, approve: item.approve, download: item.download })) });
      }
      return { users };
    });
  }

  async setItemGrant(active: ActiveClientPortalSession, input: ClientGrantInput) {
    if (!input.view && (input.comment || input.review || input.approve || input.download)) throw new BadRequestException("Other capabilities require view access");
    return this.database.prisma.$transaction(async (tx) => {
      const { project, grant, item } = await this.authorizeItem(tx, active, input.itemId, "view", true);
      if (!grant.primary) throw new ForbiddenException("Primary Client delegation authority required");
      const target = await tx.clientPortalGrant.findFirst({ where: { id: input.portalGrantId, projectId: project.id, organizationId: project.organizationId, primary: false, revokedAt: null } });
      if (!target || target.expiresAt && target.expiresAt <= new Date()) throw new ForbiddenException("Active Additional Client required");
      await tx.$queryRaw`SELECT "id" FROM "client_item_grants" WHERE "portalGrantId"=${target.id}::uuid AND "itemId"=${item.id}::uuid FOR UPDATE`;
      const before = await tx.clientItemGrant.findUnique({ where: { portalGrantId_itemId: { portalGrantId: target.id, itemId: item.id } } });
      if ((before?.version ?? 0) !== input.expectedVersion) throw new ConflictException("Item access changed. Refresh and retry");
      const access = { view: input.view, comment: input.comment, review: input.review, approve: input.approve, download: input.download };
      const row = before ? await tx.clientItemGrant.update({ where: { id: before.id }, data: { ...access, version: { increment: 1 }, changedById: active.account.id, reason: input.reason } }) : await tx.clientItemGrant.create({ data: { organizationId: project.organizationId, projectId: project.id, portalGrantId: target.id, itemId: item.id, ...access, changedById: active.account.id, reason: input.reason } });
      const previous = before ? { view: before.view, comment: before.comment, review: before.review, approve: before.approve, download: before.download } : {};
      const eventId = await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.item_access_changed", subjectType: "client_item_access", subjectId: row.id, reason: input.reason, before: { access: previous }, after: { projectId: project.id, grantId: row.id, itemId: item.id, portalGrantId: target.id, version: row.version, access } });
      const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
      await tx.clientItemGrantChange.create({ data: { organizationId: project.organizationId, projectId: project.id, grantId: row.id, grantVersion: row.version, actorId: active.account.id, reason: input.reason, before: previous, after: access, auditEventId: (event.payload as { auditEventId: string }).auditEventId } });
      await this.authorizeItem(tx, active, item.id, "view", true);
      return { itemId: item.id, portalGrantId: target.id, version: row.version, ...access };
    }, { timeout: 30_000 });
  }
}

