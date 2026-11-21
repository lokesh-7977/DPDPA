import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 (header form), enough for the read-only inventory calls.
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) =>
  createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding as SigV4 wants it (also encodes ! ' ( ) *). */
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Signed headers for a request. `headers` are the extra headers sent (content-type,
 * x-amz-target …); host and x-amz-date (and the security token) are added. S3 also needs the
 * payload hash header (`payloadHeader`).
 */
export function signRequest(v: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  now: Date;
  payloadHeader?: boolean;
}): Record<string, string> {
  const u = new URL(v.url);
  const date = amzDate(v.now);
  const day = date.slice(0, 8);
  const payloadHash = sha256(v.body ?? "");
  const headers: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.headers ?? {}))
    headers[k.toLowerCase()] = val;
  headers.host = u.host;
  headers["x-amz-date"] = date;
  if (v.payloadHeader) headers["x-amz-content-sha256"] = payloadHash;
  if (v.credentials.sessionToken)
    headers["x-amz-security-token"] = v.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const query = [...u.searchParams.entries()]
    .map(([k, val]) => [rfc3986(k), rfc3986(val)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, val]) => `${k}=${val}`)
    .join("&");
  const canonical = [
    v.method,
    u.pathname || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${v.region}/${v.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  const kDate = hmac(`AWS4${v.credentials.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, v.region), v.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");

  const out: Record<string, string> = { ...headers };
  delete out.host; // fetch sets it from the URL
  out.authorization = `AWS4-HMAC-SHA256 Credential=${v.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
