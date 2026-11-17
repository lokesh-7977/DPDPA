import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  noticeVersionStatuses,
  type NoticeContent,
} from "../../../domain/notices.ts";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/**
 * Notices (DPDPA s.5, DPDP Rules r.3). A notice has numbered versions; a published version is
 * frozen (DB trigger) so every consent points at exactly the text the person saw.
 * (purposes link lives in consent schema to avoid a circular import: see noticeVersionPurposes.)
 */
export const notices = pgTable(
  "notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("notices_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("notices_code_uq").on(t.orgId, t.code),
  ],
);

export const noticeVersionStatus = pgEnum(
  "notice_version_status",
  noticeVersionStatuses,
);

export const noticeVersions = pgTable(
  "notice_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    noticeId: uuid("notice_id").notNull(),
    versionNo: integer("version_no").notNull(),
    status: noticeVersionStatus("status").notNull().default("draft"),
    /** The fiduciary's own pages (r.3(c)). */
    withdrawUrl: text("withdraw_url"),
    rightsUrl: text("rights_url"),
    complaintUrl: text("complaint_url"),
    createdBy: uuid("created_by").references(() => users.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("notice_versions_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("notice_versions_no_uq").on(t.noticeId, t.versionNo),
    index("notice_versions_status_idx").on(t.noticeId, t.status),
    foreignKey({
      name: "notice_versions_notice_fk",
      columns: [t.orgId, t.noticeId],
      foreignColumns: [notices.orgId, notices.id],
    }),
  ],
);

export const noticeTranslations = pgTable(
  "notice_translations",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    versionId: uuid("version_id").notNull(),
    language: text("language").notNull(),
    content: jsonb("content").$type<NoticeContent>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.language] }),
    foreignKey({
      name: "notice_translations_version_fk",
      columns: [t.orgId, t.versionId],
      foreignColumns: [noticeVersions.orgId, noticeVersions.id],
    }),
  ],
);

export type Notice = typeof notices.$inferSelect;
export type NoticeVersion = typeof noticeVersions.$inferSelect;
export type NoticeTranslation = typeof noticeTranslations.$inferSelect;
