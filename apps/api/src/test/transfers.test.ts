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
const { isRestricted, transferFlags } = await import("../domain/transfers.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let openAi: string;
let domestic: string;
let activity: string;
let transferId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const today = () => new Date().toISOString().slice(0, 10);

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  editorToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "editor@acme.test",
    "editor",
  );
  viewerToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "viewer@acme.test",
    "viewer",
  );
  openAi = (
    await t.call("POST", P("/ropa/recipients"), editorToken, {
      name: "OpenAI",
      role: "processor",
      country: "US",
    })
  ).body.id;
  domestic = (
    await t.call("POST", P("/ropa/recipients"), editorToken, {
      name: "MailCo",
      role: "processor",
      country: "IN",
    })
  ).body.id;
  activity = (
    await t.call("POST", P("/ropa/activities"), editorToken, {
      code: "kyc",
      name: "KYC",
      purpose: "Verify identity",
    })
  ).body.id;
});
after(() => t.closeDb());

describe("transfer rules (pure)", () => {
  test("restriction windows and flags", () => {
    const r = [
      { country: "XX", effectiveFrom: "2027-01-01", liftedOn: "2027-06-01" },
    ];
    assert.equal(isRestricted("XX", r, "2026-12-31"), false);
    assert.equal(isRestricted("XX", r, "2027-03-01"), true);
    assert.equal(isRestricted("XX", r, "2027-06-01"), false, "lifted");
    const flags = transferFlags(
      { country: "XX", startedOn: "2026-01-01", endedOn: null },
      { restrictions: r, isSdf: true, day: "2027-03-01" },
    );
    assert.deepEqual(flags, ["restricted_country", "sdf_localisation_check"]);
    assert.deepEqual(
      transferFlags(
        { country: "XX", startedOn: "2026-01-01", endedOn: "2026-06-01" },
        { restrictions: r, isSdf: true, day: "2027-03-01" },
      ),
      [],
      "ended",
    );
  });
});

describe("transfer register (s.16, r.15)", () => {
  test("a recipient abroad shows as unregistered; the cross-border check fails", async () => {
    const gaps = (
      await t.call("GET", P("/transfers/unregistered"), viewerToken)
    ).body;
    assert.deepEqual(
      gaps.map((r: any) => r.name),
      ["OpenAI"],
    );
    const c = (
      await t.call(
        "GET",
        P("/compliance/controls/DPDPA_2023/DPDP-XBORDER-01"),
        viewerToken,
      )
    ).body.control;
    assert.equal(c.status, "not_met");
    assert.match(c.check.reason, /not in the transfer register/);
  });

  test("record: editors only, outside India, own-org recipient and activity", async () => {
    const body = {
      recipientId: openAi,
      activityId: activity,
      dataCategories: ["KYC documents"],
      purpose: "Document extraction",
      safeguards: "DPA with no-training clause",
      startedOn: "2026-04-01",
    };
    assert.equal(
      (await t.call("POST", P("/transfers"), viewerToken, body)).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", P("/transfers"), editorToken, {
          ...body,
          recipientId: domestic,
        })
      ).status,
      422,
      "recipient in India",
    );
    assert.equal(
      (
        await t.call("POST", P("/transfers"), editorToken, {
          ...body,
          country: "IN",
        })
      ).status,
      400,
    );
    const foreign = await t.call(
      "POST",
      `/orgs/${other.orgId}/ropa/recipients`,
      other.adminToken,
      { name: "X", role: "processor", country: "SG" },
    );
    assert.equal(
      (
        await t.call("POST", P("/transfers"), editorToken, {
          ...body,
          recipientId: foreign.body.id,
        })
      ).status,
      422,
    );
    const ok = await t.call("POST", P("/transfers"), editorToken, body);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.country, "US", "defaults to the recipient's country");
    transferId = ok.body.id;
    assert.deepEqual(
      (await t.call("GET", P("/transfers/unregistered"), viewerToken)).body,
      [],
    );
    const c = (
      await t.call(
        "GET",
        P("/compliance/controls/DPDPA_2023/DPDP-XBORDER-01"),
        viewerToken,
      )
    ).body.control;
    assert.equal(c.check.result, "pass");
  });

  test("restricted countries: super admin keeps the list; restricted destinations are refused and flagged", async () => {
    const add = {
      country: "US",
      notification: "G.S.R. 999(E) (test)",
      effectiveFrom: today(),
    };
    assert.equal(
      (
        await t.call(
          "POST",
          "/platform/restricted-countries",
          org.adminToken,
          add,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", "/platform/restricted-countries", t.superToken, {
          ...add,
          country: "IN",
        })
      ).status,
      400,
    );
    const r = await t.call(
      "POST",
      "/platform/restricted-countries",
      t.superToken,
      add,
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(
      (await t.call("GET", P("/transfers/restricted-countries"), viewerToken))
        .body.length,
      1,
    );

    // The existing transfer is now flagged; the check fails; new transfers there are refused.
    const listed = (await t.call("GET", P("/transfers"), viewerToken)).body;
    assert.deepEqual(listed[0].flags, ["restricted_country"]);
    const c = (
      await t.call(
        "GET",
        P("/compliance/controls/DPDPA_2023/DPDP-XBORDER-01"),
        viewerToken,
      )
    ).body.control;
    assert.equal(c.status, "not_met");
    assert.match(c.check.reason, /restricted under s\.16\(1\)/);
    const refused = await t.call("POST", P("/transfers"), editorToken, {
      recipientId: openAi,
      dataCategories: ["email"],
      purpose: "x",
      startedOn: today(),
    });
    assert.equal(refused.status, 422);
    assert.match(refused.body.error, /s\.16\(1\)/);

    // Lifting it (tomorrow) makes the destination usable again from that day.
    const tomorrow = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(
      (
        await t.call(
          "POST",
          `/platform/restricted-countries/${r.body.id}/lift`,
          t.superToken,
          { liftedOn: tomorrow },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/platform/restricted-countries/${r.body.id}/lift`,
          t.superToken,
          { liftedOn: tomorrow },
        )
      ).status,
      409,
    );
  });

  test("SDF orgs get the localisation reminder (r.13(4))", async () => {
    await t.call("PATCH", P(""), org.adminToken, { isSdf: true });
    const listed = (await t.call("GET", P("/transfers"), viewerToken)).body;
    assert.ok(listed[0].flags.includes("sdf_localisation_check"));
    await t.call("PATCH", P(""), org.adminToken, { isSdf: false });
  });

  test("end a transfer; org isolation", async () => {
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/transfers/${transferId}/end`,
          other.adminToken,
          { endedOn: today() },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call("POST", P(`/transfers/${transferId}/end`), editorToken, {
          endedOn: "2026-01-01",
        })
      ).status,
      422,
    );
    const ended = await t.call(
      "POST",
      P(`/transfers/${transferId}/end`),
      editorToken,
      { endedOn: today() },
    );
    assert.equal(ended.status, 200);
    assert.equal(
      (
        await t.call("POST", P(`/transfers/${transferId}/end`), editorToken, {
          endedOn: today(),
        })
      ).status,
      409,
    );
    assert.equal(
      (await t.call("GET", `/orgs/${other.orgId}/transfers`, other.adminToken))
        .body.length,
      0,
    );
  });

  test("audit chain: countries and ids, no free text", async () => {
    const items = (await t.call("GET", P("/audit?limit=200"), org.adminToken))
      .body.items;
    const text = JSON.stringify(
      items.filter((a: any) => a.action.startsWith("transfer.")),
    );
    assert.ok(
      text.includes("transfer.recorded") && text.includes("transfer.ended"),
    );
    assert.equal(text.includes("no-training clause"), false);
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
