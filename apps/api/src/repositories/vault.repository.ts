import { and, eq, isNotNull } from "drizzle-orm";
import { integrations, scanCredentials, type Executor } from "../db/index.ts";

/** Rows holding a sealed secret (vault key rotation). */
export const vaultRepository = {
  scanCredentialSecrets(ex: Executor) {
    return ex
      .select({
        id: scanCredentials.id,
        orgId: scanCredentials.orgId,
        secret: scanCredentials.secret,
      })
      .from(scanCredentials)
      .where(isNotNull(scanCredentials.secret));
  },

  integrationSecrets(ex: Executor) {
    return ex
      .select({
        id: integrations.id,
        orgId: integrations.orgId,
        secret: integrations.secret,
      })
      .from(integrations)
      .where(isNotNull(integrations.secret));
  },

  /** Replaces a sealed value only if it is still the one that was read (no lost update). */
  async replaceScanCredentialSecret(
    ex: Executor,
    v: {
      orgId: string;
      id: string;
      from: string;
      to: string;
      keyVersion: number;
    },
  ) {
    const rows = await ex
      .update(scanCredentials)
      .set({ secret: v.to, keyVersion: v.keyVersion })
      .where(
        and(
          eq(scanCredentials.orgId, v.orgId),
          eq(scanCredentials.id, v.id),
          eq(scanCredentials.secret, v.from),
        ),
      )
      .returning({ id: scanCredentials.id });
    return rows.length === 1;
  },

  async replaceIntegrationSecret(
    ex: Executor,
    v: {
      orgId: string;
      id: string;
      from: string;
      to: string;
      keyVersion: number;
    },
  ) {
    const rows = await ex
      .update(integrations)
      .set({ secret: v.to, keyVersion: v.keyVersion })
      .where(
        and(
          eq(integrations.orgId, v.orgId),
          eq(integrations.id, v.id),
          eq(integrations.secret, v.from),
        ),
      )
      .returning({ id: integrations.id });
    return rows.length === 1;
  },
};
