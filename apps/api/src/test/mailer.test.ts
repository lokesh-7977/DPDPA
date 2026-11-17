import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.MAIL_DRIVER = "memory";
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { createResendMailer } = await import("../services/mailer.ts");

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const message = {
  to: "invitee@acme.test",
  subject: "You're invited",
  text: "Accept: https://app.example/invite#token=SECRET-TOKEN",
};

test("sends to the Resend API with bearer auth and the expected payload", async () => {
  const { impl, calls } = fakeFetch(200, { id: "email_123" });
  await createResendMailer("re_test_key", "DPDPA <no-reply@mail.example.in>", impl).send(message);

  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).Authorization, "Bearer re_test_key");
  assert.deepEqual(JSON.parse(init.body as string), {
    from: "DPDPA <no-reply@mail.example.in>",
    to: ["invitee@acme.test"],
    subject: "You're invited",
    text: message.text,
  });
  assert.ok(init.signal, "request has a timeout");
});

test("a rejected send throws without leaking the key, recipient or link", async () => {
  const { impl } = fakeFetch(422, { statusCode: 422, name: "validation_error", message: "bad from" });
  await assert.rejects(
    createResendMailer("re_secret_key", "x@y.z", impl).send(message),
    (err: Error) => {
      assert.match(err.message, /HTTP 422 \(validation_error\)/);
      for (const secret of ["re_secret_key", "invitee@acme.test", "SECRET-TOKEN"]) {
        assert.equal(err.message.includes(secret), false, `error leaks ${secret}`);
      }
      return true;
    },
  );
});
