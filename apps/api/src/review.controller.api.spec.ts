import { ReviewRoutingService } from "./review-routing.service.js";
import "reflect-metadata";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { jest } from "@jest/globals";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { RUNTIME_CONFIG, type RuntimeConfig } from "./config.js";
import { IdentityService } from "./identity.service.js";
import { ProjectService } from "./project.service.js";
import { ReviewController } from "./review.controller.js";
import { ReviewService } from "./review.service.js";

const accountId = "55555555-5555-4555-8555-555555555555";
const taskId = "22222222-2222-4222-8222-222222222222";
const csrfToken = "review-current-csrf";
const cookie = "sense_sid=review-session";
const origin = "http://localhost:5173";

describe("S13 review HTTP boundary", () => {
  let app: INestApplication;
  let validSession: boolean;
  let identity: Record<string, jest.Mock>;
  let reviews: Record<string, jest.Mock>;

  beforeAll(async () => {
    validSession = true;
    identity = {
      session: jest.fn(async (secret?: string) => {
        if (!validSession || secret !== "review-session") throw new UnauthorizedException("Authentication required");
        return { row: { accountId }, csrfToken };
      }),
      ownerReady: jest.fn(async () => true),
      verifyCsrf: jest.fn((active: { csrfToken: string }, supplied?: string) => {
        if (supplied !== active.csrfToken) throw new ForbiddenException("Request could not be verified");
      })
    };
    reviews = {
      actionable: jest.fn(async () => ({ source: "review", total: 0, items: [], offset: 0, limit: 25 })),
      inbox: jest.fn(async () => ({ tasks: [] })),
      detail: jest.fn(async () => ({ task: { id: taskId } })),
      assignReviewer: jest.fn(async (_actor: unknown, _taskId: string, input: unknown) => input),
      submit: jest.fn(async (_actor: unknown, _taskId: string, input: unknown) => input),
      start: jest.fn(async () => ({ started: true })),
      comment: jest.fn(async (_actor: unknown, _roundId: string, input: unknown) => input),
      decision: jest.fn(async (_actor: unknown, _roundId: string, input: unknown) => input),
      assignCorrection: jest.fn(async (_actor: unknown, _roundId: string, input: unknown) => input),
      complete: jest.fn(async () => ({ completed: true })),
      categories: jest.fn(async () => []),
      createCategory: jest.fn(async (_actor: unknown, input: unknown) => input),
      setCategoryActive: jest.fn(async (_actor: unknown, _id: string, input: unknown) => input),
      escalate: jest.fn(async () => ({ escalated: true })),
      withdraw: jest.fn(async (_actor: unknown, _roundId: string, input: unknown) => input),
      changePriority: jest.fn(async (_actor: unknown, _roundId: string, input: unknown) => input),
      changeDeadline: jest.fn(async (_actor: unknown, _roundId: string, input: unknown) => input)
    };
    const projects = { actor: jest.fn(async () => ({ accountId, organizationId: "44444444-4444-4444-8444-444444444444", kind: "OWNER" as const })) };
    const config: RuntimeConfig = { nodeEnv: "test", port: 4000, databaseUrl: "postgresql://test:test@localhost:5432/test", webOrigin: origin, ownerBootstrapEmail: "owner@example.test", ownerBootstrapSecret: "b".repeat(48) };
    const module = await Test.createTestingModule({ controllers: [ReviewController], providers: [
      { provide: IdentityService, useValue: identity }, { provide: ProjectService, useValue: projects },
      { provide: ReviewService, useValue: reviews }, { provide: ReviewRoutingService, useValue: { configure: jest.fn(async () => ({})), retry: jest.fn(async () => ({})), revoke: jest.fn(async () => ({})) } }, { provide: RUNTIME_CONFIG, useValue: config }
    ] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  beforeEach(() => { validSession = true; jest.clearAllMocks(); });
  afterAll(async () => app.close());

  const write = (path: string, body: object) => request(app.getHttpServer()).post(`/api/v1/reviews/${path}`).set("Cookie", cookie).set("Origin", origin).set("x-csrf-token", csrfToken).send(body);

  it("exposes an independent actionable source with bounded pagination and current-session guards", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/reviews/actionable?offset=3&limit=10").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(reviews.actionable).toHaveBeenCalledWith(expect.objectContaining({ accountId }), 3, 10);
    expect((await request(app.getHttpServer()).get("/api/v1/reviews/actionable?limit=101").set("Cookie", cookie)).status).toBe(400);
    expect(reviews.actionable).toHaveBeenCalledTimes(1);
    validSession = false;
    expect((await request(app.getHttpServer()).get("/api/v1/reviews/actionable").set("Cookie", cookie)).status).toBe(401);
    expect(reviews.actionable).toHaveBeenCalledTimes(1);
  });
  it("requires a live session for reads and origin plus CSRF for mutations", async () => {
    validSession = false;
    expect((await request(app.getHttpServer()).get("/api/v1/reviews/inbox").set("Cookie", cookie)).status).toBe(401);
    validSession = true;
    const noOrigin = await request(app.getHttpServer()).post(`/api/v1/reviews/tasks/${taskId}/submit`).set("Cookie", cookie).set("x-csrf-token", csrfToken).send({ expectedVersion: 1, reason: "Submit work for internal review" });
    const wrongOrigin = await request(app.getHttpServer()).post(`/api/v1/reviews/tasks/${taskId}/submit`).set("Cookie", cookie).set("Origin", "https://attacker.test").set("x-csrf-token", csrfToken).send({ expectedVersion: 1, reason: "Submit work for internal review" });
    const missingCsrf = await request(app.getHttpServer()).post(`/api/v1/reviews/tasks/${taskId}/submit`).set("Cookie", cookie).set("Origin", origin).send({ expectedVersion: 1, reason: "Submit work for internal review" });
    expect([noOrigin.status, wrongOrigin.status, missingCsrf.status]).toEqual([403, 403, 403]);
    expect(reviews.submit).not.toHaveBeenCalled();
  });

  it("validates task and round IDs and strict review command DTOs", async () => {
    const assignment = { employeeId: "66666666-6666-4666-8666-666666666666", expectedVersion: 3, reason: "Assign an authorized reviewer" };
    const assigned = await write(`tasks/${taskId}/reviewer`, assignment);
    const extraAssignment = await write(`tasks/${taskId}/reviewer`, { ...assignment, reviewerAccountId: accountId });
    const badTaskId = await write("tasks/not-a-uuid/submit", { expectedVersion: 1, reason: "Submit work for internal review" });
    const submission = await write(`tasks/${taskId}/submit`, { expectedVersion: 3, revisionId: "77777777-7777-4777-8777-777777777777", reason: "Submit exact revision for review" });
    const zeroVersion = await write(`tasks/${taskId}/submit`, { expectedVersion: 0, reason: "Submit exact revision for review" });
    const invalidAnnotation = await write(`rounds/${taskId}/comment`, { comment: "Clarify this detail", reason: "Record the drawing comment", annotations: [{ page: 1, x: 1.1, y: 0.5, text: "Move note" }] });
    const badRoundId = await write("rounds/not-a-uuid/start", { reason: "Start the assigned review" });
    expect([assigned.status, extraAssignment.status, badTaskId.status, submission.status, zeroVersion.status, invalidAnnotation.status, badRoundId.status]).toEqual([201, 400, 400, 201, 400, 400, 400]);
    expect(reviews.assignReviewer).toHaveBeenCalledTimes(1);
    expect(reviews.assignReviewer).toHaveBeenCalledWith(expect.objectContaining({ accountId, kind: "OWNER" }), taskId, assignment);
    expect(reviews.submit).toHaveBeenCalledTimes(1);
  });

  it("serves authenticated no-store reads and normalizes correction severity", async () => {
    const inbox = await request(app.getHttpServer()).get("/api/v1/reviews/inbox").set("Cookie", cookie);
    const badId = await request(app.getHttpServer()).get("/api/v1/reviews/tasks/not-a-uuid").set("Cookie", cookie);
    const decision = await write(`rounds/${taskId}/decision`, { kind: "CORRECTIONS_REQUIRED", severity: "Major", categoryId: "77777777-7777-4777-8777-777777777777", comment: "Revise the dimension", reason: "Record required drawing corrections", annotations: [{ page: 2, x: 0.25, y: 0.75, text: "Check dimension" }] });
    expect(inbox.status).toBe(200);
    expect(inbox.headers["cache-control"]).toBe("no-store");
    expect(badId.status).toBe(400);
    expect(decision.status).toBe(201);
    expect(reviews.decision).toHaveBeenCalledWith(expect.objectContaining({ accountId }), taskId, expect.objectContaining({ severity: "MAJOR" }));
  });

  it("validates counted inbox pagination without bypassing authentication", async () => {
    reviews.inbox!.mockClear();
    const valid = await request(app.getHttpServer()).get("/api/v1/reviews/inbox?offset=50&limit=25").set("Cookie", cookie);
    expect(valid.status).toBe(200);
    expect(reviews.inbox).toHaveBeenCalledWith(expect.objectContaining({ accountId }), 50, 25, false, {});
    expect((await request(app.getHttpServer()).get("/api/v1/reviews/inbox?personal=true").set("Cookie", cookie)).status).toBe(200);
    expect(reviews.inbox).toHaveBeenCalledWith(expect.objectContaining({ accountId }), 0, 50, true, {});
    reviews.inbox!.mockClear();
    const bad = await request(app.getHttpServer()).get("/api/v1/reviews/inbox?offset=-1&limit=101").set("Cookie", cookie);
    expect(bad.status).toBe(400);
    expect(reviews.inbox).not.toHaveBeenCalled();
  });
  it("forwards additive inbox filters and rejects an invalid queue before service calls", async () => {
    const filtered = await request(app.getHttpServer())
      .get(`/api/v1/reviews/inbox?historical=true&projectId=${taskId}&scope=mine&queue=corrections&q=%20drawing%20&sort=due`)
      .set("Cookie", cookie);
    expect(filtered.status).toBe(200);
    expect(reviews.inbox).toHaveBeenCalledWith(expect.objectContaining({ accountId }), 0, 50, false, {
      historical: true,
      projectId: taskId,
      scope: "mine",
      queue: "corrections",
      q: "drawing",
      sort: "due"
    });

    reviews.inbox!.mockClear();
    const invalidQueue = await request(app.getHttpServer()).get("/api/v1/reviews/inbox?queue=unknown").set("Cookie", cookie);
    expect(invalidQueue.status).toBe(400);
    expect(reviews.inbox).not.toHaveBeenCalled();
  });
  it("validates reasoned escalation, withdrawal, priority and deadline commands strictly", async () => {
    const escalation = { reason: "Escalate this blocked review" };
    const withdrawal = { reason: "Withdraw a superseded review" };
    const priority = { priority: "CRITICAL", expectedVersion: 2, reason: "Raise priority for a major review blocker" };
    const deadline = { committedDueDate: "2026-10-15", expectedVersion: 3, reason: "Adjust committed date for review delay" };
    const results = await Promise.all([
      write(`rounds/${taskId}/escalate`, escalation),
      write(`rounds/${taskId}/withdraw`, withdrawal),
      write(`rounds/${taskId}/priority`, priority),
      write(`rounds/${taskId}/deadline`, deadline),
      write(`rounds/${taskId}/escalate`, { ...escalation, state: "ESCALATED" }),
      write(`rounds/${taskId}/withdraw`, { reason: "x" }),
      write(`rounds/${taskId}/priority`, { ...priority, expectedVersion: 0 }),
      write(`rounds/${taskId}/priority`, { ...priority, priority: "URGENT" }),
      write(`rounds/${taskId}/deadline`, { ...deadline, committedDueDate: "15-10-2026" }),
      write("rounds/not-a-uuid/deadline", deadline)
    ]);
    expect(results.map((response) => response.status)).toEqual([201, 201, 201, 201, 400, 400, 400, 400, 400, 400]);
    expect(reviews.escalate).toHaveBeenCalledWith(expect.objectContaining({ accountId, kind: "OWNER" }), taskId, escalation.reason);
    expect(reviews.withdraw).toHaveBeenCalledWith(expect.objectContaining({ accountId }), taskId, withdrawal);
    expect(reviews.changePriority).toHaveBeenCalledWith(expect.objectContaining({ accountId }), taskId, priority);
    expect(reviews.changeDeadline).toHaveBeenCalledWith(expect.objectContaining({ accountId }), taskId, deadline);
  });

  it("applies origin and CSRF checks to the new review mutations", async () => {
    const paths = [
      { path: `rounds/${taskId}/escalate`, body: { reason: "Escalate blocked review" } },
      { path: `rounds/${taskId}/withdraw`, body: { reason: "Withdraw review request" } },
      { path: `rounds/${taskId}/priority`, body: { priority: "HIGH", expectedVersion: 1, reason: "Raise review priority" } },
      { path: `rounds/${taskId}/deadline`, body: { committedDueDate: "2026-10-15", expectedVersion: 1, reason: "Adjust review deadline" } }
    ];
    for (const item of paths) {
      const noOrigin = await request(app.getHttpServer()).post(`/api/v1/reviews/${item.path}`).set("Cookie", cookie).set("x-csrf-token", csrfToken).send(item.body);
      const noCsrf = await request(app.getHttpServer()).post(`/api/v1/reviews/${item.path}`).set("Cookie", cookie).set("Origin", origin).send(item.body);
      expect([noOrigin.status, noCsrf.status]).toEqual([403, 403]);
    }
    expect(reviews.escalate).not.toHaveBeenCalled();
    expect(reviews.withdraw).not.toHaveBeenCalled();
    expect(reviews.changePriority).not.toHaveBeenCalled();
    expect(reviews.changeDeadline).not.toHaveBeenCalled();
  });
});
