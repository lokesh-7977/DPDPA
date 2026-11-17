import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { pino } from "pino";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { REDACT_PATHS } = await import("../config/logger.ts");

test("PII and secrets are redacted even if passed to the logger by mistake", () => {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const log = pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, sink);

  log.info(
    {
      email: "a@b.in",
      password: "hunter2-hunter2",
      user: { email: "c@d.in", phone: "+919999999999", token: "tok" },
      headers: { authorization: "Bearer x", cookie: "dpdpa_rt=y" },
      orgId: "keep-me",
    },
    "test",
  );

  const out = lines.join("");
  for (const secret of ["a@b.in", "hunter2", "c@d.in", "+919999999999", "Bearer x", "dpdpa_rt=y", '"tok"']) {
    assert.equal(out.includes(secret), false, `leaked ${secret}`);
  }
  assert.ok(out.includes("keep-me"));
});
