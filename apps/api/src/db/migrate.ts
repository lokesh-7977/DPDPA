import { fileURLToPath } from "node:url";
import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import { closeDb, db } from "./client.ts";
import { runInScope } from "./scope.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

// Migrations run as the connecting (owner) role: no switch to the RLS app role. In production
// run them with the owner connection: DATABASE_URL=<owner url> pnpm --filter api db:migrate.
await runInScope({ kind: "owner" }, async () => {
  if (env.DATABASE_URL) {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(db as any, { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as any, { migrationsFolder });
  }
});

logger.info("Migrations applied");
logger.flush();
await closeDb();
