import type { Lease } from "../../domain/jobs.ts";
import {
  MAX_STORES_PER_SYNC,
  regionCountry,
  type AwsConfig,
  type AwsInventory,
  type StoreObservation,
} from "../../domain/cloud-inventory.ts";
import { signRequest, type AwsCredentials } from "./aws-sigv4.ts";
import {
  AdapterError,
  keepLease,
  parseJson,
  request,
  xmlAll,
  xmlErrorCode,
  xmlText,
  type FetchLike,
  type Reply,
} from "./https.ts";

/**
 * Real read-only AWS inventory (step 15): STS AssumeRole into the customer's role with its
 * external ID, then S3 / RDS / DynamoDB metadata in the allow-listed regions. Only AWS hosts,
 * only read actions, names and settings only (never object contents).
 */
/** Exactly the service endpoints used (never EC2 / ELB / API Gateway names under amazonaws.com). */
const AWS_HOST =
  /^(?:sts\.ap-south-1|s3\.[a-z0-9-]+|rds\.[a-z0-9-]+|dynamodb\.[a-z0-9-]+|\d{12}\.s3-control\.us-east-1)\.amazonaws\.com$/;
const PREFIX = "Aws";
const SESSION_SECONDS = 900;
/** Re-assume the role when less than this is left of the session. */
const REFRESH_BEFORE_MS = 2 * 60_000;
/**
 * Regional STS (ap-south-1, enabled in every account): its session tokens are valid in opt-in
 * regions too (ap-south-2 Hyderabad …), unlike the global endpoint's v1 tokens.
 */
const STS_URL = "https://sts.ap-south-1.amazonaws.com/";
const STS_REGION = "ap-south-1";

const EXPIRED = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "RequestExpired",
  "TokenRefreshRequired",
]);
const THROTTLED = new Set([
  "Throttling",
  "ThrottlingException",
  "LimitExceededException",
  "RequestLimitExceeded",
  "ProvisionedThroughputExceededException",
  "TooManyRequestsException",
  "SlowDown",
]);

/** Error code of an AWS reply (XML `<Code>` or JSON `__type`), or "". */
function awsErrorCode(r: Reply): string {
  if (r.status < 400) return "";
  const t = r.text.trimStart();
  if (t.startsWith("{")) {
    try {
      const v = (JSON.parse(t) as { __type?: unknown }).__type;
      return typeof v === "string" ? (v.split("#").pop() ?? "") : "";
    } catch {
      return "";
    }
  }
  return xmlErrorCode(t) ?? "";
}

type Signed = {
  method?: "GET" | "POST";
  url: string;
  service: string;
  region: string;
  headers?: Record<string, string>;
  body?: string;
  payloadHeader?: boolean;
};

export function createAwsInventory(deps: {
  credentials: AwsCredentials;
  fetch?: FetchLike;
  now?: () => Date;
  /** Test hook for retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}) {
  const fetchImpl: FetchLike = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());

  async function sendWith(creds: AwsCredentials, s: Signed): Promise<Reply> {
    const method = s.method ?? "GET";
    const headers = signRequest({
      method,
      url: s.url,
      headers: s.headers,
      body: s.body,
      service: s.service,
      region: s.region,
      credentials: creds,
      now: now(),
      payloadHeader: s.payloadHeader,
    });
    return request(
      fetchImpl,
      PREFIX,
      AWS_HOST,
      s.url,
      { method, headers, ...(s.body !== undefined ? { body: s.body } : {}) },
      {
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        // Query / JSON APIs report throttling as HTTP 400.
        retryable: (r) => r.status === 400 && THROTTLED.has(awsErrorCode(r)),
        // S3 PermanentRedirect (wrong region) → that bucket's setting is unknown, not a failed sync.
        keep3xx: true,
      },
    );
  }

  // The assumed-role session, refreshed before it ends and after an "expired" reply.
  type Session = { creds: AwsCredentials; accountId: string; expiresAt: number };
  let session: Session | null = null;
  let sessionCfg: { cfg: AwsConfig; sessionName: string } | null = null;
  let activeLease: Lease | undefined;

  async function refresh(): Promise<Session> {
    session = await assumeRole(sessionCfg!.cfg, sessionCfg!.sessionName);
    return session;
  }

  /** A call with the customer's role, re-assuming it when the session is ending or expired. */
  async function send(s: Signed): Promise<Reply> {
    await keepLease(activeLease);
    let cur = session!;
    if (cur.expiresAt - now().getTime() < REFRESH_BEFORE_MS) cur = await refresh();
    const r = await sendWith(cur.creds, s);
    if ((r.status === 400 || r.status === 403) && EXPIRED.has(awsErrorCode(r))) {
      cur = await refresh();
      return sendWith(cur.creds, s);
    }
    return r;
  }

  /** The platform's own account: a customer may never point the connector at it. */
  let platformAccount: string | null = null;
  async function ownAccount(): Promise<string> {
    if (platformAccount) return platformAccount;
    const r = await sendWith(deps.credentials, {
      method: "POST",
      url: STS_URL,
      service: "sts",
      region: STS_REGION,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "Action=GetCallerIdentity&Version=2011-06-15",
    });
    const account = xmlText(mustOk(r), "Account");
    if (!account || !/^\d{12}$/.test(account)) throw new AdapterError("AwsBadResponse");
    platformAccount = account;
    return account;
  }

  /** A list call must succeed: 403 → AwsAccessDenied, anything else non-2xx → AwsRequestFailed. */
  function mustOk(r: Reply): string {
    if (r.status >= 200 && r.status < 300) return r.text;
    if (r.status === 403 || r.status === 401) throw new AdapterError("AwsAccessDenied");
    throw new AdapterError("AwsRequestFailed");
  }

  async function assumeRole(cfg: AwsConfig, sessionName: string): Promise<Session> {
    const body = new URLSearchParams({
      Action: "AssumeRole",
      Version: "2011-06-15",
      RoleArn: cfg.roleArn,
      RoleSessionName: sessionName,
      ExternalId: cfg.externalId,
      DurationSeconds: String(SESSION_SECONDS),
    }).toString();
    const r = await sendWith(deps.credentials, {
      method: "POST",
      url: STS_URL,
      service: "sts",
      region: STS_REGION,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body,
    });
    if (r.status === 403 || r.status === 401)
      throw new AdapterError("AwsAssumeRoleDenied");
    const xml = mustOk(r);
    const accessKeyId = xmlText(xml, "AccessKeyId");
    const secretAccessKey = xmlText(xml, "SecretAccessKey");
    const sessionToken = xmlText(xml, "SessionToken");
    const assumedArn = xmlText(xml, "Arn") ?? "";
    if (!accessKeyId || !secretAccessKey || !sessionToken)
      throw new AdapterError("AwsBadResponse");
    const wanted = cfg.roleArn.split(":")[4];
    const got = assumedArn.split(":")[4];
    if (!wanted || got !== wanted) throw new AdapterError("AwsAccountMismatch");
    const exp = Date.parse(xmlText(xml, "Expiration") ?? "");
    return {
      creds: { accessKeyId, secretAccessKey, sessionToken },
      accountId: wanted,
      expiresAt: Number.isFinite(exp) ? exp : now().getTime() + SESSION_SECONDS * 1000,
    };
  }

  // ─── S3 ───────────────────────────────────────────────────────────────────

  /** Bucket-level GET of one sub-resource: body, "missing" (the given 404 code) or null (no access). */
  async function s3Sub(
    region: string,
    bucket: string,
    sub: string,
    missingCode: string,
  ): Promise<string | "missing" | null> {
    const r = await send({
      url: `https://s3.${region}.amazonaws.com/${encodeURIComponent(bucket)}?${sub}`,
      service: "s3",
      region,
      payloadHeader: true,
    });
    if (r.status >= 200 && r.status < 300) return r.text;
    if (r.status === 404 && xmlErrorCode(r.text) === missingCode) return "missing";
    if ([400, 403, 404].includes(r.status) || (r.status >= 300 && r.status < 400))
      return null;
    throw new AdapterError("AwsRequestFailed");
  }

  type Pab = { ignoreAcls: boolean; restrictPolicies: boolean } | null;
  const parsePab = (xml: string | "missing" | null): Pab =>
    xml === null
      ? null
      : xml === "missing"
        ? { ignoreAcls: false, restrictPolicies: false }
        : {
            ignoreAcls: xmlText(xml, "IgnorePublicAcls") === "true",
            restrictPolicies: xmlText(xml, "RestrictPublicBuckets") === "true",
          };

  async function accountPab(accountId: string): Promise<Pab> {
    const r = await send({
      url: `https://${accountId}.s3-control.us-east-1.amazonaws.com/v20180820/configuration/publicAccessBlock`,
      service: "s3",
      region: "us-east-1",
      headers: { "x-amz-account-id": accountId },
      payloadHeader: true,
    });
    if (r.status >= 200 && r.status < 300) return parsePab(r.text);
    if (r.status === 404) return parsePab("missing");
    return null;
  }

  async function bucketRegion(
    bucket: string,
  ): Promise<string | null> {
    const r = await send({
      url: `https://s3.us-east-1.amazonaws.com/${encodeURIComponent(bucket)}?location`,
      service: "s3",
      region: "us-east-1",
      payloadHeader: true,
    });
    if (r.status < 200 || r.status >= 300) return null;
    // Empty constraint = us-east-1, "EU" = eu-west-1.
    const loc = xmlText(r.text, "LocationConstraint") ?? "";
    return loc === "" ? "us-east-1" : loc === "EU" ? "eu-west-1" : loc;
  }

  async function s3Buckets(
    accountId: string,
    regions: Set<string>,
    lease: Lease | undefined,
    out: StoreObservation[],
  ) {
    const buckets: { name: string; region: string }[] = [];
    let token: string | null = null;
    do {
      await keepLease(lease);
      const q: string = token
        ? `max-buckets=1000&continuation-token=${encodeURIComponent(token)}`
        : "max-buckets=1000";
      const xml = mustOk(
        await send({
          url: `https://s3.us-east-1.amazonaws.com/?${q}`,
          service: "s3",
          region: "us-east-1",
          payloadHeader: true,
        }),
      );
      for (const b of xmlAll(xml, "Bucket")) {
        const name = xmlText(b, "Name");
        if (!name) continue;
        let region = xmlText(b, "BucketRegion");
        if (!region) region = await bucketRegion(name);
        if (region && regions.has(region)) buckets.push({ name, region });
      }
      token = xmlText(xml.replace(/<Buckets>[\s\S]*<\/Buckets>/, ""), "ContinuationToken");
    } while (token && buckets.length <= MAX_STORES_PER_SYNC);
    if (!buckets.length) return;

    const account = await accountPab(accountId);
    for (const { name, region } of buckets) {
      if (out.length > MAX_STORES_PER_SYNC) return;
      await keepLease(lease);
      const enc = await s3Sub(region, name, "encryption", "ServerSideEncryptionConfigurationNotFoundError");
      const policy = await s3Sub(region, name, "policyStatus", "NoSuchBucketPolicy");
      const acl = await s3Sub(region, name, "acl", "NoSuchBucket");
      const pab = parsePab(
        await s3Sub(region, name, "publicAccessBlock", "NoSuchPublicAccessBlockConfiguration"),
      );
      const versioning = await s3Sub(region, name, "versioning", "NoSuchBucket");
      const logging = await s3Sub(region, name, "logging", "NoSuchBucket");

      const policyPublic =
        policy === null ? null : policy !== "missing" && xmlText(policy, "IsPublic") === "true";
      const aclPublic =
        acl === null || acl === "missing"
          ? acl === "missing"
            ? false
            : null
          : /acs\.amazonaws\.com\/groups\/global\/(?:AllUsers|AuthenticatedUsers)/.test(acl);
      const restrict =
        (pab?.restrictPolicies ?? false) || (account?.restrictPolicies ?? false);
      const ignoreAcls = (pab?.ignoreAcls ?? false) || (account?.ignoreAcls ?? false);
      const viaPolicy = policyPublic === null ? null : policyPublic && !restrict;
      const viaAcl = aclPublic === null ? null : aclPublic && !ignoreAcls;
      const publicAccess =
        viaPolicy === true || viaAcl === true
          ? true
          : viaPolicy === null || viaAcl === null
            ? null
            : false;

      out.push({
        kind: "s3_bucket",
        name,
        region,
        encrypted: enc === null ? null : enc !== "missing",
        publicAccess,
        backups:
          versioning === null || versioning === "missing"
            ? null
            : xmlText(versioning, "Status") === "Enabled",
        logging:
          logging === null || logging === "missing"
            ? null
            : xmlAll(logging, "LoggingEnabled").length > 0,
      });
    }
  }

  // ─── RDS ──────────────────────────────────────────────────────────────────

  async function rdsInstances(
    region: string,
    lease: Lease | undefined,
    out: StoreObservation[],
  ) {
    let marker: string | null = null;
    do {
      await keepLease(lease);
      const params = new URLSearchParams({
        Action: "DescribeDBInstances",
        Version: "2014-10-31",
        MaxRecords: "100",
      });
      if (marker) params.set("Marker", marker);
      const xml = mustOk(
        await send({
          url: `https://rds.${region}.amazonaws.com/?${params.toString()}`,
          service: "rds",
          region,
        }),
      );
      for (const db of xmlAll(xml, "DBInstance")) {
        const name = xmlText(db, "DBInstanceIdentifier");
        if (!name) continue;
        const bool = (tag: string) => {
          const t = xmlText(db, tag);
          return t === null ? null : t === "true";
        };
        const retention = xmlText(db, "BackupRetentionPeriod");
        const logs = xmlAll(db, "EnabledCloudwatchLogsExports")[0];
        out.push({
          kind: "rds_instance",
          name,
          region,
          encrypted: bool("StorageEncrypted"),
          publicAccess: bool("PubliclyAccessible"),
          backups: retention === null ? null : Number(retention) > 0,
          logging:
            logs !== undefined && xmlAll(logs, "member").length > 0
              ? true
              : xmlText(db, "DBClusterIdentifier")
                ? null // cluster member: exports are set on the cluster
                : false,
        });
      }
      marker = xmlText(xml.replace(/<DBInstances>[\s\S]*<\/DBInstances>/, ""), "Marker");
    } while (marker && out.length <= MAX_STORES_PER_SYNC);
  }

  // ─── DynamoDB ─────────────────────────────────────────────────────────────

  async function ddb(
    region: string,
    action: string,
    body: unknown,
  ): Promise<Reply> {
    return send({
      method: "POST",
      url: `https://dynamodb.${region}.amazonaws.com/`,
      service: "dynamodb",
      region,
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `DynamoDB_20120810.${action}`,
      },
      body: JSON.stringify(body),
    });
  }

  const ddbErrorType = (r: Reply) => {
    const t = parseJson<{ __type?: unknown }>(r.text || "{}", PREFIX).__type;
    return typeof t === "string" ? (t.split("#").pop() ?? "") : "";
  };

  /** Allow statement for everyone (Principal "*" / AWS "*") without conditions. */
  function policyIsPublic(policy: string): boolean | null {
    let doc: { Statement?: unknown };
    try {
      doc = JSON.parse(policy) as { Statement?: unknown };
    } catch {
      return null;
    }
    const st = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
    return st.some((s) => {
      if (!s || typeof s !== "object") return false;
      const o = s as Record<string, unknown>;
      const p = o.Principal;
      const everyone =
        p === "*" ||
        (!!p &&
          typeof p === "object" &&
          [(p as Record<string, unknown>).AWS].flat().includes("*"));
      return o.Effect === "Allow" && everyone && !o.Condition;
    });
  }

  async function dynamoTables(
    accountId: string,
    region: string,
    lease: Lease | undefined,
    out: StoreObservation[],
  ) {
    let start: string | undefined;
    do {
      await keepLease(lease);
      const page = parseJson<{ TableNames?: unknown; LastEvaluatedTableName?: unknown }>(
        mustOk(await ddb(region, "ListTables", { Limit: 100, ...(start ? { ExclusiveStartTableName: start } : {}) })),
        PREFIX,
      );
      const names = Array.isArray(page.TableNames)
        ? page.TableNames.filter((n): n is string => typeof n === "string")
        : [];
      for (const name of names) {
        if (out.length > MAX_STORES_PER_SYNC) return;
        await keepLease(lease);
        const pitr = await ddb(region, "DescribeContinuousBackups", { TableName: name });
        const backups =
          pitr.status === 200
            ? parseJson<{
                ContinuousBackupsDescription?: {
                  PointInTimeRecoveryDescription?: { PointInTimeRecoveryStatus?: unknown };
                };
              }>(pitr.text, PREFIX).ContinuousBackupsDescription?.PointInTimeRecoveryDescription
                ?.PointInTimeRecoveryStatus === "ENABLED"
            : null;
        const arn = `arn:aws:dynamodb:${region}:${accountId}:table/${name}`;
        const pol = await ddb(region, "GetResourcePolicy", { ResourceArn: arn });
        let publicAccess: boolean | null = null;
        if (pol.status === 200) {
          const p = parseJson<{ Policy?: unknown }>(pol.text, PREFIX).Policy;
          publicAccess = typeof p === "string" ? policyIsPublic(p) : false;
        } else if (
          pol.status === 400 &&
          ["PolicyNotFoundException", "ResourceNotFoundException"].includes(ddbErrorType(pol))
        ) {
          publicAccess = false;
        }
        out.push({
          kind: "dynamodb_table",
          name,
          region,
          // DynamoDB encrypts every table at rest (AWS owned key by default).
          encrypted: true,
          publicAccess,
          backups,
          logging: null,
        });
      }
      start =
        typeof page.LastEvaluatedTableName === "string" ? page.LastEvaluatedTableName : undefined;
    } while (start && out.length <= MAX_STORES_PER_SYNC);
  }

  return async function aws(
    cfg: AwsConfig,
    lease?: Lease,
    ref?: { integrationId: string },
  ): Promise<AwsInventory> {
    const target = cfg.roleArn.split(":")[4];
    if (target === (await ownAccount())) throw new AdapterError("AwsAccountRefused");
    // Session name per integration, so the customer's CloudTrail shows which one assumed the role.
    const sessionName = `dpdpa-${(ref?.integrationId ?? "inventory").replace(/[^\w+=,.@-]/g, "").slice(0, 58)}`;
    sessionCfg = { cfg, sessionName };
    activeLease = lease;
    const { accountId } = await refresh();
    // Only known regions from the stored allow-list (validated on connect).
    const regions = new Set(cfg.regions.filter((r) => regionCountry(r) !== null));
    const stores: StoreObservation[] = [];
    await s3Buckets(accountId, regions, lease, stores);
    for (const region of regions) {
      if (stores.length > MAX_STORES_PER_SYNC) break;
      await rdsInstances(region, lease, stores);
      await dynamoTables(accountId, region, lease, stores);
    }
    return { accountId, stores };
  };
}
