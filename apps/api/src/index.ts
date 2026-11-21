import { serve } from "@hono/node-server";
import { env } from "./config/env.ts";
import { logger } from "./config/logger.ts";
import { installAdapters } from "./services/adapters/index.ts";
import { assertAppLogin, closeDb } from "./db/index.ts";
import { app } from "./http/app.ts";

// Row-level security only holds if the login can't bypass it (docs/operations.md).
if (env.NODE_ENV === "production" && env.DATABASE_URL) await assertAppLogin();
installAdapters({ aws: false });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(
    { port: info.port, env: env.NODE_ENV },
    `API listening on http://localhost:${info.port} (docs: /docs)`,
  );
});

const shutdown = (signal: string) => {
  logger.info({ signal }, "shutting down");
  // Stop accepting connections; force exit if open requests do not finish in time.
  setTimeout(() => {
    logger.warn("Forced shutdown after 10 s");
    process.exit(1);
  }, 10_000).unref();
  server.close(async () => {
    await closeDb();
    logger.flush();
    process.exit(0);
  });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  // Name only: messages of DB errors can embed query params (PII).
  logger.error(
    { errName: (reason as Error)?.name ?? typeof reason },
    "unhandled promise rejection",
  );
});
