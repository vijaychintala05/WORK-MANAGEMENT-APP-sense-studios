import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import type { Prisma } from "./generated/prisma/client.js";

export type WorkEvidence = { kind: "DRAWING" | "FILE" | "LINK"; fileId: string | null; blobId: string | null; sha256: string | null; url: string | null; digest: string };

/** Links are references only: never fetched or promoted to drawing approval facts. */
export function reviewLink(value: string): string {
  if (value.length > 2048 || value !== value.trim() || ([...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) || value.includes("\\"))) throw new BadRequestException("Use a valid HTTPS review link, up to 2,048 characters");
  let url: URL;
  try { url = new URL(value); } catch { throw new BadRequestException("Use a valid HTTPS review link"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|home|lan)$/.test(host) || host.endsWith(".")) throw new BadRequestException("Use a public HTTPS review link without credentials or a private host");
  return url.href;
}

export function workEvidence(input: Omit<WorkEvidence, "digest">): WorkEvidence {
  const exact = { kind: input.kind, fileId: input.fileId, blobId: input.blobId, sha256: input.sha256, url: input.url };
  if (exact.kind === "LINK") {
    if (!exact.url || exact.fileId || exact.blobId || exact.sha256) throw new BadRequestException("Link evidence must contain only a review URL");
    exact.url = reviewLink(exact.url);
  } else if (!exact.fileId || !exact.blobId || !/^[a-f0-9]{64}$/.test(exact.sha256 ?? "") || exact.url) throw new BadRequestException("Exact stored file evidence is required");
  return { ...exact, digest: createHash("sha256").update(JSON.stringify(exact)).digest("hex") };
}

export function submittedEvidence(snapshot: unknown): WorkEvidence | null {
  if (!snapshot || typeof snapshot !== "object" || !("workEvidence" in snapshot)) return null;
  const value = snapshot.workEvidence as WorkEvidence;
  if (!value || !["DRAWING", "FILE", "LINK"].includes(value.kind)) throw new ConflictException("Submitted evidence is unavailable");
  const checked = workEvidence(value);
  if (value.digest !== checked.digest) throw new ConflictException("Submitted evidence changed");
  return checked;
}

/** Planning-only changes do not substitute different work after approval. */
export function approvedWorkMatches(task: { title: string; description: string | null; primaryOwnerEmployeeId: string; tags: string[]; checklist: unknown; planItemId: string | null }, snapshot: unknown): boolean {
  const old = snapshot as Record<string, unknown>;
  return !!old && task.title === old.title && task.description === old.description && task.primaryOwnerEmployeeId === old.ownerEmployeeId && task.planItemId === old.planItemId && JSON.stringify(task.tags) === JSON.stringify(old.tags) && JSON.stringify(task.checklist) === JSON.stringify(old.checklist);
}

export async function assertClientEvidenceFile(tx: Prisma.TransactionClient, organizationId: string, projectId: string, evidence: WorkEvidence) {
  if (!evidence.fileId) return;
  const blob = await tx.fileBlobMetadata.findFirst({ where: { id: evidence.blobId!, documentId: evidence.fileId, organizationId, sha256: evidence.sha256! }, include: { document: true } });
  if (!blob || blob.document.projectId !== projectId || blob.document.confidential || !["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(blob.mimeType)) throw new ForbiddenException("Client evidence must be a non-confidential PDF or image");
  let folderId: string | null = blob.document.folderId;
  const visited = new Set<string>();
  while (folderId) {
    if (visited.has(folderId) || visited.size >= 21) throw new ForbiddenException("Client evidence folder is unavailable");
    visited.add(folderId);
    await tx.$queryRaw`SELECT "id" FROM "document_folders" WHERE "id"=${folderId}::uuid FOR SHARE`;
    const folder: { confidential: boolean; parentId: string | null } | null = await tx.documentFolder.findFirst({ where: { id: folderId, organizationId, projectId } });
    if (!folder || folder.confidential) throw new ForbiddenException("Confidential folder evidence cannot be sent to clients");
    folderId = folder.parentId;
  }
}
