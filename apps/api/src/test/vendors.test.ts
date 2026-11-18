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
const { questionnaire, scoreAssessment, contractStatus, missingClauses } =
  await import("../domain/vendors.ts");
const { runOnce } = await import("../jobs/runner.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let dpoToken: string;
let mailCo: string;
let thirdParty: string;
let assessmentId: string;
let contractId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;

/** Every question "yes" (or "na" where allowed if asked). */
const allYes = () =>
  Object.fromEntries(
    questionnaire.map((q) => [q.id, { answer: "yes" as const }]),
  );

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
  dpoToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "dpo@acme.test",
    "privacy_officer",
  );
  mailCo = (
    await t.call("POST", P("/ropa/recipients"), editorToken, {
      name: "MailCo",
      role: "processor",
      country: "US",
    })
  ).body.id;
  thirdParty = (
    await t.call("POST", P("/ropa/recipients"), editorToken, {
      name: "Insurer",
      role: "third_party",
      country: "IN",
    })
  ).body.id;
});
after(() => t.closeDb());

describe("scoring and contracts (pure)", () => {
  test("a critical 'no' is high risk whatever the score", () => {
    assert.deepEqual(scoreAssessment(allYes()), {
      score: 100,
      risk: "low",
      gaps: [],
    });
    const r = scoreAssessment({ ...allYes(), breach_notice: { answer: "no" } });
    assert.equal(r.risk, "high");
    assert.ok(r.score > 80);
    assert.deepEqual(r.gaps, [
      {
        question: "breach_notice",
        cite: "s.8(6), r.7",
        answer: "no",
        critical: true,
      },
    ]);
    // 26 weight points; 5 lost = 81 -> medium (no critical question failed).
    const partial = scoreAssessment({
      ...allYes(),
      encryption: { answer: "partial" },
      logging: { answer: "partial" },
      location: { answer: "no" },
      continuity: { answer: "no" },
    });
    assert.equal(partial.score, 81);
    assert.equal(partial.risk, "medium");
    assert.equal(
      scoreAssessment({ ...allYes(), children: { answer: "na" } }).score,
      100,
      "na is left out",
    );
  });
  test("contract in force between signing and expiry; missing clauses cited", () => {
    assert.equal(
      contractStatus(
        { signedOn: "2026-01-01", expiresOn: "2027-01-01" },
        "2026-06-01",
      ),
      "active",
    );
    assert.equal(
      contractStatus(
        { signedOn: "2026-01-01", expiresOn: "2026-05-01" },
        "2026-06-01",
      ),
      "expired",
    );
    assert.equal(
      contractStatus({ signedOn: "2026-07-01", expiresOn: null }, "2026-06-01"),
      "not_started",
    );
    assert.deepEqual(
      missingClauses([
        "purpose_limitation",
        "breach_notification",
        "erasure_on_instruction",
        "log_retention",
        "sub_processor_approval",
        "audit_rights",
        "data_location",
      ]),
      [{ clause: "security_safeguards", cite: "s.8(5), r.6(1)(f)" }],
    );
  });
});

describe("vendors", () => {
  test("list shows processors only; unassessed means review overdue", async () => {
    const list = (await t.call("GET", P("/vendors"), viewerToken)).body;
    assert.deepEqual(
      list.map((v: any) => v.vendor.name),
      ["MailCo"],
    );
    assert.equal(list[0].reviewOverdue, true);
    assert.equal(list[0].risk, null);
    assert.equal(
      (await t.call("GET", P(`/vendors/${thirdParty}`), viewerToken)).status,
      422,
    );
    assert.equal(
      (await t.call("GET", P("/vendors/questionnaire"), viewerToken)).body
        .questions.length,
      questionnaire.length,
    );
  });

  test("assessment: draft, one at a time, answers validated, complete before submit", async () => {
    const path = P(`/vendors/${mailCo}/assessments`);
    assert.equal(
      (await t.call("POST", path, viewerToken, { answers: {} })).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", path, editorToken, {
          answers: { made_up: { answer: "yes" } },
        })
      ).status,
      422,
    );
    const started = await t.call("POST", path, editorToken, {
      answers: { contract: { answer: "yes" } },
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assessmentId = started.body.id;
    assert.equal(
      (await t.call("POST", path, editorToken, { answers: {} })).status,
      409,
      "one in progress",
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/vendor-assessments/${assessmentId}/submit`),
          editorToken,
        )
      ).status,
      422,
      "incomplete",
    );
    assert.equal(
      (
        await t.call(
          "PATCH",
          P(`/vendor-assessments/${assessmentId}`),
          editorToken,
          { answers: { encryption: { answer: "na" } } },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/vendor-assessments/${assessmentId}/submit`),
          editorToken,
        )
      ).status,
      422,
      "encryption can't be na",
    );
    const answers = {
      ...allYes(),
      breach_notice: { answer: "no", note: "Only within 7 days" },
    };
    await t.call(
      "PATCH",
      P(`/vendor-assessments/${assessmentId}`),
      editorToken,
      { answers },
    );
    const sub = await t.call(
      "POST",
      P(`/vendor-assessments/${assessmentId}/submit`),
      editorToken,
    );
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.riskRating, "high");
    assert.equal(
      (
        await t.call(
          "PATCH",
          P(`/vendor-assessments/${assessmentId}`),
          editorToken,
          { answers: allYes() },
        )
      ).status,
      409,
    );
  });

  test("decision: DPO / admin, not the submitter; reject needs a reason; approval sets a yearly review", async () => {
    const approve = P(`/vendor-assessments/${assessmentId}/approve`);
    assert.equal((await t.call("POST", approve, editorToken, {})).status, 403);
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/vendor-assessments/${assessmentId}/reject`),
          dpoToken,
          { note: "" },
        )
      ).status,
      400,
    );
    const ok = await t.call("POST", approve, dpoToken, {
      note: "Accepted with breach-notice follow-up",
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const year = new Date(Date.now() + 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(ok.body.nextReviewOn, year);
    assert.equal(
      (await t.call("POST", approve, org.adminToken, {})).status,
      409,
      "decided once",
    );

    // Segregation: the submitter can't decide on their own assessment.
    const second = await t.call(
      "POST",
      P(`/vendors/${mailCo}/assessments`),
      dpoToken,
      { answers: allYes() },
    );
    await t.call(
      "POST",
      P(`/vendor-assessments/${second.body.id}/submit`),
      dpoToken,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/vendor-assessments/${second.body.id}/approve`),
          dpoToken,
          {},
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/vendor-assessments/${second.body.id}/reject`),
          org.adminToken,
          { note: "Superseded" },
        )
      ).body.status,
      "rejected",
    );

    const v = (await t.call("GET", P(`/vendors/${mailCo}`), viewerToken)).body;
    assert.equal(v.risk, "high");
    assert.equal(v.reviewOverdue, false);
    assert.deepEqual(
      v.assessments
        .find((a: any) => a.id === assessmentId)
        .gaps.map((g: any) => g.question),
      ["breach_notice"],
    );
  });

  test("decided assessments are immutable in the database", async () => {
    await assert.rejects(
      t.db.execute(
        sql`UPDATE vendor_assessments SET score = 100 WHERE status = 'approved'`,
      ),
      (e: Error & { cause?: Error }) =>
        /immutable/.test(e.cause?.message ?? e.message),
    );
  });

  test("contracts: dates and clauses validated; one in force becomes the contract reference", async () => {
    const path = P(`/vendors/${mailCo}/contracts`);
    const future = new Date(Date.now() + 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(
      (
        await t.call("POST", path, editorToken, {
          reference: "DPA-1",
          signedOn: future,
          clauses: [],
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", path, editorToken, {
          reference: "DPA-1",
          signedOn: "2026-01-01",
          expiresOn: "2025-01-01",
          clauses: [],
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", path, editorToken, {
          reference: "DPA-1",
          signedOn: "2026-01-01",
          clauses: ["nda"],
        })
      ).status,
      400,
    );
    const ok = await t.call("POST", path, editorToken, {
      reference: "DPA-2026-04",
      signedOn: "2026-04-01",
      expiresOn: "2028-03-31",
      clauses: [
        "purpose_limitation",
        "breach_notification",
        "erasure_on_instruction",
      ],
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    contractId = ok.body.id;
    assert.equal(ok.body.status, "active");
    assert.ok(
      ok.body.missingClauses.some(
        (m: any) =>
          m.clause === "security_safeguards" && m.cite.includes("r.6(1)(f)"),
      ),
    );
    const v = (await t.call("GET", P(`/vendors/${mailCo}`), viewerToken)).body;
    assert.equal(v.vendor.contractRef, "DPA-2026-04");
    assert.equal(v.contract.reference, "DPA-2026-04");
    // The ROPA recipient sees the contract too (ROPA / AIGIS / control checks read contractRef).
    const recs = (await t.call("GET", P("/ropa/recipients"), viewerToken)).body;
    assert.equal(
      recs.find((r: any) => r.id === mailCo).contractRef,
      "DPA-2026-04",
    );
  });

  test("signed copy: attached once, validated, append-only otherwise", async () => {
    const pdf = new Uint8Array(
      new TextEncoder().encode("%PDF-1.4\nsigned\n%%EOF"),
    );
    const upload = (
      token: string,
      body: Uint8Array<ArrayBuffer> | string,
      type = "application/pdf",
    ) =>
      t.app.request(
        P(`/vendor-contracts/${contractId}/file?fileName=dpa.pdf`),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
          body,
        },
      );
    assert.equal((await upload(viewerToken, pdf)).status, 403);
    assert.equal((await upload(editorToken, "not a pdf")).status, 422);
    const ok = await upload(editorToken, pdf);
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.ok((await ok.json()).artifactId);
    assert.equal((await upload(editorToken, pdf)).status, 409);
    await assert.rejects(
      t.db.execute(sql`UPDATE vendor_contracts SET reference = 'edited'`),
      (e: Error & { cause?: Error }) =>
        /append-only/.test(e.cause?.message ?? e.message),
    );
  });

  test("org isolation", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/vendors/${mailCo}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/vendor-assessments/${assessmentId}/submit`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (await t.call("GET", `/orgs/${other.orgId}/vendors`, other.adminToken))
        .body.length,
      0,
    );
  });

  test("audit chain: scores and clause names, no free-text notes", async () => {
    const items = (await t.call("GET", P("/audit?limit=500"), org.adminToken))
      .body.items;
    const vendor = items.filter((a: any) => a.action.startsWith("vendor."));
    assert.ok(vendor.length >= 8);
    const text = JSON.stringify(vendor);
    assert.equal(text.includes("Only within 7 days"), false);
    assert.equal(text.includes("breach-notice follow-up"), false);
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});

describe("review fixes", () => {
  let vendor: string;
  before(async () => {
    vendor = (
      await t.call("POST", P("/ropa/recipients"), editorToken, {
        name: "CloudCo",
        role: "processor",
        country: "IN",
      })
    ).body.id;
  });

  test("nobody who wrote the answers can decide (creator, editor or submitter)", async () => {
    // DPO writes the answers, an editor submits: the DPO still can't approve them.
    const a = await t.call(
      "POST",
      P(`/vendors/${vendor}/assessments`),
      dpoToken,
      { answers: allYes() },
    );
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/vendor-assessments/${a.body.id}/submit`),
          editorToken,
        )
      ).status,
      200,
    );
    const denied = await t.call(
      "POST",
      P(`/vendor-assessments/${a.body.id}/approve`),
      dpoToken,
      {},
    );
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /helped write/);
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/vendor-assessments/${a.body.id}/approve`),
          org.adminToken,
          {},
        )
      ).status,
      200,
    );
  });

  test("the database freezes a submitted assessment except for its decision", async () => {
    const a = await t.call(
      "POST",
      P(`/vendors/${vendor}/assessments`),
      editorToken,
      { answers: allYes() },
    );
    await t.call(
      "POST",
      P(`/vendor-assessments/${a.body.id}/submit`),
      editorToken,
    );
    const id = a.body.id as string;
    await assert.rejects(
      t.db.execute(
        sql`UPDATE vendor_assessments SET score = 10 WHERE id = ${id}`,
      ),
      (e: Error & { cause?: Error }) =>
        /can only be decided/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(
        sql`UPDATE vendor_assessments SET status = 'draft' WHERE id = ${id}`,
      ),
      (e: Error & { cause?: Error }) =>
        /can only be decided/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(
        sql`UPDATE vendor_assessments SET org_id = ${other.orgId} WHERE id = ${id}`,
      ),
      (e: Error & { cause?: Error }) =>
        /identity columns/.test(e.cause?.message ?? e.message),
    );
    await t.call("POST", P(`/vendor-assessments/${id}/reject`), dpoToken, {
      note: "Retake",
    });
  });

  test("a draft can't jump to a decision in the database; one open assessment per vendor", async () => {
    const a = await t.call(
      "POST",
      P(`/vendors/${vendor}/assessments`),
      editorToken,
      { answers: {} },
    );
    const id = a.body.id as string;
    await assert.rejects(
      t.db.execute(
        sql`UPDATE vendor_assessments SET status = 'approved', decided_at = now() WHERE id = ${id}`,
      ),
      (e: Error & { cause?: Error }) =>
        /draft can only be edited or submitted/.test(
          e.cause?.message ?? e.message,
        ),
    );
    await assert.rejects(
      t.db
        .execute(sql`INSERT INTO vendor_assessments (org_id, recipient_id, questionnaire_version, answers)
        VALUES (${org.orgId}, ${vendor}, 1, '{}'::jsonb)`),
      (e: Error & { cause?: Error }) =>
        /vendor_assessments_open_uq|duplicate key/.test(
          e.cause?.message ?? e.message,
        ),
    );
  });

  test("contract ref follows the contract in force: newest wins, backdated can't displace it, expiry clears it", async () => {
    const ref = async () =>
      (await t.call("GET", P("/ropa/recipients"), viewerToken)).body.find(
        (r: any) => r.id === vendor,
      ).contractRef;
    const add = (body: Record<string, unknown>) =>
      t.call("POST", P(`/vendors/${vendor}/contracts`), editorToken, {
        clauses: [],
        ...body,
      });
    assert.equal(
      (
        await add({
          reference: "DPA-NEW",
          signedOn: "2026-04-01",
          expiresOn: "2028-03-31",
        })
      ).status,
      201,
    );
    assert.equal(await ref(), "DPA-NEW");
    // Recorded later but signed earlier: still in force, yet the newer one stays the reference.
    assert.equal(
      (
        await add({
          reference: "DPA-OLD",
          signedOn: "2025-06-01",
          expiresOn: "2028-12-31",
        })
      ).status,
      201,
    );
    assert.equal(await ref(), "DPA-NEW");
    assert.equal(
      (await t.call("GET", P(`/vendors/${vendor}`), viewerToken)).body.contract
        .reference,
      "DPA-NEW",
    );

    // Daily refresh after DPA-NEW expires: the older contract is the one still in force.
    await runOnce({ now: new Date("2028-04-15T06:00:00Z"), batch: 50 });
    assert.equal(await ref(), "DPA-OLD");
    // After both expire there is no contract: the ref is cleared, so "no contract" gaps return.
    await runOnce({ now: new Date("2029-01-15T06:00:00Z"), batch: 50 });
    assert.equal(await ref(), null);
    const audit = (
      await t.call(
        "GET",
        P("/audit?action=vendor.contract_ref_changed&limit=50"),
        org.adminToken,
      )
    ).body.items;
    assert.ok(audit.length >= 3);
    assert.equal(
      JSON.stringify(audit).includes("DPA-OLD"),
      false,
      "references stay out of the audit chain",
    );
  });

  test("a reference typed by hand in ROPA, with no recorded contract, is left alone", async () => {
    const manual = await t.call("POST", P("/ropa/recipients"), editorToken, {
      name: "Legacy",
      role: "processor",
      country: "IN",
      contractRef: "Paper DPA 2019",
    });
    await runOnce({ now: new Date("2029-02-15T06:00:00Z"), batch: 50 });
    const r = (
      await t.call("GET", P("/ropa/recipients"), viewerToken)
    ).body.find((x: any) => x.id === manual.body.id);
    assert.equal(r.contractRef, "Paper DPA 2019");
  });
});
