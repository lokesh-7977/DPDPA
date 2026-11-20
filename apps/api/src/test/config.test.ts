import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

/**
 * Production config checks (config/env.ts) run at import and stop the process on any problem.
 * Each case loads the module in a child process with a controlled environment.
 */
const apiDir = fileURLToPath(new URL("../..", import.meta.url));
const rand = (n: number) => randomBytes(n).toString("base64url");

/** A complete, valid production environment (no real services are contacted). */
const valid = (): Record<string, string> => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgres://app:x@db.example.com:5432/app",
  JWT_SECRET: rand(48),
  AUDIT_HMAC_KEY: rand(48),
  CREDENTIAL_VAULT_KEY: randomBytes(32).toString("base64"),
  RATE_LIMIT_ENABLED: "true",
  RATE_LIMIT_STORE: "postgres",
  MAIL_DRIVER: "resend",
  RESEND_API_KEY: "re_test_key",
  MAIL_FROM: "Platform <no-reply@mail.example.com>",
  APP_URL: "https://app.example.com",
  STORAGE_DRIVER: "fs",
  CORS_ORIGINS: "https://app.example.com",
  LOG_LEVEL: "fatal",
});

function load(env: Record<string, string>) {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      "await import('./src/config/env.ts'); console.log('BOOT_OK')",
    ],
    // Only what the check needs: never the developer's own environment or .env.
    {
      cwd: apiDir,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("production config checks", () => {
  test("a complete production environment boots", () => {
    const r = load(valid());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /BOOT_OK/);
  });

  const refused: [string, Record<string, string>, RegExp][] = [
    [
      "example JWT secret",
      { JWT_SECRET: "change-me-change-me-change-me-change-me-change-me" },
      /JWT_SECRET/,
    ],
    [
      "audit key = JWT secret",
      {
        AUDIT_HMAC_KEY: "same-secret-same-secret-same-secret-same-secret",
        JWT_SECRET: "same-secret-same-secret-same-secret-same-secret",
      },
      /AUDIT_HMAC_KEY/,
    ],
    [
      "weak vault key",
      { CREDENTIAL_VAULT_KEY: Buffer.alloc(32, 7).toString("base64") },
      /CREDENTIAL_VAULT_KEY/,
    ],
    ["memory rate limits", { RATE_LIMIT_STORE: "memory" }, /RATE_LIMIT_STORE/],
    ["console mail", { MAIL_DRIVER: "console" }, /MAIL_DRIVER/],
    ["http app URL", { APP_URL: "http://app.example.com" }, /APP_URL/],
    [
      "localhost CORS",
      { CORS_ORIGINS: "https://localhost:3000" },
      /CORS_ORIGINS/,
    ],
    [
      "CORS with a path",
      { CORS_ORIGINS: "https://app.example.com/" },
      /CORS_ORIGINS/,
    ],
  ];
  for (const [name, patch, message] of refused)
    test(`refused: ${name}`, () => {
      const r = load({ ...valid(), ...patch });
      assert.notEqual(r.code, 0, `should not boot: ${name}`);
      assert.match(r.out, message);
      assert.doesNotMatch(r.out, /BOOT_OK/);
    });
});
