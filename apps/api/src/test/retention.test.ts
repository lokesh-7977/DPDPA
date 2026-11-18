import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.STORAGE_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { bootTestApp } = await import("./helpers.ts");
const { memoryOutbox } = await import("../services/mailer.ts");
const { runOnce } = await import("../jobs/runner.ts");
const { erasureDue, scheduleFor } = await import("../domain/retention.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let shop: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let key: string;
let purpose: string;
let leaving: string;
let returning: string;
let held: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY);
const principal = async (id: string, o = org) =>
  (await t.call("GET", `/orgs/${o.orgId}/data-principals/${id}`, o.adminToken))
    .body;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  shop = await t.createOrg("shop");
  editorToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "editor@acme.test",
    "editor",
  );
  dpoToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "dpo@acme.test",
    "privacy_officer",
  );
  await t.call("PATCH", P(""), org.adminToken, { dpoEmail: "dpo@acme.test" });
  key = (
    await t.call("POST", P("/api-keys"), org.adminToken, {
      name: "App",
      scopes: ["consents:write"],
    })
  ).body.key;
  purpose = (
    await t.call("POST", P("/purposes"), org.adminToken, {
      code: "newsletter",
      name: "Newsletter",
      description: "Monthly updates",
      dataCategories: ["email"],
      retentionDays: 30,
    })
  ).body.id;
  const consented = async (ref: string, email: string) => {
    const p = (
      await t.call("POST", P("/data-principals"), key, {
        externalRef: ref,
        email,
      })
    ).body.id;
    const c = await t.call("POST", P("/consents"), key, {
      principalId: p,
      purposeId: purpose,
      noticeVersion: "v1",
      language: "en",
      channel: "web",
    });
    await t.call("POST", P(`/consents/${c.body.id}/withdraw`), key, {});
    return p;
  };
  leaving = await consented("U-LEAVE", "leaving@x.in");
  returning = await consented("U-BACK", "returning@x.in");
  held = await consented("U-HOLD", "held@x.in");
});
after(() => t.closeDb());

describe("erasure rules (pure)", () => {
  const now = new Date("2028-01-01T00:00:00Z");
  const base = {
    erasedAt: null,
    lastActiveAt: new Date("2026-01-01T00:00:00Z"),
    holdUntil: null,
    consents: [],
    hasActiveWards: false,
  };
  const withdrawn = (at: string, days: number) => ({
    status: "withdrawn" as const,
    withdrawnAt: new Date(at),
    expiresAt: null,
    retentionDays: days,
  });

  test("purpose served: all consents ended + retention; never before one year of inactivity (r.8(3))", () => {
    const d = erasureDue(
      { ...base, consents: [withdrawn("2027-06-01T00:00:00Z", 30)] },
      { thirdScheduleClass: null },
      now,
    )!;
    assert.equal(d.reason, "purpose_served");
    assert.equal(d.dueAt.toISOString(), "2027-07-01T00:00:00.000Z");
    const recent = erasureDue(
      {
        ...base,
        lastActiveAt: new Date("2027-06-01T00:00:00Z"),
        consents: [withdrawn("2027-06-01T00:00:00Z", 30)],
      },
      { thirdScheduleClass: null },
      now,
    )!;
    assert.equal(
      recent.dueAt.toISOString(),
      "2028-05-31T00:00:00.000Z",
      "one-year floor",
    );
    const active = {
      status: "granted" as const,
      withdrawnAt: null,
      expiresAt: null,
      retentionDays: 30,
    };
    assert.equal(
      erasureDue(
        { ...base, consents: [withdrawn("2027-06-01T00:00:00Z", 30), active] },
        { thirdScheduleClass: null },
        now,
      ),
      null,
    );
  });

  test("Third Schedule inactivity: three years, not before the Rules' commencement + 3 years", () => {
    const d = erasureDue(
      { ...base, lastActiveAt: new Date("2020-01-01T00:00:00Z") },
      { thirdScheduleClass: "ecommerce" },
      now,
    )!;
    assert.equal(d.reason, "inactivity");
    assert.equal(d.dueAt.toISOString(), "2030-05-13T00:00:00.000Z");
    assert.equal(
      erasureDue(base, { thirdScheduleClass: null }, now),
      null,
      "no consents, not a listed class",
    );
  });

  test("holds, wards and the 48 h notice", () => {
    const c = [withdrawn("2027-06-01T00:00:00Z", 30)];
    assert.equal(
      erasureDue(
        { ...base, consents: c, holdUntil: "2028-06-01" },
        { thirdScheduleClass: null },
        now,
      ),
      null,
    );
    assert.equal(
      erasureDue(
        { ...base, consents: c, hasActiveWards: true },
        { thirdScheduleClass: null },
        now,
      ),
      null,
    );
    assert.equal(
      scheduleFor(new Date("2027-07-01T00:00:00Z"), now).toISOString(),
      "2028-01-03T00:00:00.000Z",
    );
  });
});

describe("retention sweep", () => {
  test("settings: Third Schedule class is validated and needs org_admin", async () => {
    assert.equal(
      (
        await t.call("PATCH", `/orgs/${shop.orgId}`, shop.adminToken, {
          thirdScheduleClass: "bank",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call("PATCH", P(""), editorToken, {
          thirdScheduleClass: "ecommerce",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await t.call("PATCH", `/orgs/${shop.orgId}`, shop.adminToken, {
          thirdScheduleClass: "ecommerce",
        })
      ).body.thirdScheduleClass,
      "ecommerce",
    );
  });

  test("legal hold (s.8(7)): DPO / admin, future date", async () => {
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/data-principals/${held}/retention-hold`),
          editorToken,
          { holdUntil: "2099-01-01", reason: "x" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/data-principals/${held}/retention-hold`),
          dpoToken,
          { holdUntil: "2020-01-01", reason: "x" },
        )
      ).status,
      422,
    );
    const ok = await t.call(
      "POST",
      P(`/data-principals/${held}/retention-hold`),
      dpoToken,
      {
        holdUntil: "2099-01-01",
        reason: "Tax records: Income-tax Act retention",
      },
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.holdUntil, "2099-01-01");
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${shop.orgId}/data-principals/${held}/retention-hold`,
          shop.adminToken,
          { holdUntil: "2099-01-01", reason: "x" },
        )
      ).status,
      404,
    );
  });

  test("a year after withdrawal: erasure scheduled, notice emailed (r.8(2)), preview shows it", async () => {
    await runOnce({ now: inDays(366), batch: 50 });
    const p = await principal(leaving);
    assert.ok(p.erasureScheduledFor, JSON.stringify(p));
    assert.equal(p.erasureReason, "purpose_served");
    // The daily job runs on its day's clock (midnight UTC); the notice goes out then.
    const jobClock = Date.parse(`${inDays(366).toISOString().slice(0, 10)}T00:00:00Z`);
    assert.ok(
      Date.parse(p.erasureScheduledFor) >= jobClock + 48 * 3_600_000,
      "at least 48 h after the notice",
    );
    const mail = memoryOutbox.find(
      (m) =>
        m.to === "leaving@x.in" &&
        /will erase your personal data/.test(m.subject),
    );
    assert.ok(mail);
    assert.match(mail.text, /log in or contact us/);
    assert.match(mail.text, /dpo@acme\.test/, "r.9 contact");
    assert.equal((await principal(held)).erasureScheduledFor, null, "held");
    const preview = (
      await t.call("GET", P("/retention/preview?days=30"), dpoToken)
    ).body;
    assert.ok(
      preview.some((i: any) => i.principal.id === leaving && i.scheduled),
    );
  });

  test("the person comes back: activity cancels the scheduled erasure", async () => {
    assert.ok((await principal(returning)).erasureScheduledFor);
    const back = await t.call(
      "POST",
      P(`/data-principals/${returning}/activity`),
      key,
    );
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.erasureScheduledFor, null);
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${shop.orgId}/data-principals/${returning}/activity`,
          key,
        )
      ).status,
      404,
    );
  });

  test("after the notice period: erased, with proof in the audit chain", async () => {
    await runOnce({ now: inDays(370), batch: 50 });
    const gone = await principal(leaving);
    assert.ok(gone.erasedAt);
    assert.equal(gone.email, null);
    assert.equal((await principal(returning)).erasedAt, null, "came back");
    assert.equal((await principal(held)).erasedAt, null, "held");
    const audit = (await t.call("GET", P("/audit?limit=500"), org.adminToken))
      .body.items;
    const erased = audit.find(
      (a: any) => a.action === "retention.erased" && a.entityId === leaving,
    );
    assert.equal(erased.payload.reason, "purpose_served");
    assert.ok(
      audit.some(
        (a: any) =>
          a.action === "data_principal.erased" && a.entityId === leaving,
      ),
    );
    assert.equal(
      JSON.stringify(audit).includes("Income-tax"),
      false,
      "hold reason stays out of the chain",
    );
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });

  test("Third Schedule org: three years of inactivity (from the Rules' commencement at the earliest)", async () => {
    const shopKey = (
      await t.call("POST", `/orgs/${shop.orgId}/api-keys`, shop.adminToken, {
        name: "App",
        scopes: ["consents:write"],
      })
    ).body.key;
    const idle = (
      await t.call("POST", `/orgs/${shop.orgId}/data-principals`, shopKey, {
        externalRef: "IDLE",
        email: "idle@x.in",
      })
    ).body.id;
    await runOnce({ now: new Date("2030-05-01T06:00:00Z"), batch: 50 });
    assert.equal(
      (await principal(idle, shop)).erasureScheduledFor,
      null,
      "not before commencement + 3 years",
    );
    await runOnce({ now: new Date("2030-05-12T06:00:00Z"), batch: 50 });
    const p = await principal(idle, shop);
    assert.equal(p.erasureReason, "inactivity");
    assert.match(
      memoryOutbox.find((m) => m.to === "idle@x.in")!.text,
      /three years/,
    );
  });
});
