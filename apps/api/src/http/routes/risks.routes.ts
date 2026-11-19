import { createRoute, z } from "@hono/zod-openapi";
import type {
  RemediationTask,
  Risk,
  RiskEvent,
} from "../../db/schemas/index.ts";
import { riskLevels } from "../../domain/dpia.ts";
import {
  registerStatuses,
  riskCategories,
  riskTreatments,
} from "../../domain/risk-register.ts";
import { risksService } from "../../services/risks.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** Phase 9d — organization risk register. */
const base = {
  tags: ["Risk register"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");
const unprocessable = json(ErrorSchema, "Unprocessable");

const Plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^[^\p{Cc}\p{Cf}]*$/u,
      "must not contain control or invisible characters",
    );
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r\t])*$/u,
      "must not contain control or invisible characters",
    );
const Score = z.number().int().min(1).max(5);
const Day = z.iso.date();
const Level = z.enum(riskLevels);
const ControlRef = z.object({
  framework: z.enum(["DPDPA_2023", "AIGIS_BASELINE"]),
  controlCode: z.string().max(50),
});

const RiskSchema = z
  .object({
    id: z.uuid(),
    ref: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    category: z.enum(riskCategories),
    ownerUserId: z.uuid().nullable(),
    inherentLikelihood: z.number().int(),
    inherentImpact: z.number().int(),
    inherentScore: z.number().int(),
    inherentLevel: Level,
    residualLikelihood: z.number().int(),
    residualImpact: z.number().int(),
    residualScore: z.number().int(),
    residualLevel: Level,
    treatment: z.enum(riskTreatments),
    status: z.enum(registerStatuses),
    acceptance: z
      .object({
        justification: z.string(),
        acceptedBy: z.uuid(),
        acceptedAt: z.iso.datetime(),
        acceptedUntil: Day,
        expired: z.boolean(),
      })
      .nullable(),
    reviewEveryDays: z.number().int(),
    lastReviewedAt: z.iso.datetime().nullable(),
    nextReviewAt: z.iso.datetime(),
    reviewOverdue: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Risk");

type RiskView = Risk & {
  refLabel: string;
  inherentScore: number;
  inherentLevel: z.infer<typeof Level>;
  residualScore: number;
  residualLevel: z.infer<typeof Level>;
  nextReviewAt: Date;
  reviewOverdue: boolean;
  acceptanceExpired: boolean;
};
const toRiskDto = (r: RiskView) => ({
  id: r.id,
  ref: r.refLabel,
  title: r.title,
  description: r.description,
  category: r.category,
  ownerUserId: r.ownerUserId,
  inherentLikelihood: r.inherentLikelihood,
  inherentImpact: r.inherentImpact,
  inherentScore: r.inherentScore,
  inherentLevel: r.inherentLevel,
  residualLikelihood: r.residualLikelihood,
  residualImpact: r.residualImpact,
  residualScore: r.residualScore,
  residualLevel: r.residualLevel,
  treatment: r.treatment,
  status: r.status,
  acceptance:
    r.status === "accepted" && r.acceptedBy && r.acceptedAt && r.acceptedUntil
      ? {
          justification: r.acceptanceJustification ?? "",
          acceptedBy: r.acceptedBy,
          acceptedAt: r.acceptedAt.toISOString(),
          acceptedUntil: r.acceptedUntil,
          expired: r.acceptanceExpired,
        }
      : null,
  reviewEveryDays: r.reviewEveryDays,
  lastReviewedAt: r.lastReviewedAt?.toISOString() ?? null,
  nextReviewAt: r.nextReviewAt.toISOString(),
  reviewOverdue: r.reviewOverdue,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const TaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  dueDate: z.string().nullable(),
  assigneeUserId: z.uuid().nullable(),
});
const toTaskDto = (t: RemediationTask) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  dueDate: t.dueDate,
  assigneeUserId: t.assigneeUserId,
});
const toEventDto = (e: RiskEvent) => ({
  kind: e.kind,
  actorUserId: e.actorUserId,
  data: e.data,
  createdAt: e.createdAt.toISOString(),
});

const RiskParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  riskId: z.uuid().openapi({ param: { name: "riskId", in: "path" } }),
});

const Fields = {
  title: Plain(200),
  description: Text(5000).nullable().optional(),
  category: z.enum(riskCategories),
  ownerUserId: z.uuid().nullable().optional(),
  reviewEveryDays: z.number().int().min(7).max(730).optional(),
  treatment: z.enum(["mitigate", "transfer", "avoid"]).optional(),
  inherentLikelihood: Score,
  inherentImpact: Score,
  residualLikelihood: Score,
  residualImpact: Score,
};

const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/risks",
  summary: "Risk register",
  request: {
    params: OrgIdParam,
    query: z.object({
      status: z.enum(registerStatuses).optional(),
      category: z.enum(riskCategories).optional(),
      ownerUserId: z.uuid().optional(),
      level: Level.optional(),
      reviewOverdue: z.stringbool().optional(),
    }),
  },
  responses: { 200: json(z.array(RiskSchema), "Risks"), ...errors },
});
const heatmapRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/risks/heatmap",
  summary:
    "5×5 heat map of open and accepted risks (cells[likelihood-1][impact-1])",
  request: {
    params: OrgIdParam,
    query: z.object({
      basis: z.enum(["inherent", "residual"]).default("residual"),
    }),
  },
  responses: {
    200: json(
      z.object({
        basis: z.enum(["inherent", "residual"]),
        cells: z.array(z.array(z.number().int())),
        byLevel: z.record(Level, z.number().int()),
        total: z.number().int(),
      }),
      "Heat map",
    ),
    ...errors,
  },
});
const createRoute_ = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/risks",
  summary: "Add a risk (residual can't score above inherent)",
  request: {
    params: OrgIdParam,
    body: jsonBody(
      z.object({ ...Fields, controls: z.array(ControlRef).max(50).optional() }),
      "Risk",
    ),
  },
  responses: {
    201: json(RiskSchema, "Created"),
    422: unprocessable,
    ...errors,
  },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/risks/{riskId}",
  summary:
    "Risk with its controls (and their status), treatment tasks and history",
  request: { params: RiskParams },
  responses: {
    200: json(
      z.object({
        risk: RiskSchema,
        controls: z.array(
          ControlRef.extend({
            title: z.string().nullable(),
            status: z.string().nullable(),
          }),
        ),
        tasks: z.array(TaskSchema),
        events: z.array(
          z.object({
            kind: z.string(),
            actorUserId: z.uuid().nullable(),
            data: z.record(z.string(), z.unknown()),
            createdAt: z.iso.datetime(),
          }),
        ),
      }),
      "Risk",
    ),
    404: notFound,
    ...errors,
  },
});
const updateRoute = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/risks/{riskId}",
  summary:
    "Edit or re-score (re-scoring an accepted risk withdraws the acceptance)",
  request: {
    params: RiskParams,
    body: jsonBody(z.object(Fields).partial(), "Changes"),
  },
  responses: {
    200: json(RiskSchema, "Updated"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const controlsRoute = createRoute({
  ...base,
  method: "put",
  path: "/{orgId}/risks/{riskId}/controls",
  summary: "Set the controls that reduce this risk",
  request: {
    params: RiskParams,
    body: jsonBody(
      z.object({ controls: z.array(ControlRef).max(50) }),
      "Controls",
    ),
  },
  responses: {
    200: json(z.array(ControlRef), "Linked"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const acceptRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/risks/{riskId}/accept",
  summary:
    "Accept the residual risk until a date (DPO / admin; critical: org admin only; max 1 year)",
  request: {
    params: RiskParams,
    body: jsonBody(
      z.object({ justification: Text(2000).min(1), acceptedUntil: Day }),
      "Decision",
    ),
  },
  responses: {
    200: json(RiskSchema, "Accepted"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const simple = (path: string, summary: string) =>
  createRoute({
    ...base,
    method: "post",
    path: `/{orgId}/risks/{riskId}/${path}`,
    summary,
    request: { params: RiskParams },
    responses: {
      200: json(RiskSchema, "Updated"),
      404: notFound,
      409: conflict,
      ...errors,
    },
  });
const reviewRoute = simple(
  "review",
  "Record a review (resets the review clock)",
);
const closeRoute = simple("close", "Close (DPO / admin)");
const reopenRoute = simple(
  "reopen",
  "Reopen a closed or accepted risk (DPO / admin)",
);
const taskRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/risks/{riskId}/tasks",
  summary: "Add a remediation task that treats this risk",
  request: {
    params: RiskParams,
    body: jsonBody(
      z.object({
        title: Plain(200),
        assigneeUserId: z.uuid().nullable().optional(),
        dueDate: Day.nullable().optional(),
        priority: z.enum(["low", "medium", "high", "critical"]).optional(),
      }),
      "Task",
    ),
  },
  responses: {
    201: json(TaskSchema, "Created"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});

export const risksRoutes = createRouter()
  .openapi(heatmapRoute, async (c) =>
    c.json(
      await risksService.heatmap(orgContext(c), c.req.valid("query").basis),
      200,
    ),
  )
  .openapi(listRoute, async (c) =>
    c.json(
      (await risksService.list(orgContext(c), c.req.valid("query"))).map(
        toRiskDto,
      ),
      200,
    ),
  )
  .openapi(createRoute_, async (c) =>
    c.json(
      toRiskDto(await risksService.create(orgContext(c), c.req.valid("json"))),
      201,
    ),
  )
  .openapi(getRoute, async (c) => {
    const r = await risksService.get(
      orgContext(c),
      c.req.valid("param").riskId,
    );
    return c.json(
      {
        risk: toRiskDto(r.risk),
        controls: r.controls.map((x) => ({
          ...x,
          framework: x.framework as "DPDPA_2023" | "AIGIS_BASELINE",
        })),
        tasks: r.tasks.map(toTaskDto),
        events: r.events.map(toEventDto),
      },
      200,
    );
  })
  .openapi(updateRoute, async (c) =>
    c.json(
      toRiskDto(
        await risksService.update(
          orgContext(c),
          c.req.valid("param").riskId,
          c.req.valid("json"),
        ),
      ),
      200,
    ),
  )
  .openapi(controlsRoute, async (c) => {
    const rows = await risksService.setControls(
      orgContext(c),
      c.req.valid("param").riskId,
      c.req.valid("json").controls,
    );
    return c.json(
      rows.map((x) => ({
        ...x,
        framework: x.framework as "DPDPA_2023" | "AIGIS_BASELINE",
      })),
      200,
    );
  })
  .openapi(acceptRoute, async (c) =>
    c.json(
      toRiskDto(
        await risksService.accept(
          orgContext(c),
          c.req.valid("param").riskId,
          c.req.valid("json"),
        ),
      ),
      200,
    ),
  )
  .openapi(reviewRoute, async (c) =>
    c.json(
      toRiskDto(
        await risksService.review(orgContext(c), c.req.valid("param").riskId),
      ),
      200,
    ),
  )
  .openapi(closeRoute, async (c) =>
    c.json(
      toRiskDto(
        await risksService.close(orgContext(c), c.req.valid("param").riskId),
      ),
      200,
    ),
  )
  .openapi(reopenRoute, async (c) =>
    c.json(
      toRiskDto(
        await risksService.reopen(orgContext(c), c.req.valid("param").riskId),
      ),
      200,
    ),
  )
  .openapi(taskRoute, async (c) =>
    c.json(
      toTaskDto(
        await risksService.addTask(
          orgContext(c),
          c.req.valid("param").riskId,
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  );
