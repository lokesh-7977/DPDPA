import { z } from "@hono/zod-openapi";
import type { RestrictedCountry, Transfer } from "../../../db/schemas/index.ts";

const Prose = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r])*$/u,
      "must not contain control characters",
    );
const Plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^[^\p{Cc}\p{Cf}]*$/u,
      "must not contain control or invisible characters",
    );
const Day = z.iso.date().openapi({ example: "2026-04-01" });
/** ISO 3166-1 alpha-2, outside India. */
const Country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2 country code")
  .refine((c) => c !== "IN", "Must be a country outside India")
  .openapi({ example: "US" });

export const RecordTransferSchema = z
  .object({
    recipientId: z.uuid(),
    activityId: z.uuid().nullable().optional(),
    /** Defaults to the recipient's country. */
    country: Country.optional(),
    dataCategories: z.array(Plain(100)).min(1).max(50),
    purpose: Prose(2000),
    safeguards: Prose(4000).nullable().optional(),
    startedOn: Day,
  })
  .openapi("RecordTransfer");

export const EndTransferSchema = z
  .object({ endedOn: Day })
  .openapi("EndTransfer");

export const TransferSchema = z
  .object({
    id: z.uuid(),
    recipientId: z.uuid(),
    recipientName: z.string(),
    activityId: z.uuid().nullable(),
    country: z.string(),
    dataCategories: z.array(z.string()),
    purpose: z.string(),
    safeguards: z.string().nullable(),
    startedOn: z.string(),
    endedOn: z.string().nullable(),
    active: z.boolean(),
    /** restricted_country (stop it, s.16(1)); sdf_localisation_check (r.13(4)). */
    flags: z.array(z.enum(["restricted_country", "sdf_localisation_check"])),
    createdAt: z.iso.datetime(),
  })
  .openapi("Transfer");

export const RecordedTransferSchema = TransferSchema.omit({
  recipientName: true,
  active: true,
  flags: true,
}).openapi("RecordedTransfer");

export const UnregisteredSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: z.string(),
    country: z.string(),
  })
  .openapi("UnregisteredRecipientAbroad");

export const RestrictionSchema = z
  .object({
    id: z.uuid(),
    country: z.string(),
    notification: z.string(),
    effectiveFrom: z.string(),
    liftedOn: z.string().nullable(),
  })
  .openapi("RestrictedCountry");

export const AddRestrictionSchema = z
  .object({
    country: Country,
    /** The Gazette notification under s.16(1), e.g. "G.S.R. 123(E)". */
    notification: Plain(100),
    effectiveFrom: Day,
  })
  .openapi("AddRestrictedCountry");

export const LiftRestrictionSchema = z
  .object({ liftedOn: Day })
  .openapi("LiftRestriction");

export const TransferParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  transferId: z.uuid().openapi({ param: { name: "transferId", in: "path" } }),
});
export const RestrictionParams = z.object({
  restrictionId: z
    .uuid()
    .openapi({ param: { name: "restrictionId", in: "path" } }),
});

type Listed = Transfer & {
  recipientName: string;
  active: boolean;
  flags: ("restricted_country" | "sdf_localisation_check")[];
};

const base = (t: Transfer) => ({
  id: t.id,
  recipientId: t.recipientId,
  activityId: t.activityId,
  country: t.country,
  dataCategories: t.dataCategories,
  purpose: t.purpose,
  safeguards: t.safeguards,
  startedOn: t.startedOn,
  endedOn: t.endedOn,
  createdAt: t.createdAt.toISOString(),
});

export const toTransferDto = (t: Listed) => ({
  ...base(t),
  recipientName: t.recipientName,
  active: t.active,
  flags: t.flags,
});
export const toRecordedTransferDto = (t: Transfer) => base(t);

export const toRestrictionDto = (r: RestrictedCountry) => ({
  id: r.id,
  country: r.country,
  notification: r.notification,
  effectiveFrom: r.effectiveFrom,
  liftedOn: r.liftedOn,
});
