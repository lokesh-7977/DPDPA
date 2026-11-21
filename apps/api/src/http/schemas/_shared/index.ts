import { z } from "@hono/zod-openapi";

/** One-line text: trimmed, not empty, no control or invisible characters. */
export const Plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^[^\p{Cc}\p{Cf}]*$/u,
      "must not contain control or invisible characters",
    );

/** Free text: line breaks allowed, other control / invisible characters not. */
export const Prose = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r])*$/u,
      "must not contain control characters",
    );

/** Date → ISO string, keeping null / undefined as null. */
export const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
