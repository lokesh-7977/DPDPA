/**
 * Uploaded evidence files (breach evidence, control evidence). Pure validation rules.
 */
import { unprocessable } from "./errors.ts";
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
/** Types that are evidence, not active content (no HTML/SVG: never rendered inline). */
export const EVIDENCE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
};

/** Safe display name: letters, digits, dot, dash, underscore; max 120 chars. */
export function safeFileName(name: string, ext: string): string {
  const base =
    name
      .replace(/\.[^.]*$/, "")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 100) || "evidence";
  return `${base}.${ext}`;
}

/** Binary types must start with their signature (a mislabelled file is rejected). */
export function matchesDeclaredType(
  bytes: Uint8Array,
  contentType: string,
): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (contentType) {
    case "application/pdf":
      return starts(0x25, 0x50, 0x44, 0x46); // %PDF
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    default: {
      // Text types: valid UTF-8 without NUL bytes.
      if (bytes.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
    }
  }
}

/**
 * Validate an upload; returns the normalised content type and a safe file name.
 * Throws UNPROCESSABLE with a reason the uploader can act on.
 */
export function validateEvidenceFile(v: {
  body: Uint8Array;
  contentType: string;
  fileName: string;
}) {
  const type = v.contentType.split(";")[0]!.trim().toLowerCase();
  const ext = EVIDENCE_TYPES[type];
  if (!ext)
    throw unprocessable(
      `Allowed types: ${Object.keys(EVIDENCE_TYPES).join(", ")}`,
    );
  if (!v.body.byteLength) throw unprocessable("Empty file");
  if (v.body.byteLength > EVIDENCE_MAX_BYTES)
    throw unprocessable("File over 10 MB");
  if (!matchesDeclaredType(v.body, type))
    throw unprocessable("File content does not match its type");
  return { contentType: type, fileName: safeFileName(v.fileName, ext) };
}
