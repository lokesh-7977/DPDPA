import { unprocessable } from "./errors.ts";

/**
 * Cross-border transfers (DPDPA s.16; DPDP Rules 2025 r.15). Pure rules.
 *
 * s.16(1): the Central Government may, by notification, restrict transfers of personal data
 * to countries or territories outside India. Transfers are otherwise allowed, subject to the
 * requirements the Government specifies for making data available to a foreign State (r.15),
 * and to stricter sector laws (s.16(2)). r.13(4): a Significant Data Fiduciary must keep
 * personal data the Government specifies (and its traffic data) in India.
 */

export const HOME_COUNTRY = "IN";

export type Restriction = {
  country: string;
  effectiveFrom: string;
  liftedOn: string | null;
};

/** Restricted on `day` (YYYY-MM-DD): notified, in effect, not lifted. */
export function isRestricted(
  country: string,
  restrictions: readonly Restriction[],
  day: string,
): boolean {
  return restrictions.some(
    (r) =>
      r.country === country &&
      r.effectiveFrom <= day &&
      (r.liftedOn === null || r.liftedOn > day),
  );
}

export function assertCrossBorder(country: string): void {
  if (country === HOME_COUNTRY)
    throw unprocessable("A transfer is to a country outside India");
}

/** In force on `day`: started and not ended. */
export const transferActive = (
  t: { startedOn: string; endedOn: string | null },
  day: string,
) => t.startedOn <= day && (t.endedOn === null || t.endedOn > day);

export type TransferFlag = "restricted_country" | "sdf_localisation_check";

/**
 * Flags on an active transfer:
 * - restricted_country — the destination is (now) restricted under s.16(1): stop the transfer.
 * - sdf_localisation_check — the org is a Significant Data Fiduciary: confirm none of the data is
 *   of a kind the Government specified must stay in India (r.13(4)).
 */
export function transferFlags(
  t: { country: string; startedOn: string; endedOn: string | null },
  ctx: { restrictions: readonly Restriction[]; isSdf: boolean; day: string },
): TransferFlag[] {
  if (!transferActive(t, ctx.day)) return [];
  const flags: TransferFlag[] = [];
  if (isRestricted(t.country, ctx.restrictions, ctx.day))
    flags.push("restricted_country");
  if (ctx.isSdf) flags.push("sdf_localisation_check");
  return flags;
}
