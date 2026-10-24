import { reviewRoutingTestTarget, verifyReviewRoutingTestDatabase } from "./review-routing-test-target.js";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "./database.service.js";
import { AuthorizationService } from "./authorization.service.js";
import { ApprovalService } from "./approval.service.js";
import { TaskService } from "./task.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { ProjectService } from "./project.service.js";
import { AccountKind, Prisma } from "./generated/prisma/client.js";
import { recordProjectEvent } from "./project-events.js";
import { isS27DisposableTestTarget, matchesS27DisposableServer } from "./s27-disposable-test-target.js";
import { resolve } from "node:path";
import { loadRecoveryTestTarget, verifyRecoveryTestDatabase } from "./recovery-test-target.js";
import type { RuntimeConfig } from "./config.js";
const databaseUrl = process.env.DATABASE_URL;
const dbDescribe = databaseUrl ? describe : describe.skip;

/** Creates committed synthetic records only in the exact fresh run-owned suite target.
 * Append-only evidence stays until the manifest-owned database cleanup; no row reset. */
dbDescribe("Current subtask commit and deferred evidence acceptance", () => {
  let database: DatabaseService;
  beforeAll(async () => {
    if (process.env.SENSE_REVIEW_ROUTING_TEST_RUN) {
      const owned = reviewRoutingTestTarget(resolve(process.cwd(), "../.."), "DATABASE_URL");
      database = new DatabaseService({ nodeEnv: "test", databaseUrl: owned.url, port: 4000, webOrigin: "http://localhost:59443" } as RuntimeConfig);
      await verifyReviewRoutingTestDatabase(database.prisma, owned); return;
    }
    const recovery = process.env.SENSE_RECOVERY_TEST_MANIFEST ? loadRecoveryTestTarget(process.env, resolve(process.cwd(), "../.."), "DATABASE_URL") : undefined;
    const ci119 = process.env.GITHUB_ACTIONS === "true" && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") && process.env.S27_EXPECTED_MIGRATIONS === "119" && isS27DisposableTestTarget("DATABASE_URL", databaseUrl);
    if (!recovery && !ci119 && (!isS27DisposableTestTarget("DATABASE_URL", databaseUrl) || !databaseUrl?.includes("sense_s27_main_s27_1791849600000_ac13_test"))) throw new Error("Exact newly authorized acceptance target required");
    database = new DatabaseService({ nodeEnv: "test", databaseUrl, port: 4000, webOrigin: "http://localhost:59443" } as RuntimeConfig);
    if (recovery) { await verifyRecoveryTestDatabase(database.prisma, recovery); return; }
    const identity = await database.prisma.$queryRaw<Array<{ database: string; port: number }>>`SELECT current_database() AS database, inet_server_port() AS port`;
    if (!identity[0] || !matchesS27DisposableServer(databaseUrl, identity[0].database, identity[0].port)) throw new Error("Acceptance server mismatch");
    const migrations = await database.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    if (Number(migrations[0]?.n) !== (ci119 ? 119 : 118)) throw new Error("Exact reviewed migration count required");
  });
  afterAll(async () => database?.onModuleDestroy());
  async function fixture() {
    const suffix=randomUUID(), authorization=new AuthorizationService(database), approvals=new ApprovalService(database);
    const tasks=new TaskService(database,authorization,approvals), workflow=new ProjectWorkflowService(database,authorization,approvals);
    const seeded=await database.prisma.$transaction(async tx=>{
      const org=await tx.organization.findFirst()??await tx.organization.create({data:{name:"Bounded commit acceptance"}});
      const owner=await tx.account.findFirst({where:{kind:"OWNER",state:"ACTIVE"}})??await tx.account.create({data:{normalizedEmail:`commit-owner-${suffix}@example.test`,kind:"OWNER",state:"ACTIVE"}});
      const branch=await tx.branch.create({data:{organizationId:org.id,name:`Commit branch ${suffix}`}});
      const team=await tx.team.create({data:{organizationId:org.id,branchId:branch.id,name:`Commit team ${suffix}`}});
      const account=await tx.account.create({data:{normalizedEmail:`commit-worker-${suffix}@example.test`,kind:"STAFF",state:"ACTIVE"}});
      const employee=await tx.employee.create({data:{organizationId:org.id,accountId:account.id,homeBranchId:branch.id,homeTeamId:team.id,hiredAt:new Date("2026-01-01")}});
      for(const permissionKey of ["project.view","project.manage"])await tx.employeePermissionOverride.create({data:{organizationId:org.id,employeeId:employee.id,permissionKey,effect:"ALLOW",scopeKind:"BRANCH",branchId:branch.id,reason:"Committed fixture explicit lead eligibility"}});
      return {org,owner,employee,branch};
    });
    const actor={organizationId:seeded.org.id,accountId:seeded.owner.id,kind:AccountKind.OWNER};
    const {project}=await new ProjectService(database).create(actor,{branchId:seeded.branch.id,title:`Commit project ${suffix}`,deliveryType:"DESIGN",scopes:["Delivery"],reason:"Create committed fixture with canonical project evidence"});
    await workflow.assignment(actor,project.id,{employeeId:seeded.employee.id,expectedVersion:1,reason:"Assign commit fixture worker"});
    await workflow.lead(actor,project.id,{employeeId:seeded.employee.id,expectedVersion:2,reason:"Appoint commit fixture lead"});
    await workflow.status(actor,project.id,{toStatus:"ACTIVE",expectedVersion:3,reason:"Activate commit fixture"});
    const input={title:"Committed parent",type:"PROJECT" as const,priority:"MEDIUM" as const,targetDate:"2026-10-20",reason:"Canonical commit acceptance",projectId:project.id,ownerEmployeeId:seeded.employee.id};
    const parent=await tasks.create(actor,input);
    return {actor,tasks,input,parent};
  }
  it("commits canonical child/parent evidence and reads the real relation after transaction closure", async()=>{
    const f=await fixture(),child=await f.tasks.createSubtask(f.actor,f.parent.id,{...f.input,title:"Committed child",expectedParentVersion:1});
    const row=await database.prisma.taskSubtaskLink.findUniqueOrThrow({where:{childTaskId_organizationId:{childTaskId:child.task.id,organizationId:f.actor.organizationId}}});
    expect(row.parentTaskId).toBe(f.parent.id);
    expect((await database.prisma.task.findUniqueOrThrow({where:{id:f.parent.id}})).version).toBe(2);
    expect((await f.tasks.subtasks(f.actor,f.parent.id)).completionBlocked).toBe(true);
  });
  it.each(["missing-parent", "forged-reason"])("rejects %s deferred evidence on actual commit and leaves no relation",async mode=>{
    const f=await fixture(),child=await f.tasks.create(f.actor,{...f.input,title:`Rejected ${mode} child`});
    await expect(database.prisma.$transaction(async tx=>{
      await recordProjectEvent(tx,{organizationId:f.actor.organizationId,actorId:f.actor.accountId,eventName:"task.created",subjectType:"task",subjectId:child.id,reason:f.input.reason,after:{parentTaskId:f.parent.id,projectId:f.input.projectId}});
      if(mode==="forged-reason")await recordProjectEvent(tx,{organizationId:f.actor.organizationId,actorId:f.actor.accountId,eventName:"task.updated",subjectType:"task",subjectId:f.parent.id,reason:"Different forged reason",after:{subtaskAction:"created",childTaskId:child.id}});
      await tx.taskSubtaskLink.create({data:{organizationId:f.actor.organizationId,projectId:f.input.projectId,parentTaskId:f.parent.id,childTaskId:child.id,createdById:f.actor.accountId,reason:f.input.reason}});
    })).rejects.toThrow("canonical child and parent evidence");
    expect(await database.prisma.taskSubtaskLink.findUnique({where:{childTaskId_organizationId:{childTaskId:child.id,organizationId:f.actor.organizationId}}})).toBeNull();
  });
  it("serializes child insertion behind parent completion, rejecting the stale creation after lock release",async()=>{
    const f=await fixture();await f.tasks.transition(f.actor,f.parent.id,{toState:"IN_PROGRESS",expectedVersion:1,reason:"Start race parent"});
    let release!:()=>void,locked!:()=>void;
    const lockReady=new Promise<void>(resolve=>{locked=resolve;}),allowCommit=new Promise<void>(resolve=>{release=resolve;});
    const completing=database.prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM tasks WHERE id=${f.parent.id}::uuid FOR UPDATE`;
      locked();await allowCommit;
      const transactionDatabase={prisma:new Proxy(tx,{get(target,key){if(key==="$transaction")return async(callback:(inner:Prisma.TransactionClient)=>Promise<unknown>)=>callback(tx);return Reflect.get(target,key);}})};
      const approvals=new ApprovalService(transactionDatabase as DatabaseService);
      const tasks=new TaskService(transactionDatabase as DatabaseService,new AuthorizationService(transactionDatabase as DatabaseService),approvals);
      await tasks.transition(f.actor,f.parent.id,{toState:"COMPLETED",expectedVersion:2,reason:"Race parent completes before child"});
    },{timeout:30000});
    await lockReady;
    const inserting=f.tasks.createSubtask(f.actor,f.parent.id,{...f.input,title:"Racing child",expectedParentVersion:2});
    // Release is a deterministic barrier; no timing sleep or automatic retry.
    release();await completing;
    await expect(inserting).rejects.toThrow();
    expect((await database.prisma.task.findUniqueOrThrow({where:{id:f.parent.id}})).status).toBe("COMPLETED");
    expect(await database.prisma.taskSubtaskLink.count({where:{parentTaskId:f.parent.id}})).toBe(0);
  });
  it("serializes parent completion behind committed child insertion and blocks the unfinished child",async()=>{
    const f=await fixture();await f.tasks.transition(f.actor,f.parent.id,{toState:"IN_PROGRESS",expectedVersion:1,reason:"Start reverse race parent"});
    let release!:()=>void,inserted!:()=>void;
    const insertedReady=new Promise<void>(resolve=>{inserted=resolve;}),allowCommit=new Promise<void>(resolve=>{release=resolve;});
    const inserting=database.prisma.$transaction(async tx=>{
      const transactionDatabase={prisma:new Proxy(tx,{get(target,key){if(key==="$transaction")return async(callback:(inner:Prisma.TransactionClient)=>Promise<unknown>)=>callback(tx);return Reflect.get(target,key);}})};
      const approvals=new ApprovalService(transactionDatabase as DatabaseService);
      const tasks=new TaskService(transactionDatabase as DatabaseService,new AuthorizationService(transactionDatabase as DatabaseService),approvals);
      await tasks.createSubtask(f.actor,f.parent.id,{...f.input,title:"Child inserted before finish",expectedParentVersion:2});
      inserted();await allowCommit;
    },{timeout:30000});
    await insertedReady;
    const completing=f.tasks.transition(f.actor,f.parent.id,{toState:"COMPLETED",expectedVersion:3,reason:"Finish races child insertion"});
    release();await inserting;
    await expect(completing).rejects.toThrow("Complete all subtasks");
    expect((await database.prisma.task.findUniqueOrThrow({where:{id:f.parent.id}})).status).toBe("IN_PROGRESS");
    expect(await database.prisma.taskSubtaskLink.count({where:{parentTaskId:f.parent.id}})).toBe(1);
  });});
