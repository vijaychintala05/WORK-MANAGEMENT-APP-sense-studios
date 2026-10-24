import { assertClientEvidenceFile, submittedEvidence } from "./review-work-evidence.js";
import { createHash, randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "./database.service.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import type { ActiveClientPortalSession } from "./client-portal-identity.service.js";
import { NasStorage } from "./nas-storage.js";
import { RUNTIME_CONFIG, type RuntimeConfig } from "./config.js";
import { validateDocumentFile, validateFirstChunk } from "./document-file-policy.js";
import { recordProjectEvent } from "./project-events.js";
import { ProjectStatus, RevisionState } from "./generated/prisma/client.js";

const safeMime = (mime: string) => ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);

@Injectable()
export class ClientPortalFilesService {
  constructor(private readonly database: DatabaseService, private readonly scope: ClientPortalScopeService, @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}
  private async storage() {
    if (!this.config.nasRoot) throw new ConflictException("File storage is unavailable");
    const storage = new NasStorage(this.config.nasRoot);
    await storage.initialize();
    return storage;
  }
  async stream(active: ActiveClientPortalSession, itemId: string, download: boolean) {
    return this.database.prisma.$transaction(async (tx) => {
      const { item, project } = await this.scope.authorizeItem(tx, active, itemId, download ? "download" : "view");
      const snapshot = item.snapshot as Record<string, unknown>;
      const evidence = submittedEvidence(snapshot);
      if (evidence) await assertClientEvidenceFile(tx, project.organizationId, project.id, evidence);
      const revision = item.revisionId ? await tx.documentRevision.findFirst({ where: { id: item.revisionId, projectId: project.id, organizationId: project.organizationId } }) : null;
      const exact = revision ?? evidence;
      if (!exact?.fileId || !exact.blobId || !exact.sha256) throw new NotFoundException("This item has no file");
      if (snapshot.blobId !== exact.blobId || snapshot.sha256 !== exact.sha256 || snapshot.fileId !== exact.fileId || revision && snapshot.revisionId !== revision.id) throw new ConflictException("Exact item file evidence does not match");
      const blob = await tx.fileBlobMetadata.findFirst({ where: { id: exact.blobId, organizationId: project.organizationId }, include: { document: true } });
      if (!blob || blob.documentId !== exact.fileId || blob.document.projectId !== project.id || blob.sha256 !== exact.sha256 || blob.document.confidential || !safeMime(blob.mimeType)) throw new ForbiddenException("Only exact non-confidential PDF/image review files are available");
      if (download && blob.document.viewOnly) throw new ForbiddenException("This document permits viewing only");
      const superseded = !!revision && (!revision.isCurrent || revision.state === RevisionState.SUPERSEDED);
      if (project.status !== ProjectStatus.CANCELLED && superseded) throw new ConflictException("This revision was superseded. Request the current review item");
      const storage = await this.storage();
      const opened = await storage.openBlob(blob.storageKey);
      if (opened.size !== Number(blob.sizeBytes)) { opened.stream.destroy(); throw new ConflictException("Stored file size does not match"); }
      try { await this.scope.authorizeItem(tx, active, itemId, download ? "download" : "view"); }
      catch (error) { opened.stream.destroy(); throw error; }
      return { ...opened, name: blob.fileName, mime: blob.mimeType, superseded };
    }, { timeout: 30_000 });
  }
  async reference(active: ActiveClientPortalSession, itemId: string, input: { name: string; mime: string; reason: string; bytes: Buffer }) {
    const file = validateDocumentFile(input.name, input.mime, input.bytes.length, 8 * 1024 * 1024);
    if (!safeMime(file.mimeType)) throw new ForbiddenException("References must be PDF or image files");
    validateFirstChunk(file.extension, input.bytes);
    return this.database.prisma.$transaction(async (tx) => {
      const { project, item } = await this.scope.authorizeItem(tx, active, itemId, "comment", true);
      const storage = await this.storage();
      const uploadId = randomUUID();
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      await storage.writeChunk(uploadId, 0, input.bytes, sha256);
      const blob = await storage.finalize(uploadId, 1, input.bytes.length, sha256);
      // Finalized orphan blobs remain private if the database transaction fails;
      // reconciliation must compare ClientReference as well as FileBlobMetadata.
      await this.scope.authorizeItem(tx, active, itemId, "comment", true);
      const row = await tx.clientReference.create({ data: { organizationId: project.organizationId, projectId: project.id, itemId: item.id, accountId: active.account.id, name: file.fileName, mime: file.mimeType, size: blob.size, sha256: blob.sha256, storageKey: blob.key } });
      await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "client.reference_uploaded", subjectType: "client_reference", subjectId: row.id, reason: input.reason, after: { projectId: project.id, referenceId: row.id, itemId: item.id, sha256: row.sha256, size: row.size, mime: row.mime } });
      return { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256 };
    }, { timeout: 30_000 });
  }
  async referenceStream(active: ActiveClientPortalSession, referenceId: string) {
    return this.database.prisma.$transaction(async (tx) => {
      const reference = await tx.clientReference.findUnique({ where: { id: referenceId } });
      if (!reference) throw new NotFoundException("Reference not found");
      const { project } = await this.scope.authorizeItem(tx, active, reference.itemId, "view");
      if (project.status === ProjectStatus.CANCELLED || !safeMime(reference.mime)) throw new ForbiddenException("Reference access ended");
      const opened = await (await this.storage()).openBlob(reference.storageKey);
      if (opened.size !== reference.size) { opened.stream.destroy(); throw new ConflictException("Stored reference size does not match"); }
      try { await this.scope.authorizeItem(tx, active, reference.itemId, "view"); }
      catch (error) { opened.stream.destroy(); throw error; }
      return { ...opened, name: reference.name, mime: reference.mime, superseded: false };
    }, { timeout: 30_000 });
  }
  async handover(active: ActiveClientPortalSession, projectId: string) {
    return this.database.prisma.$transaction(async (tx) => {
      const { project } = await this.scope.authorizeProject(tx, active, projectId);
      const closed = project.status === ProjectStatus.CANCELLED ? await tx.projectStatusChange.findFirst({ where: { projectId, toStatus: ProjectStatus.CANCELLED }, orderBy: { occurredAt: "asc" } }) : null;
      const rows = await tx.drawingTransmittal.findMany({ where: { projectId, organizationId: project.organizationId, recipients: { some: { accountId: active.account.id } }, ...(closed ? { issuedAt: { lte: closed.occurredAt } } : {}) }, include: { items: true, recipients: { where: { accountId: active.account.id } } }, orderBy: { issuedAt: "desc" } });
      const issues = [];
      for (const row of rows) {
        const items = [];
        let visible = true;
        for (const issued of row.items) {
          const candidates = await tx.clientReviewItem.findMany({ where: { projectId, revisionId: issued.revisionId }, orderBy: { id: "asc" } });
          let shared: typeof candidates[number] | undefined;
          for (const candidate of candidates) {
            try { await this.scope.authorizeItem(tx, active, candidate.id, "view"); shared = candidate; break; }
            catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
          }
          if (!shared) { visible = false; break; }
          const revision = await tx.documentRevision.findUniqueOrThrow({ where: { id: issued.revisionId } });
          const blob = await tx.fileBlobMetadata.findUniqueOrThrow({ where: { id: revision.blobId } });
          if (!safeMime(blob.mimeType)) { visible = false; break; }
          items.push({ itemId: shared.id, revisionId: revision.id, label: `${revision.series}${revision.number}`, sha256: issued.sha256, mime: blob.mimeType, superseded: !revision.isCurrent });
        }
        if (visible) issues.push({ id: row.id, purpose: row.purpose, issuedAt: row.issuedAt, items, acknowledgementRequired: row.recipients[0]?.acknowledgementRequired ?? false, acknowledgedAt: row.recipients[0]?.acknowledgedAt ?? null, canAcknowledge: project.status === ProjectStatus.ACTIVE && !row.recipients[0]?.acknowledgedAt });
      }
      return { issues };
    }, { timeout: 30_000 });
  }
  async acknowledge(active: ActiveClientPortalSession, transmittalId: string, input: { note: string; reason: string }) {
    return this.database.prisma.$transaction(async (tx) => {
      const preview = await tx.drawingTransmittal.findUnique({ where: { id: transmittalId } });
      if (!preview) throw new NotFoundException("Issued delivery not found");
      const { project } = await this.scope.authorizeProject(tx, active, preview.projectId, true);
      const items = await tx.transmittalItem.findMany({ where: { transmittalId, projectId: project.id } });
      for (const issued of items) {
        const candidates = await tx.clientReviewItem.findMany({ where: { projectId: project.id, revisionId: issued.revisionId }, orderBy: { id: "asc" } });
        let allowed = false;
        for (const candidate of candidates) {
          try { await this.scope.authorizeItem(tx, active, candidate.id, "view", true); allowed = true; break; }
          catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
        }
        if (!allowed) throw new ForbiddenException("Issued delivery access ended");
      }
      await tx.$queryRaw`SELECT "accountId" FROM "transmittal_recipients" WHERE "transmittalId"=${transmittalId}::uuid AND "accountId"=${active.account.id}::uuid FOR UPDATE`;
      const recipient = await tx.transmittalRecipient.findUnique({ where: { transmittalId_accountId: { transmittalId, accountId: active.account.id } } });
      if (!recipient) throw new ForbiddenException("Only the named client can acknowledge this delivery");
      if (recipient.acknowledgedAt) throw new ConflictException("Delivery is already acknowledged");
      const acknowledgedAt = new Date();
      await tx.transmittalRecipient.update({ where: { transmittalId_accountId: { transmittalId, accountId: active.account.id } }, data: { acknowledgedAt, note: input.note } });
      await recordProjectEvent(tx, { organizationId: project.organizationId, actorId: active.account.id, eventName: "transmittal.acknowledged", subjectType: "transmittal", subjectId: transmittalId, reason: input.reason, after: { projectId: project.id, accountId: active.account.id, acknowledgedAt: acknowledgedAt.toISOString(), note: input.note } });
      await this.scope.authorizeProject(tx, active, project.id, true);
      return { acknowledgedAt };
    }, { timeout: 30_000 });
  }
}
