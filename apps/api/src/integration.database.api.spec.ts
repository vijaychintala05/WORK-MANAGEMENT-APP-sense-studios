import "reflect-metadata";
import { jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "./database.service.js";
import { AuthorizationService } from "./authorization.service.js";
import { ProjectService, type ProjectActor } from "./project.service.js";
import { TaskService } from "./task.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { ApprovalService } from "./approval.service.js";
import { ProjectTemplateService } from "./project-template.service.js";
import { ReviewService } from "./review.service.js";
import { DocumentService } from "./document.service.js";
import { RevisionService } from "./revision.service.js";
import { NotificationsService } from "./notifications.service.js";
import { IntegrationService } from "./integration.service.js";
import { serializeCalendar } from "./integration-calendar.js";
import { CrmService } from "./crm.service.js";
import { WorkforceService } from "./workforce.service.js";
import { websiteSignature } from "./integration-webhook.js";
import { Prisma } from "./generated/prisma/client.js";
import type { RuntimeConfig } from "./config.js";
const url=process.env.S25_DATABASE_URL;
const suite=url?describe:describe.skip;
class Rollback extends Error{}
suite("S25 real PostgreSQL calendar scope and immutable evidence",()=>{
 let database:DatabaseService;
 beforeAll(async()=>{const parsed=new URL(url!);const s25=["56433","57433"].includes(parsed.port)&&/^\/sense_s25_[a-z0-9_]+_test$/.test(parsed.pathname);const s27=process.env.S27_E2E_ENABLED==="1"&&parsed.port==="58440"&&/^\/sense_s25_s27_[a-z0-9_]+_test$/.test(parsed.pathname);if(!["127.0.0.1","localhost"].includes(parsed.hostname)||(!s25&&!s27))throw Error("Exact S25 or explicitly enabled S25/S27 test target required");database=new DatabaseService({nodeEnv:"test",port:4000,databaseUrl:url!,webOrigin:"http://localhost:5173"});const rows=await database.prisma.$queryRaw<Array<{name:string}>>`SELECT current_database() name`;if(rows[0]?.name!==parsed.pathname.slice(1))throw Error("Exact database mismatch");});
 afterAll(async()=>{await database?.onModuleDestroy();});
 async function fixture(work:(f:{service:IntegrationService;owner:ProjectActor;staff:ProjectActor;other:ProjectActor;tx:Prisma.TransactionClient;projectId:string;employeeId:string;branchId:string;sourceId:string;workforce:WorkforceService;tasks:TaskService;db:DatabaseService;projects:ProjectService;reviews:ReviewService})=>Promise<void>){
  try{await database.prisma.$transaction(async tx=>{
   const organization=await tx.organization.create({data:{name:"S25 fictional "+randomUUID()}}),branch=await tx.branch.create({data:{organizationId:organization.id,name:"S25 branch"}}),team=await tx.team.create({data:{organizationId:organization.id,branchId:branch.id,name:"S25 team"}});
   const people:Array<ProjectActor&{employeeId?:string}>=[];
   for(const kind of ["OWNER","STAFF","STAFF"] as const){const account=await tx.account.create({data:{normalizedEmail:randomUUID()+"@example.test",kind,state:"ACTIVE"}});let employeeId:string|undefined;if(kind==="STAFF")employeeId=(await tx.employee.create({data:{organizationId:organization.id,homeBranchId:branch.id,homeTeamId:team.id,accountId:account.id,hiredAt:new Date("2026-01-01")}})).id;people.push({accountId:account.id,kind,organizationId:organization.id,...(employeeId?{employeeId}:{})});}
   const [owner,staff,other]=people as [ProjectActor,ProjectActor&{employeeId:string},ProjectActor];

   let sequence=0;
   const wrap=(target:Prisma.TransactionClient):Prisma.TransactionClient=>new Proxy(target,{get(delegate,key){if(key==="$transaction")return async(callback:(t:Prisma.TransactionClient)=>Promise<unknown>)=>{const name="s25_fixture_"+(++sequence);await target.$executeRawUnsafe("SAVEPOINT "+name);try{const result=await callback(wrap(target));await target.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");await target.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");await target.$executeRawUnsafe("RELEASE SAVEPOINT "+name);return result;}catch(error){await target.$executeRawUnsafe("ROLLBACK TO SAVEPOINT "+name);await target.$executeRawUnsafe("RELEASE SAVEPOINT "+name);throw error;}};return Reflect.get(delegate,key,delegate);}});
   const db={prisma:wrap(tx)} as unknown as DatabaseService,authorization=new AuthorizationService(db),projects=new ProjectService(db),tasks=new TaskService(db,authorization),config={nodeEnv:"test",port:4000,databaseUrl:url!,webOrigin:"http://localhost:5173",externalShareSecret:"s25-fictional-encryption-key-1234567890"} as RuntimeConfig,documents=new DocumentService(db,authorization,config),revisions=new RevisionService(db,authorization,documents),reviews=new ReviewService(db,authorization,documents,revisions,new NotificationsService(db)),crm=new CrmService(db,authorization),workforce=new WorkforceService(db,authorization,new ApprovalService(db),new NotificationsService(db),config),service=new IntegrationService(db,projects,tasks,reviews,crm,workforce,config);
   const source=await tx.crmSource.create({data:{organizationId:organization.id,name:"Website",builtIn:true}});
   const workflow=new ProjectWorkflowService(db,authorization,new ApprovalService(db));
   const {project}=await projects.create(owner,{branchId:branch.id,title:"Confidential fictional project",deliveryType:"DESIGN",scopes:["Delivery"],reason:"Create lawful S25 fixture"});
   for(const permissionKey of ["project.view","project.manage"])await tx.employeePermissionOverride.create({data:{organizationId:organization.id,employeeId:staff.employeeId,permissionKey,effect:"ALLOW",scopeKind:"BRANCH",branchId:branch.id,reason:"Explicit fixture scope"}});
   await workflow.assignment(owner,project.id,{employeeId:staff.employeeId,expectedVersion:1,reason:"Explicit fixture assignment"});
   await workflow.lead(owner,project.id,{employeeId:staff.employeeId,expectedVersion:2,reason:"Appoint fixture lead"});
   await workflow.status(owner,project.id,{toStatus:"ACTIVE",expectedVersion:3,reason:"Activate fixture project"});
   await work({service,owner,staff,other,tx,projectId:project.id,employeeId:staff.employeeId,branchId:branch.id,sourceId:source.id,workforce,tasks,db,projects,reviews});throw new Rollback();
  },{timeout:120000});}catch(error){if(!(error instanceof Rollback))throw error;}
 }
 const create=()=>({commandId:randomUUID(),reason:"Explicit fictional event",kind:"MEETING" as const,startAt:"2026-10-08T10:00:00Z",endAt:"2026-10-08T11:00:00Z"});
 test("creator-only events retain versions, dedupe and generic exports",async()=>fixture(async f=>{
  const input=create(),row=await f.service.createEvent(f.staff,input);expect((await f.service.createEvent(f.staff,input)).id).toBe(row.id);await expect(f.service.createEvent(f.staff,{...input,endAt:"2026-10-08T12:00:00Z"})).rejects.toBeInstanceOf(ConflictException);
  await expect(f.service.updateEvent(f.other,row.id,{commandId:randomUUID(),reason:"Unauthorized edit",expectedVersion:1,startAt:input.startAt,endAt:input.endAt})).rejects.toBeInstanceOf(ForbiddenException);
  const updated=await f.service.updateEvent(f.staff,row.id,{commandId:randomUUID(),reason:"Explicit reschedule",expectedVersion:1,startAt:input.startAt,endAt:"2026-10-08T12:00:00Z"});expect(updated.version).toBe(2);
  await expect(f.service.cancelEvent(f.staff,row.id,{commandId:randomUUID(),reason:"Stale cancellation",expectedVersion:1})).rejects.toBeInstanceOf(ConflictException);
  const current=await f.service.calendar(f.staff);expect(current.events).toHaveLength(1);expect(serializeCalendar(current.events)).toContain("SUMMARY:Meeting");expect((await f.service.calendar(f.other)).events).toHaveLength(0);
  await f.service.cancelEvent(f.staff,row.id,{commandId:randomUUID(),reason:"Explicit cancellation",expectedVersion:2});expect((await f.service.calendar(f.staff)).events[0]?.cancelled).toBe(true);
  expect(await f.tx.integrationCalendarHistory.count({where:{calendarEventId:row.id}})).toBe(3);
 }));
 test("project events require explicit assignment and project manage",async()=>fixture(async f=>{
  const input={...create(),projectId:f.projectId};await expect(f.service.createEvent(f.other,input)).rejects.toBeInstanceOf(ForbiddenException);
  const row=await f.service.createEvent(f.owner,{...input,commandId:randomUUID()});expect(row.projectId).toBe(f.projectId);expect((await f.service.setup(f.other)).events).toHaveLength(0);
  await f.tx.employeePermissionOverride.create({data:{organizationId:f.owner.organizationId,employeeId:f.employeeId,permissionKey:"project.view",effect:"DENY",scopeKind:"BRANCH",branchId:(await f.tx.project.findUniqueOrThrow({where:{id:f.projectId}})).branchId,reason:"Revoke current source access"}});expect((await f.service.calendar(f.staff)).events).toHaveLength(0);
 }));
 test("subscription rotation and revoke enforce active source identity without stored secrets",async()=>fixture(async f=>{
  const input={commandId:randomUUID(),reason:"Explicit subscription"},first=await f.service.subscription(f.staff,input);expect(first.token).toHaveLength(43);expect((await f.service.subscription(f.staff,input)) as unknown as Record<string,unknown>).not.toHaveProperty("token");
  await f.service.createEvent(f.staff,create());expect((await f.service.subscriptionCalendar(first.token)).events).toHaveLength(1);
  const second=await f.service.subscription(f.staff,{commandId:randomUUID(),reason:"Rotate capability"});await expect(f.service.subscriptionCalendar(first.token)).rejects.toBeInstanceOf(NotFoundException);
  const receipt=await f.tx.integrationReceipt.findUniqueOrThrow({where:{actorId_commandId:{actorId:f.staff.accountId,commandId:input.commandId}}});expect(JSON.stringify(receipt.result)).not.toContain(first.token);
  await f.service.revokeSubscription(f.staff,{commandId:randomUUID(),reason:"Revoke capability"});await expect(f.service.subscriptionCalendar(second.token)).rejects.toBeInstanceOf(NotFoundException);
 }));
 test("actual task deadlines retain opaque UID across changes and disclose no source titles",async()=>fixture(async f=>{
  const task=await f.tasks.create(f.owner,{title:"Private actual source title",description:"Sensitive source description",type:"PROJECT",projectId:f.projectId,ownerEmployeeId:f.employeeId,priority:"HIGH",targetDate:"2026-10-12",reason:"Create dated source fixture"});
  const before=(await f.service.calendar(f.staff)).events.find(event=>event.kind==="TASK_DEADLINE");expect(before?.start).toBe("2026-10-12");expect(serializeCalendar((await f.service.calendar(f.staff)).events)).not.toMatch(/Private actual source title|Sensitive source description|Confidential fictional project/);
  await f.tasks.edit(f.owner,task.id,{title:"Changed private title",targetDate:"2026-10-15",priority:"HIGH",expectedVersion:1,reason:"Reschedule actual source"});
  const after=(await f.service.calendar(f.staff)).events.find(event=>event.kind==="TASK_DEADLINE");expect(after?.uid).toBe(before?.uid);expect(after?.start).toBe("2026-10-15");expect(after?.sequence).toBeGreaterThan(before!.sequence);
 }));
 test("current review assignments follow linked deadlines and disappear when review permission is revoked",async()=>fixture(async f=>{
  const reviewer=await f.tx.employee.findUniqueOrThrow({where:{accountId:f.other.accountId}}),project=await f.tx.project.findUniqueOrThrow({where:{id:f.projectId}}),auth=new AuthorizationService(f.db),workflow=new ProjectWorkflowService(f.db,auth,new ApprovalService(f.db));
  for(const permissionKey of ["project.view","review.decide"])await f.tx.employeePermissionOverride.create({data:{organizationId:f.owner.organizationId,employeeId:reviewer.id,permissionKey,effect:"ALLOW",scopeKind:"BRANCH",branchId:project.branchId,reason:"Explicit reviewer fixture scope"}});
  await workflow.assignment(f.owner,f.projectId,{employeeId:reviewer.id,expectedVersion:project.version,reason:"Assign named independent reviewer"});
  const task=await f.tasks.create(f.owner,{title:"Sensitive review title",type:"PROJECT",projectId:f.projectId,ownerEmployeeId:f.employeeId,priority:"HIGH",targetDate:"2026-10-21",reviewRequirement:"INTERNAL",reason:"Create actual review source"});
  await f.reviews.assignReviewer(f.owner,task.id,{employeeId:reviewer.id,expectedVersion:1,reason:"Name independent reviewer"});
  await f.tasks.transition(f.staff,task.id,{toState:"IN_PROGRESS",expectedVersion:2,reason:"Start review source work"});
  await f.reviews.submit(f.staff,task.id,{reviewUrl:"https://files.sensestudios.com/integration/review-source",expectedVersion:3,reason:"Submit source for named review"});
  const before=await f.service.calendar(f.other);expect(before.events.filter(event=>event.kind==="REVIEW_ASSIGNMENT")).toHaveLength(1);expect(before.events.find(event=>event.kind==="REVIEW_ASSIGNMENT")?.start).toBe("2026-10-21");expect(serializeCalendar(before.events)).not.toContain("Sensitive review title");
  await f.tx.employeePermissionOverride.create({data:{organizationId:f.owner.organizationId,employeeId:reviewer.id,permissionKey:"review.decide",effect:"DENY",scopeKind:"BRANCH",branchId:project.branchId,reason:"Revoke current review performing grant"}});expect((await f.service.calendar(f.other)).events.filter(event=>event.kind==="REVIEW_ASSIGNMENT")).toHaveLength(0);
 }));
 test("milestone projection uses lawful applied template date and current source access",async()=>fixture(async f=>{
  const prior=await f.tx.project.findUniqueOrThrow({where:{id:f.projectId}}),templates=new ProjectTemplateService(f.db,new AuthorizationService(f.db));
  const template=await templates.create(f.owner,{name:"Private milestone template",reason:"Explicit fixture milestone definition",definition:{deliveryType:"DESIGN",scopes:["Delivery"],stages:[{key:"DESIGN",label:"Private stage"}],milestones:[{key:"ISSUE",label:"Sensitive milestone label",stageKey:"DESIGN",required:false,targetOffsetDays:5}],folders:[]}});
  const {project}=await f.projects.create(f.owner,{branchId:prior.branchId,title:"Sensitive milestone project",deliveryType:"DESIGN",scopes:["Delivery"],templateVersionId:template.template.versions[0]!.id,idempotencyKey:randomUUID(),reason:"Apply actual milestone template"}),workflow=new ProjectWorkflowService(f.db,new AuthorizationService(f.db),new ApprovalService(f.db));
  await workflow.assignment(f.owner,project.id,{employeeId:f.employeeId,expectedVersion:1,reason:"Assign milestone fixture contributor"});await workflow.lead(f.owner,project.id,{employeeId:f.employeeId,expectedVersion:2,reason:"Appoint milestone fixture lead"});await workflow.status(f.owner,project.id,{toStatus:"ACTIVE",expectedVersion:3,reason:"Activate milestone fixture"});
  const milestone=await f.tx.projectPlanItem.findFirstOrThrow({where:{projectId:project.id,kind:"MILESTONE"}}),projection=await f.service.calendar(f.staff);expect(projection.events.find(event=>event.kind==="MILESTONE")?.start).toBe(milestone.targetAt!.toISOString().slice(0,10));expect(serializeCalendar(projection.events)).not.toMatch(/Sensitive milestone|Private stage/);
 }));
 test("audit failure rolls back event and receipt in the same real transaction",async()=>fixture(async f=>{
  const base=f.db.prisma;
  const wrapped=new Proxy(base,{get(target,key){if(key==="$transaction")return async(callback:(tx:Prisma.TransactionClient)=>Promise<unknown>)=>base.$transaction(async tx=>callback(new Proxy(tx,{get(t,k){if(k==="auditEvent")return new Proxy(t.auditEvent,{get(delegate,method){if(method==="create")return async()=>{throw Error("Injected S25 audit failure");};return Reflect.get(delegate,method,delegate);}});return Reflect.get(t,k,t);}})));return Reflect.get(target,key,target);}});
  const service=new IntegrationService({prisma:wrapped} as unknown as DatabaseService,f.projects,f.tasks,f.reviews),input=create();
  const before=await f.tx.integrationCalendarEvent.count();await expect(service.createEvent(f.staff,input)).rejects.toThrow("Injected S25 audit failure");expect(await f.tx.integrationCalendarEvent.count()).toBe(before);expect(await f.tx.integrationReceipt.count({where:{actorId:f.staff.accountId,commandId:input.commandId}})).toBe(0);
 }));
 test("capability fetch rechecks suspended account and mutations recheck expired sessions",async()=>fixture(async f=>{
  const subscription=await f.service.subscription(f.staff,{commandId:randomUUID(),reason:"Scoped subscription fixture"});
  const session=await f.tx.session.create({data:{accountId:f.staff.accountId,tokenHash:randomUUID().replaceAll("-","").padEnd(64,"0"),csrfTokenHash:randomUUID().replaceAll("-","").padEnd(64,"0"),expiresAt:new Date(Date.now()-1000)}});
  await expect(f.service.createEvent({...f.staff,sessionId:session.id},create())).rejects.toBeInstanceOf(ForbiddenException);
  await f.tx.account.update({where:{id:f.staff.accountId},data:{state:"SUSPENDED"}});await expect(f.service.subscriptionCalendar(subscription.token)).rejects.toBeInstanceOf(ForbiddenException);
 }));
 test("Owner Website routing encrypts secrets and signed retries create exactly one NEW lead",async()=>fixture(async f=>{
  const command={commandId:randomUUID(),reason:"Explicit fixed Website route",label:"Website",branchId:f.branchId,sourceId:f.sourceId,actorId:f.owner.accountId};await expect(f.service.createConnector(f.staff,command)).rejects.toBeInstanceOf(ForbiddenException);
  const row=await f.service.createConnector(f.owner,command),replay=await f.service.createConnector(f.owner,command);expect(replay.id).toBe(row.id);expect(replay.secret).toBeUndefined();expect((await f.tx.integrationConnector.findUniqueOrThrow({where:{id:row.id}})).encryptedSecret).not.toContain(row.secret);expect(JSON.stringify(await f.tx.integrationReceipt.findMany())).not.toContain(row.secret);
  await expect(f.service.createConnector(f.owner,{...command,commandId:randomUUID(),branchId:randomUUID()})).rejects.toBeInstanceOf(ForbiddenException);
  const manual=await f.tx.crmSource.create({data:{organizationId:f.owner.organizationId,name:"Manual",builtIn:true}});await expect(f.service.createConnector(f.owner,{...command,commandId:randomUUID(),sourceId:manual.id})).rejects.toBeInstanceOf(ForbiddenException);
  const enquiry={enquiryId:"fixture-1",title:"Private enquiry",contactName:"Private person",email:"private@example.test"},timestamp=String(Math.floor(Date.now()/1000)),signature=websiteSignature(row.secret,row.id,timestamp,enquiry);
  await expect(f.service.ingestEnquiry(row.id,timestamp,"0".repeat(64),enquiry)).rejects.toBeInstanceOf(NotFoundException);expect(await f.tx.lead.count()).toBe(0);
  const result=await f.service.ingestEnquiry(row.id,timestamp,signature,enquiry);expect(await f.service.ingestEnquiry(row.id,timestamp,signature,enquiry)).toMatchObject({deliveryId:result.deliveryId,replayed:true});expect(await f.tx.lead.count()).toBe(1);const lead=await f.tx.lead.findFirstOrThrow();expect(lead).toMatchObject({stage:"NEW",branchId:f.branchId,sourceId:f.sourceId,createdById:f.owner.accountId,clientId:null});expect(await f.tx.leadStageChange.count({where:{leadId:lead.id}})).toBe(1);
  const changed={...enquiry,title:"Changed"};await expect(f.service.ingestEnquiry(row.id,timestamp,websiteSignature(row.secret,row.id,timestamp,changed),changed)).rejects.toBeInstanceOf(ConflictException);await expect(f.service.ingestEnquiry(row.id,timestamp,signature,{...enquiry,branchId:randomUUID()})).rejects.toThrow("Invalid website enquiry");expect(JSON.stringify((await f.service.setup(f.owner)).deliveries)).not.toContain("Private");expect((await f.service.setup(f.staff)).websiteConnectors).toEqual([]);
 }));
 test("Website revoked actor records safe failure and an authorized same-payload retry succeeds",async()=>fixture(async f=>{
  const permission=await f.tx.employeePermissionOverride.create({data:{organizationId:f.owner.organizationId,employeeId:f.employeeId,permissionKey:"lead.create",effect:"ALLOW",scopeKind:"BRANCH",branchId:f.branchId,reason:"Website actor authority"}}),row=await f.service.createConnector(f.owner,{commandId:randomUUID(),reason:"Explicit staff Website route",label:"Website",branchId:f.branchId,sourceId:f.sourceId,actorId:f.staff.accountId}),enquiry={enquiryId:"retry-1",title:"Private enquiry",contactName:"Private person"},timestamp=String(Math.floor(Date.now()/1000)),signature=websiteSignature(row.secret,row.id,timestamp,enquiry);
  await f.tx.employeePermissionOverride.update({where:{id:permission.id},data:{effect:"DENY"}});await expect(f.service.ingestEnquiry(row.id,timestamp,signature,enquiry)).rejects.toBeInstanceOf(ForbiddenException);expect(await f.tx.lead.count()).toBe(0);expect(await f.tx.integrationDelivery.findFirst()).toMatchObject({status:"FAILED",failureCode:"ROUTING_UNAVAILABLE",leadId:null});await f.tx.employeePermissionOverride.update({where:{id:permission.id},data:{effect:"ALLOW"}});expect((await f.service.ingestEnquiry(row.id,timestamp,signature,enquiry)).status).toBe("DELIVERED");expect(await f.tx.integrationDelivery.count()).toBe(1);expect(await f.tx.lead.count()).toBe(1);
 }));
 test("Website rotation, disable and inactive source deny ingestion",async()=>fixture(async f=>{
  const row=await f.service.createConnector(f.owner,{commandId:randomUUID(),reason:"Website rotation test",label:"Website",branchId:f.branchId,sourceId:f.sourceId,actorId:f.owner.accountId}),enquiry={enquiryId:"rotate-1",title:"Enquiry",contactName:"Person"},timestamp=String(Math.floor(Date.now()/1000)),next=await f.service.rotateConnector(f.owner,row.id,{commandId:randomUUID(),reason:"Rotate Website secret",expectedVersion:1});await expect(f.service.ingestEnquiry(row.id,timestamp,websiteSignature(row.secret,row.id,timestamp,enquiry),enquiry)).rejects.toBeInstanceOf(NotFoundException);
  await f.tx.crmSource.update({where:{id:f.sourceId},data:{active:false}});await expect(f.service.ingestEnquiry(row.id,timestamp,websiteSignature(next.secret!,row.id,timestamp,enquiry),enquiry)).rejects.toBeInstanceOf(ForbiddenException);await f.service.disableConnector(f.owner,row.id,{commandId:randomUUID(),reason:"Disable Website route",expectedVersion:2});await expect(f.service.ingestEnquiry(row.id,timestamp,websiteSignature(next.secret!,row.id,timestamp,enquiry),enquiry)).rejects.toBeInstanceOf(NotFoundException);expect(await f.tx.lead.count()).toBe(0);
  await f.tx.$executeRawUnsafe("SAVEPOINT connector_deny");try{await expect(f.tx.integrationConnector.update({where:{id:row.id},data:{branchId:randomUUID(),version:4}})).rejects.toThrow();}finally{await f.tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT connector_deny");await f.tx.$executeRawUnsafe("RELEASE SAVEPOINT connector_deny");}
  await f.tx.$executeRawUnsafe("SAVEPOINT connector_history_deny");try{await expect(f.tx.integrationConnectorVersion.updateMany({where:{connectorId:row.id},data:{reason:"Forged routing evidence"}})).rejects.toThrow();}finally{await f.tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT connector_history_deny");await f.tx.$executeRawUnsafe("RELEASE SAVEPOINT connector_history_deny");}
 }));
 test("Website lead and delivery rollback atomically; maps disclose only authorized configured coordinates",async()=>fixture(async f=>{
  const row=await f.service.createConnector(f.owner,{commandId:randomUUID(),reason:"Website rollback test",label:"Website",branchId:f.branchId,sourceId:f.sourceId,actorId:f.owner.accountId}),enquiry={enquiryId:"rollback-1",title:"Enquiry",contactName:"Person"},timestamp=String(Math.floor(Date.now()/1000));const spy=jest.spyOn(f.tx.integrationDelivery,"create").mockRejectedValueOnce(new Error("Injected delivery failure"));try{await expect(f.service.ingestEnquiry(row.id,timestamp,websiteSignature(row.secret,row.id,timestamp,enquiry),enquiry)).rejects.toThrow("Injected delivery failure");}finally{spy.mockRestore();}expect(await f.tx.lead.count()).toBe(0);expect(await f.tx.integrationDelivery.count()).toBe(0);
  await f.workforce.site(f.owner,{commandId:randomUUID(),reason:"Explicit configured site",projectId:f.projectId,label:"Site",latitude:12.34,longitude:56.78,radiusMetres:100,qrCode:"PrivateQR"});const own=(await f.service.setup(f.owner)).locations;expect(own).toHaveLength(1);expect(own[0]).toMatchObject({projectId:f.projectId,latitude:12.34,longitude:56.78});expect(own[0]?.mapUrl).toContain("openstreetmap.org");expect(JSON.stringify(own)).not.toContain("qr");expect((await f.service.setup(f.other)).locations).toHaveLength(0);
 }));
 test("SQL prevents history mutation and unaudited calendar updates",async()=>fixture(async f=>{
  const row=await f.service.createEvent(f.owner,create());let savepoint=0;
  async function denied(run:()=>Promise<unknown>){const name="sql_deny_"+(++savepoint);await f.tx.$executeRawUnsafe("SAVEPOINT "+name);try{await expect(run()).rejects.toThrow();}finally{await f.tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT "+name);await f.tx.$executeRawUnsafe("RELEASE SAVEPOINT "+name);}}
  await denied(()=>f.tx.integrationCalendarHistory.updateMany({where:{calendarEventId:row.id},data:{reason:"Forged evidence"}}));
  await denied(async()=>{await f.tx.integrationCalendarEvent.update({where:{id:row.id},data:{endAt:new Date("2026-10-08T13:00:00Z"),version:{increment:1}}});await f.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");});
  expect((await f.tx.integrationCalendarEvent.findUniqueOrThrow({where:{id:row.id}})).version).toBe(1);
 }));
});
