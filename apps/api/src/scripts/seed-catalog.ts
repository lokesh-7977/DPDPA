/**
 * Load the compliance catalog (apps/api/catalog/*.json) into the database.
 * Idempotent; a changed file must bump its "version".
 *
 *   pnpm --filter api seed:catalog
 */
import { closeDb } from "../db/index.ts";
import { catalogService, loadCatalogFiles } from "../services/catalog.service.ts";

try {
  const summary = await catalogService.seed(await loadCatalogFiles());
  console.log("Catalog seeded:", summary);
} catch (err) {
  console.error(`Catalog seed failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
