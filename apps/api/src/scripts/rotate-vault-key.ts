import { closeDb } from "../db/index.ts";
import { vaultRotationService } from "../services/vault-rotation.service.ts";

/**
 * Re-seals every stored secret with CREDENTIAL_VAULT_KEY. Run after setting the new key (and a
 * higher CREDENTIAL_VAULT_KEY_VERSION) and moving the old one to CREDENTIAL_VAULT_KEY_PREVIOUS
 * (docs/operations.md, "Rotating secrets"). Safe to run again: values on the current key are
 * left alone. Exit 1 if any value opens with neither key.
 */
try {
  const counts = await vaultRotationService.rotate();
  console.log(
    `Re-sealed ${counts.resealed}; already current ${counts.current}; changed meanwhile ${counts.changed}; unreadable ${counts.unreadable}`,
  );
  if (counts.unreadable) process.exitCode = 1;
} catch (err) {
  console.error(`Rotation failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
