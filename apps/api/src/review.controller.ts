import { ReviewRoutingService } from "./review-routing.service.js";
import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { RUNTIME_CONFIG, type RuntimeConfig } from "./config.js";
import { IdentityService } from "./identity.service.js";
import { ProjectService } from "./project.service.js";
import { ReviewService } from "./review.service.js";

const uuid = z.uuid();
const reason = z.string().trim().min(3).max(1000);
const annotation = z.object({
  page: z.number().int().positive(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  text: z.string().trim().min(1).max(1000)
}).strict();
const annotations = z.array(annotation).max(100).optional();
const assignment = z.object({ employeeId: uuid, expectedVersion: z.number().int().positive(), reason }).strict();
const submit = z.object({
  reason,
  expectedVersion: z.number().int().positive(),
  revisionId: uuid.optional(),
  fileId: uuid.optional(),
  reviewUrl: z.string().max(2048).optional(),
  annotations,
  markupFileId: uuid.optional()
}).strict().refine(value => [value.revisionId, value.fileId, value.reviewUrl].filter(Boolean).length === 1, "Choose one file, drawing revision or review link");
const start = z.object({ reason }).strict();
const comment = z.object({
  comment: z.string().trim().min(1).max(2000),
  reason,
  annotations,
  markupFileId: uuid.optional()
}).strict();
const decision = z.object({
  kind: z.enum(["APPROVED", "CORRECTIONS_REQUIRED"]),
  severity: z.enum(["Minor", "Moderate", "Major", "Critical"]).transform((value) => value.toUpperCase()).optional(),
  categoryId: uuid.optional(),
  comment: z.string().trim().max(2000).optional(),
  reason,
  annotations,
  markupFileId: uuid.optional()
}).strict();
const correctionOwner = z.object({ ownerEmployeeId: uuid, reason }).strict();
const complete = z.object({ expectedVersion: z.number().int().positive(), reason }).strict();
const categoryCreate = z.object({ name: z.string().trim().min(2).max(120), reason }).strict();
const categoryActive = z.object({ active: z.boolean(), reason }).strict();
const roundReason = z.object({ reason }).strict();
const priorityChange = z.object({ priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]), expectedVersion: z.number().int().positive(), reason }).strict();
const deadlineChange = z.object({ committedDueDate: z.iso.date(), expectedVersion: z.number().int().positive(), reason }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException("Invalid request");
  return result.data;
}

@Controller("reviews")
export class ReviewController {
  constructor(
    private readonly identity: IdentityService,
    private readonly projects: ProjectService,
    private readonly reviews: ReviewService,
    private readonly routing: ReviewRoutingService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig
  ) {}

  private cookie(request: Request) {
    const name = this.config.webOrigin.startsWith("https:") ? "__Host-sense_sid" : "sense_sid";
    const pair = request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
    return pair?.slice(name.length + 1);
  }

  private async actor(request: Request) {
    const active = await this.identity.session(this.cookie(request));
    const actor = await this.projects.actor(active.row.accountId);
    if (actor.kind === "OWNER" && !(await this.identity.ownerReady(actor.accountId))) throw new ForbiddenException("Owner identity setup is required");
    return { active, actor };
  }

  private async mutate(request: Request, csrf?: string) {
    if (request.headers.origin !== this.config.webOrigin) throw new ForbiddenException("Request origin is not allowed");
    const result = await this.actor(request);
    this.identity.verifyCsrf(result.active, csrf);
    return result.actor;
  }

  private noStore(response: Response) { response.setHeader("Cache-Control", "no-store"); }

  @Post("tasks/:taskId/routing")
  async configureRouting(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("taskId") taskId: string, @Body() body: unknown) {
    return this.routing.configure(await this.mutate(request, csrf), parse(uuid, taskId), parse(z.object({ expectedVersion: z.number().int().positive(), internal: z.boolean(), client: z.boolean(), reason }).strict(), body));
  }
  @Post("tasks/:taskId/routing/retry")
  async retryRouting(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("taskId") taskId: string) {
    return this.routing.retry(await this.mutate(request, csrf), parse(uuid, taskId));
  }
  @Post("tasks/:taskId/routing/revoke")
  async revokeRouting(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("taskId") taskId: string, @Body() body: unknown) {
    return this.routing.revoke(await this.mutate(request, csrf), parse(uuid, taskId), parse(roundReason, body).reason);
  }
  @Get("projects/:projectId/confirmed-drawings")
  async confirmedDrawings(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param("projectId") projectId: string) {
    this.noStore(response); const { actor } = await this.actor(request);
    return this.reviews.confirmedDrawings(actor, parse(uuid, projectId));
  }

  @Get("actionable")
  async actionable(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Query("offset") offset?: string, @Query("limit") limit?: string) {
    this.noStore(response); const { actor } = await this.actor(request);
    const input = parse(z.object({ offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) }), { offset, limit });
    return this.reviews.actionable(actor, input.offset, input.limit);
  }
  @Get("inbox")
  async inbox(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Query("offset") offset?: string, @Query("limit") limit?: string, @Query("personal") personal?: string, @Query("historical") historical?: string, @Query("projectId") projectId?: string, @Query("scope") scope?: string, @Query("queue") queue?: string, @Query("q") q?: string, @Query("sort") sort?: string) {
    this.noStore(response);
    const page = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse({ offset, limit });
    if (!page.success) throw new BadRequestException("Invalid inbox pagination");
    if (personal !== undefined && personal !== "true" && personal !== "false") throw new BadRequestException("Invalid review scope");
    if (historical !== undefined && historical !== "true" && historical !== "false") throw new BadRequestException("Invalid historical filter");
    if (scope !== undefined && scope !== "mine" && scope !== "accessible") throw new BadRequestException("Invalid review scope");
    if (queue !== undefined && !["waiting", "corrections", "resubmitted", "history"].includes(queue)) throw new BadRequestException("Invalid review queue");
    if (queue !== undefined && !["waiting", "corrections", "resubmitted", "history"].includes(queue)) throw new BadRequestException("Invalid review queue");
    const parsedQ = q === undefined ? undefined : z.string().trim().max(160).safeParse(q);
    if ((parsedQ && !parsedQ.success) || (sort !== undefined && sort !== "project" && sort !== "due")) throw new BadRequestException("Invalid review inbox filters");
    const filters = { ...(historical === "true" ? { historical: true } : {}), ...(projectId ? { projectId: parse(uuid, projectId) } : {}), ...(scope ? { scope: scope as "mine" | "accessible" } : {}), ...(queue ? { queue: queue as "waiting" | "corrections" | "resubmitted" | "history" } : {}), ...(parsedQ?.success && parsedQ.data ? { q: parsedQ.data } : {}), ...(sort ? { sort: sort as "project" | "due" } : {}) };
    return this.reviews.inbox((await this.actor(request)).actor, page.data.offset, page.data.limit, personal === "true", filters);
  }

  @Get("tasks/:taskId")
  async detail(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param("taskId") taskId: string) {
    this.noStore(response);
    return this.reviews.detail((await this.actor(request)).actor, parse(uuid, taskId));
  }

  @Post("tasks/:taskId/reviewer")
  async assignReviewer(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("taskId") taskId: string, @Body() body: unknown) {
    return this.reviews.assignReviewer(await this.mutate(request, csrf), parse(uuid, taskId), parse(assignment, body));
  }

  @Post("tasks/:taskId/submit")
  async submit(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("taskId") taskId: string, @Body() body: unknown) {
    return this.reviews.submit(await this.mutate(request, csrf), parse(uuid, taskId), parse(submit, body));
  }

  @Post("rounds/:roundId/start")
  async start(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("roundId") roundId: string, @Body() body: unknown) {
    return this.reviews.start(await this.mutate(request, csrf), parse(uuid, roundId), parse(start, body).reason);
  }

  @Post("rounds/:roundId/comment")
  async comment(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("roundId") roundId: string, @Body() body: unknown) {
    return this.reviews.comment(await this.mutate(request, csrf), parse(uuid, roundId), parse(comment, body));
  }

  @Post("rounds/:roundId/decision")
  async decision(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("roundId") roundId: string, @Body() body: unknown) {
    return this.reviews.decision(await this.mutate(request, csrf), parse(uuid, roundId), parse(decision, body));
  }

  @Post("rounds/:roundId/correction")
  async assignCorrection(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("roundId") roundId: string, @Body() body: unknown) {
    return this.reviews.assignCorrection(await this.mutate(request, csrf), parse(uuid, roundId), parse(correctionOwner, body));
  }

  @Post("tasks/:taskId/complete")
  async complete(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("taskId") taskId: string, @Body() body: unknown) {
    return this.reviews.complete(await this.mutate(request, csrf), parse(uuid, taskId), parse(complete, body));
  }

  @Get("categories")
  async categories(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.noStore(response);
    return this.reviews.categories((await this.actor(request)).actor);
  }

  @Post("categories")
  async createCategory(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Body() body: unknown) {
    return this.reviews.createCategory(await this.mutate(request, csrf), parse(categoryCreate, body));
  }

  @Post("categories/:categoryId/active")
  async setCategoryActive(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("categoryId") categoryId: string, @Body() body: unknown) {
    return this.reviews.setCategoryActive(await this.mutate(request, csrf), parse(uuid, categoryId), parse(categoryActive, body));
  }

  @Post("rounds/:roundId/escalate")
  async escalate(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("roundId") roundId: string, @Body() body: unknown) {
    return this.reviews.escalate(await this.mutate(request, csrf), parse(uuid, roundId), parse(roundReason, body).reason);
  }

  @Post("rounds/:roundId/withdraw")
  async withdraw(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("roundId") roundId: string, @Body() body: unknown) {
    return this.reviews.withdraw(await this.mutate(request, csrf), parse(uuid, roundId), parse(roundReason, body));
  }

  @Post("rounds/:roundId/priority")
  async changePriority(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("roundId") roundId: string, @Body() body: unknown) {
    return this.reviews.changePriority(await this.mutate(request, csrf), parse(uuid, roundId), parse(priorityChange, body));
  }

  @Post("rounds/:roundId/deadline")
  async changeDeadline(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("roundId") roundId: string, @Body() body: unknown) {
    return this.reviews.changeDeadline(await this.mutate(request, csrf), parse(uuid, roundId), parse(deadlineChange, body));
  }
}
