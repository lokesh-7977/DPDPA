import { createSign } from "node:crypto";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A compact RS256 JWT signed with a PEM private key (Google service accounts, GitHub Apps). */
export function signRs256(
  claims: Record<string, unknown>,
  privateKeyPem: string,
  kid?: string,
): string {
  const header = b64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) }),
  );
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}
