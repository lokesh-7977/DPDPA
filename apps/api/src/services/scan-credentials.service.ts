import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  db,
  type Domain,
  type ScanAuthorization,
  type ScanCredential,
} from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import { CookieJar, findLoginForm } from "../domain/authenticated-crawl.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { urlBlockedReason } from "../domain/scan-authorization.ts";
import { crawlPath, resolveHref } from "../domain/web-audit.ts";
import { domainsRepository } from "../repositories/domains.repository.ts";
import { scanCredentialsRepository } from "../repositories/scan-credentials.repository.ts";
import { auditService } from "./audit.service.ts";
import {
  credentialVault,
  VAULT_AAD,
  VAULT_KEY_VERSION,
} from "./credential-vault.ts";
import { webFetcher, type FetchResult } from "./web-fetcher.ts";

/**
 * Phase 4c — test accounts for crawling behind a login. Only the org_admin adds or revokes
 * them; the username / password are sealed (AES-256-GCM) and never leave the server. Revoking
 * wipes the sealed value.
 */

const aad = VAULT_AAD.scanCredential;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const MAX_LOGIN_REDIRECTS = 3;

export const scanCredentialsService = {
  async list(ctx: OrgContext, domainId: string) {
    assertPermission(ctx, "data.read");
    if (!(await domainsRepository.find(db, ctx.org.orgId, domainId)))
      throw notFound("Domain not found");
    return scanCredentialsRepository.list(db, ctx.org.orgId, domainId);
  },

  add(
    ctx: OrgContext,
    domainId: string,
    v: {
      label: string;
      loginPath: string;
      loggedInMarker: string;
      username: string;
      password: string;
      usernameField?: string | null;
      passwordField?: string | null;
    },
  ) {
    assertPermission(ctx, "org.manage");
    if (!PATH.test(v.loginPath) || v.loginPath.includes(".."))
      throw unprocessable("Invalid loginPath");
    return db.transaction(async (tx) => {
      const domain = await domainsRepository.find(tx, ctx.org.orgId, domainId);
      if (!domain) throw notFound("Domain not found");
      if (domain.status !== "verified")
        throw conflict("Verify ownership of the domain first");
      const id = randomUUID();
      const row = await scanCredentialsRepository.insert(tx, {
        id,
        orgId: ctx.org.orgId,
        domainId,
        label: v.label,
        loginPath: v.loginPath,
        loggedInMarker: v.loggedInMarker,
        usernameField: v.usernameField ?? null,
        passwordField: v.passwordField ?? null,
        secret: credentialVault.seal(
          JSON.stringify({ username: v.username, password: v.password }),
          aad(ctx.org.orgId, id),
        ),
        keyVersion: VAULT_KEY_VERSION,
        createdBy: ctx.user.userId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "scan_credential.added",
        entityType: "scan_credential",
        entityId: id,
        payload: { domainId },
      });
      return row;
    });
  },

  revoke(ctx: OrgContext, id: string) {
    assertPermission(ctx, "org.manage");
    return db.transaction(async (tx) => {
      const c = await scanCredentialsRepository.find(tx, ctx.org.orgId, id);
      if (!c) throw notFound("Credential not found");
      if (c.revokedAt) throw conflict("Already revoked");
      const row = await scanCredentialsRepository.update(
        tx,
        ctx.org.orgId,
        id,
        {
          secret: null,
          revokedAt: new Date(),
          revokedBy: ctx.user.userId,
        },
      );
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "scan_credential.revoked",
        entityType: "scan_credential",
        entityId: id,
        payload: { domainId: c.domainId },
      });
      return row!;
    });
  },
};

export type LoginResult =
  /** landingPath: the page the login ended on, crawled first. */
  | { ok: true; jar: CookieJar; landingPath: string }
  | { ok: false; reason: string };

/**
 * Logs in with the test account (worker). Every request passes the URL gate: the login page and
 * the form's action must be on the authorized host and paths. Cookies stay in memory.
 * Reasons are fixed strings (stored as the scan's stop reason).
 */
export async function loginSession(
  gate: { domain: Domain; authorization: ScanAuthorization },
  credential: ScanCredential,
): Promise<LoginResult> {
  if (credential.revokedAt || !credential.secret)
    return { ok: false, reason: "Test account revoked" };
  const { username, password } = JSON.parse(
    credentialVault.open(
      credential.secret,
      aad(credential.orgId, credential.id),
    ),
  ) as {
    username: string;
    password: string;
  };
  const pause = () => sleep(Math.ceil(1000 / gate.authorization.maxRps));
  const allowed = (url: string) => urlBlockedReason({ ...gate, url }) === null;
  const jar = new CookieJar();

  const loginUrl = `https://${gate.domain.hostname}${credential.loginPath}`;
  if (!allowed(loginUrl))
    return { ok: false, reason: "Login page is outside the authorized paths" };
  const page = await webFetcher.fetch(loginUrl, { cookie: jar.header() });
  if (!page.ok || !page.html)
    return { ok: false, reason: "Login page could not be loaded" };
  jar.add(page.setCookies);
  const form = findLoginForm(page.html, loginUrl, credential);
  if (!form) return { ok: false, reason: "Login form not found" };
  if (!allowed(form.action))
    return {
      ok: false,
      reason: "Login form posts outside the authorized site",
    };
  await pause();

  let res: FetchResult = await webFetcher.fetch(form.action, {
    cookie: jar.header(),
    form: {
      ...form.hidden,
      [form.usernameField]: username,
      [form.passwordField]: password,
    },
  });
  let url = form.action;
  for (
    let i = 0;
    res.ok &&
    res.status >= 300 &&
    res.status < 400 &&
    res.location &&
    i < MAX_LOGIN_REDIRECTS;
    i++
  ) {
    jar.add(res.setCookies);
    const next = resolveHref(res.location, url);
    if (
      !next ||
      !allowed(`https://${gate.domain.hostname}${crawlPath(next)}`) ||
      next.hostname !== gate.domain.hostname
    )
      break;
    url = next.toString();
    await pause();
    res = await webFetcher.fetch(
      `https://${gate.domain.hostname}${crawlPath(next)}`,
      { cookie: jar.header() },
    );
  }
  if (!res.ok) return { ok: false, reason: "Login request failed" };
  jar.add(res.setCookies);
  const marker = credential.loggedInMarker.toLowerCase();
  if (!res.html?.toLowerCase().includes(marker))
    return { ok: false, reason: "Login failed (logged-in marker not found)" };
  await scanCredentialsRepository.update(db, credential.orgId, credential.id, {
    lastUsedAt: new Date(),
  });
  return { ok: true, jar, landingPath: crawlPath(new URL(url)) };
}
