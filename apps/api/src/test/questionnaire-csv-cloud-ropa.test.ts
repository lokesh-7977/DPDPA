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
const { runOnce } = await import("../jobs/runner.ts");
const { parseCsv, questionsFromCsv } =
  await import("../domain/questionnaires.ts");
const { useInventoryProvider } = await import("../services/cloud-inventory.ts");

useInventoryProvider({
  async aws() {
    return {
      accountId: "123456789012",
      stores: [
        {
          kind: "s3_bucket",
          name: "kyc-docs",
          region: "ap-south-1",
          encrypted: true,
          publicAccess: false,
          backups: true,
          logging: true,
        },
        {
          kind: "rds_instance",
          name: "orders-db",
          region: "eu-west-1",
          encrypted: true,
          publicAccess: false,
          backups: true,
          logging: true,
        },
      ],
    };
  },
  async workspace() {
    throw new Error("unused");
  },
});

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
const P = (p: string) => `/orgs/${org.orgId}${p}`;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
});
after(() => t.closeDb());

describe("questionnaire CSV import", () => {
  test("RFC 4180: quotes, embedded commas, doubled quotes, line breaks, BOM, CRLF", () => {
    const rows = parseCsv(
      '﻿id,question\r\n1,"Do you encrypt data, at rest?"\r\n2,"Say ""hello""\nacross lines"\n',
    );
    assert.deepEqual(rows, [
      ["id", "question"],
      ["1", "Do you encrypt data, at rest?"],
      ["2", 'Say "hello"\nacross lines'],
    ]);
  });

  test("question column by header; else the first column; limits enforced", () => {
    const withHeader = questionsFromCsv(
      "Section,Question Text\nA,Is data stored in India?\nB,\n",
    );
    assert.deepEqual(withHeader, { questions: ["Is data stored in India?"] });
    const noHeader = questionsFromCsv(
      "Who is your DPO?\nHow do you handle breaches?",
    );
    assert.deepEqual(noHeader, {
      questions: ["Who is your DPO?", "How do you handle breaches?"],
    });
    assert.match(
      (questionsFromCsv("") as { problem: string }).problem,
      /no rows/,
    );
    const tooMany = Array.from({ length: 501 }, (_, i) => `Q${i}`).join("\n");
    assert.match(
      (questionsFromCsv(tooMany) as { problem: string }).problem,
      /At most 500/,
    );
  });

  test("import through the API (larger than the 64 KB default body limit)", async () => {
    const lines = ["question"];
    for (let i = 0; i < 400; i++)
      lines.push(
        `"Question ${i}: describe how personal data, including ${"x".repeat(150)}, is protected?"`,
      );
    const csv = lines.join("\n");
    assert.ok(csv.length > 64 * 1024);
    const r = await t.call(
      "POST",
      P("/questionnaires/import-csv"),
      org.adminToken,
      {
        name: "Vendor review",
        csv,
      },
    );
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.total, 400);
    const bad = await t.call(
      "POST",
      P("/questionnaires/import-csv"),
      org.adminToken,
      {
        name: "Empty",
        csv: "question\n\n",
      },
    );
    assert.equal(bad.status, 422);
  });
});

describe("CSV edge cases and access", () => {
  test("unterminated quote refused; header below a title row; column by name or number", () => {
    assert.match(
      (
        questionsFromCsv('1,"Do you encrypt\n2,Who is DPO?') as {
          problem: string;
        }
      ).problem,
      /Unterminated/,
    );
    const titled = questionsFromCsv(
      "Vendor security review 2026\nID,Question Description,Response\n1,Do you encrypt?,\n2,Who is the DPO?,",
    );
    assert.deepEqual(titled, {
      questions: ["Do you encrypt?", "Who is the DPO?"],
    });
    assert.deepEqual(questionsFromCsv("ID,Ask\n1,Q one\n2,Q two", "Ask"), {
      questions: ["Q one", "Q two"],
    });
    assert.deepEqual(questionsFromCsv("1,Q one\n2,Q two", 2), {
      questions: ["Q one", "Q two"],
    });
    assert.match(
      (questionsFromCsv("ID,Ask\n1,Q", "Missing") as { problem: string })
        .problem,
      /No column named/,
    );
  });

  test("hostile input stops early", () => {
    const blankFlood = "\n".repeat(900_000);
    const t0 = Date.now();
    assert.match(
      (questionsFromCsv(blankFlood) as { problem: string }).problem,
      /no rows/,
    );
    const rowFlood = "a\n".repeat(400_000);
    assert.match(
      (questionsFromCsv(rowFlood) as { problem: string }).problem,
      /At most 500/,
    );
    const longCell = "x".repeat(9_000);
    assert.match(
      (questionsFromCsv(longCell) as { problem: string }).problem,
      /longer than/,
    );
    assert.ok(Date.now() - t0 < 2_000, "bounded work");
  });

  test("401 without a token, 403 for a viewer", async () => {
    const viewer = await t.addMember(
      org.orgId,
      org.adminToken,
      "viewer@acme.test",
      "viewer",
    );
    const body = { name: "x", csv: "question\nQ1" };
    assert.equal(
      (await t.call("POST", P("/questionnaires/import-csv"), undefined, body))
        .status,
      401,
    );
    assert.equal(
      (await t.call("POST", P("/questionnaires/import-csv"), viewer, body))
        .status,
      403,
    );
  });
});

describe("cloud data stores become ROPA system suggestions", () => {
  test("sync → suggestions with hosting country; accept → database system; never re-suggested", async () => {
    const conn = await t.call("POST", P("/integrations/aws"), org.adminToken, {
      name: "AWS",
      roleArn: "arn:aws:iam::123456789012:role/dpdpa-readonly",
      regions: ["ap-south-1", "eu-west-1"],
    });
    assert.equal(conn.status, 201, JSON.stringify(conn.body));
    const sync = async () => {
      assert.equal(
        (
          await t.call(
            "POST",
            P(`/integrations/${conn.body.id}/sync`),
            org.adminToken,
          )
        ).status,
        202,
      );
      await runOnce({ batch: 20 });
    };
    await sync();
    const list = (await t.call("GET", P("/ropa/suggestions"), org.adminToken))
      .body;
    const systems = list.filter(
      (s: { type: string }) => s.type === "add_system",
    );
    assert.deepEqual(
      systems
        .map(
          (s: { payload: { name: string; hostingCountry: string } }) =>
            `${s.payload.name}|${s.payload.hostingCountry}`,
        )
        .sort(),
      ["kyc-docs (S3 bucket)|IN", "orders-db (RDS database, eu-west-1)|IE"],
    );
    const kyc = systems.find((s: { payload: { name: string } }) =>
      s.payload.name.startsWith("kyc-docs"),
    );
    const accepted = await t.call(
      "POST",
      P(`/ropa/suggestions/${kyc.id}/accept`),
      org.adminToken,
      {},
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const sys = (await t.call("GET", P("/ropa/systems"), org.adminToken)).body;
    const created = (sys.items ?? sys).find(
      (s: { name: string }) => s.name === "kyc-docs (S3 bucket)",
    );
    assert.equal(created.type, "database");
    assert.equal(created.hostingCountry, "IN");
    await sync();
    const again = (
      await t.call("GET", P("/ropa/suggestions"), org.adminToken)
    ).body.filter((s: { type: string }) => s.type === "add_system");
    assert.equal(again.length, 2, "no duplicates on the next sync");
    const page = (
      await t.call(
        "GET",
        P("/ropa/suggestions?limit=1&offset=0"),
        org.adminToken,
      )
    ).body;
    assert.equal(page.length, 1, "paged");
    const kycPayload = systems.find((x: { payload: { name: string } }) =>
      x.payload.name.startsWith("kyc-docs"),
    ).payload;
    assert.equal(kycPayload.source, "cloud");
    assert.equal(
      kycPayload.name,
      "kyc-docs (S3 bucket)",
      "S3 names are global: no region",
    );
  });
});
