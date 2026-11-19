import { pino } from "pino";
import { z } from "zod";

/** Startup-only logger: the configured one (config/logger.ts) needs a valid env first. */
const bootLog = pino({ base: { service: "dpdpa-api" } });

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3002),
  /** Overrides the per-environment default (prod info, dev debug, test silent). */
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),
  /** postgres://... in real deployments. Unset => embedded PGlite (dev only). */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default(".pglite"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_ISSUER: z.string().default("dpdpa-api"),
  /**
   * Key for HMAC-ing IP/User-Agent before they enter the immutable audit chain.
   * Defaults to a key derived from JWT_SECRET; set separately in production.
   */
  AUDIT_HMAC_KEY: z.string().min(32).optional(),
  /**
   * AES-256-GCM key (32 random bytes, base64) encrypting website test-account credentials
   * (phase 4c). Defaults to a key derived from JWT_SECRET outside production.
   */
  CREDENTIAL_VAULT_KEY: z
    .string()
    .refine(
      (s) =>
        /^[A-Za-z0-9+/]{43}=$/.test(s) &&
        // Random 32-byte keys have ~31 distinct byte values; typed or repeated text has far fewer.
        new Set(Buffer.from(s, "base64")).size >= 16,
      "CREDENTIAL_VAULT_KEY must be 32 random bytes, base64 (openssl rand -base64 32)",
    )
    .optional(),
  /** Only trust X-Forwarded-For when running behind a known reverse proxy. */
  TRUST_PROXY: z.stringbool().default(false),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://localhost:3001")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  /** Web app base URL, used in invitation links. */
  APP_URL: z.url().default("http://localhost:3000"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  INVITATION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  /**
   * resend = real delivery via Resend (required in production).
   * memory = tests (kept in-process). console = dev (prints links).
   */
  MAIL_DRIVER: z.enum(["resend", "memory", "console"]).default("console"),
  /** Resend API key (re_…). Secret: never logged. */
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  /** Sender, on a domain verified in Resend, e.g. `DPDPA Platform <no-reply@mail.example.in>`. */
  MAIL_FROM: z.string().min(3).optional(),
  /** Per-IP / per-account limits on auth endpoints. Only disable in tests. */
  RATE_LIMIT_ENABLED: z.stringbool().default(true),
  /** memory = per process (dev / one instance); postgres = shared by every API instance. */
  RATE_LIMIT_STORE: z.enum(["memory", "postgres"]).default("memory"),
  /**
   * Where generated files (exports, reports, evidence) are stored.
   * fs = local directory (dev / single node). memory = tests. S3 comes later.
   */
  STORAGE_DRIVER: z.enum(["fs", "memory"]).default("fs"),
  STORAGE_DIR: z.string().default(".storage"),
  /** Worker: how often an idle worker polls the job queue. */
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
  /** Worker: jobs claimed per poll. */
  WORKER_BATCH: z.coerce.number().int().min(1).max(50).default(5),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // fieldErrors holds zod messages only, never the submitted values.
  bootLog.fatal(
    { fieldErrors: z.flattenError(parsed.error).fieldErrors },
    "Invalid environment",
  );
  process.exit(1);
}

export const env = parsed.data;

if (env.MAIL_DRIVER === "resend" && (!env.RESEND_API_KEY || !env.MAIL_FROM)) {
  bootLog.fatal("MAIL_DRIVER=resend needs RESEND_API_KEY and MAIL_FROM");
  process.exit(1);
}

if (env.NODE_ENV === "production") {
  const problems: string[] = [];
  if (!env.DATABASE_URL) problems.push("DATABASE_URL is required");
  // Placeholder from .env.example, or too short to be 32 random bytes (base64url = 43 chars).
  if (/change-me/i.test(env.JWT_SECRET) || env.JWT_SECRET.length < 43) {
    problems.push(
      "JWT_SECRET must be a real random secret (>= 43 chars, not the example)",
    );
  }
  if (!env.AUDIT_HMAC_KEY) {
    problems.push("AUDIT_HMAC_KEY is required");
  } else if (
    /change-me/i.test(env.AUDIT_HMAC_KEY) ||
    env.AUDIT_HMAC_KEY === env.JWT_SECRET
  ) {
    problems.push(
      "AUDIT_HMAC_KEY must be its own random secret (not JWT_SECRET, not the example)",
    );
  }
  if (!env.CREDENTIAL_VAULT_KEY)
    problems.push("CREDENTIAL_VAULT_KEY is required (openssl rand -base64 32)");
  if (!env.RATE_LIMIT_ENABLED)
    problems.push("RATE_LIMIT_ENABLED=false is not allowed in production");
  if (env.RATE_LIMIT_STORE !== "postgres")
    problems.push(
      "RATE_LIMIT_STORE=postgres is required in production (limits shared by every instance)",
    );
  // memory/console would hold or print invitation tokens.
  if (env.MAIL_DRIVER !== "resend") {
    problems.push(
      `MAIL_DRIVER=${env.MAIL_DRIVER} is not allowed in production (use resend)`,
    );
  }
  if (!env.APP_URL.startsWith("https://"))
    problems.push("APP_URL must be https in production");
  if (env.STORAGE_DRIVER === "memory")
    problems.push("STORAGE_DRIVER=memory is not allowed in production");
  // Explicit, exact https origins (scheme + host [+ port], no path); the localhost default fails.
  const isHttpsOrigin = (o: string) => {
    try {
      const u = new URL(o);
      return (
        u.protocol === "https:" && u.origin === o && u.hostname !== "localhost"
      );
    } catch {
      return false;
    }
  };
  if (!env.CORS_ORIGINS.length || !env.CORS_ORIGINS.every(isHttpsOrigin)) {
    problems.push(
      "CORS_ORIGINS must be exact https origins (e.g. https://app.example.com) in production",
    );
  }
  if (problems.length) {
    bootLog.fatal({ problems }, "Invalid production environment");
    process.exit(1);
  }
}
