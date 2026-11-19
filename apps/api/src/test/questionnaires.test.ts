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
const { bestMatch, suggestAnswers, STANDARD_QUESTIONS } =
  await import("../domain/questionnaires.ts");

const EMPTY = {
  orgName: "Acme",
  dpoName: null,
  dpoEmail: null,
  grievanceEmail: null,
  rightsResponseDays: 30,
  approvedPolicies: [],
  processors: [],
  transferCountries: [],
  trainingCourses: 0,
  lastAccessReview: null,
  hasBreachPlan: false,
  aiSystems: 0,
  retentionAutomated: false,
};

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let qId: string;
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
    grievanceEmail: "grievance@acme.in",
  });
  await t.call("POST", P("/ropa/recipients"), editorToken, {
    name: "CloudCo",
    role: "processor",
    country: "SG",
  });
});
after(() => t.closeDb());

describe("questionnaire rules (pure)", () => {
  test("no facts, no invented answers", () => {
    const keys = suggestAnswers(EMPTY).map((s) => s.key);
    for (const k of [
      "dpo_contact",
      "grievance",
      "policies",
      "breach",
      "training",
      "access_reviews",
      "retention",
    ]) {
      assert.equal(keys.includes(k), false, k);
    }
    assert.ok(keys.includes("rights_requests") && keys.includes("consent"));
  });
  test("matching by word overlap", () => {
    const lib = STANDARD_QUESTIONS.map((s) => ({
      question: s.question,
      keywords: s.keywords,
    }));
    assert.equal(
      bestMatch(
        "Please list all sub-processors used to process customer data",
        lib,
      )?.entry.question,
      lib[4]!.question,
    );
    assert.match(
      bestMatch("Do you store data outside India?", lib)!.entry.question,
      /outside India/,
    );
    assert.match(
      bestMatch("Describe your incident and breach notification process", lib)!
        .entry.question,
      /breach/,
    );
    assert.equal(bestMatch("What is the capital of France?", lib), null);
  });
});

describe("answer library", () => {
  let suggested: any[];

  test("suggest from platform data; idempotent", async () => {
    assert.equal(
      (await t.call("POST", P("/answer-library/suggest"), org.adminToken))
        .status,
      201,
    );
    const all = (await t.call("GET", P("/answer-library"), editorToken)).body;
    suggested = all;
    const dpo = all.find((a: any) => a.standardKey === "dpo_contact");
    assert.match(dpo.answer, /dpo@acme\.in/);
    assert.match(
      all.find((a: any) => a.standardKey === "subprocessors").answer,
      /CloudCo/,
    );
    assert.equal(
      all.some((a: any) => a.standardKey === "breach"),
      false,
      "no approved breach plan yet",
    );
    assert.ok(all.every((a: any) => a.status === "draft"));
    assert.equal(
      (await t.call("POST", P("/answer-library/suggest"), org.adminToken)).body
        .length,
      0,
    );
  });

  test("approval by someone who did not write it; edits go back to draft", async () => {
    const dpo = suggested.find((a: any) => a.standardKey === "dpo_contact");
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/answer-library/${dpo.id}/approve`),
          editorToken,
        )
      ).status,
      403,
      "editor can't approve",
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/answer-library/${dpo.id}/approve`),
          org.adminToken,
        )
      ).status,
      403,
      "author can't approve",
    );
    for (const a of suggested) {
      assert.equal(
        (await t.call("POST", P(`/answer-library/${a.id}/approve`), dpoToken))
          .status,
        200,
      );
    }
    const edited = await t.call(
      "PATCH",
      P(`/answer-library/${dpo.id}`),
      editorToken,
      { answer: "Asha Rao, dpo@acme.in." },
    );
    assert.equal(edited.body.status, "draft");
    assert.equal(edited.body.approvedAt, null);
    const own = await t.call("POST", P("/answer-library"), editorToken, {
      topic: "security",
      question: "Do you encrypt personal data at rest?",
      answer: "Yes, AES-256 at rest and TLS 1.2+ in transit.",
      keywords: ["Encryption", "encrypt", "at rest"],
    });
    assert.deepEqual(own.body.keywords, ["encryption", "encrypt", "at rest"]);
    await t.call("POST", P(`/answer-library/${own.body.id}/approve`), dpoToken);
  });
});

describe("questionnaires", () => {
  test("import: each question gets the best approved answer", async () => {
    const r = await t.call("POST", P("/questionnaires"), editorToken, {
      name: "BigBank vendor security review",
      requester: "BigBank Ltd",
      questions: [
        "List the sub-processors that will process our customer data.",
        "Is any data stored outside India?",
        "Is data encrypted at rest?",
        "Who is your DPO?",
        "Do you hold an ISO 27001 certificate?",
      ],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    qId = r.body.questionnaire.id;
    assert.equal(r.body.total, 5);
    const items = (
      await t.call("GET", P(`/questionnaires/${qId}`), editorToken)
    ).body.items;
    assert.match(items[0].answer, /CloudCo/);
    assert.match(items[1].answer, /Yes, to: SG|stored and processed in India/);
    assert.match(items[2].answer, /AES-256/);
    assert.equal(
      items[3].status,
      "needs_answer",
      "DPO answer is back in draft, so not matched",
    );
    assert.equal(items[4].status, "needs_answer");
  });

  test("answer, complete (DPO / admin), then frozen; export", async () => {
    const items = (
      await t.call("GET", P(`/questionnaires/${qId}`), editorToken)
    ).body.items;
    assert.equal(
      (
        await t.call(
          "PUT",
          P(`/questionnaires/${qId}/items/${items[4].id}`),
          editorToken,
          {},
        )
      ).status,
      422,
    );
    for (const i of items) {
      const body =
        i.status === "needs_answer"
          ? { answer: "Not yet; certification planned for 2027." }
          : {};
      assert.equal(
        (
          await t.call(
            "PUT",
            P(`/questionnaires/${qId}/items/${i.id}`),
            editorToken,
            body,
          )
        ).body.status,
        "answered",
      );
    }
    assert.equal(
      (await t.call("POST", P(`/questionnaires/${qId}/complete`), editorToken))
        .status,
      403,
    );
    assert.equal(
      (await t.call("POST", P(`/questionnaires/${qId}/complete`), dpoToken))
        .body.status,
      "completed",
    );
    assert.equal(
      (
        await t.call(
          "PUT",
          P(`/questionnaires/${qId}/items/${items[0].id}`),
          editorToken,
          { answer: "x" },
        )
      ).status,
      409,
    );
    await assert.rejects(
      t.db.execute(sql`UPDATE questionnaire_items SET answer = 'x'`),
      (e: Error & { cause?: Error }) =>
        /immutable/.test(e.cause?.message ?? e.message),
    );
    const ex = (
      await t.call("GET", P(`/questionnaires/${qId}/export`), editorToken)
    ).body;
    assert.equal(ex.answers.length, 5);
    assert.equal(ex.answers[0].number, 1);
    assert.ok(ex.answers.every((a: any) => a.answer));
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/questionnaires/${qId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/answer-library`,
          other.adminToken,
        )
      ).body.length,
      0,
    );
    const items = (await t.call("GET", P("/audit?limit=300"), org.adminToken))
      .body.items;
    for (const a of [
      "answer.suggested",
      "answer.created",
      "answer.approved",
      "answer.updated",
      "questionnaire.created",
      "questionnaire.completed",
      "questionnaire.answered",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    assert.equal(
      JSON.stringify(items).includes("BigBank"),
      false,
      "no free text in the chain",
    );
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
