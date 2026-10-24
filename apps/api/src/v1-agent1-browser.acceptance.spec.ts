import "reflect-metadata";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { MyWorkAttentionResponse } from "@sense/contracts";
import { Test } from "@nestjs/testing";
import type { INestApplication, NestInterceptor } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { tap } from "rxjs";
import express from "express";
import { chromium, expect as expectPage, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { AppModule } from "./app.module.js";
import { RUNTIME_CONFIG, type RuntimeConfig } from "./config.js";
import { DatabaseService } from "./database.service.js";
import { ProjectService, type ProjectActor } from "./project.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { ProjectTemplateService } from "./project-template.service.js";
import { TaskService } from "./task.service.js";
import { ReviewService } from "./review.service.js";
import { DocumentService } from "./document.service.js";
import { AccountKind, PrismaClient, type Prisma } from "./generated/prisma/client.js";
import { AuthorizationService } from "./authorization.service.js";
import { ApprovalService } from "./approval.service.js";
import { loadAgent1BrowserTarget, verifyAgent1BrowserDatabase } from "./v1-agent1-browser-target.js";
import { loadRecoveryTestTarget } from "./recovery-test-target.js";
import { reviewRoutingTestTarget, verifyReviewRoutingTestDatabase } from "./review-routing-test-target.js";

// Operator-only: standard unit/integration/e2e discovery does not match this filename.
// Real session fixtures exercise ordinary guards; passkey/onboarding acceptance is separate.
const root = resolve(process.cwd(), "../..");
const recoveryBrowser = process.env.SENSE_RECOVERY_TEST_MANIFEST ? loadRecoveryTestTarget(process.env, root, "RECOVERY_BROWSER_DATABASE_URL") : undefined;
const reviewBrowser = process.env.SENSE_REVIEW_ROUTING_TEST_RUN ? reviewRoutingTestTarget(root, "S27_PARITY_DATABASE_URL") : undefined;
const base = reviewBrowser ? resolve(reviewBrowser.state.base, "management-browser") : recoveryBrowser ? resolve(dirname(process.env.SENSE_RECOVERY_TEST_MANIFEST!), "agent1-browser") : resolve(root, ".artifacts/v1/20261016-agent1-browser");
function browserTarget() { return reviewBrowser ? { url: reviewBrowser.url, manifest: { storage: resolve(base, "files") } } : loadAgent1BrowserTarget(process.env, root); }
async function verifyBrowserDatabase(client: Prisma.TransactionClient): Promise<void> {
  if (reviewBrowser) await verifyReviewRoutingTestDatabase(client, reviewBrowser);
  else await verifyAgent1BrowserDatabase(client, loadAgent1BrowserTarget(process.env, root).manifest);
}
const apiPort = recoveryBrowser?.target.apiPort ?? 59752, webPort = recoveryBrowser?.target.webPort ?? 59753;
const webOrigin = `http://127.0.0.1:${webPort}`;
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const viewports = [{ width: 1440, height: 900 }, { width: 1024, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }];
const date = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

describe("Agent1 source119 real session/application/browser acceptance", () => {
  let guardDatabase: DatabaseService | undefined, database: DatabaseService, app: INestApplication | undefined;
  let browser: Browser | undefined, web: ChildProcess | undefined;
  const captures: Array<{ viewport: { width: number; height: number }; state: string; noOverflow: boolean; targets: Array<{ height: number; minimum: number }> }> = [];
  const journeys: Array<{ width: number; passed: boolean }> = [];
  const rowGeometry: Array<{ width: number; titleWidth: number; titleOffset: number; mainCoversRow: boolean; actionHeight: number; labelContrast: number }> = [];
  const diagnostics: Array<{ event: string; page: string; detail: string }> = [];
  const serverErrors: Array<{ path: string; name?: string; code?: string; detail: string }> = [];
  let directoryRead: { projects: number; returned: number; queries: number; elapsedMs: number } | undefined;
  beforeAll(async () => {
    const target = browserTarget(); // Must fail before any connection/startup.
    const config: RuntimeConfig = { nodeEnv: "test", databaseUrl: target.url, port: apiPort, webOrigin,
      nasRoot: target.manifest.storage, ownerBootstrapEmail: undefined, ownerBootstrapSecret: undefined };
    guardDatabase = new DatabaseService(config);
    await verifyBrowserDatabase(guardDatabase.prisma);
    for (const port of [apiPort, webPort]) await new Promise<void>((done, reject) => {
      const server = createServer(); server.once("error", reject); server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : done()));
    });
    mkdirSync(resolve(base, "browser"), { recursive: true }); mkdirSync(target.manifest.storage, { recursive: true });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(RUNTIME_CONFIG).useValue(config).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    const observer: NestInterceptor = { intercept(context, next) {
      const path = context.switchToHttp().getRequest<{ url: string }>().url.split("?")[0]!;
      return next.handle().pipe(tap({ error: (error: unknown) => {
        const failure = error as { name?: string; code?: string; meta?: { error?: string }; message?: string; getStatus?: () => number };
        if (failure.getStatus && failure.getStatus() < 500) return;
        const detail = (failure.meta?.error ?? failure.message ?? "Unknown server error").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database URL redacted]").slice(0, 1500);
        serverErrors.push({ path, ...(failure.name ? { name: failure.name } : {}), ...(failure.code ? { code: failure.code } : {}), detail });
      } }));
    } };
    app.useGlobalInterceptors(observer); // Observes errors; preserves ordinary exception handling.
    app.enableCors({ origin: webOrigin, credentials: true }); app.use(express.json({ limit: "1mb" })); app.setGlobalPrefix("api/v1");
    await app.listen(apiPort, "127.0.0.1"); database = app.get(DatabaseService);
    await verifyBrowserDatabase(database.prisma);
    const webLog = createWriteStream(resolve(base, "web.log"), { flags: "a" });
    web = spawn(process.execPath, [resolve(root, "apps/web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
      cwd: resolve(root, "apps/web"), env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    web.stdout?.pipe(webLog, { end: false }); web.stderr?.pipe(webLog, { end: false }); web.once("exit", () => webLog.end());
    web.once("error", () => webLog.end());
    let announced = false; let startup = "";
    web.stdout?.on("data", chunk => { startup = (startup + String(chunk)).slice(-4096); announced ||= startup.includes(`${webOrigin}/`); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (web.exitCode !== null || web.signalCode !== null) throw new Error("Owned Vite exited; inspect its local log");
      try { if (announced) { const result = await fetch(webOrigin); if (result.ok) { ready = true; break; } } } catch { /* still starting this known child */ }
      await new Promise(done => setTimeout(done, 100));
    }
    if (!ready) throw new Error("Owned Vite did not become ready");
    browser = await chromium.launch({ headless: true });
  }, 30000);
  afterAll(async () => {
    const cleanup: Array<{ step: string; milliseconds: number }> = [];
    const close = async (step: string, work: () => Promise<unknown>): Promise<void> => { const start = Date.now(); try { await work(); } finally { cleanup.push({ step, milliseconds: Date.now() - start }); } };
    try { await close("browser", async () => browser?.close()); }
    finally {
      try { await close("web", async () => { if (web && web.exitCode === null && web.signalCode === null) { const stopped = new Promise<void>(done => web!.once("exit", () => done())); web.kill(); await stopped; } }); }
      finally { try { await close("application", async () => app?.close()); } finally { await close("guard connection", async () => guardDatabase?.onModuleDestroy()); } }
    }
    if (existsSync(resolve(base, "browser"))) writeFileSync(resolve(base, "browser/report.json"), JSON.stringify({ classification: "Real PostgreSQL and application controllers with server-validated fixture sessions; no passkey/pilot acceptance", captures, journeys, rowGeometry, directoryRead, diagnostics, serverErrors, cleanup }, null, 2));
  }, 30000);

  async function fixture(width: number) {
    const suffix = randomUUID();
    const result = await database.prisma.$transaction(async tx => {
      const organization = await tx.organization.findFirst() ?? await tx.organization.create({ data: { name: "Agent1 browser acceptance" } });
      const owner = await tx.account.findFirst({ where: { kind: "OWNER", state: "ACTIVE" } }) ?? await tx.account.create({ data: { kind: "OWNER", state: "ACTIVE", normalizedEmail: "agent1-browser-owner@example.test" } });
      if (await tx.passkeyCredential.count({ where: { accountId: owner.id } }) === 0) {
        for (let index = 0; index < 2; index++) await tx.passkeyCredential.create({ data: { accountId: owner.id, credentialId: randomUUID(), publicKey: randomBytes(32) } });
        await tx.ownerRecoveryCode.create({ data: { accountId: owner.id, codeHash: hash(randomUUID()), acknowledgedAt: new Date() } });
      }
      const branch = await tx.branch.create({ data: { organizationId: organization.id, name: `Browser ${width} ${suffix}` } });
      const team = await tx.team.create({ data: { organizationId: organization.id, branchId: branch.id, name: "Delivery" } });
      const people = [];
      for (const key of ["worker", "reviewer", "outsider"]) {
        const account = await tx.account.create({ data: { kind: "STAFF", state: "ACTIVE", normalizedEmail: `${key}-${suffix}@example.test` } });
        const employee = await tx.employee.create({ data: { organizationId: organization.id, accountId: account.id, homeBranchId: branch.id, homeTeamId: team.id, hiredAt: new Date("2026-01-01") } });
        if (key !== "outsider") for (const permissionKey of ["project.view", "document.view", ...(key === "reviewer" ? ["project.manage", "review.decide"] : [])]) {
          await tx.employeePermissionOverride.create({ data: { organizationId: organization.id, employeeId: employee.id, permissionKey, effect: "ALLOW", scopeKind: "BRANCH", branchId: branch.id, reason: "Explicit scoped browser fixture grant" } });
        }
        const secret = randomBytes(32).toString("base64url"), csrf = createHmac("sha256", secret).update("csrf").digest("base64url");
        const session = await tx.session.create({ data: { accountId: account.id, tokenHash: hash(secret), csrfTokenHash: hash(csrf), expiresAt: new Date(Date.now() + 3600000) } });
        people.push({ key, account, employee, secret, csrf, session });
      }
      const secret = randomBytes(32).toString("base64url"), csrf = createHmac("sha256", secret).update("csrf").digest("base64url");
      await tx.session.create({ data: { accountId: owner.id, tokenHash: hash(secret), csrfTokenHash: hash(csrf), expiresAt: new Date(Date.now() + 3600000) } });
      return { organization, owner, branch, people, ownerSession: { secret, csrf } };
    });
    const actor: ProjectActor = { kind: AccountKind.OWNER, accountId: result.owner.id, organizationId: result.organization.id };
    const template = (await app!.get(ProjectTemplateService).create(actor, { name: `Lifecycle ${suffix}`, reason: "Canonical required-gate acceptance baseline", definition: {
      deliveryType: "DESIGN", scopes: ["Design"], stages: [{ key: "DELIVERY", label: "Delivery" }],
      milestones: [{ key: "RELEASE", label: "Release gate", stageKey: "DELIVERY", required: true }], folders: [],
    } })).template;
    const category = await app!.get(ReviewService).createCategory(actor, { name: `Browser correction ${suffix}`, reason: "Canonical correction classification fixture" });
    const worker = result.people[0]!, reviewer = result.people[1]!, outsider = result.people[2]!;
    const workerActor: ProjectActor = { ...actor, kind: AccountKind.STAFF, accountId: worker.account.id };
    const project = (await app!.get(ProjectService).create(actor, { branchId: result.branch.id, title: `Browser project ${width} ${suffix}`, deliveryType: "DESIGN", scopes: ["Design"], reason: "Canonical browser project fixture" })).project;
    const workflow = app!.get(ProjectWorkflowService), tasks = app!.get(TaskService);
    for (const person of [worker, reviewer]) {
      const current = await database.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      await workflow.assignment(actor, project.id, { employeeId: person.employee.id, expectedVersion: current.version, reason: "Explicit fixture project assignment" });
    }
    let current = await database.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    await workflow.lead(actor, project.id, { employeeId: reviewer.employee.id, expectedVersion: current.version, reason: "Appoint fixture lead through ordinary service" });
    current = await database.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    await workflow.status(actor, project.id, { toStatus: "ACTIVE", expectedVersion: current.version, reason: "Activate canonical fixture project" });
    const privateTask = await tasks.create({ ...workerActor, accountId: outsider.account.id }, { title: `Private outsider ${suffix}`, type: "NON_PROJECT", priority: "LOW", targetDate: date, reason: "Private task scope control" });
    const shared = await tasks.create(actor, { title: `Shared ${suffix}`, type: "PROJECT", projectId: project.id, ownerEmployeeId: worker.employee.id, collaborators: [{ employeeId: reviewer.employee.id }], priority: "HIGH", targetDate: date, reason: "Canonical collaborator filter fixture" });
    const reviewTask = await tasks.create(actor, { title: `Review package ${suffix}`, type: "PROJECT", projectId: project.id, ownerEmployeeId: worker.employee.id, priority: "HIGH", targetDate: date, reviewRequirement: "INTERNAL", reason: "Canonical review fixture" });
    const reviews = app!.get(ReviewService);
    await reviews.assignReviewer(actor, reviewTask.id, { employeeId: reviewer.employee.id, expectedVersion: reviewTask.version, reason: "Explicit eligible fixture reviewer" });
    let reviewCurrent = await database.prisma.task.findUniqueOrThrow({ where: { id: reviewTask.id } });
    await tasks.transition(workerActor, reviewTask.id, { toState: "IN_PROGRESS", expectedVersion: reviewCurrent.version, reason: "Begin fixture design work" });
    reviewCurrent = await database.prisma.task.findUniqueOrThrow({ where: { id: reviewTask.id } });
    await reviews.submit(workerActor, reviewTask.id, { expectedVersion: reviewCurrent.version, reviewUrl: `https://files.sensestudios.com/acceptance/${reviewTask.id}`, reason: "Submit exact fixture link evidence for internal review" });
    const round = await database.prisma.reviewRound.findFirstOrThrow({ where: { taskId: reviewTask.id } });
    const documents = app!.get(DocumentService);
    const folder = await documents.createFolder(actor, project.id, { name: `Evidence ${width}`, confidential: false, reason: "Own isolated browser file fixture" });
    expect(folder.provisionState).toBe("READY");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=", "base64");
    const upload = await documents.startUpload(actor, project.id, { folderId: folder.id, fileName: "project-proof.png", mimeType: "image/png", sizeBytes: bytes.length, confidential: false, viewOnly: false, reason: "Upload isolated evidence through owning workflow" });
    await documents.writeChunk(actor, upload.uploadId, 0, bytes, hash(bytes)); await documents.finalize(actor, upload.uploadId);
    return { ...result, actor, workerActor, worker, reviewer, outsider, project, privateTask, shared, reviewTask, round, workflow, templateVersionId: template.versions[0]!.id, category };
  }
  async function context(secret: string, viewport: { width: number; height: number }): Promise<BrowserContext> {
    const value = await browser!.newContext({ baseURL: webOrigin, viewport });
    value.setDefaultTimeout(10000); value.setDefaultNavigationTimeout(20000);
    value.on("page", page => {
      const record = (event: string, detail: string): void => { diagnostics.push({ event, page: new URL(page.url() || webOrigin).pathname, detail: detail.slice(0, 2000) }); };
      page.on("console", message => { if (message.type() === "error") record("console", message.text()); });
      page.on("pageerror", error => record("pageerror", error.message)); page.on("crash", () => record("crash", "Renderer crashed"));
      page.on("requestfailed", request => record("requestfailed", `${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ""}`));
      page.on("response", response => { if (response.status() >= 400) record("http", `${response.status()} ${new URL(response.url()).pathname}`); });
    });
    await value.addCookies([{ name: "sense_sid", value: secret, url: webOrigin, httpOnly: true, sameSite: "Strict" }]);
    await value.route("**/*", route => new URL(route.request().url()).origin === webOrigin ? route.continue() : route.abort());
    return value;
  }
  async function capture(page: Page, viewport: { width: number; height: number }, state: string): Promise<void> {
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    // Shared shell must select one navigation mode on every authenticated page.
    if (await page.locator(".workspace-mobile-nav").count()) {
      expect(await page.locator(".workspace-mobile-nav").isVisible()).toBe(viewport.width < 768);
      expect(await page.locator(".workspace-sidebar").isVisible()).toBe(viewport.width >= 768);
    }
    if (state.startsWith("v10-")) {
      const queueContentsFit = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".dv-attention-queue .dv-attention-row > *, .dv-attention-queue .dv-attention-foot > *, .dv-attention-actions a, .dv-attention-actions button")]
        .every(element => {
          const card = element.closest(".dv-attention-queue");
          if (!card) return false;
          const bounds = element.getBoundingClientRect(), parent = card.getBoundingClientRect();
          return bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1;
        }));
      expect(queueContentsFit).toBe(true);
    }
    const targets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-task-creation-recovery], .task-form button[type="submit"], .project-section-nav button, .project-resource-summary :is(a, button), .project-section-links a, .my-work-review-inbox-link, .my-work-decisions-link, .actionable-work__header button, .actionable-work__controls :is(button, select), .actionable-work > nav a, .actionable-work__pager button, .actionable-work__row > :is(a, button)')]
      .filter(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
      .map(element => ({ height: element.getBoundingClientRect().height, minimum: element.closest(".project-section-nav") && innerWidth > 760 ? 40 : 44 })));
    await page.screenshot({ path: resolve(base, `browser/${viewport.width}-${state}.png`), fullPage: true });
    await page.screenshot({ path: resolve(base, `browser/${viewport.width}-${state}-viewport.png`) });
    captures.push({ viewport, state, noOverflow, targets }); expect(noOverflow).toBe(true); expect(targets.every(target => target.height >= target.minimum)).toBe(true);
  }
  async function fillTask(form: Locator, title: string): Promise<void> {
    await form.getByLabel("Task name", { exact: true }).fill(title); await form.getByLabel("Target date", { exact: true }).fill(date);
    await form.getByLabel("Reason", { exact: true }).fill("Record verified browser acceptance work");
  }
  async function lifecycle(ownerPage: Page, workerPage: Page, f: Awaited<ReturnType<typeof fixture>>, projectId: string, viewport: { width: number; height: number }): Promise<void> {
    const ownerHeaders = { Origin: webOrigin, "X-CSRF-Token": f.ownerSession.csrf }, workerHeaders = { Origin: webOrigin, "X-CSRF-Token": f.worker.csrf };
    const projectNow = () => database.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const projectCommand = async (path: string, button: string, expected = 201): Promise<void> => {
      await ownerPage.getByLabel("Project action reason", { exact: true }).fill("Record isolated lifecycle acceptance");
      const response = ownerPage.waitForResponse(value => new URL(value.url()).pathname === `/api/v1/projects/${projectId}${path}` && value.request().method() === "POST");
      await ownerPage.getByRole("button", { name: button, exact: true }).click(); expect((await response).status()).toBe(expected);
    };
    const status = async (value: string, expected = 201): Promise<void> => {
      await ownerPage.locator(".project-section-nav").getByRole("button", { name: "Overview", exact: true }).click();
      await ownerPage.getByLabel("New project status", { exact: true }).selectOption(value); await projectCommand("/status", "Change status", expected);
      if (expected === 201) await expectPage(ownerPage.locator(".project-detail-heading .project-status-pill")).toHaveText(value);
    };
    await status("ACTIVE", 409); // No lead: activation must not invent an accountable person.
    expect((await projectNow()).status).toBe("DRAFT");
    await ownerPage.locator(".project-section-nav").getByRole("button", { name: "People", exact: true }).click();
    for (const person of [f.worker, f.reviewer]) {
      await ownerPage.getByRole("combobox", { name: "Contributor", exact: true }).selectOption(person.employee.id);
      await projectCommand("/assignments", "Assign contributor");
      await expectPage(ownerPage.locator(".project-section-panel:not([hidden]) .project-history li").filter({ hasText: person.account.normalizedEmail })).toBeVisible();
    }
    await ownerPage.getByRole("combobox", { name: "Project lead", exact: true }).selectOption(f.reviewer.employee.id); await projectCommand("/lead", "Set lead");
    await status("ACTIVE");
    const create = await ownerPage.request.post("/api/v1/tasks", { headers: ownerHeaders, data: { title: `Lifecycle review ${randomUUID()}`, type: "PROJECT", projectId, ownerEmployeeId: f.worker.employee.id, priority: "HIGH", targetDate: date, reviewRequirement: "INTERNAL", reason: "Create lifecycle delivery work using canonical API", idempotencyKey: randomUUID() } });
    expect(create.status()).toBe(201); const task = await create.json() as { id: string; version: number };
    expect((await ownerPage.request.post(`/api/v1/reviews/tasks/${task.id}/reviewer`, { headers: ownerHeaders, data: { employeeId: f.reviewer.employee.id, expectedVersion: task.version, reason: "Appoint independent review participant" } })).status()).toBe(201);
    let current = await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect((await workerPage.request.post(`/api/v1/tasks/${task.id}/state`, { headers: workerHeaders, data: { toState: "IN_PROGRESS", expectedVersion: current.version, reason: "Begin lifecycle delivery work" } })).status()).toBe(201);
    const reviewForm = (page: Page, button: string): Locator => page.locator("form").filter({ has: page.getByRole("button", { name: button, exact: true }) });
    const reviewCommand = async (page: Page, button: string, path: string): Promise<void> => {
      const form = reviewForm(page, button); await form.getByLabel(/^(Reason|Submission reason|Decision reason)$/).fill("Record canonical lifecycle review action");
      const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/v1/reviews${path}` && value.request().method() === "POST");
      await form.getByRole("button", { name: button, exact: true }).click(); expect((await response).status()).toBe(201);
    };
    await workerPage.goto(`/reviews?taskId=${task.id}`); await reviewCommand(workerPage, "Submit for review", `/tasks/${task.id}/submit`);
    const first = await database.prisma.reviewRound.findFirstOrThrow({ where: { taskId: task.id } });
    const snapshot = await database.prisma.reviewSubmission.findUniqueOrThrow({ where: { id: first.submissionId } });
    const reviewerContext = await context(f.reviewer.secret, viewport), reviewerPage = await reviewerContext.newPage();
    try {
      const attentionResponse = await reviewerPage.request.get(`/api/v1/my-work/attention?projectId=${f.project.id}&source=all&limit=100`);
      expect(attentionResponse.status()).toBe(200); const attention = await attentionResponse.json() as MyWorkAttentionResponse;
      expect(attention.sourceCounts.review).toEqual({ status: "ready", total: 1 });
      expect(attention.items.filter(item => item.source === "review").map(item => item.roundId)).toEqual([f.round.id]);
      const tasksOnlyResponse = await reviewerPage.request.get(`/api/v1/my-work/attention?projectId=${f.project.id}&priorities=HIGH&limit=100`);
      expect(tasksOnlyResponse.status()).toBe(200); const tasksOnly = await tasksOnlyResponse.json() as MyWorkAttentionResponse;
      expect(tasksOnly.source).toBe("task"); expect(tasksOnly.sourceCounts.review).toEqual({ status: "excluded" }); expect(tasksOnly.sourceCounts.approval).toEqual({ status: "excluded" });
      expect(tasksOnly.items.every(item => item.source === "task")).toBe(true);
      await reviewerPage.goto(`/my-work?projectId=${f.project.id}&workPhase=attention`);
      const obligation = reviewerPage.locator(".actionable-work").getByRole("link", { name: new RegExp(f.reviewTask.title) });
      await expectPage(obligation).toBeVisible(); await capture(reviewerPage, viewport, "assigned-review-obligation");
      await obligation.click(); await expectPage(reviewerPage.getByRole("heading", { name: f.reviewTask.title, exact: true })).toBeVisible();
      expect(new URL(reviewerPage.url()).searchParams.get("roundId")).toBe(f.round.id);
      await reviewerPage.goto(`/reviews?taskId=${task.id}&roundId=${first.id}`); await reviewCommand(reviewerPage, "Start review", `/rounds/${first.id}/start`);
      const decision = reviewForm(reviewerPage, "Save decision"); await decision.getByRole("combobox", { name: "Decision", exact: true }).selectOption("CORRECTIONS_REQUIRED");
      await decision.getByLabel("Decision comment", { exact: true }).fill("Correct the delivery package before acceptance");
      await decision.getByRole("combobox", { name: "Category", exact: true }).selectOption(f.category.id); await reviewCommand(reviewerPage, "Save decision", `/rounds/${first.id}/decision`);
      await ownerPage.goto(`/reviews?taskId=${task.id}&roundId=${first.id}`);
      await reviewForm(ownerPage, "Create correction task").getByRole("combobox", { name: "Correction owner", exact: true }).selectOption(f.worker.employee.id);
      await reviewCommand(ownerPage, "Create correction task", `/rounds/${first.id}/correction`);
      const correctedRound = await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: first.id } }); expect(correctedRound.correctionTaskId).toBeTruthy();
      current = await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect((await workerPage.request.post(`/api/v1/reviews/tasks/${task.id}/submit`, { headers: workerHeaders, data: { expectedVersion: current.version, reason: "Unfinished correction must block resubmission" } })).status()).toBe(409);
      for (const toState of ["IN_PROGRESS", "COMPLETED"]) {
        const correction = await database.prisma.task.findUniqueOrThrow({ where: { id: correctedRound.correctionTaskId! } });
        expect((await workerPage.request.post(`/api/v1/tasks/${correction.id}/state`, { headers: workerHeaders, data: { toState, expectedVersion: correction.version, reason: "Perform assigned correction through canonical task workflow" } })).status()).toBe(201);
      }
      await workerPage.goto(`/reviews?taskId=${task.id}`); await reviewCommand(workerPage, "Submit for review", `/tasks/${task.id}/submit`);
      const secondSubmission = await database.prisma.reviewSubmission.findUniqueOrThrow({ where: { taskId_roundNumber: { taskId: task.id, roundNumber: 2 } } });
      const second = await database.prisma.reviewRound.findUniqueOrThrow({ where: { submissionId: secondSubmission.id } }); expect(second.id).not.toBe(first.id);
      await reviewerPage.goto(`/reviews?taskId=${task.id}&roundId=${second.id}`); await reviewCommand(reviewerPage, "Start review", `/rounds/${second.id}/start`);
      await reviewForm(reviewerPage, "Save decision").getByLabel("Decision comment", { exact: true }).fill("Corrections independently verified");
      await reviewCommand(reviewerPage, "Save decision", `/rounds/${second.id}/decision`);
      await workerPage.goto(`/reviews?taskId=${task.id}`); await reviewCommand(workerPage, "Complete task", `/tasks/${task.id}/complete`);
      await expectPage(workerPage.getByText("Task completed.", { exact: true })).toBeVisible();
      await expectPage(workerPage.locator(".review-detail-heading p")).toContainText("COMPLETED");
      await workerPage.locator(".review-detail-heading").scrollIntoViewIfNeeded();
      expect((await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("COMPLETED");
      expect((await database.prisma.reviewSubmission.findUniqueOrThrow({ where: { id: first.submissionId } })).taskSnapshot).toEqual(snapshot.taskSnapshot);
      expect((await database.prisma.reviewRound.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("CORRECTIONS_REQUIRED");
      expect(await database.prisma.reviewRound.count({ where: { taskId: task.id } })).toBe(2);
      await capture(workerPage, viewport, "completed-correction-review");
    } finally { await reviewerContext.close(); }
    await ownerPage.goto(`/projects?projectId=${projectId}`); await status("COMPLETED", 409);
    expect((await projectNow()).status).toBe("ACTIVE");
    const heldCreate = await ownerPage.request.post("/api/v1/tasks", { headers: ownerHeaders, data: { title: `Hold control ${randomUUID()}`, type: "PROJECT", projectId, ownerEmployeeId: f.worker.employee.id, priority: "LOW", targetDate: date, reason: "Verify hold blocks otherwise ordinary task progress" } });
    expect(heldCreate.status()).toBe(201); const heldTask = await heldCreate.json() as { id: string; version: number };
    await status("ON_HOLD");
    expect((await workerPage.request.post(`/api/v1/tasks/${heldTask.id}/state`, { headers: workerHeaders, data: { toState: "IN_PROGRESS", expectedVersion: heldTask.version, reason: "Held project refuses ordinary task progress" } })).status()).toBe(409);
    expect((await database.prisma.task.findUniqueOrThrow({ where: { id: heldTask.id } })).status).toBe("NOT_STARTED");
    await capture(ownerPage, viewport, "held-project"); await status("ACTIVE");
    for (const toState of ["IN_PROGRESS", "COMPLETED"]) {
      const heldCurrent = await database.prisma.task.findUniqueOrThrow({ where: { id: heldTask.id } });
      expect((await workerPage.request.post(`/api/v1/tasks/${heldTask.id}/state`, { headers: workerHeaders, data: { toState, expectedVersion: heldCurrent.version, reason: "Resumed project accepts ordinary task progress" } })).status()).toBe(201);
    }
    await status("ARCHIVED", 409);
    await ownerPage.locator(".project-section-nav").getByRole("button", { name: "Plan", exact: true }).click();
    await ownerPage.getByLabel("Reason for plan update", { exact: true }).fill("Required delivery milestone verified after corrected work");
    const milestone = ownerPage.locator(".project-plan-items li").filter({ hasText: "Release gate" });
    const completed = ownerPage.waitForResponse(value => /\/plan-items\/[^/]+\/complete$/.test(new URL(value.url()).pathname) && value.request().method() === "POST");
    await milestone.getByRole("button", { name: "Mark complete", exact: true }).click(); expect((await completed).status()).toBe(201);
    await expectPage(milestone.getByText("Complete", { exact: true })).toBeVisible();
    await status("COMPLETED"); await status("ARCHIVED");
    await expectPage(ownerPage.getByText("This project is closed. Its delivery history is retained. Approved closeout work is managed in Tasks.", { exact: true })).toBeVisible();
    const archived = await projectNow();
    expect((await ownerPage.request.post(`/api/v1/projects/${projectId}/status`, { headers: ownerHeaders, data: { toStatus: "ACTIVE", expectedVersion: archived.version, reason: "Archived project cannot be reopened" } })).status()).toBe(409);
    expect(await database.prisma.projectGateOverride.count({ where: { projectId } })).toBe(0);
    expect(await database.prisma.projectPlanCompletion.count({ where: { item: { projectId, kind: "MILESTONE", required: true } } })).toBe(1);
    expect(await database.prisma.reviewRound.count({ where: { taskId: task.id } })).toBe(2);
    await capture(ownerPage, viewport, "archived-project");
  }
  it("accepts My Work management scopes for Owner and authorized Leader with employee isolation", async () => {
    const f = await fixture(1023);
    const task = await app!.get(TaskService).create(f.workerActor, { title: `Scoped personal work ${randomUUID()}`, type: "NON_PROJECT", priority: "HIGH", targetDate: date, reason: "My Work real management scope acceptance" });
    const account = await database.prisma.account.create({ data: { kind: "STAFF", state: "ACTIVE", normalizedEmail: `management-leader-${randomUUID()}@example.test` } });
    const employee = await database.prisma.employee.create({ data: { accountId: account.id, organizationId: f.organization.id, homeBranchId: f.branch.id, homeTeamId: f.worker.employee.homeTeamId, hiredAt: new Date("2026-01-01") } });
    await database.prisma.employee.update({ where: { id: f.worker.employee.id }, data: { reportsToId: employee.id } });
    await database.prisma.employeePermissionOverride.create({ data: { organizationId: f.organization.id, employeeId: employee.id, permissionKey: "task.assign", effect: "ALLOW", scopeKind: "TEAM", branchId: f.branch.id, teamId: employee.homeTeamId, reason: "Explicit current reporting-tree management grant" } });
    const secret = randomBytes(32).toString("base64url"), csrf = createHmac("sha256", secret).update("csrf").digest("base64url");
    await database.prisma.session.create({ data: { accountId: account.id, tokenHash: hash(secret), csrfTokenHash: hash(csrf), expiresAt: new Date(Date.now() + 3600000) } });
    for (const identity of [{ key: "owner", secret: f.ownerSession.secret }, { key: "leader", secret }, { key: "employee", secret: f.worker.secret }]) {
      const session = await context(identity.secret, viewports[0]!); const page = await session.newPage();
      try {
        await page.goto("/my-work?scope=personal&phase=active");
        if (identity.key !== "employee") {
          await page.getByRole("button", { name: "All teams", exact: true }).click();
          await page.getByRole("combobox", { name: "Work team", exact: true }).selectOption(employee.homeTeamId);
          await page.getByRole("combobox", { name: "Work employee", exact: true }).selectOption(f.worker.employee.id);
          await expectPage(page.locator(".my-work-demo-row").filter({ hasText: task.title })).toBeVisible();
          await expectPage(page.locator(".my-work-group-head").filter({ hasText: "Today" })).toHaveCount(0);
          expect(new URL(page.url()).searchParams.get("scope")).toBe("all");
          expect(new URL(page.url()).searchParams.get("ownerEmployeeId")).toBe(f.worker.employee.id);
        } else {
          await expectPage(page.locator(".my-work-demo-row").filter({ hasText: task.title })).toBeVisible();
          await expectPage(page.getByRole("button", { name: "All teams", exact: true })).toHaveCount(0);
        }
        for (const viewport of [...viewports, { width: 783, height: 884 }]) { await page.setViewportSize(viewport); await capture(page, viewport, `management-${identity.key}-drilldown`); }
        if (identity.key !== "employee") {
          await page.getByRole("button", { name: "My Work", exact: true }).click();
          await expectPage(page.getByRole("combobox", { name: "Work team", exact: true })).toHaveCount(0);
          expect(new URL(page.url()).searchParams.has("ownerEmployeeId")).toBe(false);
        }
      } finally { await session.close(); }
    }
    expect(serverErrors).toEqual([]); expect(diagnostics.filter(row => row.event === "pageerror")).toEqual([]);
  }, 120000);
  it("accepts V10 Dashboard for six real account contexts at four widths with retained customization and timer persistence", async () => {
    const f = await fixture(1010);
    const timerTask = await app!.get(TaskService).create(f.workerActor, { title: `V10 internal time task ${randomUUID()}`, type: "NON_PROJECT", priority: "LOW", targetDate: date, reason: "Verify existing non-project task time contract" });
    const createPerson = async (key: string, branchId = f.branch.id, teamId = f.worker.employee.homeTeamId) => {
      const account = await database.prisma.account.create({ data: { kind: "STAFF", state: "ACTIVE", normalizedEmail: `${key}-${randomUUID()}@example.test` } });
      const employee = await database.prisma.employee.create({ data: { accountId: account.id, organizationId: f.organization.id, homeBranchId: branchId, homeTeamId: teamId, hiredAt: new Date("2026-01-01") } });
      const secret = randomBytes(32).toString("base64url"), csrf = createHmac("sha256", secret).update("csrf").digest("base64url");
      await database.prisma.session.create({ data: { accountId: account.id, tokenHash: hash(secret), csrfTokenHash: hash(csrf), expiresAt: new Date(Date.now() + 3600000) } });
      return { account, employee, secret, csrf };
    };
    const leader = await createPerson("v10-leader"), site = await createPerson("v10-site");
    await database.prisma.employee.update({ where: { id: f.worker.employee.id }, data: { reportsToId: leader.employee.id } });
    await database.prisma.employeePermissionOverride.create({ data: { organizationId: f.organization.id, employeeId: leader.employee.id, permissionKey: "task.assign", effect: "ALLOW", scopeKind: "TEAM", branchId: f.branch.id, teamId: leader.employee.homeTeamId, reason: "Explicit reporting-tree management for My Work scope acceptance" } });
    await database.prisma.employeePermissionOverride.create({ data: { organizationId: f.organization.id, employeeId: leader.employee.id, permissionKey: "performance.manage", effect: "ALLOW", scopeKind: "TEAM", branchId: f.branch.id, teamId: leader.employee.homeTeamId, reason: "Explicit scoped V10 Team Leader fixture" } });
    const otherBranch = await database.prisma.branch.create({ data: { organizationId: f.organization.id, name: `V10 other ${randomUUID()}` } });
    const otherTeam = await database.prisma.team.create({ data: { organizationId: f.organization.id, branchId: otherBranch.id, name: "Other team" } });
    const cross = await createPerson("v10-cross", otherBranch.id, otherTeam.id);
    const siteProject = (await app!.get(ProjectService).create(f.actor, { branchId: f.branch.id, title: `V10 site ${randomUUID()}`, deliveryType: "TURNKEY", scopes: ["Site delivery"], reason: "V10 authorized site source fixture" })).project;
    for (const [person, projectId, permissions] of [[site, siteProject.id, ["project.view", "site.view"]], [cross, f.project.id, ["project.view"]]] as const) {
      for (const permissionKey of permissions) await database.prisma.employeePermissionOverride.create({ data: { organizationId: f.organization.id, employeeId: person.employee.id, permissionKey, effect: "ALLOW", ...(person.employee.homeBranchId === f.branch.id ? { scopeKind: "BRANCH", branchId: f.branch.id } as const : { scopeKind: "ORGANIZATION" } as const), reason: "Explicit V10 project source access; cross-branch project assignment remains required" } });
      const current = await database.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      await f.workflow.assignment(f.actor, projectId, { employeeId: person.employee.id, expectedVersion: current.version, reason: "Explicit V10 account project assignment" });
    }
    const identities = [{ key: "owner", secret: f.ownerSession.secret }, { key: "leader", secret: leader.secret }, { key: "employee", secret: f.worker.secret }, { key: "site", secret: site.secret }, { key: "reviewer", secret: f.reviewer.secret }, { key: "cross-branch", secret: cross.secret }];
    const contextFailures: Array<{ context: string; message: string }> = [];
    for (const identity of identities) {
      const session = await context(identity.secret, viewports[0]!);
      const page = await session.newPage();
      const scoreReads: string[] = [];
      page.on("request", request => { if (/\/performance\/employees\//.test(request.url())) scoreReads.push(request.url()); });
      try {
        if (identity.key === "owner" || identity.key === "leader") {
          await page.goto("/my-work?scope=personal&phase=active");
          await page.getByRole("button", { name: "All teams", exact: true }).click();
          await expectPage(page.getByRole("combobox", { name: "Work team", exact: true })).toBeVisible();
          await page.getByRole("combobox", { name: "Work team", exact: true }).selectOption(f.worker.employee.homeTeamId);
          await page.getByRole("combobox", { name: "Work employee", exact: true }).selectOption(f.worker.employee.id);
          await expectPage(page.locator(".my-work-queue-heading")).toContainText(identity.key === "owner" ? "Organization queue" : "Authorized team queue");
          await expectPage(page.locator(".my-work-demo-row").first()).toBeVisible();
          for (const viewport of [...viewports, { width: 783, height: 884 }]) {
            await page.setViewportSize(viewport);
            await capture(page, viewport, `management-${identity.key}-drilldown`);
          }
          await page.getByRole("button", { name: "My Work", exact: true }).click();
          await expectPage(page.getByRole("combobox", { name: "Work team", exact: true })).toHaveCount(0);
        }
        await page.setViewportSize(viewports[0]!);
        await page.goto("/dashboard");
        await expectPage(page.locator(".dv-summary-card")).toHaveCount(5);
        await expectPage(page.locator(".dv-widget").filter({ has: page.getByRole("heading", { name: "Time tracking", exact: true }) })).toBeVisible();
        await expectPage(page.getByText(/Task source read at/)).toBeVisible();
        await expectPage(page.locator(".dv-summary-count").first()).toBeVisible();
        if (identity.key === "owner") { await expectPage(page.getByText(/no employee record/)).toBeVisible(); await expectPage(page.getByRole("button", { name: "Start timer", exact: true })).toHaveCount(0); }
        if (identity.key === "leader") { await expectPage(page.getByRole("heading", { name: "Performance", exact: true })).toBeVisible(); await expectPage(page.getByRole("button", { name: "Teams", exact: true })).toHaveCount(0); const selection = page.getByRole("combobox", { name: /^Employee/ }); await expectPage(selection.locator("option")).toHaveCount(2); await expectPage(selection).toHaveValue(f.worker.employee.id); }
        if (identity.key === "site") await expectPage(page.getByRole("heading", { name: "Site delivery", exact: true })).toBeVisible();
        if (identity.key === "reviewer") await expectPage(page.locator(".dv-review-rounds")).toContainText(f.reviewTask.title);
        if (identity.key !== "owner") await expectPage(page.locator(".dv-attention-queue")).not.toContainText(f.privateTask.title);
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await expectPage(page.locator(".dv-widget-grid")).toBeVisible();
          await capture(page, viewport, `v10-${identity.key}`);
          expect(await page.locator(".workspace-mobile-nav").isVisible()).toBe(viewport.width < 768);
          expect(await page.locator(".dv-attention-body > a").count()).toBeLessThanOrEqual(2);
          expect(await page.locator(".dashboard-overview-grid").count()).toBe(0);
        }
        if (!["owner", "leader"].includes(identity.key)) expect(scoreReads).toEqual([]);
        if (identity.key === "employee") {
          await page.getByPlaceholder("What are you working on?").fill("V10 real persisted timer");
          await page.getByRole("combobox", { name: /^Task/ }).selectOption(timerTask.id);
          await page.getByLabel("Non-project activity", { exact: true }).fill("V10 internal coordination");
          const started = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/time/timers" && r.request().method() === "POST");
          await page.getByRole("button", { name: "Start timer", exact: true }).click(); expect((await started).status()).toBe(201);
          await expectPage(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
          await page.reload(); await expectPage(page.getByText(/V10 real persisted timer/)).toBeVisible();
          await page.getByRole("button", { name: "Pause", exact: true }).click();
          await expectPage(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Resume", exact: true }).click();
          await expectPage(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
          page.once("dialog", dialog => dialog.accept("V10 timer completed"));
          await page.getByRole("button", { name: "Stop & save", exact: true }).click();
          await expectPage(page.getByRole("button", { name: "Start timer", exact: true })).toBeVisible();
          const entries = await database.prisma.timeEntry.findMany({ where: { employeeId: f.worker.employee.id, taskId: timerTask.id } });
          const versions = await database.prisma.timeEntryVersion.findMany({ where: { OR: entries.map(entry => ({ entryId: entry.id, version: entry.version })) } });
          expect(versions.some(version => { const data = version.data as { workNote?: string; activityLabel?: string }; return data.workNote === "V10 real persisted timer" && data.activityLabel === "V10 internal coordination"; })).toBe(true);
        }
        if (identity.key === "owner") {
          await page.getByRole("button", { name: "Edit widgets", exact: true }).click();
          await page.getByRole("button", { name: "Hide Time tracking widget", exact: true }).click();
          await page.getByRole("button", { name: "Done", exact: true }).click();
          await page.reload(); await expectPage(page.getByRole("heading", { name: "Time tracking", exact: true })).toHaveCount(0);
          await page.setViewportSize(viewports[0]!); await expectPage(page.getByRole("heading", { name: "Time tracking", exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Edit widgets", exact: true }).click();
          const timeHandle = page.getByRole("button", { name: "Drag to move Time tracking", exact: true });
          const storageKey = `sense-dashboard-layout-v2:${encodeURIComponent(f.owner.id)}:desktop`;
          const beforeCancel = await page.evaluate(key => localStorage.getItem(key), storageKey);
          await timeHandle.focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
          expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(beforeCancel);
          await page.locator(".dv-widget-grid").evaluate(element => element.scrollIntoView({ block: "start" }));
          const start = await timeHandle.boundingBox(), target = await page.getByRole("button", { name: "Drag to move Decisions & assigned reviews", exact: true }).boundingBox();
          expect(start).not.toBeNull(); expect(target).not.toBeNull();
          await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2); await page.mouse.down();
          await page.mouse.move(start!.x + start!.width / 2 + 8, start!.y + start!.height / 2, { steps: 3 });
          await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 15 });
          await page.mouse.move(target!.x + target!.width / 2 + 2, target!.y + target!.height / 2, { steps: 2 }); await page.mouse.up();
          await expectPage(page.locator(".dv-widget-col").nth(1).locator('[data-widget-id="time"]')).toBeVisible();
          await page.getByRole("button", { name: "Reset layout", exact: true }).click();
          await page.getByRole("button", { name: "Add widgets", exact: true }).click();
          await page.getByRole("button", { name: /Training.*Add/ }).click();
          await expectPage(page.getByRole("heading", { name: "Training", exact: true })).toBeVisible();
          await capture(page, viewports[0]!, "v10-owner-edit-gallery");
          await page.getByRole("button", { name: "Reset layout", exact: true }).click();
          await expectPage(page.getByRole("heading", { name: "Training", exact: true })).toHaveCount(0);
          await page.getByRole("button", { name: "Move Time tracking to other column", exact: true }).click();
          await page.getByRole("button", { name: "Done", exact: true }).click();
          await page.reload(); await expectPage(page.locator(".dv-widget-col").nth(1).getByRole("heading", { name: "Time tracking", exact: true })).toHaveCount(1);
          await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click(); await capture(page, viewports[0]!, "v10-owner-collapsed");
          await page.keyboard.press("Control+k"); await expectPage(page.getByLabel("Search pages", { exact: true })).toBeVisible(); await page.keyboard.press("Escape");
          await page.setViewportSize(viewports[2]!); await page.getByRole("button", { name: /^More/ }).click(); await expectPage(page.getByRole("heading", { name: "More destinations", exact: true })).toBeVisible(); await page.getByRole("button", { name: "Close navigation", exact: true }).click();
          await page.locator(".dv-widget-head").first().dispatchEvent("pointerdown", { pointerType: "touch" });
          await expectPage(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
          await page.locator(".dv-widget-head").first().dispatchEvent("pointerup", { pointerType: "touch" });
          await capture(page, viewports[2]!, "v10-owner-mobile-edit");
        }
      } catch (error) {
        await page.screenshot({ path: resolve(base, `browser/v10-${identity.key}-failure.png`), fullPage: true }).catch(() => undefined);
        writeFileSync(resolve(base, `browser/v10-${identity.key}-failure.json`), JSON.stringify({ context: identity.key, message: error instanceof Error ? error.message : "Unknown V10 acceptance failure" }, null, 2));
        contextFailures.push({ context: identity.key, message: error instanceof Error ? error.message : "Unknown V10 acceptance failure" });
      } finally { await session.close(); }
    }
    expect(contextFailures).toEqual([]);
    expect(serverErrors).toEqual([]);
    expect(diagnostics.filter(row => row.event === "pageerror")).toEqual([]);
  }, 240000);

  it.each(viewports)("runs persisted task/Project/recovery/authorization workflows at $width pixels", async viewport => {
    const f = await fixture(viewport.width), workerContext = await context(f.worker.secret, viewport);
    const ownerContext = await context(f.ownerSession.secret, viewport), outsiderContext = await context(f.outsider.secret, viewport);
    const page = await workerContext.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto("/my-work"); const workspace = page.locator(".task-workspace").first();
      await workspace.getByRole("button", { name: "Create task", exact: true }).first().click();
      let form = page.getByRole("form", { name: "Create task", exact: true }); const title = `Personal browser ${viewport.width} ${randomUUID()}`;
      await expectPage(workspace.getByRole("heading", { name: "My work", level: 1, exact: true })).toBeVisible();
      await expectPage(page.getByRole("link", { name: "Skip to main content", exact: true })).toHaveCount(1);
      await page.locator("dialog.task-create-dialog[open]").getByRole("button", { name: "Create task", exact: true }).click();
      await expectPage(form.locator(".task-error-summary")).toBeFocused();
      await expectPage(form.getByLabel("Task name", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await form.locator(".task-error-summary").getByRole("link", { name: "Task name must be between 2 and 160 characters.", exact: true }).click();
      await expectPage(form.getByLabel("Task name", { exact: true })).toBeFocused();
      expect(await database.prisma.task.count({ where: { title } })).toBe(0);
      await capture(page, viewport, "ux22-task-errors");
      await fillTask(form, title); await form.getByRole("combobox", { name: "Priority", exact: true }).selectOption("CRITICAL");
      const optional = form.getByText("Optional planning", { exact: true }); if (await optional.count()) await optional.click();
      const needle = `description-${randomUUID()}`; await form.getByLabel(/Description/).fill(needle);
      await page.locator("dialog.task-create-dialog[open]").getByRole("button", { name: "Create task", exact: true }).click();
      await expectPage(page.locator("dialog.task-detail-drawer[open]").getByText("Task created.", { exact: true })).toBeVisible();
      await expectPage(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
      const personal = await database.prisma.task.findMany({ where: { title, primaryOwnerEmployeeId: f.worker.employee.id } }); expect(personal).toHaveLength(1);
      await page.reload(); await expectPage(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
      await capture(page, viewport, "personal-persisted");
      await page.goto(`/my-work?q=${needle}&priorities=CRITICAL&sort=priority_desc`);
      await expectPage(workspace.getByRole("button", { name: new RegExp(title) }).first()).toBeVisible();
      await expectPage(workspace.locator(".task-list-paging").getByText("Showing 1–1 of 1 filtered tasks", { exact: true })).toBeVisible();
      const filtered = await page.request.get(`/api/v1/tasks?scope=personal&q=${needle}&priorities=CRITICAL&sort=priority_desc`);
      expect(filtered.status()).toBe(200); const filteredBody = await filtered.json(); expect(filteredBody.total).toBe(1); expect(filteredBody.items[0].id).toBe(personal[0]!.id);
      const row = workspace.locator(".my-work-demo-row").filter({ hasText: title });
      const measureRow = () => row.evaluate(element => {
        if (!element.isConnected || !element.getClientRects().length) return null;
        const box = element.getBoundingClientRect(), title = element.querySelector(".my-work-titleline strong")!.getBoundingClientRect();
        const main = element.querySelector(".my-work-row-main")!.getBoundingClientRect(), action = element.querySelector(".my-work-row-action button")!.getBoundingClientRect();
        const luminance = (value: string): number => {
          const channels = value.match(/[\d.]+/g); if (!channels || channels.length < 3) throw new Error(`Attached status chip has unsupported computed color: ${value}`);
          return channels.slice(0, 3).map(Number).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
            .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
        };
        const chip = getComputedStyle(element.querySelector(".my-work-status")!), foreground = luminance(chip.color), background = luminance(chip.backgroundColor);
        const labelContrast = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
        return { titleWidth: title.width, titleOffset: title.x - box.x, mainCoversRow: Math.abs(main.width - box.width) < 8 && Math.abs(main.height - box.height) < 8, actionHeight: action.height, labelContrast };
      });
      const measurements: Array<Exclude<Awaited<ReturnType<typeof measureRow>>, null>> = [];
      await expectPage.poll(async () => { const value = await measureRow(); if (value) measurements.push(value); return value !== null; }).toBe(true);
      const geometry = measurements.at(-1)!;
      rowGeometry.push({ width: viewport.width, ...geometry });
      expect(geometry.titleWidth).toBeGreaterThanOrEqual(80); expect(geometry.titleOffset).toBeLessThanOrEqual(60);
      expect(geometry.mainCoversRow).toBe(true); expect(geometry.actionHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.labelContrast).toBeGreaterThanOrEqual(4.5);
      await capture(page, viewport, "my-work-filtered");
      const rowAction = row.getByRole("button", { name: `Open task: ${title}`, exact: true }); await rowAction.focus(); await rowAction.press("Enter");
      await expectPage(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
      await page.goto(`/my-work?q=${encodeURIComponent(f.shared.title)}&collaboratorEmployeeIds=${f.reviewer.employee.id}`);
      await expectPage(workspace.getByRole("button", { name: new RegExp(f.shared.title) }).first()).toBeVisible();
      const forbidden = await page.request.get(`/api/v1/tasks/${f.privateTask.id}`); expect(forbidden.status()).toBe(403);

      await page.goto(`/projects?projectId=${f.project.id}&projectSection=tasks`);
      await page.getByRole("button", { name: "Create task", exact: true }).first().click();
      form = page.getByRole("form", { name: "Create task", exact: true });
      await expectPage(form.getByLabel("Task project", { exact: true })).toHaveValue(f.project.title);
      await expectPage(form.getByLabel("Task project", { exact: true })).toHaveAttribute("readonly", "");
      const parentTitle = `Recovered Project task ${randomUUID()}`; await fillTask(form, parentTitle);
      const submitted: string[] = []; let lose = true; let committedStatus: number | undefined;
      await page.route("**/api/v1/tasks", async route => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        submitted.push(route.request().postData() ?? "");
        if (lose) { lose = false; const committed = await route.fetch(); committedStatus = committed.status(); await route.abort("failed"); }
        else await route.continue();
      });
      await page.locator("dialog.task-create-dialog[open]").getByRole("button", { name: "Create task", exact: true }).click();
      const uncertain = page.getByRole("region", { name: "Unconfirmed creation" }); await expectPage(uncertain).toBeVisible();
      expect(committedStatus).toBe(201);
      await expectPage(form.getByLabel("Task name", { exact: true })).toBeDisabled(); await capture(page, viewport, "uncertain-project-task");
      const recovery = uncertain.getByRole("button", { name: "Check creation result", exact: true }); await recovery.focus(); await recovery.press("Enter");
      await expectPage(page.getByText("Task creation confirmed.", { exact: true })).toBeVisible();
      await expectPage(page.getByRole("heading", { name: parentTitle, exact: true })).toBeVisible();
      expect(submitted).toHaveLength(2); expect(submitted[1]).toBe(submitted[0]); await page.unroute("**/api/v1/tasks");
      const parents = await database.prisma.task.findMany({ where: { title: parentTitle, projectId: f.project.id } }); expect(parents).toHaveLength(1); const parent = parents[0]!;
      expect(await database.prisma.taskCreationReceipt.count({ where: { taskId: parent.id } })).toBe(1);
      expect(await database.prisma.taskStatusChange.count({ where: { taskId: parent.id } })).toBe(1);
      expect(await database.prisma.domainEvent.count({ where: { subjectId: parent.id, eventName: "task.created" } })).toBe(1);
      expect([...new URL(page.url()).searchParams.values()]).toContain(parent.id);
      await capture(page, viewport, "recovered-project-task");
      await page.getByRole("button", { name: "Create subtask", exact: true }).click();
      const childForm = page.getByRole("form", { name: "Create subtask", exact: true }); const childTitle = `Child ${randomUUID()}`; await fillTask(childForm, childTitle);
      await childForm.getByRole("button", { name: "Create subtask", exact: true }).click();
      await expectPage(page.getByText("Subtask created.", { exact: true })).toBeVisible();
      const children = await database.prisma.task.findMany({ where: { title: childTitle, projectId: f.project.id } }); expect(children).toHaveLength(1); const child = children[0]!;
      await expectPage(page.getByRole("heading", { name: parentTitle, exact: true })).toBeVisible();
      const createdChild = page.getByRole("button", { name: child.id, exact: true }); await expectPage(createdChild).toBeVisible();
      await createdChild.click(); await expectPage(page.getByRole("heading", { name: childTitle, exact: true })).toBeVisible();
      expect(await database.prisma.taskSubtaskLink.count({ where: { parentTaskId: parent.id, childTaskId: child.id } })).toBe(1);
      expect(await database.prisma.taskCreationReceipt.count({ where: { taskId: child.id, parentTaskId: parent.id } })).toBe(1);
      expect([...new URL(page.url()).searchParams.values()]).toContain(child.id);
      const headers = { Origin: webOrigin, "X-CSRF-Token": f.worker.csrf };
      let parentNow = await database.prisma.task.findUniqueOrThrow({ where: { id: parent.id } }); expect(parentNow.version).toBe(parent.version + 1);
      expect((await page.request.post(`/api/v1/tasks/${parent.id}/state`, { headers, data: { toState: "IN_PROGRESS", expectedVersion: parentNow.version, reason: "Begin actual parent work" } })).status()).toBe(201);
      parentNow = await database.prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
      expect((await page.request.post(`/api/v1/tasks/${parent.id}/state`, { headers, data: { toState: "COMPLETED", expectedVersion: parentNow.version, reason: "Must refuse unfinished child" } })).status()).toBe(409);
      await capture(page, viewport, "canonical-child");

      await page.goto(`/projects?projectId=${f.project.id}&projectSection=people`);
      await expectPage(page.getByRole("heading", { name: "Assigned contributors", exact: true })).toBeVisible();
      await expectPage(page.locator(".project-detail").getByText(f.worker.account.normalizedEmail, { exact: true })).toBeVisible();
      await expectPage(page.getByRole("combobox", { name: "Contributor", exact: true })).toHaveCount(0);
      await capture(page, viewport, "project-people");
      await page.goto(`/projects?projectId=${f.project.id}&projectSection=documents`);
      await expectPage(page.getByText("project-proof.png", { exact: true })).toBeVisible();
      await capture(page, viewport, "real-project-file");
      const documentLink = page.getByRole("link", { name: "Open documents", exact: true }); await expectPage(documentLink).toHaveAttribute("href", `/documents?projectId=${f.project.id}`);
      await page.goto(`/projects?projectId=${f.project.id}&projectSection=reviews`);
      const reviewLink = page.locator(".project-resource-list").getByRole("link", { name: f.reviewTask.title, exact: true }); await expectPage(reviewLink).toBeVisible();
      expect(new URL((await reviewLink.getAttribute("href"))!, webOrigin).searchParams.get("roundId")).toBe(f.round.id);
      await reviewLink.focus(); await reviewLink.press("Enter");
      await expectPage(page.getByRole("heading", { name: f.reviewTask.title, exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("roundId")).toBe(f.round.id); await capture(page, viewport, "canonical-review-round");

      const ownerPage = await ownerContext.newPage(); await ownerPage.goto("/projects?q=PreviouslyExisting");
      await ownerPage.getByLabel("Project branch", { exact: true }).selectOption(f.branch.id);
      await ownerPage.getByText("Project template (optional)", { exact: true }).click();
      await ownerPage.getByLabel("Project template", { exact: true }).selectOption(f.templateVersionId);
      const projectForm = ownerPage.getByRole("form", { name: "Create project", exact: true }); const projectTitle = `Confirmed draft ${randomUUID()}`;
      await projectForm.getByLabel("Project title", { exact: true }).fill(projectTitle);
      await expectPage(projectForm.getByLabel("Initial service scopes", { exact: true })).toHaveValue("Design");
      await projectForm.getByLabel("Creation reason", { exact: true }).fill("Create confirmed canonical Project through real UI");
      await projectForm.getByRole("button", { name: "Create Draft project", exact: true }).click();
      await expectPage(ownerPage.getByRole("heading", { name: projectTitle, exact: true })).toBeVisible();
      const createdProjects = await database.prisma.project.findMany({ where: { title: projectTitle } }); expect(createdProjects).toHaveLength(1);
      expect(new URL(ownerPage.url()).searchParams.get("projectId")).toBe(createdProjects[0]!.id);
      expect(new URL(ownerPage.url()).searchParams.get("q")).toBe("PreviouslyExisting"); await capture(ownerPage, viewport, "confirmed-draft-project");
      await ownerPage.getByRole("button", { name: "← Back to projects", exact: true }).click();
      await expectPage(ownerPage.getByLabel("Search projects", { exact: true })).toHaveValue("PreviouslyExisting");
      await ownerPage.goto(`/projects?projectId=${createdProjects[0]!.id}`);
      await lifecycle(ownerPage, page, f, createdProjects[0]!.id, viewport);

      const strangerPage = await outsiderContext.newPage(); expect((await strangerPage.request.get(`/api/v1/tasks/${parent.id}`)).status()).toBe(403);
      const before = await database.prisma.task.count();
      expect((await page.request.post("/api/v1/tasks", { headers, data: { title: "Forged foreign assignment", type: "NON_PROJECT", ownerEmployeeId: f.outsider.employee.id, priority: "LOW", targetDate: date, reason: "Negative scope check" } })).status()).toBe(403);
      expect(await database.prisma.task.count()).toBe(before);
      expect((await page.request.post("/api/v1/tasks", { headers: { Origin: webOrigin, "X-CSRF-Token": "invalid" }, data: { title: "Invalid CSRF", type: "NON_PROJECT", priority: "LOW", targetDate: date, reason: "Negative CSRF check" } })).status()).toBe(403);
      const ownerHeaders = { Origin: webOrigin, "X-CSRF-Token": f.ownerSession.csrf };
      for (const toState of ["IN_PROGRESS", "COMPLETED"]) {
        const shared = await database.prisma.task.findUniqueOrThrow({ where: { id: f.shared.id } });
        expect((await ownerPage.request.post(`/api/v1/tasks/${shared.id}/state`, { headers: ownerHeaders, data: { toState, expectedVersion: shared.version, reason: "Retain completed delivery during project cancellation" } })).status()).toBe(201);
      }
      const currentProject = await database.prisma.project.findUniqueOrThrow({ where: { id: f.project.id } });
      await f.workflow.revokeAssignment(f.actor, f.project.id, f.worker.employee.id, { expectedVersion: currentProject.version, reason: "Revoke fixture project assignment to test current reads" });
      expect((await page.request.get(`/api/v1/tasks/${parent.id}`)).status()).toBe(403);
      const taskCount = await database.prisma.task.count({ where: { projectId: f.project.id } });
      await ownerPage.goto(`/projects?projectId=${f.project.id}`);
      await ownerPage.getByLabel("Project action reason", { exact: true }).fill("Cancel isolated project while preserving completed delivery and review history");
      await ownerPage.getByLabel("Stop unfinished delivery work and retain completed work and history", { exact: true }).check();
      const cancelled = ownerPage.waitForResponse(value => new URL(value.url()).pathname === `/api/v1/projects/${f.project.id}/cancel` && value.request().method() === "POST");
      await ownerPage.getByRole("button", { name: "Cancel project", exact: true }).click(); expect((await cancelled).status()).toBe(201);
      await expectPage(ownerPage.locator(".project-detail-heading .project-status-pill")).toHaveText("CANCELLED");
      expect(await database.prisma.task.count({ where: { projectId: f.project.id } })).toBe(taskCount);
      expect((await database.prisma.task.findUniqueOrThrow({ where: { id: f.shared.id } })).status).toBe("COMPLETED");
      expect((await database.prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe("STOPPED_DUE_TO_PROJECT_CANCELLATION");
      expect(await database.prisma.reviewRound.count({ where: { id: f.round.id } })).toBe(1);
      await expectPage(ownerPage.getByRole("button", { name: "Cancel project", exact: true })).toHaveCount(0);
      await capture(ownerPage, viewport, "cancelled-project-history");
      await database.prisma.session.update({ where: { id: f.worker.session.id }, data: { revokedAt: new Date() } });
      expect((await page.request.get("/api/v1/auth/session")).status()).toBe(401);
      await page.goto("/my-work"); await expectPage(page.getByText("Sign in to view My Work", { exact: true })).toBeVisible();
      await capture(page, viewport, "revoked-session"); expect(errors).toEqual([]); journeys.push({ width: viewport.width, passed: true });
    } catch (error) {
      await page.screenshot({ path: resolve(base, `browser/${viewport.width}-failure.png`), fullPage: true }).catch(() => undefined);
      const state = await page.evaluate(() => ({ ready: document.readyState, root: document.getElementById("root")?.innerHTML.slice(0, 100000), scripts: [...document.scripts].map(script => script.src), resources: performance.getEntriesByType("resource").slice(-40).map(entry => ({ name: new URL(entry.name).pathname, duration: entry.duration })) })).catch(() => undefined);
      writeFileSync(resolve(base, `browser/${viewport.width}-failure.json`), JSON.stringify({ url: page.url(), message: String(error), pageErrors: errors, state, diagnostics: diagnostics.slice(-60), serverErrors }, null, 2));
      throw error;
    } finally { await workerContext.close(); await ownerContext.close(); await outsiderContext.close(); }
  }, 180000);

  it("bounds the real Project directory query independently of accumulated fixture rows", async () => {
    const target = browserTarget();
    const measured = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.url, options: "-c timezone=UTC" }), log: [{ emit: "event", level: "query" }] });
    let queries = 0; measured.$on("query", () => { queries++; });
    try {
      await verifyBrowserDatabase(measured);
      const owner = await measured.account.findFirstOrThrow({ where: { kind: "OWNER", state: "ACTIVE" } });
      const db = { prisma: measured } as unknown as DatabaseService;
      const actor = await new ProjectService(db).actor(owner.id), projects = await measured.project.count({ where: { organizationId: actor.organizationId } });
      const workflow = new ProjectWorkflowService(db, new AuthorizationService(db), new ApprovalService(db));
      queries = 0; const started = Date.now(); const result = await workflow.list(actor, undefined, 0, 50);
      directoryRead = { projects, returned: result.items.length, queries, elapsedMs: Date.now() - started };
      expect(result.total).toBe(projects); expect(result.items).toHaveLength(Math.min(projects, 50)); expect(queries).toBeLessThanOrEqual(20);
      expect(serverErrors).toEqual([]);
    } finally { await measured.$disconnect(); }
  }, 30000);
});
