import { z } from "@hono/zod-openapi";
import { Plain, iso } from "../_shared/index.ts";
import type { AuditorGrant, AuditorRoom } from "../../../db/schemas/index.ts";
import { roomScopes } from "../../../domain/auditor-room.ts";
import type { RiskView } from "../risks/index.ts";

export const RoomSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    scopes: z.array(z.enum(roomScopes)),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    open: z.boolean(),
  })
  .openapi("AuditorRoom");

export const toRoomDto = (r: AuditorRoom) => ({
  id: r.id,
  name: r.name,
  scopes: r.scopes as (typeof roomScopes)[number][],
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
  revokedAt: iso(r.revokedAt),
  open: !r.revokedAt && r.expiresAt > new Date(),
});

export const GrantSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    name: z.string(),
    lastSignInAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("AuditorGrant");

export const toGrantDto = (g: AuditorGrant) => ({
  id: g.id,
  email: g.email,
  name: g.name,
  lastSignInAt: iso(g.lastSignInAt),
  revokedAt: iso(g.revokedAt),
  createdAt: g.createdAt.toISOString(),
});

export const RoomParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  roomId: z.uuid().openapi({ param: { name: "roomId", in: "path" } }),
});

export const GrantParams = RoomParams.extend({
  grantId: z.uuid().openapi({ param: { name: "grantId", in: "path" } }),
});

// ─── Auditor side ────────────────────────────────────────────────────────────
//
// Explicit, allow-listed shapes only: no user ids, artifact ids, contributor lists,
// IP / user-agent hashes or internal event data. A column added to a table later
// never reaches the room unless it is added here.

export const RoomInfo = z
  .object({
    name: z.string(),
    organization: z.string(),
    scopes: z.array(z.string()),
    closesAt: z.iso.datetime(),
    auditor: z.string(),
  })
  .openapi("AuditorRoomInfo");

export const RoomControl = z
  .object({
    framework: z.string(),
    code: z.string(),
    title: z.string(),
    objective: z.string().nullable(),
    applicable: z.boolean(),
    status: z.string(),
    automaticCheck: z
      .object({ result: z.string(), reason: z.string() })
      .nullable(),
    evidence: z.object({
      current: z.number().int(),
      expired: z.number().int(),
      pending: z.number().int(),
      rejected: z.number().int(),
    }),
    lastReviewedAt: z.iso.datetime().nullable(),
    nextReviewAt: z.iso.datetime().nullable(),
    reviewOverdue: z.boolean(),
  })
  .openapi("AuditorRoomControl");

/** The fields of a managed control (compliance service) that an auditor sees. */
type ControlRow = {
  framework: string;
  code: string;
  title: string;
  objective?: string | null;
  applicable: boolean;
  status: string;
  check?: { result: string; reason: string } | null;
  evidenceCounts: {
    current: number;
    expired: number;
    pending: number;
    rejected: number;
  };
  lastReviewedAt: Date | null;
  nextReviewAt: Date | null;
  reviewOverdue: boolean;
};

export const toRoomControl = (c: ControlRow) => ({
  framework: c.framework,
  code: c.code,
  title: c.title,
  objective: c.objective ?? null,
  applicable: c.applicable,
  status: c.status,
  automaticCheck: c.check
    ? { result: c.check.result, reason: c.check.reason }
    : null,
  evidence: c.evidenceCounts,
  lastReviewedAt: iso(c.lastReviewedAt),
  nextReviewAt: iso(c.nextReviewAt),
  reviewOverdue: c.reviewOverdue,
});

export const RoomEvidence = z
  .object({
    kind: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    url: z.string().nullable(),
    hasFile: z.boolean(),
    collectedAt: z.iso.datetime().nullable(),
    validUntil: z.iso.datetime(),
    status: z.string(),
    decidedAt: z.iso.datetime().nullable(),
  })
  .openapi("AuditorRoomEvidence");

/** The fields of a control evidence item that an auditor sees. */
type EvidenceRow = {
  kind: string;
  title: string;
  description?: string | null;
  url?: string | null;
  artifactId?: string | null;
  collectedAt: Date | null;
  validUntil: Date;
  status: string;
  decidedAt: Date | null;
};

export const toRoomEvidence = (e: EvidenceRow) => ({
  kind: e.kind,
  title: e.title,
  description: e.description ?? null,
  url: e.url ?? null,
  hasFile: !!e.artifactId,
  collectedAt: iso(e.collectedAt),
  validUntil: e.validUntil.toISOString(),
  status: e.status,
  decidedAt: iso(e.decidedAt),
});

export const RoomPolicy = z
  .object({
    policyId: z.uuid(),
    code: z.string(),
    title: z.string(),
    current: z
      .object({
        versionId: z.uuid(),
        version: z.number().int(),
        approvedAt: z.iso.datetime().nullable(),
      })
      .nullable(),
  })
  .openapi("AuditorRoomPolicy");

export const RoomRisk = z
  .object({
    id: z.uuid(),
    ref: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    category: z.string(),
    inherentScore: z.number().int(),
    inherentLevel: z.string(),
    residualScore: z.number().int(),
    residualLevel: z.string(),
    treatment: z.string(),
    status: z.string(),
    acceptedUntil: z.string().nullable(),
    nextReviewAt: z.iso.datetime(),
    reviewOverdue: z.boolean(),
  })
  .openapi("AuditorRoomRisk");

type RiskRow = RiskView;

export const toRoomRisk = (r: RiskRow) => ({
  id: r.id,
  ref: r.refLabel,
  title: r.title,
  description: r.description,
  category: r.category,
  inherentScore: r.inherentScore,
  inherentLevel: r.inherentLevel,
  residualScore: r.residualScore,
  residualLevel: r.residualLevel,
  treatment: r.treatment,
  status: r.status,
  acceptedUntil: r.status === "accepted" ? r.acceptedUntil : null,
  nextReviewAt: r.nextReviewAt.toISOString(),
  reviewOverdue: r.reviewOverdue,
});

export const RoomAuditEntry = z
  .object({
    seq: z.number().int(),
    occurredAt: z.iso.datetime(),
    actorType: z.string(),
    action: z.string(),
    entityType: z.string(),
    entityId: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    hash: z.string(),
  })
  .openapi("AuditorRoomAuditEntry");

const Id = (name: string) => z.uuid().openapi({ param: { name, in: "path" } });

export const CreateRoomBody = z.object({
  name: Plain(200),
  scopes: z.array(z.enum(roomScopes)).min(1),
  expiresAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
});

export const RoomDetailSchema = z.object({
  room: RoomSchema,
  grants: z.array(GrantSchema),
  access: z.array(
    z.object({
      grantId: z.uuid(),
      resource: z.string(),
      resourceId: z.string().nullable(),
      at: z.iso.datetime(),
    }),
  ),
});

export const InviteBody = z.object({
  email: z.email().max(254),
  name: Plain(200),
});

export const SessionRequest = z.object({ token: z.string().min(20).max(200) });

export const SessionSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.iso.datetime(),
  room: z.object({
    name: z.string(),
    organization: z.string(),
    scopes: z.array(z.string()),
    closesAt: z.iso.datetime(),
  }),
});

export const RequestLinkBody = z.object({
  roomId: z.uuid(),
  email: z.email().max(254),
});

export const ControlParams = z.object({
  framework: z
    .enum(["DPDPA_2023", "AIGIS_BASELINE"])
    .openapi({ param: { name: "framework", in: "path" } }),
  code: z
    .string()
    .max(50)
    .openapi({ param: { name: "code", in: "path" } }),
});

export const ControlDetailSchema = z.object({
  control: RoomControl,
  evidence: z.array(RoomEvidence),
});

export const PolicyVersionParams = z.object({
  policyId: Id("policyId"),
  versionId: Id("versionId"),
});

export const PolicyVersionSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  status: z.string(),
  approvedAt: z.iso.datetime().nullable(),
  body: z.string(),
});

export const RiskParams = z.object({ riskId: Id("riskId") });

export const RiskDetailSchema = z.object({
  risk: RoomRisk,
  controls: z.array(
    z.object({
      framework: z.string(),
      controlCode: z.string(),
      title: z.string().nullable(),
      status: z.string().nullable(),
    }),
  ),
  tasks: z.array(
    z.object({
      title: z.string(),
      status: z.string(),
      priority: z.string(),
      dueDate: z.string().nullable(),
    }),
  ),
  history: z.array(z.object({ kind: z.string(), at: z.iso.datetime() })),
});

export const AuditVerifySchema = z.object({
  valid: z.boolean(),
  entries: z.number().int(),
  brokenAtSeq: z.number().int().nullable(),
});

export const TrainingSummarySchema = z.array(
  z.object({
    title: z.string(),
    completed: z.number().int(),
    open: z.number().int(),
    overdue: z.number().int(),
  }),
);

export const AccessReviewsSchema = z.array(
  z.object({
    status: z.string(),
    dueDate: z.string(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    summary: z
      .object({
        kept: z.number(),
        rolesChanged: z.number(),
        removed: z.number(),
        keysRevoked: z.number(),
        skipped: z.number(),
      })
      .nullable(),
  }),
);
