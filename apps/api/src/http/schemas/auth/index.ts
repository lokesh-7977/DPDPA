import { z } from "@hono/zod-openapi";
import { orgRoles } from "../../../domain/auth.ts";
import { PASSWORD_MAX, PASSWORD_MIN } from "../../../domain/passwords.ts";

export const PasswordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

export const LoginSchema = z
  .object({
    email: z.email().max(254).openapi({ example: "admin@acme.in" }),
    // Max only: a short wrong password should get the same 401 as any other.
    password: z.string().min(1).max(PASSWORD_MAX),
  })
  .openapi("Login");

export const AccessTokenSchema = z
  .object({
    accessToken: z.string(),
    tokenType: z.literal("Bearer"),
    expiresIn: z.number().int().openapi({ description: "Seconds" }),
  })
  .openapi("AccessToken");

export const ChangePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(PASSWORD_MAX), newPassword: PasswordSchema })
  .openapi("ChangePassword");

export const MeSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    name: z.string(),
    isSuperAdmin: z.boolean(),
    orgs: z.array(
      z.object({
        orgId: z.uuid(),
        slug: z.string(),
        name: z.string(),
        status: z.enum(["active", "suspended"]),
        role: z.enum(orgRoles),
      }),
    ),
  })
  .openapi("Me");
