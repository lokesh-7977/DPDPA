import { z } from "@hono/zod-openapi";
import { orgRoles } from "../../../domain/auth.ts";

export const OrgRoleSchema = z.enum(orgRoles).openapi("OrgRole");

export const MemberSchema = z
  .object({
    userId: z.uuid(),
    email: z.string(),
    name: z.string(),
    role: OrgRoleSchema,
    joinedAt: z.iso.datetime(),
  })
  .openapi("Member");

export const ChangeRoleSchema = z.object({ role: OrgRoleSchema }).openapi("ChangeRole");

export const MemberParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  userId: z.uuid().openapi({ param: { name: "userId", in: "path" } }),
});

export const toMemberDto = (m: {
  userId: string;
  email: string;
  name: string;
  role: (typeof orgRoles)[number];
  joinedAt: Date;
}) => ({ ...m, joinedAt: m.joinedAt.toISOString() });
