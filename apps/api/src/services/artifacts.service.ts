import { createHash, randomUUID } from "node:crypto";
import { db, type Tx } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import { notFound } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { artifactsRepository, type NewArtifact } from "../repositories/artifacts.repository.ts";
import { auditService } from "./audit.service.ts";
import { blobStore } from "./storage/blob-store.ts";

type Kind = NewArtifact["kind"];
const EXT: Record<string, string> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "text/plain": "txt",
  "image/png": "png",
  "image/jpeg": "jpg",
};

export const artifactsService = {
  /**
   * Store bytes, then record metadata + audit in `tx`. The blob is written first: if the
   * transaction then rolls back, an orphan blob remains (harmless, unreferenced) rather
   * than a DB row pointing at nothing.
   */
  async store(
    tx: Tx,
    actor: Actor,
    v: { orgId: string; kind: Kind; fileName: string; contentType: string; body: Uint8Array; createdBy: string | null; retentionUntil?: Date | null },
  ) {
    const id = randomUUID();
    const storageKey = `org/${v.orgId}/${v.kind}/${id}.${EXT[v.contentType] ?? "bin"}`;
    await blobStore.put(storageKey, v.body);
    const row = await artifactsRepository.insert(tx, {
      id,
      orgId: v.orgId,
      kind: v.kind,
      fileName: v.fileName,
      contentType: v.contentType,
      storageKey,
      sha256: createHash("sha256").update(v.body).digest("hex"),
      sizeBytes: v.body.byteLength,
      createdBy: v.createdBy,
      retentionUntil: v.retentionUntil ?? null,
    });
    await auditService.record(tx, actor, {
      orgId: v.orgId,
      action: "artifact.created",
      entityType: "artifact",
      entityId: row.id,
      payload: { kind: v.kind, sha256: row.sha256, sizeBytes: row.sizeBytes },
    });
    return row;
  },

  /** Metadata + bytes. Content integrity is re-checked against the recorded sha256. */
  async download(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const artifact = await artifactsRepository.findForOrg(db, ctx.org.orgId, id);
    if (!artifact) throw notFound("Artifact not found");
    const body = await blobStore.get(artifact.storageKey);
    if (!body || createHash("sha256").update(body).digest("hex") !== artifact.sha256) {
      throw new Error("Artifact content missing or altered");
    }
    return { artifact, body };
  },
};
