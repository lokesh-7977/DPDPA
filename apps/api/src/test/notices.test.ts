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
const { sql } = await import("drizzle-orm");
const { assessNotice } = await import("../domain/notices.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let dpoToken: string;
let noticeId: string;
let v1: string;
let v2: string;
let marketing: string;
let analytics: string;
let principal: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;

const content = (purposes: Record<string, { description: string; personalData: string }>, title = "Privacy notice") => ({
  title,
  introduction: "Acme asks for your consent to use your personal data as described below.",
  purposes,
  withdrawal: "Withdraw any time from Settings > Privacy, as easily as you gave it.",
  rights: "Ask for access, correction or erasure, or nominate someone, from Settings > Privacy.",
  complaint: "If we don't resolve your grievance, you can complain to the Data Protection Board of India.",
});

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
  dpoToken = await t.addMember(org.orgId, org.adminToken, "dpo@acme.test", "privacy_officer");
  const purpose = (code: string, extra = {}) =>
    t.call("POST", P("/purposes"), org.adminToken, {
      code,
      name: code,
      description: `${code} purpose`,
      dataCategories: ["email"],
      retentionDays: 365,
      ...extra,
    });
  marketing = (await purpose("marketing")).body.id;
  analytics = (await purpose("analytics")).body.id;
  principal = (await t.call("POST", P("/data-principals"), editorToken, { externalRef: "U1", email: "u1@x.in" })).body.id;
});
after(() => t.closeDb());

describe("r.3 completeness (pure)", () => {
  test("lists what is missing", () => {
    const issues = assessNotice({
      purposeCodes: ["marketing"],
      withdrawUrl: null,
      rightsUrl: "https://acme.in/rights",
      translations: { hi: content({}) as any },
    }).map((i) => i.code);
    assert.deepEqual(issues.sort(), ["no_english", "no_withdraw_link", "purpose_missing"]);
  });
});

describe("notice builder", () => {
  test("create: editors can, viewers can't; codes unique per org", async () => {
    assert.equal((await t.call("POST", P("/notices"), viewerToken, { code: "main", name: "Main" })).status, 403);
    const res = await t.call("POST", P("/notices"), editorToken, { code: "main", name: "Main app notice" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    noticeId = res.body.notice.id;
    v1 = res.body.version.id;
    assert.equal(res.body.version.status, "draft");
    assert.equal((await t.call("POST", P("/notices"), editorToken, { code: "main", name: "Again" })).status, 409);
    assert.equal((await t.call("GET", P("/notices/languages"), viewerToken)).body.length, 23);
  });

  test("draft purposes: own org, active and consent-based only", async () => {
    const path = P(`/notice-versions/${v1}`);
    const foreign = await t.call("POST", `/orgs/${other.orgId}/purposes`, other.adminToken, {
      code: "x",
      name: "x",
      description: "x",
      dataCategories: ["email"],
      retentionDays: 30,
    });
    assert.equal((await t.call("PATCH", path, editorToken, { purposeIds: [foreign.body.id] })).status, 422);
    const legit = await t.call("POST", P("/purposes"), org.adminToken, {
      code: "fraud",
      name: "Fraud checks",
      description: "Fraud prevention",
      dataCategories: ["email"],
      retentionDays: 30,
      legalBasis: "legitimate_use",
    });
    assert.equal((await t.call("PATCH", path, editorToken, { purposeIds: [legit.body.id] })).status, 422);
    assert.equal((await t.call("PATCH", path, editorToken, { withdrawUrl: "http://acme.in/withdraw" })).status, 400, "https only");
    const ok = await t.call("PATCH", path, editorToken, {
      purposeIds: [marketing],
      withdrawUrl: "https://acme.in/privacy/withdraw",
      rightsUrl: "https://acme.in/privacy/rights",
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test("translations: 22 scheduled languages + English only; text validated; Indic joiners allowed", async () => {
    const tr = (lang: string) => P(`/notice-versions/${v1}/translations/${lang}`);
    const en = content({ marketing: { description: "Offers by email", personalData: "Your email address" } });
    assert.equal((await t.call("PUT", tr("fr"), editorToken, en)).status, 400);
    assert.equal((await t.call("PUT", tr("en"), editorToken, { ...en, title: "A\u0000B" })).status, 400);
    assert.equal((await t.call("PUT", tr("en"), viewerToken, en)).status, 403);
    assert.equal((await t.call("PUT", tr("en"), editorToken, en)).status, 204);
    const hi = content(
      { marketing: { description: "ईमेल द्वारा ऑफ़र", personalData: "आपका ईमेल पता" } },
      "गोपनीयता सूचना\u200d",
    );
    assert.equal((await t.call("PUT", tr("hi"), editorToken, hi)).status, 204);
    const detail = (await t.call("GET", P(`/notice-versions/${v1}`), viewerToken)).body;
    assert.deepEqual(detail.translations.map((x: any) => x.language), ["en", "hi"]);
    assert.deepEqual(detail.issues, []);
    assert.equal(detail.label, "main.v1");
  });

  test("publish: DPO / admin, only when complete", async () => {
    // Make it incomplete: add a purpose the texts don't cover.
    await t.call("PATCH", P(`/notice-versions/${v1}`), editorToken, { purposeIds: [marketing, analytics] });
    assert.equal((await t.call("POST", P(`/notice-versions/${v1}/publish`), editorToken)).status, 403);
    const bad = await t.call("POST", P(`/notice-versions/${v1}/publish`), dpoToken);
    assert.equal(bad.status, 422);
    assert.match(bad.body.error, /\[en\] Purpose analytics/);
    await t.call("PATCH", P(`/notice-versions/${v1}`), editorToken, { purposeIds: [marketing] });
    const ok = await t.call("POST", P(`/notice-versions/${v1}/publish`), dpoToken);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "published");
  });

  test("published versions are frozen (API and database)", async () => {
    assert.equal((await t.call("PATCH", P(`/notice-versions/${v1}`), editorToken, { rightsUrl: "https://x.in/r" })).status, 409);
    assert.equal(
      (await t.call("PUT", P(`/notice-versions/${v1}/translations/ta`), editorToken, content({ marketing: { description: "x", personalData: "y" } }))).status,
      409,
    );
    await assert.rejects(
      t.db.execute(sql`UPDATE notice_translations SET content = '{}'::jsonb WHERE language = 'en'`),
      (e: Error & { cause?: Error }) => /not a draft/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(sql`UPDATE notice_versions SET rights_url = 'https://evil.example' WHERE status = 'published'`),
      (e: Error & { cause?: Error }) => /immutable/.test(e.cause?.message ?? e.message),
    );
  });

  test("public notice: requested language, English fallback, 404s", async () => {
    const hi = await t.call("GET", "/public/orgs/acme/notices/main?lang=hi");
    assert.equal(hi.status, 200, JSON.stringify(hi.body));
    assert.equal(hi.body.language, "hi");
    assert.equal(hi.body.versionId, v1);
    assert.equal(hi.body.content.purposes.marketing.personalData, "आपका ईमेल पता");
    assert.deepEqual(hi.body.availableLanguages, ["en", "hi"]);
    assert.equal((await t.call("GET", "/public/orgs/acme/notices/main?lang=ta")).body.language, "en");
    assert.equal((await t.call("GET", "/public/orgs/acme/notices/nope")).status, 404);
    assert.equal((await t.call("GET", "/public/orgs/beta/notices/main")).status, 404);
  });

  test("new version copies the latest; publishing it retires the old one", async () => {
    const draft = await t.call("POST", P(`/notices/${noticeId}/versions`), editorToken);
    assert.equal(draft.status, 201);
    v2 = draft.body.id;
    assert.equal(draft.body.versionNo, 2);
    assert.equal((await t.call("POST", P(`/notices/${noticeId}/versions`), editorToken)).status, 409, "one draft at a time");
    await t.call("PATCH", P(`/notice-versions/${v2}`), editorToken, { purposeIds: [marketing, analytics] });
    const both = { marketing: { description: "Offers by email", personalData: "Your email address" }, analytics: { description: "Usage stats", personalData: "Pages you visit" } };
    await t.call("PUT", P(`/notice-versions/${v2}/translations/en`), editorToken, content(both));
    await t.call("DELETE", P(`/notice-versions/${v2}/translations/hi`), editorToken);
    assert.equal((await t.call("POST", P(`/notice-versions/${v2}/publish`), org.adminToken)).status, 200);
    const list = (await t.call("GET", P("/notices"), viewerToken)).body[0].versions;
    assert.deepEqual(list.map((v: any) => [v.versionNo, v.status]), [[2, "published"], [1, "retired"]]);
  });
});

describe("consent tied to the notice shown", () => {
  const grant = (extra: Record<string, unknown>, purposeId = analytics) =>
    t.call("POST", P("/consents"), editorToken, { principalId: principal, purposeId, language: "en-IN", channel: "web", ...extra });

  test("current version + covered purpose + available language", async () => {
    assert.equal((await grant({ noticeVersionId: v1 })).status, 422, "retired version");
    assert.equal((await grant({ noticeVersionId: v2, language: "hi" })).status, 422, "no Hindi in v2");
    const foreign = await t.call("POST", `/orgs/${other.orgId}/notices`, other.adminToken, { code: "main", name: "x" });
    assert.equal((await grant({ noticeVersionId: foreign.body.version.id })).status, 422, "other org");
    assert.equal((await grant({ noticeVersionId: v2, noticeVersion: "main.v1" })).status, 422, "label mismatch");
    const ok = await grant({ noticeVersionId: v2 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.noticeVersion, "main.v2");
    assert.equal(ok.body.noticeVersionId, v2);
  });

  test("external notices still work with a label; one of the two is required", async () => {
    assert.equal((await grant({}, marketing)).status, 400);
    const ok = await grant({ noticeVersion: "website-2026-11" }, marketing);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.noticeVersionId, null);
  });

  test("audit chain valid", async () => {
    const audit = (await t.call("GET", P("/audit?limit=500"), org.adminToken)).body.items;
    assert.ok(audit.some((a: any) => a.action === "notice.published"));
    const granted = audit.find((a: any) => a.action === "consent.granted" && a.payload.noticeVersionId === v2);
    assert.ok(granted);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});
