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

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let approvedPolicy: string;
let approvedVersion: string;
let draftPolicy: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;

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
  dpoToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "dpo@acme.test",
    "privacy_officer",
  );
  await t.call("PATCH", `/orgs/${org.orgId}`, org.adminToken, {
    dpoName: "Asha Rao",
    dpoEmail: "dpo@acme.in",
  });

  // One approved policy, one draft.
  const p = await t.call("POST", P("/policies"), editorToken, {
    code: "information_security",
  });
  approvedPolicy = p.body.policy.id;
  approvedVersion = p.body.version.id;
  const V = `/policies/${approvedPolicy}/versions/${approvedVersion}`;
  await t.call("PUT", P(V), editorToken, {
    body: "# Information security policy\n\nWe encrypt personal data at rest.\n",
  });
  await t.call("POST", P(`${V}/submit`), editorToken);
  assert.equal(
    (await t.call("POST", P(`${V}/approve`), dpoToken)).body.status,
    "approved",
  );
  draftPolicy = (
    await t.call("POST", P("/policies"), editorToken, {
      code: "breach_response",
    })
  ).body.policy.id;

  for (const r of [
    { name: "CloudCo", role: "processor", country: "SG" },
    { name: "Insurer", role: "third_party", country: "IN" },
  ]) {
    await t.call("POST", P("/ropa/recipients"), editorToken, r);
  }
});
after(() => t.closeDb());

describe("trust center", () => {
  test("nothing is public before it is published and turned on", async () => {
    assert.equal((await t.call("GET", "/public/orgs/acme/trust")).status, 404);
    const g = (await t.call("GET", P("/trust-center"), editorToken)).body;
    assert.equal(g.settings.enabled, false);
    assert.equal(g.latest, null);
    assert.equal(
      (
        await t.call("POST", P("/trust-center/visibility"), org.adminToken, {
          enabled: true,
        })
      ).status,
      409,
    );
  });

  test("settings: DPO / admin; only the org's own policies", async () => {
    const body = {
      headline: "Privacy at Acme",
      overview: "How we protect your personal data.",
      contactEmail: "privacy@acme.in",
      showReadiness: true,
      showProcessors: true,
      policyIds: [approvedPolicy],
    };
    assert.equal(
      (await t.call("PUT", P("/trust-center"), editorToken, body)).status,
      403,
    );
    const foreign = (
      await t.call("POST", `/orgs/${other.orgId}/policies`, other.adminToken, {
        code: "privacy_notice",
      })
    ).body.policy.id;
    assert.equal(
      (
        await t.call("PUT", P("/trust-center"), dpoToken, {
          ...body,
          policyIds: [foreign],
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("PUT", P("/trust-center"), dpoToken, {
          contactEmail: "not-an-email",
        })
      ).status,
      400,
    );
    const ok = await t.call("PUT", P("/trust-center"), dpoToken, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.policyIds, [approvedPolicy]);
  });

  test("publish: snapshot of contacts, readiness, processors and approved policies", async () => {
    await t.call("PUT", P("/trust-center"), dpoToken, {
      policyIds: [approvedPolicy, draftPolicy],
    });
    const refused = await t.call("POST", P("/trust-center/publish"), dpoToken);
    assert.equal(refused.status, 409, "draft policy has no approved version");
    await t.call("PUT", P("/trust-center"), dpoToken, {
      policyIds: [approvedPolicy],
    });

    assert.equal(
      (await t.call("POST", P("/trust-center/publish"), editorToken)).status,
      403,
    );
    const s = await t.call("POST", P("/trust-center/publish"), dpoToken);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.version, 1);
    assert.deepEqual(s.body.dpo, { name: "Asha Rao", email: "dpo@acme.in" });
    assert.deepEqual(
      s.body.processors,
      [{ name: "CloudCo", country: "SG" }],
      "processors only, not third parties",
    );
    assert.ok(s.body.readiness.some((r: any) => r.framework === "DPDPA_2023"));
    assert.deepEqual(
      s.body.policies.map((p: any) => [p.title, p.versionId]),
      [["Information security policy", approvedVersion]],
    );
  });

  test("public page: org admin turns it on; serves only the snapshot and its policies", async () => {
    assert.equal(
      (
        await t.call("POST", P("/trust-center/visibility"), dpoToken, {
          enabled: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", P("/trust-center/visibility"), org.adminToken, {
          enabled: true,
        })
      ).body.enabled,
      true,
    );

    const page = await t.call("GET", "/public/orgs/acme/trust");
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.headline, "Privacy at Acme");

    // A change after publishing is not public until the next publish.
    await t.call("PUT", P("/trust-center"), dpoToken, { headline: "Changed" });
    assert.equal(
      (await t.call("GET", "/public/orgs/acme/trust")).body.headline,
      "Privacy at Acme",
    );

    const pol = await t.call(
      "GET",
      `/public/orgs/acme/trust/policies/${approvedVersion}`,
    );
    assert.equal(pol.status, 200);
    assert.match(pol.body.body, /encrypt personal data/);
    const draftVersion = (
      await t.call("GET", P(`/policies/${draftPolicy}`), editorToken)
    ).body.versions[0].id;
    assert.equal(
      (await t.call("GET", `/public/orgs/acme/trust/policies/${draftVersion}`))
        .status,
      404,
      "unlisted policy",
    );
    assert.equal(
      (
        await t.call(
          "GET",
          `/public/orgs/beta/trust/policies/${approvedVersion}`,
        )
      ).status,
      404,
      "other org's page",
    );

    await t.call("POST", P("/trust-center/visibility"), org.adminToken, {
      enabled: false,
    });
    assert.equal((await t.call("GET", "/public/orgs/acme/trust")).status, 404);
    assert.equal(
      (
        await t.call(
          "GET",
          `/public/orgs/acme/trust/policies/${approvedVersion}`,
        )
      ).status,
      404,
    );
  });

  test("snapshots are immutable; isolation; audit", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE trust_center_snapshots SET version = 9`),
      (e: Error & { cause?: Error }) =>
        /append-only/.test(e.cause?.message ?? e.message),
    );
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/trust-center`,
          other.adminToken,
        )
      ).body.latest,
      null,
    );
    const items = (await t.call("GET", P("/audit?limit=300"), org.adminToken))
      .body.items;
    for (const a of [
      "trust_center.settings_updated",
      "trust_center.published",
      "trust_center.enabled",
      "trust_center.disabled",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
