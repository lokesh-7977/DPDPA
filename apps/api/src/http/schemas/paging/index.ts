import { z } from "@hono/zod-openapi";

/** Offset paging for list endpoints: at most 500 rows per request. */
export const PageFields = {
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
};
export const PageQuery = z.object(PageFields);
