import { createHmac } from "node:crypto";
import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import { db, type GithubInstallation, type Tx } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import {
  conflict,
  DomainError,
  notFound,
  unprocessable,
} from "../domain/errors.ts";
import {
  defaultBranchPush,
  MAX_SARIF_BYTES,
  nonceHash,
  SAFE_REF,
  sameNonce,
  signInstallState,
  verifyInstallState,
  webhookSignatureValid,
} from "../domain/github.ts";
import { errorLabel, type Lease } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import { githubRepository } from "../repositories/github.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { usersRepository } from "../repositories/users.repository.ts";
import { auditService } from "./audit.service.ts";
import { codeScansService } from "./code-scans.service.ts";
import { codeScanner, githubClient } from "./github-client.ts";
import { queueService } from "./queue.service.ts";

/**
 * Step 17 — GitHub App for managed HoundDog scans.
 * - Install: the org_admin's link carries a signed state whose nonce is also a cookie in that
 *   browser and a single-use row; at setup GitHub's OAuth code proves the installer controls
 *   the installation; the admin's role is checked again. Any refusal looks the same.
 * - Webhooks: signature over the raw bytes first; each delivery handled once.
 * - Scans: opt-in per repository (DPO / admin); the newest pending commit is scanned and an
 *   older scan never overwrites a newer one; results go through the CI ingest.
 */

const APP: Actor = { type: "system", id: "system:github-app" };
const stateKey = () =>
  createHmac("sha256", env.JWT_SECRET)
    .update("dpdpa:github-install-state")
    .digest();
/** One answer for every refused setup (no oracle for which installations exist / are linked). */
const refused = () =>
  unprocessable(
    "This installation can't be linked: start again from the platform",
  );
type Page = { limit: number; offset: number };

function assertConfigured() {
  if (!env.GITHUB_APP_SLUG || !env.GITHUB_WEBHOOK_SECRET)
    throw conflict("The GitHub App is not configured on this platform");
}

async function audit(
  tx: Tx,
  actor: Actor,
  orgId: string,
  action: string,
  entityId: string,
  payload: Record<string, unknown> = {},
) {
  await auditService.record(tx, actor, {
    orgId,
    action,
    entityType: "github_installation",
    entityId,
    payload,
  });
}

/** Payload shapes we read (GitHub sends more; everything else is ignored). */
type Hook = {
  action?: string;
  installation?: { id?: number };
  repositories_added?: { id: number; full_name: string; private?: boolean }[];
  repositories_removed?: { id: number }[];
  ref?: string;
  after?: string;
  repository?: { id?: number; full_name?: string; default_branch?: string };
};

/** Queues a scan unless one is already waiting (it will pick up the newest pending ref). */
async function queueScan(tx: Tx, orgId: string, repoRef: string) {
  if (
    await queueService.hasOpen(tx, "github.scan", orgId, "repoRef", repoRef, [
      "queued",
    ])
  )
    return false;
  await queueService.enqueue(tx, "github.scan", orgId, { repoRef });
  return true;
}

/** Permanent scan failures (bad SARIF, refused input) are not retried. */
const permanent = (e: unknown) =>
  e instanceof DomainError ||
  (e instanceof Error &&
    (e.name === "SarifTooLarge" || e.name === "GithubUnavailable"));

export const githubService = {
  /** org_admin: link to install the App; the nonce goes into a cookie in this browser. */
  async installLink(ctx: OrgContext) {
    assertPermission(ctx, "org.manage");
    assertConfigured();
    const { state, nonce, expiresAt } = signInstallState(stateKey(), {
      orgId: ctx.org.orgId,
      userId: ctx.user.userId,
    });
    await githubRepository.insertNonce(db, {
      nonceHash: nonceHash(nonce),
      orgId: ctx.org.orgId,
      userId: ctx.user.userId,
      expiresAt,
    });
    const url = new URL(
      `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`,
    );
    url.searchParams.set("state", state);
    return { url: url.toString(), nonce, expiresAt };
  },

  /**
   * GitHub's setup redirect. Linked only when: the state is valid, unexpired and unused; the
   * browser holds its nonce; the requester is still org_admin of an active org; and GitHub's
   * OAuth code shows the installer controls that installation.
   */
  async completeSetup(v: {
    installationId: number;
    state: string;
    code: string;
    cookieNonce: string | undefined;
  }) {
    assertConfigured();
    const claims = verifyInstallState(stateKey(), v.state);
    if (!claims || !sameNonce(v.cookieNonce, claims.n)) throw refused();
    const used = await githubRepository.consumeNonce(db, {
      nonceHash: nonceHash(claims.n),
      orgId: claims.orgId,
      userId: claims.userId,
      now: new Date(),
    });
    if (!used) throw refused();
    const gh = githubClient();
    if (!(await gh.installerControls(v.code, v.installationId)))
      throw refused();
    const info = await gh.installation(v.installationId);
    const repos = await gh.repositories(v.installationId);
    return db.transaction(async (tx) => {
      const member = await membershipsRepository.find(
        tx,
        claims.orgId,
        claims.userId,
      );
      const org = await organizationsRepository.findById(tx, claims.orgId);
      const user = await usersRepository.findById(tx, claims.userId);
      if (
        member?.role !== "org_admin" ||
        org?.status !== "active" ||
        user?.status !== "active"
      )
        throw refused();
      const existing = await githubRepository.byInstallationId(
        tx,
        v.installationId,
      );
      if (existing && existing.orgId !== claims.orgId) throw refused();
      const fields = {
        accountLogin: info.account.login.slice(0, 100),
        accountType: info.account.type.slice(0, 30),
      };
      const inst = existing
        ? (await githubRepository.updateInstallation(
            tx,
            existing.orgId,
            existing.id,
            {
              ...fields,
              status: "active",
              removedAt: null,
            },
          ))!
        : await githubRepository.insertInstallation(tx, {
            orgId: claims.orgId,
            installationId: v.installationId,
            ...fields,
            createdBy: claims.userId,
          });
      await githubRepository.upsertRepos(
        tx,
        repos.map((r) => ({
          orgId: claims.orgId,
          installationRef: inst.id,
          repoId: r.id,
          fullName: r.fullName.slice(0, 200),
          defaultBranch: SAFE_REF.test(r.defaultBranch)
            ? r.defaultBranch
            : null,
          private: r.private,
        })),
      );
      await githubRepository.keepOnlyRepos(
        tx,
        claims.orgId,
        inst.id,
        repos.map((r) => r.id),
      );
      await audit(
        tx,
        { type: "user", id: claims.userId },
        claims.orgId,
        "github.installed",
        inst.id,
        { repositories: repos.length },
      );
      return { orgId: claims.orgId };
    });
  },

  async view(ctx: OrgContext, page: Page) {
    assertPermission(ctx, "data.read");
    const [installations, repositories] = await Promise.all([
      githubRepository.installations(db, ctx.org.orgId),
      githubRepository.repos(db, ctx.org.orgId, page),
    ]);
    return { installations, repositories };
  },

  /** DPO / admin: turn scanning of one repository on or off. */
  setEnabled(ctx: OrgContext, repoRef: string, enabled: boolean) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const row = await githubRepository.repoWithInstallation(
        tx,
        ctx.org.orgId,
        repoRef,
        true,
      );
      if (!row) throw notFound("Repository not found");
      if (row.installation.status !== "active")
        throw conflict("The GitHub App is not installed for this repository");
      if (row.repo.enabled === enabled) return row.repo;
      const repo = await githubRepository.updateRepo(
        tx,
        ctx.org.orgId,
        repoRef,
        {
          enabled,
        },
      );
      await audit(
        tx,
        ctx.actor,
        ctx.org.orgId,
        enabled ? "github.repo_enabled" : "github.repo_disabled",
        row.installation.id,
        { repoRef },
      );
      return repo!;
    });
  },

  /** DPO / admin: scan the default branch now (joins a scan already waiting). */
  requestScan(ctx: OrgContext, repoRef: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const row = await githubRepository.repoWithInstallation(
        tx,
        ctx.org.orgId,
        repoRef,
        true,
      );
      if (!row) throw notFound("Repository not found");
      if (row.installation.status !== "active")
        throw conflict("The GitHub App is not installed for this repository");
      if (!row.repo.enabled)
        throw conflict("Turn scanning on for this repository first");
      await githubRepository.updateRepo(tx, ctx.org.orgId, repoRef, {
        pendingRef: row.repo.defaultBranch ?? "HEAD",
        pendingAt: new Date(),
      });
      if (await queueScan(tx, ctx.org.orgId, repoRef))
        await audit(
          tx,
          ctx.actor,
          ctx.org.orgId,
          "github.scan_requested",
          row.installation.id,
          {
            repoRef,
          },
        );
      return { queued: true };
    });
  },

  /**
   * POST /webhooks/github. Signature over the raw bytes first; each delivery handled once.
   * Returns null when the signature is wrong.
   */
  async webhook(v: {
    rawBody: Uint8Array;
    signature: string | undefined;
    event: string;
    deliveryId: string;
  }): Promise<{ duplicate: boolean } | null> {
    assertConfigured();
    if (
      !webhookSignatureValid(env.GITHUB_WEBHOOK_SECRET!, v.rawBody, v.signature)
    )
      return null;
    let hook: Hook;
    try {
      hook = JSON.parse(Buffer.from(v.rawBody).toString("utf8")) as Hook;
    } catch {
      throw unprocessable("Invalid JSON");
    }
    return db.transaction(async (tx) => {
      if (!(await githubRepository.claimDelivery(tx, v.deliveryId, v.event)))
        return { duplicate: true };
      const installationId = hook.installation?.id;
      const inst =
        typeof installationId === "number"
          ? await githubRepository.byInstallationId(tx, installationId)
          : null;
      if (!inst) return { duplicate: false }; // ping, or an installation we don't know
      await githubRepository.tagDelivery(tx, v.deliveryId, inst.orgId);
      await handle(tx, v.event, hook, inst);
      return { duplicate: false };
    });
  },

  /**
   * Job `github.scan` (detached). Claims the newest pending ref, scans outside any transaction
   * (lease renewed meanwhile), then ingests in ONE transaction that re-checks access and that no
   * newer scan already won, and records the result. Temporary failures are retried by the queue
   * (the ref is put back unless a newer one arrived); each attempt's failure is recorded.
   */
  async runScan(orgId: string, repoRef: string, lease?: Lease) {
    const claim = await db.transaction(async (tx) => {
      const row = await githubRepository.repoWithInstallation(
        tx,
        orgId,
        repoRef,
        true,
      );
      const org = row
        ? await organizationsRepository.findById(tx, orgId)
        : null;
      if (
        !row ||
        org?.status !== "active" ||
        row.installation.status !== "active" ||
        !row.repo.enabled ||
        !row.repo.pendingRef
      )
        return null;
      await githubRepository.updateRepo(tx, orgId, repoRef, {
        pendingRef: null,
        pendingAt: null,
      });
      return {
        ...row,
        ref: row.repo.pendingRef,
        refAt: row.repo.pendingAt ?? new Date(0),
      };
    });
    if (!claim) return { skipped: true };
    if (
      !SAFE_REF.test(claim.ref) ||
      (claim.ref === "HEAD" && claim.repo.defaultBranch)
    )
      return { skipped: "unsafe_ref" };

    // Keep the lease alive while the scanner works; only a refused renewal counts as lost.
    let lost = false;
    const heartbeat = lease
      ? setInterval(() => {
          void lease.renew().then(
            (ok) => {
              if (!ok) lost = true;
            },
            () => {},
          );
        }, 60_000)
      : null;
    try {
      const result = await codeScanner().scan({
        installationId: claim.installation.installationId,
        repository: claim.repo.fullName,
        ref: claim.ref,
        lease,
      });
      if (lost || (lease && !(await lease.renew()))) {
        // Our lease is gone: give the ref back and make sure a job will scan it.
        await db.transaction(async (tx) => {
          if (
            await githubRepository.restorePending(
              tx,
              orgId,
              repoRef,
              claim.ref,
              claim.refAt,
            )
          )
            await queueScan(tx, orgId, repoRef);
        });
        return { skipped: "lease_lost" };
      }
      if (
        Buffer.byteLength(JSON.stringify(result.sarif ?? null)) >
        MAX_SARIF_BYTES
      )
        throw Object.assign(new Error("SARIF too large"), {
          name: "SarifTooLarge",
        });
      // The stored default branch wins; the scanner's answer only fills a gap (never HEAD).
      const branch = claim.repo.defaultBranch ?? result.branch;
      if (
        !SAFE_REF.test(branch) ||
        branch === "HEAD" ||
        !/^[0-9a-f]{40}$/.test(result.commitSha)
      )
        throw unprocessable("Scanner returned an invalid commit or branch");

      const ingested = await codeScansService.ingestForOrg(
        orgId,
        APP,
        {
          repository: claim.repo.fullName,
          provider: "github",
          commitSha: result.commitSha,
          branch,
          sarif: result.sarif,
        },
        {
          defaultBranch: branch,
          previousRepository:
            claim.repo.ingestedAs &&
            claim.repo.ingestedAs !== claim.repo.fullName
              ? claim.repo.ingestedAs
              : null,
          // Access may have changed during the scan; a newer scan's results win.
          guard: async (tx) => {
            const now = await githubRepository.repoWithInstallation(
              tx,
              orgId,
              repoRef,
              true,
            );
            const org = await organizationsRepository.findById(tx, orgId);
            if (
              !now ||
              org?.status !== "active" ||
              now.installation.status !== "active" ||
              !now.repo.enabled
            )
              return false;
            // Results of a newer (or the same) ref are already recorded.
            if (now.repo.currentRefAt && now.repo.currentRefAt >= claim.refAt)
              return false;
            return true;
          },
          after: async (tx) => {
            await githubRepository.updateRepo(tx, orgId, repoRef, {
              currentRefAt: claim.refAt,
              defaultBranch: branch,
              ingestedAs: claim.repo.fullName,
              lastScanAt: new Date(),
              lastScanStatus: "succeeded",
              lastScanError: null,
              lastCommitSha: result.commitSha,
            });
          },
        },
      );
      if (!ingested) return { skipped: "superseded_or_revoked" };
      return { ok: true, commitSha: result.commitSha };
    } catch (e) {
      const error = errorLabel(e);
      logger.warn({ repoRef, error }, "GitHub scan failed");
      await db.transaction(async (tx) => {
        const now = await githubRepository.repoWithInstallation(
          tx,
          orgId,
          repoRef,
          true,
        );
        // A newer ref's results are current: this old failure must not hide them.
        const superseded =
          !!now?.repo.currentRefAt && now.repo.currentRefAt >= claim.refAt;
        if (!superseded)
          await githubRepository.updateRepo(tx, orgId, repoRef, {
            lastScanAt: new Date(),
            lastScanStatus: "failed",
            lastScanError: error,
          });
        // Retry the same ref, unless a newer one is waiting or already scanned.
        if (!permanent(e))
          await githubRepository.restorePending(
            tx,
            orgId,
            repoRef,
            claim.ref,
            claim.refAt,
          );
        await audit(
          tx,
          APP,
          orgId,
          "github.scan_failed",
          claim.installation.id,
          {
            repoRef,
            error,
          },
        );
      });
      if (permanent(e)) return { ok: false, error };
      throw e; // temporary: the queue retries with backoff
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  },

  /** A scan job that used all its attempts: if a commit is still pending, queue a fresh one. */
  async afterDeadScan(orgId: string, repoRef: string, jobCreatedAt: Date) {
    await db.transaction(async (tx) => {
      const row = await githubRepository.repoWithInstallation(
        tx,
        orgId,
        repoRef,
        true,
      );
      if (!row?.repo.pendingRef) return;
      // Only a commit that arrived after this job was created deserves a new job; the ref this
      // job kept failing on is dropped (no endless retry loop; the repo stays "failed").
      const newer = !!row.repo.pendingAt && row.repo.pendingAt > jobCreatedAt;
      if (newer && row.repo.enabled && row.installation.status === "active")
        await queueScan(tx, orgId, repoRef);
      else
        await githubRepository.updateRepo(tx, orgId, repoRef, {
          pendingRef: null,
          pendingAt: null,
        });
    });
  },

  /** Daily clean-up (system.cleanup): delivery ids and install nonces older than 30 days. */
  purge(tx: Tx, now: Date) {
    return githubRepository.purge(
      tx,
      new Date(now.getTime() - 30 * 86_400_000),
    );
  },
};

async function handle(
  tx: Tx,
  event: string,
  hook: Hook,
  inst: GithubInstallation,
) {
  // A removed installation only comes back through a new setup.
  if (inst.status === "removed") return;
  if (event === "installation") {
    const status =
      hook.action === "deleted"
        ? "removed"
        : hook.action === "suspend"
          ? "suspended"
          : hook.action === "unsuspend"
            ? "active"
            : null;
    if (!status || status === inst.status) return;
    await githubRepository.updateInstallation(tx, inst.orgId, inst.id, {
      status,
      removedAt: status === "removed" ? new Date() : null,
    });
    const action =
      hook.action === "unsuspend"
        ? "github.installation_unsuspended"
        : `github.installation_${status}`;
    await audit(tx, APP, inst.orgId, action, inst.id);
    return;
  }
  if (event === "installation_repositories") {
    const added = (hook.repositories_added ?? []).filter(
      (r) => typeof r.id === "number" && typeof r.full_name === "string",
    );
    const removed = (hook.repositories_removed ?? []).filter(
      (r) => typeof r.id === "number",
    );
    await githubRepository.upsertRepos(
      tx,
      added.map((r) => ({
        orgId: inst.orgId,
        installationRef: inst.id,
        repoId: r.id,
        fullName: r.full_name.slice(0, 200),
        private: typeof r.private === "boolean" ? r.private : null,
      })),
    );
    await githubRepository.removeRepos(
      tx,
      inst.orgId,
      inst.id,
      removed.map((r) => r.id),
    );
    await audit(tx, APP, inst.orgId, "github.repositories_changed", inst.id, {
      added: added.length,
      removed: removed.length,
    });
    return;
  }
  if (event === "push" && inst.status === "active") {
    const repoId = hook.repository?.id;
    if (typeof repoId !== "number") return;
    let repo = await githubRepository.repoByGithubId(
      tx,
      inst.orgId,
      inst.id,
      repoId,
    );
    if (!repo) {
      const name = hook.repository?.full_name;
      const branch = hook.repository?.default_branch;
      if (typeof name !== "string") return;
      await githubRepository.upsertRepos(tx, [
        {
          orgId: inst.orgId,
          installationRef: inst.id,
          repoId,
          fullName: name.slice(0, 200),
          defaultBranch:
            typeof branch === "string" && SAFE_REF.test(branch) ? branch : null,
        },
      ]);
      return; // scanning starts off: nothing to queue
    }
    // Keep name and default branch current (renames; repos added without a branch).
    const branch = hook.repository?.default_branch;
    const name = hook.repository?.full_name;
    const patch: { fullName?: string; defaultBranch?: string } = {};
    if (typeof name === "string" && name !== repo.fullName)
      patch.fullName = name.slice(0, 200);
    if (
      typeof branch === "string" &&
      SAFE_REF.test(branch) &&
      branch !== repo.defaultBranch
    )
      patch.defaultBranch = branch;
    const scan = repo.enabled ? defaultBranchPush(hook) : null;
    if (Object.keys(patch).length || scan)
      await githubRepository.updateRepo(tx, inst.orgId, repo.id, {
        ...patch,
        ...(scan ? { pendingRef: scan.commitSha, pendingAt: new Date() } : {}),
      });
    if (scan) await queueScan(tx, inst.orgId, repo.id);
  }
}
