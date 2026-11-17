import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "./middleware/auth.ts";

export const ErrorSchema = z
  .object({
    error: z.string(),
    issues: z.array(z.unknown()).optional(),
  })
  .openapi("Error");

export const IdParam = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

/**
 * Request body. `required: true` makes zod-openapi reject a missing body or a
 * non-JSON content type (400) instead of silently passing `{}` to the handler.
 */
export const jsonBody = <T extends z.ZodType>(schema: T, description: string) => ({
  ...json(schema, description),
  required: true,
});

export const errors = {
  400: json(ErrorSchema, "Validation error"),
  401: json(ErrorSchema, "Missing or invalid token"),
  403: json(ErrorSchema, "Insufficient role"),
} as const;

export const bearer = [{ Bearer: [] }];

/** Router with consistent 400 response shape for zod validation failures. */
export const createRouter = () =>
  new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Validation failed", issues: result.error.issues },
          400,
        );
      }
    },
  });
