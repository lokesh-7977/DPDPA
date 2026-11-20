import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
const { credentialVault, useVaultKeys, VAULT_AAD } =
  await import("../services/credential-vault.ts");
const { vaultRotationService } =
  await import("../services/vault-rotation.service.ts");

const OLD = randomBytes(32).toString("base64");
const NEW = randomBytes(32).toString("base64");
const KEY = JSON.stringify({
  type: "service_account",
  client_email: "dpdpa-scan@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
});

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let integrationId: string;

const stored = async () =>
  (
    (await t.db.execute(
      sql`SELECT secret FROM integrations WHERE id = ${integrationId}`,
    )) as unknown as { rows: { secret: string }[] }
  ).rows[0]!.secret;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  useVaultKeys({ current: OLD });
  const r = await t.call(
    "POST",
    `/orgs/${org.orgId}/integrations/google-workspace`,
    org.adminToken,
    {
      name: "Workspace",
      domain: "acme.in",
      adminEmail: "it@acme.in",
      serviceAccountKey: KEY,
    },
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  integrationId = r.body.id;
});
after(() => t.closeDb());

describe("vault key rotation", () => {
  test("during rotation, values sealed with the previous key still open", async () => {
    useVaultKeys({ current: NEW, previous: OLD });
    const opened = credentialVault.openReporting(
      await stored(),
      VAULT_AAD.integration(org.orgId, integrationId),
    );
    assert.equal(opened.withPrevious, true);
    assert.equal(
      JSON.parse(opened.plaintext).client_email,
      "dpdpa-scan@proj.iam.gserviceaccount.com",
    );
  });

  test("rotate re-seals with the new key; the old key can then be dropped", async () => {
    const before = await stored();
    const counts = await vaultRotationService.rotate();
    assert.deepEqual(counts, {
      resealed: 1,
      current: 0,
      unreadable: 0,
      changed: 0,
    });
    const after = await stored();
    assert.notEqual(after, before);
    useVaultKeys({ current: NEW });
    const opened = credentialVault.openReporting(
      after,
      VAULT_AAD.integration(org.orgId, integrationId),
    );
    assert.equal(opened.withPrevious, false);
    const [audit] = (
      (await t.db.execute(
        sql`SELECT payload FROM audit_log WHERE action = 'vault.key_rotated'`,
      )) as unknown as { rows: { payload: unknown }[] }
    ).rows;
    assert.deepEqual(audit!.payload, counts, "counts only on the trail");
  });

  test("running again changes nothing; a value no key opens is reported", async () => {
    assert.deepEqual(await vaultRotationService.rotate(), {
      resealed: 0,
      current: 1,
      unreadable: 0,
      changed: 0,
    });
    useVaultKeys({ current: randomBytes(32).toString("base64") });
    const r = await vaultRotationService.rotate();
    assert.equal(r.unreadable, 1);
    useVaultKeys({ current: NEW });
  });

  test("a value changed between read and write is left alone (compare-and-swap)", async () => {
    const { vaultRepository } =
      await import("../repositories/vault.repository.ts");
    const ok = await t.db.transaction((tx) =>
      vaultRepository.replaceIntegrationSecret(tx, {
        orgId: org.orgId,
        id: integrationId,
        from: "not-what-is-stored",
        to: "x",
        keyVersion: 2,
      }),
    );
    assert.equal(ok, false);
  });

  test("runs as the app role under row-level security (system scope)", async () => {
    const { runInScope } = await import("../db/scope.ts");
    useVaultKeys({
      current: randomBytes(32).toString("base64"),
      previous: NEW,
    });
    const r = await runInScope({ kind: "system" }, () =>
      vaultRotationService.rotate(),
    );
    assert.equal(r.resealed, 1, "sees and updates the org's row");
  });
});
