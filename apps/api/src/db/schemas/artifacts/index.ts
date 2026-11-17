import { bigint, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Files produced for an org (exports, reports, crawler evidence). Content lives in the BlobStore. */
export const artifactKind = pgEnum("artifact_kind", ["ropa_export", "report", "evidence"]);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    kind: artifactKind("kind").notNull(),
    /** Human file name for downloads. */
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    /** Key in the BlobStore: org/<orgId>/<kind>/<id>. */
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("artifacts_storage_key_uq").on(t.storageKey), index("artifacts_org_idx").on(t.orgId, t.createdAt)],
);

export type Artifact = typeof artifacts.$inferSelect;
