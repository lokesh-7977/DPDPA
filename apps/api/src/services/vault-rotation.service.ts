import { logger } from "../config/logger.ts";
import { db } from "../db/index.ts";
import { errorLabel } from "../domain/jobs.ts";
import { vaultRepository } from "../repositories/vault.repository.ts";
import { auditService } from "./audit.service.ts";
import {
  credentialVault,
  VAULT_AAD,
  VAULT_KEY_VERSION,
} from "./credential-vault.ts";

/**
 * Vault key rotation: every stored secret that still opens only with the previous key is
 * re-sealed with the current one (one row per transaction, compare-and-swap so a concurrent
 * change wins). Values that open with neither key are counted and left untouched. The run is
 * recorded on the platform audit chain (counts only).
 */
export const vaultRotationService = {
  async rotate() {
    const counts = { resealed: 0, current: 0, unreadable: 0, changed: 0 };
    const kinds = [
      {
        rows: () => vaultRepository.scanCredentialSecrets(db),
        aad: VAULT_AAD.scanCredential,
        replace: vaultRepository.replaceScanCredentialSecret,
      },
      {
        rows: () => vaultRepository.integrationSecrets(db),
        aad: VAULT_AAD.integration,
        replace: vaultRepository.replaceIntegrationSecret,
      },
    ];
    for (const kind of kinds) {
      for (const row of await kind.rows()) {
        const aad = kind.aad(row.orgId, row.id);
        let opened: { plaintext: string; withPrevious: boolean };
        try {
          opened = credentialVault.openReporting(row.secret!, aad);
        } catch (e) {
          counts.unreadable++;
          logger.error(
            { id: row.id, errName: errorLabel(e) },
            "Vault value opens with no key",
          );
          continue;
        }
        if (!opened.withPrevious) {
          counts.current++;
          continue;
        }
        const ok = await db.transaction((tx) =>
          kind.replace(tx, {
            orgId: row.orgId,
            id: row.id,
            from: row.secret!,
            to: credentialVault.seal(opened.plaintext, aad),
            keyVersion: VAULT_KEY_VERSION,
          }),
        );
        if (ok) counts.resealed++;
        else counts.changed++;
      }
    }
    await db.transaction((tx) =>
      auditService.record(
        tx,
        { type: "system", id: "system:vault-rotation" },
        {
          orgId: null,
          action: "vault.key_rotated",
          entityType: "platform",
          entityId: "credential-vault",
          payload: counts,
        },
      ),
    );
    logger.info(counts, "Vault key rotation done");
    return counts;
  },
};
