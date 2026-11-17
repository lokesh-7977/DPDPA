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
const { FLOWS, hounddogSarif } = await import("./fixtures/hounddog-sarif.ts");
const { runOnce } = await import("../jobs/runner.ts");
const { memoryOutbox } = await import("../services/mailer.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let ciKey: string;
let logFindingId: string;
let taskId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;

const upload = (flows: Parameters<typeof hounddogSarif>[0], commitSha: string) =>
  t.call("POST", "/ci/code-scans/sarif", ciKey, { repository: "acme/api", commitSha, sarif: hounddogSarif(flows) });

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
  ciKey = (await t.call("POST", P("/api-keys"), org.adminToken, { name: "CI" })).body.key;
  await upload([FLOWS.emailToLogs, FLOWS.aadhaarToOpenAI], "aaaaaaa");
  const findings = (await t.call("GET", P("/findings"), viewerToken)).body;
  logFindingId = findings.find((f: any) => f.evidence.sinkType === "log").id;
});
after(() => t.closeDb());

const me = async (token: string) => (await t.call("GET", "/auth/me", token)).body;

describe("remediation tasks", () => {
  test("create from a finding, assigned to a member", async () => {
    const editor = await me(editorToken);
    assert.equal((await t.call("POST", P("/remediation-tasks"), viewerToken, { title: "x" })).status, 403);
    const res = await t.call("POST", P("/remediation-tasks"), editorToken, {
      title: "Stop logging email addresses",
      findingIds: [logFindingId],
      assigneeUserId: editor.user?.id ?? editor.id,
      dueDate: "2000-01-01",
      priority: "high",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.source, "finding");
    assert.equal(res.body.overdue, true);
    taskId = res.body.id;
    assert.deepEqual((await t.call("GET", P(`/remediation-tasks/${taskId}`), viewerToken)).body.findingIds, [logFindingId]);
  });

  test("assignee and findings must belong to the org; gap tasks need a subject", async () => {
    const other = await t.createOrg("beta");
    const outsider = await me(other.adminToken);
    const bad = await t.call("POST", P("/remediation-tasks"), editorToken, {
      title: "x",
      assigneeUserId: outsider.user?.id ?? outsider.id,
    });
    assert.equal(bad.status, 422);
    const foreign = await t.call("POST", `/orgs/${other.orgId}/remediation-tasks`, other.adminToken, {
      title: "x",
      findingIds: [logFindingId],
    });
    assert.equal(foreign.status, 422, "another org's finding");
    assert.equal((await t.call("POST", P("/remediation-tasks"), editorToken, { title: "x", source: "ropa_gap" })).status, 422);
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/remediation-tasks/${taskId}`, other.adminToken)).status, 404);
  });

  test("wont_do is a risk decision: DPO/admin with a note", async () => {
    const manual = await t.call("POST", P("/remediation-tasks"), editorToken, { title: "Rotate keys" });
    const path = P(`/remediation-tasks/${manual.body.id}`);
    assert.equal((await t.call("PATCH", path, editorToken, { status: "wont_do", statusNote: "no" })).status, 403);
    assert.equal((await t.call("PATCH", path, org.adminToken, { status: "wont_do" })).status, 422);
    const ok = await t.call("PATCH", path, org.adminToken, { status: "wont_do", statusNote: "Compensating control in place" });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.completedAt);
    assert.equal((await t.call("PATCH", path, editorToken, { status: "in_progress" })).status, 409, "reopen to todo first");
  });

  test("overdue filter and daily digest email to the assignee", async () => {
    const overdue = (await t.call("GET", P("/remediation-tasks?overdue=true"), viewerToken)).body;
    assert.deepEqual(overdue.map((x: any) => x.id), [taskId]);
    await runOnce({ batch: 50 });
    const mail = memoryOutbox.find((m) => m.to === "editor@acme.test" && /overdue remediation task/.test(m.subject));
    assert.ok(mail);
    assert.match(mail.text, /Stop logging email addresses/);
  });

  test("a baseline scan that fixes the finding closes the task", async () => {
    const res = await upload([FLOWS.aadhaarToOpenAI], "bbbbbbb");
    assert.equal(res.body.stats.findingsResolved, 1);
    assert.equal(res.body.stats.tasksClosed, 1);
    const task = (await t.call("GET", P(`/remediation-tasks/${taskId}`), viewerToken)).body.task;
    assert.equal(task.status, "done");
    assert.equal(task.overdue, false);
  });

  test("every change is in the org's audit chain", async () => {
    const audit = await t.call("GET", P("/audit?action=remediation.task.auto_closed"), org.adminToken);
    assert.equal(audit.body.items.length, 1);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});
