import { config } from "@repo/eslint-config/base";

/**
 * Layer boundaries (dependencies point downward only):
 *
 *   http          routes, DTO schemas, middleware, error mapping
 *     ↓
 *   services      business rules, transactions, audit recording
 *     ↓
 *   repositories  Drizzle queries only
 *     ↓
 *   db            client, schema, migrations
 *
 *   jobs          worker handlers (sit beside http: call services only)
 *
 *   domain        pure types, errors, policies, hash chain (usable by all; imports nothing above)
 */
type Pattern = { group?: string[]; regex?: string; message: string };

const layer = (files: string[], patterns: Pattern[]) => ({
  files,
  rules: { "no-restricted-imports": ["error", { patterns }] },
});

const msg = (from: string, to: string) => `${from} layer must not import ${to}.`;

export default [
  ...config,
  {
    // Babel parser + core rules misreport TS types; `tsc --noEmit` covers both.
    files: ["src/**/*.ts"],
    // no-console: runtime code logs through pino (src/config/logger.ts).
    rules: { "no-undef": "off", "no-unused-vars": "off", "no-console": "error" },
  },
  {
    // CLI scripts print to the operator; tests may print diagnostics.
    files: ["src/scripts/**/*.ts", "src/test/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Tests set env vars for an isolated run, and one-off CLI scripts read their own inputs
    // (e.g. SUPER_ADMIN_PASSWORD); neither affects turbo build caching.
    // drizzle.config.ts is a CLI config that reads DATABASE_URL itself.
    files: ["src/test/**/*.ts", "src/scripts/**/*.ts", "drizzle.config.ts"],
    rules: { "turbo/no-undeclared-env-vars": "off" },
  },
  layer(
    ["src/domain/**/*.ts"],
    [
      {
        group: ["**/db/*", "**/repositories/*", "**/services/*", "**/http/*"],
        message: msg("domain", "other layers"),
      },
      { group: ["hono", "hono/*", "@hono/*", "drizzle-orm", "drizzle-orm/*"], message: msg("domain", "frameworks") },
    ],
  ),
  layer(
    ["src/repositories/**/*.ts"],
    [
      { group: ["**/services/*", "**/http/*"], message: msg("repository", "services/http") },
      { group: ["hono", "hono/*", "@hono/*"], message: msg("repository", "HTTP frameworks") },
    ],
  ),
  layer(
    ["src/services/**/*.ts"],
    [
      { group: ["**/http/*", "**/http/**"], message: msg("service", "http") },
      // hono/jwt is allowed: it's a JWT util, not HTTP plumbing.
      { regex: "^(@hono/|hono($|/(?!jwt$)))", message: msg("service", "HTTP frameworks (throw DomainError instead)") },
      { group: ["drizzle-orm", "drizzle-orm/*"], message: "Services call repositories; put queries there." },
    ],
  ),
  layer(
    ["src/jobs/**/*.ts"],
    [
      {
        group: ["**/repositories/*", "**/http/*", "**/http/**", "**/db/client*", "**/db/migrate*"],
        message: msg("jobs", "repositories/http; handlers call services"),
      },
      { group: ["drizzle-orm", "drizzle-orm/*"], message: msg("jobs", "the ORM") },
      { group: ["hono", "hono/*", "@hono/*"], message: msg("jobs", "HTTP frameworks") },
    ],
  ),
  layer(
    ["src/http/**/*.ts"],
    [
      {
        group: ["**/repositories/*", "**/db/client*", "**/db/index*", "**/db/tenant*", "**/db/migrate*"],
        message: msg("http", "repositories/db; go through a service (type-only imports from db/schemas are fine)"),
      },
      { group: ["drizzle-orm", "drizzle-orm/*"], message: msg("http", "the ORM") },
    ],
  ),
];
