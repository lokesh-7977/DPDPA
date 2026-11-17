import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// Separate process (node --test runs each file on its own), with limits ON.
process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "true";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { db, closeDb } = await import("../db/index.ts");
const { app } = await import("../http/app.ts");
const { migrate } = await import("drizzle-orm/pglite/migrator");

before(async () => {
  await migrate(db as never, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
});
after(() => closeDb());

const login = (email: string) =>
  app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "wrong-password-123" }),
  });

test("login is rate-limited per IP + email, with Retry-After", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await login("target@victim.test")).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  const limited = await login("target@victim.test");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("invitation endpoints are rate-limited per IP", async () => {
  let last = 0;
  for (let i = 0; i < 31; i++) {
    const res = await app.request("/invitations/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(43) }),
    });
    last = res.status;
  }
  assert.equal(last, 429);
});
