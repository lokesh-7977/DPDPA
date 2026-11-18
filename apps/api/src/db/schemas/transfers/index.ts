import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";
import { processingActivities, recipients } from "../ropa/index.ts";

/**
 * Countries restricted under DPDPA s.16(1) by Central Government notification. Platform-wide,
 * kept by the super admin; none were notified when this was built.
 */
export const restrictedCountries = pgTable(
  "restricted_countries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** ISO 3166-1 alpha-2. */
    country: text("country").notNull(),
    /** The Gazette notification, e.g. "G.S.R. ___(E)". */
    notification: text("notification").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    liftedOn: date("lifted_on"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("restricted_countries_notification_uq").on(
      t.country,
      t.notification,
    ),
    check(
      "restricted_countries_country_ck",
      sql`${t.country} ~ '^[A-Z]{2}$' AND ${t.country} <> 'IN'`,
    ),
    check(
      "restricted_countries_dates_ck",
      sql`${t.liftedOn} IS NULL OR ${t.liftedOn} > ${t.effectiveFrom}`,
    ),
  ],
);

/** The org's register of personal data transferred outside India (s.16, r.15). Tenant data. */
export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** Who receives the data abroad (ROPA recipient). */
    recipientId: uuid("recipient_id").notNull(),
    /** The processing activity it serves, when recorded. */
    activityId: uuid("activity_id"),
    /** Destination, ISO 3166-1 alpha-2 (never IN). */
    country: text("country").notNull(),
    dataCategories: text("data_categories").array().notNull(),
    purpose: text("purpose").notNull(),
    /** Contract terms, encryption, etc. that protect the data abroad. */
    safeguards: text("safeguards"),
    startedOn: date("started_on").notNull(),
    endedOn: date("ended_on"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("transfers_org_idx").on(t.orgId, t.country),
    foreignKey({
      name: "transfers_recipient_fk",
      columns: [t.orgId, t.recipientId],
      foreignColumns: [recipients.orgId, recipients.id],
    }),
    foreignKey({
      name: "transfers_activity_fk",
      columns: [t.orgId, t.activityId],
      foreignColumns: [processingActivities.orgId, processingActivities.id],
    }),
    check(
      "transfers_country_ck",
      sql`${t.country} ~ '^[A-Z]{2}$' AND ${t.country} <> 'IN'`,
    ),
    check(
      "transfers_dates_ck",
      sql`${t.endedOn} IS NULL OR ${t.endedOn} > ${t.startedOn}`,
    ),
  ],
);

export type RestrictedCountry = typeof restrictedCountries.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
