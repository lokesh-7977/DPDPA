/**
 * Step 15 — cloud (AWS) and Google Workspace inventory: pure validation, region → country and
 * findings. Read-only facts about where personal data is stored and how it is protected.
 * Citations: s.8(5) and r.6(1) (reasonable security safeguards; clause letters checked against the
 * Gazette text of G.S.R. 846(E), 13 Nov 2025: (a) encryption / masking, (b) access control,
 * (c) logs and monitoring, (d) continued processing / backups), s.16 / r.15 (outside India).
 */

export const integrationKinds = ["aws", "google_workspace"] as const;
export type IntegrationKind = (typeof integrationKinds)[number];

export const storeKinds = [
  "s3_bucket",
  "rds_instance",
  "dynamodb_table",
] as const;
export type StoreKind = (typeof storeKinds)[number];

/** One data store as the provider reports it. null = the provider could not tell. */
export type StoreObservation = {
  kind: StoreKind;
  name: string;
  region: string;
  encrypted: boolean | null;
  publicAccess: boolean | null;
  backups: boolean | null;
  logging: boolean | null;
};

export type AwsInventory = { accountId: string; stores: StoreObservation[] };

export type WorkspaceInventory = {
  domain: string;
  users: number;
  /** Non-admin users without 2-step verification (admins are counted separately). */
  usersWithout2sv: number;
  adminsWithout2sv: number;
  twoStepEnforced: boolean | null;
  /** Drive sharing outside the domain: off, only allow-listed domains, or open. */
  externalDriveSharing: "off" | "allowlist" | "on" | null;
  /** More users than one sync reads: the counts cover only the first part of the directory. */
  usersTruncated?: boolean;
};

export type AwsConfig = {
  roleArn: string;
  externalId: string;
  regions: string[];
};
export type WorkspaceConfig = { domain: string; adminEmail: string };

// ─── Regions ──────────────────────────────────────────────────────────────────

/** AWS region → ISO 3166-1 alpha-2 country of the data centres. */
export const AWS_REGION_COUNTRY: Readonly<Record<string, string>> = {
  "ap-south-1": "IN",
  "ap-south-2": "IN",
  "us-east-1": "US",
  "us-east-2": "US",
  "us-west-1": "US",
  "us-west-2": "US",
  "ca-central-1": "CA",
  "ca-west-1": "CA",
  "mx-central-1": "MX",
  "sa-east-1": "BR",
  "eu-west-1": "IE",
  "eu-west-2": "GB",
  "eu-west-3": "FR",
  "eu-central-1": "DE",
  "eu-central-2": "CH",
  "eu-north-1": "SE",
  "eu-south-1": "IT",
  "eu-south-2": "ES",
  "me-south-1": "BH",
  "me-central-1": "AE",
  "il-central-1": "IL",
  "af-south-1": "ZA",
  "ap-east-1": "HK",
  "ap-east-2": "TW",
  "ap-northeast-1": "JP",
  "ap-northeast-2": "KR",
  "ap-northeast-3": "JP",
  "ap-southeast-1": "SG",
  "ap-southeast-2": "AU",
  "ap-southeast-3": "ID",
  "ap-southeast-4": "AU",
  "ap-southeast-5": "MY",
  "ap-southeast-6": "NZ",
  "ap-southeast-7": "TH",
};

/** Region names as some APIs report them (S3 GetBucketLocation: empty = us-east-1, "EU" = eu-west-1). */
const REGION_ALIASES: Readonly<Record<string, string>> = { "": "us-east-1", EU: "eu-west-1" };

/** Known region? Own keys only ("constructor", "__proto__" … are not regions). */
export const isKnownRegion = (region: string): boolean =>
  Object.hasOwn(AWS_REGION_COUNTRY, region);

/** Country of a region; null when the region is not in the table (a finding asks to update it). */
export function regionCountry(region: string): string | null {
  const r = Object.hasOwn(REGION_ALIASES, region) ? REGION_ALIASES[region]! : region;
  return isKnownRegion(r) ? AWS_REGION_COUNTRY[r]! : null;
}

/** Most data stores kept per sync; larger accounts are truncated with a finding. */
export const MAX_STORES_PER_SYNC = 10_000;
/** Longest store name kept (names appear in findings). */
export const MAX_STORE_NAME = 255;

// ─── Validation ───────────────────────────────────────────────────────────────

const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,64}$/;
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Reason the AWS settings are invalid, or null. */
export function awsConfigProblem(v: {
  roleArn: string;
  regions: string[];
}): string | null {
  if (!ROLE_ARN.test(v.roleArn))
    return "roleArn must be an IAM role ARN (arn:aws:iam::<12 digits>:role/<name>)";
  if (!v.regions.length) return "Give at least one region";
  const unknown = v.regions.filter((r) => !isKnownRegion(r));
  if (unknown.length) return `Unknown region(s): ${unknown.join(", ")}`;
  return null;
}

export function workspaceConfigProblem(v: {
  domain: string;
  adminEmail: string;
}): string | null {
  const domain = v.domain.toLowerCase();
  if (!DOMAIN.test(domain))
    return "domain must be the Workspace primary domain (e.g. example.in)";
  const at = v.adminEmail.toLowerCase().split("@");
  if (at.length !== 2 || at[1] !== domain)
    return "adminEmail must be an address in that domain";
  return null;
}

/** The fields of a service-account key the connector uses; everything else is dropped. */
export type ServiceAccountKey = {
  type: "service_account";
  client_email: string;
  private_key: string;
  private_key_id?: string;
  client_id?: string;
};

const SA_EMAIL = /^[a-z][a-z0-9-]{4,61}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const PEM = /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n?$/;

/**
 * Parses a Google service-account JSON key and keeps only the fields the connector needs.
 * URLs in the key (token_uri, auth_uri, universe_domain, credential_source …) are dropped: the
 * adapter uses Google's fixed token endpoint, so a key can't point the worker at another host.
 */
export function parseServiceAccountKey(
  raw: string,
): { key: ServiceAccountKey } | { problem: string } {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { problem: "serviceAccountKey must be the JSON key file of a service account" };
  }
  if (o?.type !== "service_account")
    return { problem: "serviceAccountKey is not a service account key" };
  const email = o.client_email;
  const pem = o.private_key;
  if (typeof email !== "string" || !SA_EMAIL.test(email))
    return { problem: "serviceAccountKey has no valid client_email (…@….iam.gserviceaccount.com)" };
  if (typeof pem !== "string" || !PEM.test(pem))
    return { problem: "serviceAccountKey has no valid private_key (PEM)" };
  const key: ServiceAccountKey = { type: "service_account", client_email: email, private_key: pem };
  if (typeof o.private_key_id === "string") key.private_key_id = o.private_key_id.slice(0, 100);
  if (typeof o.client_id === "string") key.client_id = o.client_id.slice(0, 100);
  return { key };
}

// ─── Findings ─────────────────────────────────────────────────────────────────

export const cloudSeverities = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export type CloudSeverity = (typeof cloudSeverities)[number];

export type CloudFinding = {
  code: string;
  severity: CloudSeverity;
  /** e.g. "s3_bucket:customer-uploads" or "workspace:example.in". Names only, never contents. */
  resource: string;
  message: string;
  citation: string;
};

const SEC = "DPDPA s.8(5); DPDP Rules r.6";
/** r.6(1) clause by safeguard. */
const SEC_ENCRYPTION = "DPDPA s.8(5); DPDP Rules r.6(1)(a)";
const SEC_ACCESS = "DPDPA s.8(5); DPDP Rules r.6(1)(b)";
const SEC_LOGS = "DPDPA s.8(5); DPDP Rules r.6(1)(c)";
const SEC_BACKUP = "DPDPA s.8(5); DPDP Rules r.6(1)(d)";
const XB = "DPDPA s.16; DPDP Rules r.15";

export function storeFindings(stores: StoreObservation[]): CloudFinding[] {
  const out: CloudFinding[] = [];
  for (const s of stores) {
    const resource = `${s.kind}:${s.name}`;
    if (s.publicAccess)
      out.push({
        code: "CLOUD-STORE-PUBLIC",
        severity: "critical",
        resource,
        citation: SEC_ACCESS,
        message: "Data store is publicly accessible",
      });
    if (s.encrypted === false)
      out.push({
        code: "CLOUD-STORE-UNENCRYPTED",
        severity: "high",
        resource,
        citation: SEC_ENCRYPTION,
        message: "Data store is not encrypted at rest",
      });
    if (s.backups === false)
      out.push({
        code: "CLOUD-STORE-NO-BACKUP",
        severity: "medium",
        resource,
        citation: SEC_BACKUP,
        message: "No backups: personal data could be lost",
      });
    if (s.logging === false)
      out.push({
        code: "CLOUD-STORE-NO-LOGGING",
        severity: "medium",
        resource,
        citation: SEC_LOGS,
        message: "Access to the data store is not logged",
      });
    const country = regionCountry(s.region);
    if (country === null)
      out.push({
        code: "CLOUD-REGION-UNKNOWN",
        severity: "low",
        resource,
        citation: XB,
        message: "Region not recognised: its country can't be determined (the platform's region table needs an update)",
      });
    else if (country !== "IN")
      out.push({
        code: "CLOUD-STORE-ABROAD",
        severity: "info",
        resource,
        citation: XB,
        message: `Data stored outside India (${country}): record it in the transfer register`,
      });
  }
  return out;
}

export function workspaceFindings(w: WorkspaceInventory): CloudFinding[] {
  const resource = `workspace:${w.domain}`;
  const out: CloudFinding[] = [];
  if (w.adminsWithout2sv > 0)
    out.push({
      code: "GWS-ADMIN-NO-2SV",
      severity: "critical",
      resource,
      citation: SEC_ACCESS,
      message: `${w.usersTruncated ? "At least " : ""}${w.adminsWithout2sv} administrator(s) without 2-step verification`,
    });
  if (w.usersWithout2sv > 0)
    out.push({
      code: "GWS-USERS-NO-2SV",
      severity: w.twoStepEnforced ? "medium" : "high",
      resource,
      citation: SEC_ACCESS,
      message: `${w.usersTruncated ? "At least " : ""}${w.usersWithout2sv} of ${w.usersTruncated ? "the first " : ""}${w.users} active user(s) without 2-step verification${w.twoStepEnforced === false ? " (not enforced)" : ""}`,
    });
  if (w.externalDriveSharing === "on")
    out.push({
      code: "GWS-DRIVE-EXTERNAL",
      severity: "medium",
      resource,
      citation: SEC_ACCESS,
      message: "Drive files can be shared with anyone outside the organization",
    });
  if (w.usersTruncated)
    out.push({
      code: "GWS-INVENTORY-TRUNCATED",
      severity: "low",
      resource,
      citation: SEC,
      message: "The directory is larger than one sync reads: 2-step verification counts cover only part of it",
    });
  return out;
}

/** Countries of stores outside India not covered by an active transfer to that country. */
export function uncoveredCountries(
  storeCountries: (string | null)[],
  activeTransferCountries: string[],
): string[] {
  const covered = new Set(activeTransferCountries);
  const out = new Set<string>();
  // Unknown regions (null) can't be covered by a transfer: they get their own finding instead.
  for (const c of storeCountries) if (c && c !== "IN" && !covered.has(c)) out.add(c);
  return [...out].sort();
}

/** Caps an inventory: names bounded; beyond MAX_STORES_PER_SYNC stores a finding says so. */
export function boundInventory(stores: StoreObservation[]): {
  stores: StoreObservation[];
  truncated: CloudFinding | null;
} {
  const kept = stores.slice(0, MAX_STORES_PER_SYNC).map((st) => ({
    ...st,
    name: st.name.slice(0, MAX_STORE_NAME),
  }));
  return {
    stores: kept,
    truncated:
      stores.length > MAX_STORES_PER_SYNC
        ? {
            code: "CLOUD-INVENTORY-TRUNCATED",
            severity: "low",
            resource: "inventory",
            citation: SEC,
            message: `Only the first ${MAX_STORES_PER_SYNC} of ${stores.length} data stores were recorded`,
          }
        : null,
  };
}

/** it-admin@acme.in → i***@acme.in (staff address shown to every reader of the integration). */
export const maskEmail = (email: string): string => {
  const [user, domain] = email.split("@");
  return user && domain ? `${user[0]}***@${domain}` : "***";
};
