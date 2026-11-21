import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.STORAGE_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.GITHUB_APP_SLUG = "dpdpa-scanner";
process.env.GITHUB_WEBHOOK_SECRET = "whsec-test-test-test-test-test-test-1234";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { bootTestApp, unwrapEnvelope } = await import("./helpers.ts");
const { sql } = await import("drizzle-orm");
const { runOnce } = await import("../jobs/runner.ts");
const { useGithubClient, useCodeScanner } =
  await import("../services/github-client.ts");
const { FLOWS, hounddogSarif } = await import("./fixtures/hounddog-sarif.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let dpoToken: string;
let editorToken: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET!;
const INSTALLATION = 4242;
const SHA = (c: string) => c.repeat(40);

// Fake GitHub: one installation; the OAuth code "ok-<id>" proves control of installation <id>.
useGithubClient({
  async installation(id) {
    return {
      account: {
        login: id === INSTALLATION ? "acme" : "someone-else",
        type: "Organization",
      },
    };
  },
  async installerControls(code, id) {
    return code === `ok-${id}`;
  },
  async repositories() {
    return [
      { id: 101, fullName: "acme/app", defaultBranch: "master", private: true },
      {
        id: 102,
        fullName: "acme/website",
        defaultBranch: "main",
        private: false,
      },
    ];
  },
});
const scans: { repository: string; ref: string }[] = [];
let scannerFails = false;
let duringScan: (() => Promise<void>) | null = null;
let scannerBranch = "master";
useCodeScanner({
  async scan(v) {
    scans.push({ repository: v.repository, ref: v.ref });
    if (duringScan) {
      const hook = duringScan;
      duringScan = null;
      await hook();
    }
    if (scannerFails) {
      scannerFails = false;
      throw Object.assign(new Error("clone failed: token ghs_secret"), {
        name: "CloneFailed",
      });
    }
    return {
      commitSha: /^[0-9a-f]{40}$/.test(v.ref) ? v.ref : SHA("a"),
      branch: scannerBranch,
      sarif: hounddogSarif([FLOWS.aadhaarToOpenAI, FLOWS.emailToLogs]),
    };
  },
});

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
let delivery = 0;
async function webhook(
  event: string,
  payload: unknown,
  opts: { secret?: string; id?: string; raw?: string } = {},
) {
  const body = opts.raw ?? JSON.stringify(payload);
  return t.app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": opts.id ?? `d-${++delivery}`,
      "X-Hub-Signature-256": sign(body, opts.secret),
    },
    body,
  });
}
const push = (repoId: number, ref: string, after: string, branch = "master") =>
  webhook("push", {
    ref,
    after,
    installation: { id: INSTALLATION },
    repository: { id: repoId, full_name: "acme/app", default_branch: branch },
  });

/** Install link for an admin: the state from the URL and the nonce cookie set in the browser. */
async function installLink(orgId: string, token: string) {
  const res = await t.app.request(`/orgs/${orgId}/github/install-link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const raw = res.headers.get("set-cookie") ?? "";
  const body = unwrapEnvelope(await res.json()) as { url?: string };
  return {
    status: res.status,
    state: body.url ? new URL(body.url).searchParams.get("state")! : "",
    cookie: raw.split(";")[0]!,
    raw,
  };
}
const setup = (
  installationId: number,
  state: string,
  code: string,
  cookie?: string,
) =>
  t.app.request(
    `/github/setup?installation_id=${installationId}&state=${encodeURIComponent(state)}&code=${code}`,
    { headers: cookie ? { Cookie: cookie } : {} },
  );
const view = async () => (await t.call("GET", P("/github"), editorToken)).body;
const repoNamed = async (name: string) =>
  (await view()).repositories.find(
    (r: { fullName: string }) => r.fullName === name,
  );

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  dpoToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "dpo@acme.test",
    "privacy_officer",
  );
  editorToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "ed@acme.test",
    "editor",
  );
});
after(() => t.closeDb());

describe("install (org_admin; ownership proven; single use; bound to the browser)", () => {
  test("install link: admin only; nonce cookie is HttpOnly and scoped to /github", async () => {
    assert.equal(
      (await t.call("POST", P("/github/install-link"), dpoToken)).status,
      403,
    );
    const l = await installLink(org.orgId, org.adminToken);
    assert.equal(l.status, 200);
    assert.match(l.raw, /HttpOnly/i);
    assert.match(l.raw, /Path=\/github/);
    assert.match(l.raw, /SameSite=Lax/i);
  });

  test("refused: tampered state, no cookie, someone else's installation; then linked once", async () => {
    const l = await installLink(org.orgId, org.adminToken);
    assert.equal(
      (await setup(INSTALLATION, `${l.state}x`, `ok-${INSTALLATION}`, l.cookie))
        .status,
      422,
    );
    assert.equal(
      (await setup(INSTALLATION, l.state, `ok-${INSTALLATION}`)).status,
      422,
      "no browser cookie",
    );
    // Spoofed installation id: the installer's OAuth code doesn't control it.
    assert.equal(
      (await setup(777, l.state, `ok-${INSTALLATION}`, l.cookie)).status,
      422,
    );
    // A refused attempt burns the link: the genuine retry needs a fresh one.
    assert.equal(
      (await setup(INSTALLATION, l.state, `ok-${INSTALLATION}`, l.cookie))
        .status,
      422,
    );
    const l2 = await installLink(org.orgId, org.adminToken);
    const ok = await setup(
      INSTALLATION,
      l2.state,
      `ok-${INSTALLATION}`,
      l2.cookie,
    );
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get("location") ?? "", /github=connected/);
    const again = await setup(
      INSTALLATION,
      l2.state,
      `ok-${INSTALLATION}`,
      l2.cookie,
    );
    assert.equal(again.status, 422, "the link is single use");
    const v = await view();
    assert.equal(v.installations.length, 1);
    assert.deepEqual(
      v.repositories.map(
        (r: { fullName: string; defaultBranch: string; enabled: boolean }) =>
          `${r.fullName}:${r.defaultBranch}:${r.enabled}`,
      ),
      ["acme/app:master:false", "acme/website:main:false"],
    );
  });

  test("another org can't take the installation (same refusal, no oracle)", async () => {
    const other = await t.createOrg("other");
    const l = await installLink(other.orgId, other.adminToken);
    const r = await setup(
      INSTALLATION,
      l.state,
      `ok-${INSTALLATION}`,
      l.cookie,
    );
    assert.equal(r.status, 422);
    assert.deepEqual(
      (await t.call("GET", `/orgs/${other.orgId}/github`, other.adminToken))
        .body.installations,
      [],
    );
  });

  test("settings update redirect from GitHub links nothing", async () => {
    const r = await t.app.request(
      `/github/setup?installation_id=${INSTALLATION}&setup_action=update`,
    );
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location") ?? "", /github=updated/);
  });
});

describe("webhooks and scans", () => {
  let repoRef: string;

  test("signature over the raw bytes; deliveries once; large payloads accepted", async () => {
    assert.equal(
      (
        await webhook(
          "push",
          { ref: "x" },
          { secret: "wrong-secret-wrong-secret-wrong-secret" },
        )
      ).status,
      401,
    );
    // Same JSON, different bytes: the signature must be over what was sent.
    const raw = '{ "zen" : "hi" }';
    assert.equal(
      (await webhook("ping", null, { raw, id: "same" })).status,
      202,
    );
    const again = await webhook("ping", null, { raw, id: "same" });
    assert.equal(again.status, 200);
    assert.equal(
      (unwrapEnvelope(await again.json()) as { duplicate: boolean }).duplicate,
      true,
    );
    const big = await webhook("ping", { pad: "x".repeat(200_000) });
    assert.equal(big.status, 202, "webhooks are not held to the 64 KB default");
  });

  test("push to a disabled repo is ignored; enabling needs DPO / admin", async () => {
    await push(101, "refs/heads/master", SHA("b"));
    await runOnce({ batch: 20 });
    assert.equal(scans.length, 0);
    repoRef = (await repoNamed("acme/app")).id;
    assert.equal(
      (
        await t.call("PUT", P(`/github/repos/${repoRef}`), editorToken, {
          enabled: true,
        })
      ).status,
      403,
    );
    const on = await t.call("PUT", P(`/github/repos/${repoRef}`), dpoToken, {
      enabled: true,
    });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.enabled, true);
  });

  test("default branch (master) push scans; other branches and deletions ignored; pushes collapse", async () => {
    await push(101, "refs/heads/feature-x", SHA("c"));
    await push(101, "refs/heads/master", "0".repeat(40));
    await push(101, "refs/heads/master", SHA("d"));
    await push(101, "refs/heads/master", SHA("e")); // newer push before the scan starts
    await runOnce({ batch: 20 });
    assert.deepEqual(
      scans,
      [{ repository: "acme/app", ref: SHA("e") }],
      "one scan, newest commit",
    );
    const findings = (await t.call("GET", P("/findings"), editorToken)).body;
    assert.ok(
      findings.length >= 2,
      "findings from the scan (master counted as baseline)",
    );
    const repo = await repoNamed("acme/app");
    assert.equal(repo.lastScanStatus, "succeeded");
    assert.equal(repo.lastCommitSha, SHA("e"));
  });

  test("manual scan; a failure keeps the error name only and is retried", async () => {
    assert.equal(
      (await t.call("POST", P(`/github/repos/${repoRef}/scan`), editorToken))
        .status,
      403,
    );
    scannerFails = true;
    assert.equal(
      (await t.call("POST", P(`/github/repos/${repoRef}/scan`), dpoToken))
        .status,
      202,
    );
    await runOnce({ batch: 20 });
    const repo = await repoNamed("acme/app");
    assert.equal(repo.lastScanStatus, "failed");
    assert.equal(repo.lastScanError, "CloneFailed");
    assert.doesNotMatch(JSON.stringify(repo), /ghs_secret/);
    const [job] = (
      (await t.db.execute(
        sql`SELECT status FROM jobs WHERE type = 'github.scan' ORDER BY created_at DESC LIMIT 1`,
      )) as unknown as { rows: { status: string }[] }
    ).rows;
    assert.equal(
      job!.status,
      "queued",
      "temporary failure: retried by the queue",
    );
  });

  test("suspended: no toggles or scans until unsuspended", async () => {
    await webhook("installation", {
      action: "suspend",
      installation: { id: INSTALLATION },
    });
    assert.equal(
      (await t.call("POST", P(`/github/repos/${repoRef}/scan`), dpoToken))
        .status,
      409,
    );
    assert.equal(
      (
        await t.call("PUT", P(`/github/repos/${repoRef}`), dpoToken, {
          enabled: false,
        })
      ).status,
      409,
    );
    await webhook("installation", {
      action: "unsuspend",
      installation: { id: INSTALLATION },
    });
    assert.equal((await view()).installations[0].status, "active");
  });

  test("repositories added without a branch learn it (and renames) from the next push", async () => {
    await webhook("installation_repositories", {
      action: "added",
      installation: { id: INSTALLATION },
      repositories_added: [{ id: 103, full_name: "acme/api", private: true }],
      repositories_removed: [{ id: 102 }],
    });
    let api = await repoNamed("acme/api");
    assert.equal(api.defaultBranch, null);
    assert.equal(await repoNamed("acme/website"), undefined);
    await webhook("push", {
      ref: "refs/heads/trunk",
      after: SHA("f"),
      installation: { id: INSTALLATION },
      repository: {
        id: 103,
        full_name: "acme/api-v2",
        default_branch: "trunk",
      },
    });
    api = await repoNamed("acme/api-v2");
    assert.equal(api.defaultBranch, "trunk");
  });

  test("another org can't touch these repositories", async () => {
    const other = await t.createOrg("third");
    assert.equal(
      (
        await t.call(
          "PUT",
          `/orgs/${other.orgId}/github/repos/${repoRef}`,
          other.adminToken,
          { enabled: false },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/github/repos/${repoRef}/scan`,
          other.adminToken,
        )
      ).status,
      404,
    );
  });

  test("a push during a failing scan is not lost: the newest commit is scanned next", async () => {
    // Clear the failed retry left by the earlier test.
    await t.db.execute(
      sql`UPDATE jobs SET status = 'succeeded' WHERE type = 'github.scan' AND status = 'queued'`,
    );
    await t.db.execute(
      sql`UPDATE github_repos SET pending_ref = NULL WHERE id = ${repoRef}`,
    );
    scans.length = 0;
    await push(101, "refs/heads/master", SHA("1"));
    duringScan = async () => {
      await push(101, "refs/heads/master", SHA("2"));
    };
    scannerFails = true;
    await runOnce({ batch: 20 }); // scan of 111… fails while 222… arrives
    await runOnce({ now: new Date(Date.now() + 3_600_000), batch: 20 }); // later: retries / queued
    assert.equal(scans[0]!.ref, SHA("1"));
    assert.ok(
      scans.some((x) => x.ref === SHA("2")),
      "the newer commit was scanned",
    );
    assert.equal((await repoNamed("acme/app")).lastCommitSha, SHA("2"));
  });

  test("two workers: an older commit failing after a newer one succeeded never comes back", async () => {
    const { githubService } = await import("../services/github.service.ts");
    await t.db.execute(
      sql`UPDATE jobs SET status = 'succeeded' WHERE type = 'github.scan' AND status = 'queued'`,
    );
    await t.db.execute(
      sql`UPDATE github_repos SET pending_ref = ${SHA("5")}, pending_at = now() WHERE id = ${repoRef}`,
    );
    // Worker 1 scans 555…; meanwhile 666… arrives and worker 2 scans it successfully.
    duringScan = async () => {
      await t.db.execute(
        sql`UPDATE github_repos SET pending_ref = ${SHA("6")}, pending_at = now() WHERE id = ${repoRef}`,
      );
      assert.deepEqual(await githubService.runScan(org.orgId, repoRef), {
        ok: true,
        commitSha: SHA("6"),
      });
      scannerFails = true; // worker 1 now fails with a temporary error
    };
    await assert.rejects(githubService.runScan(org.orgId, repoRef));
    const repo = await repoNamed("acme/app");
    assert.equal(repo.lastCommitSha, SHA("6"));
    assert.equal(
      repo.lastScanStatus,
      "succeeded",
      "an old failure doesn't hide the newer success",
    );
    const [row] = (
      (await t.db.execute(
        sql`SELECT pending_ref FROM github_repos WHERE id = ${repoRef}`,
      )) as unknown as { rows: { pending_ref: string | null }[] }
    ).rows;
    assert.equal(row!.pending_ref, null, "555… is not put back");
  });

  test("lease lost: the claimed commit goes back for the worker that takes over", async () => {
    const { githubService } = await import("../services/github.service.ts");
    await t.db.execute(
      sql`UPDATE github_repos SET pending_ref = ${SHA("3")}, pending_at = now() WHERE id = ${repoRef}`,
    );
    const r = await githubService.runScan(org.orgId, repoRef, {
      renew: async () => false,
    });
    assert.equal(r.skipped, "lease_lost");
    assert.equal((await repoNamed("acme/app")).lastCommitSha, SHA("6"));
    const [row] = (
      (await t.db.execute(
        sql`SELECT pending_ref FROM github_repos WHERE id = ${repoRef}`,
      )) as unknown as {
        rows: { pending_ref: string }[];
      }
    ).rows;
    assert.equal(row!.pending_ref, SHA("3"));
    await t.db.execute(
      sql`UPDATE github_repos SET pending_ref = NULL WHERE id = ${repoRef}`,
    );
  });

  test("default branch and repository renamed after the first scan: same asset, still baseline", async () => {
    const assetRows = async () =>
      (
        (await t.db.execute(
          sql`SELECT full_name, default_branch FROM repo_assets WHERE org_id = ${org.orgId} ORDER BY full_name`,
        )) as unknown as {
          rows: { full_name: string; default_branch: string }[];
        }
      ).rows;
    assert.deepEqual(await assetRows(), [
      { full_name: "acme/app", default_branch: "master" },
    ]);
    await webhook("push", {
      ref: "refs/heads/main",
      after: SHA("4"),
      installation: { id: INSTALLATION },
      repository: {
        id: 101,
        full_name: "acme/app-renamed",
        default_branch: "main",
      },
    });
    await runOnce({ now: new Date(Date.now() + 7_200_000), batch: 20 });
    assert.deepEqual(
      await assetRows(),
      [{ full_name: "acme/app-renamed", default_branch: "main" }],
      "renamed, not duplicated",
    );
    const repo = await repoNamed("acme/app-renamed");
    assert.equal(repo.lastCommitSha, SHA("4"));
    assert.equal(repo.defaultBranch, "main");
  });

  test("uninstall on GitHub stops scans; later events for it are ignored", async () => {
    await webhook("installation", {
      action: "deleted",
      installation: { id: INSTALLATION },
    });
    const v = await view();
    assert.equal(v.installations[0].status, "removed");
    assert.deepEqual(
      v.repositories,
      [],
      "repositories of removed installations are hidden",
    );
    const before = scans.length;
    await push(101, "refs/heads/master", SHA("9"));
    await webhook("installation", {
      action: "unsuspend",
      installation: { id: INSTALLATION },
    });
    await runOnce({ batch: 20 });
    assert.equal(scans.length, before);
    assert.equal((await view()).installations[0].status, "removed");
    assert.equal(
      (await t.call("POST", P(`/github/repos/${repoRef}/scan`), dpoToken))
        .status,
      409,
    );
  });
});
