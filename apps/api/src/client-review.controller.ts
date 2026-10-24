import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { RUNTIME_CONFIG, type RuntimeConfig } from "./config.js";
import { IdentityService } from "./identity.service.js";
import { ProjectService } from "./project.service.js";
import { ClientReviewService } from "./client-review.service.js";

const uuid = z.uuid();
const reason = z.string().trim().min(3).max(1000);
const packageCreate = z.object({
  title: z.string().trim().min(1).max(160), reason,
  items: z.array(z.object({ taskId: uuid, expectedTaskVersion: z.number().int().positive(), revisionId: uuid.optional(), workSubmissionId: uuid.optional(), label: z.string().trim().min(1).max(160) }).strict()).min(1).max(100)
}).strict();
const classify = z.object({ category: z.enum(["PREFERENCE_NEW_REQUIREMENT", "EMPLOYEE_WORK_ERROR"]), expectedVersion: z.number().int().positive(), reason }).strict();
const correction = z.object({ ownerEmployeeId: uuid, reason }).strict();
const resume = z.object({ expectedTaskVersion: z.number().int().positive(), reason }).strict();
const complete = z.object({ expectedVersion: z.number().int().positive(), reason }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException("Invalid request");
  return result.data;
}

@Controller("client-reviews")
export class ClientReviewController {
  constructor(
    private readonly identity: IdentityService,
    private readonly projects: ProjectService,
    private readonly reviews: ClientReviewService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig
  ) {}

  private cookie(request: Request) {
    const name = this.config.webOrigin.startsWith("https:") ? "__Host-sense_sid" : "sense_sid";
    const pair = request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
    return pair?.slice(name.length + 1);
  }

  private async actor(request: Request, csrf?: string, mutate = false) {
    if (mutate && request.headers.origin !== this.config.webOrigin) throw new ForbiddenException("Request origin is not allowed");
    const active = await this.identity.session(this.cookie(request));
    const actor = await this.projects.actor(active.row.accountId);
    if (actor.kind === "OWNER" && !(await this.identity.ownerReady(actor.accountId))) throw new ForbiddenException("Owner identity setup is required");
    if (mutate) this.identity.verifyCsrf(active, csrf);
    return actor;
  }

  @Get("projects/:projectId")
  async project(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param("projectId") projectId: string) {
    response.setHeader("Cache-Control", "no-store");
    return this.reviews.projectDetail(await this.actor(request), parse(uuid, projectId));
  }

  @Post("projects/:projectId/packages")
  async createPackage(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.reviews.createPackage(await this.actor(request, csrf, true), parse(uuid, projectId), parse(packageCreate, body));
  }

  @Post("items/:itemId/classification")
  async classify(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.reviews.classify(await this.actor(request, csrf, true), parse(uuid, itemId), parse(classify, body));
  }

  @Post("items/:itemId/correction")
  async assignCorrection(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.reviews.assignCorrection(await this.actor(request, csrf, true), parse(uuid, itemId), parse(correction, body));
  }

  @Post("items/:itemId/resume")
  async resumeCorrection(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.reviews.resumeCorrection(await this.actor(request, csrf, true), parse(uuid, itemId), parse(resume, body));
  }

  @Post("tasks/:taskId/complete")
  async completeTask(@Req() request: Request, @Headers("x-csrf-token") csrf: string | undefined, @Param("taskId") taskId: string, @Body() body: unknown) {
    return this.reviews.completeTask(await this.actor(request, csrf, true), parse(uuid, taskId), parse(complete, body));
  }
}
