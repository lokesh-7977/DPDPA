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
export const jsonBody = <T extends z.ZodType>(
  schema: T,
  description: string,
) => ({
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

type Schema = Record<string, unknown>;
type OpenApiDoc = {
  paths?: Record<
    string,
    Record<
      string,
      {
        responses?: Record<
          string,
          { content?: Record<string, { schema?: Schema }> }
        >;
      }
    >
  >;
  components?: { schemas?: Record<string, Schema> };
};

/**
 * The published document describes the response envelope (http/middleware/envelope.ts):
 * 2xx bodies as { status, detail, data: <schema> }, errors as ErrorEnvelope.
 */
export function envelopeDocument<T extends object>(input: T): T {
  const doc = input as OpenApiDoc;
  const errorEnvelope: Schema = {
    type: "object",
    required: ["status", "error"],
    properties: {
      status: { type: "integer", examples: [404] },
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", examples: ["NOT_FOUND"] },
          message: { type: "string" },
          issues: { type: "array", items: {} },
          details: { type: "object" },
        },
      },
    },
  };
  doc.components = {
    ...doc.components,
    schemas: { ...doc.components?.schemas, ErrorEnvelope: errorEnvelope },
  };
  for (const methods of Object.values(doc.paths ?? {}))
    for (const op of Object.values(methods))
      for (const [code, response] of Object.entries(op.responses ?? {})) {
        const media = response.content?.["application/json"];
        if (!media) continue;
        media.schema = code.startsWith("2")
          ? {
              type: "object",
              required: ["status", "detail", "data"],
              properties: {
                status: { type: "integer", examples: [Number(code)] },
                detail: {
                  type: "string",
                  examples: [
                    (
                      {
                        "200": "OK",
                        "201": "Created",
                        "202": "Accepted",
                      } as Record<string, string>
                    )[code] ?? "OK",
                  ],
                },
                data: media.schema ?? {},
              },
            }
          : { $ref: "#/components/schemas/ErrorEnvelope" };
      }
  return input;
}
