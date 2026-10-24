import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { actionableTaskReasons } from "./actionable-work-policy.js";
import { taskCreateHash } from "./task-create-identity.js";
import type { TaskCreationOptions, TaskReadRefinements, TaskListSort } from "@sense/contracts";
import { withAuthorizationReadTime } from "./authorization-read-context.js";
import { reviewMetricWhere } from "./task-review-metric.js";
import { taskRefinementPredicates, taskSearchPredicate, taskReadOrder, actionableTaskSearchMatches } from "./task-read-filters.js";
import { pauseTimeTimers } from "./time-lifecycle.js";
import { cancelExternalGrants, externalCancellationBlockers, externalRevocationNotices } from "./external-portal-policy.js";
import { ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { WorkforceService } from "./workforce.service.js";
import { assertNoSubtaskDependencyCycle, assertSubtasksCompleted } from "./task-subtask-policy.js";
import { AccountKind, AccountState, EmployeeState, NotificationChannel, Prisma, ProjectStatus, TaskPriority, TaskReviewRequirement, TaskStatus, TaskType } from "./generated/prisma/client.js";
import { AuthorizationService } from "./authorization.service.js";
import { DatabaseService } from "./database.service.js";
import { recordProjectEvent } from "./project-events.js";
import { NotificationsService } from "./notifications.service.js";
import { ApprovalService, type ApprovalHandler } from "./approval.service.js";
import { evaluateEmployeeExitTask, evaluateProjectCancellationTask, evaluateTaskResume, evaluateTaskStateTransition, evaluateTaskWaiting } from "./task-state-policy.js";
import { resolveTaskCreationProfile } from "./task-creation-profile.js";
import type { ProjectActor } from "./project.service.js";

type Tx = Prisma.TransactionClient;
type TaskRow = NonNullable<Awaited<ReturnType<Tx["task"]["findUnique"]>>>;
type ProjectRow = NonNullable<Awaited<ReturnType<Tx["project"]["findUnique"]>>>;
const EXTENSION_TYPE = "task.deadline_extension";
// Readable bound for the unbounded actionable scan. Candidates are ordered by
// target date, so a bounded scan covers the most urgent work first. Exceeding
// it is a refusal (ServiceUnavailableException), never a silent truncation, so
// a published total is never smaller than the real set of actionable work.
export const UNBOUNDED_CANDIDATE_SCAN = 5000;
type ExtensionContext = { taskId: string; previousDate: string; proposedDate: string; ownerEmployeeId: string; approverAccountId: string; taskVersion?: number };
function extensionContext(value: unknown): ExtensionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConflictException("Extension evidence is unavailable");
  const fields = value as Record<string, unknown>;
  for (const key of ["taskId", "previousDate", "proposedDate", "ownerEmployeeId", "approverAccountId"]) if (typeof fields[key] !== "string") throw new ConflictException("Extension evidence is unavailable");
  if (fields.taskVersion !== undefined && (!Number.isInteger(fields.taskVersion) || Number(fields.taskVersion) < 1)) throw new ConflictException("Extension version evidence is unavailable");
  return fields as ExtensionContext;
}

export interface CreateTaskInput {
  idempotencyKey?: string | undefined;
  acknowledgeOverload?: boolean | undefined;
  title: string; type: TaskType; priority: TaskPriority; targetDate: string; reason: string;
  description?: string | undefined; startDate?: string | undefined; estimatedHours?: number | undefined; projectId?: string | undefined;
  ownerEmployeeId?: string | undefined; reviewRequirement?: TaskReviewRequirement | undefined;
  collaborators?: Array<{ employeeId: string; estimatedHours?: number | undefined }> | undefined;
  planItemId?: string | undefined; tags?: string[] | undefined; checklist?: Array<{ label: string; checked: boolean }> | undefined;
}

@Injectable()
export class TaskService {
  constructor(private readonly database: DatabaseService, private readonly authorization: AuthorizationService, private readonly approvals: ApprovalService = new ApprovalService(database), @Optional() private readonly workforce?: WorkforceService) {
    this.approvals.registerHandler(this.extensionHandler());
  }
  private get db() { return this.database.prisma; }
  private async transaction<T>(command: (tx: Tx) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(command, { timeout: 30_000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2010" && error.meta?.code === "40P01")) throw new ConflictException("Work changed concurrently. Refresh and retry");
      throw error;
    }
  }

  private async activeActor(tx: Tx, actor: ProjectActor) {
    await tx.$queryRaw`SELECT "id" FROM "accounts" WHERE "id" = ${actor.accountId}::uuid FOR SHARE`;
    const account = await tx.account.findUnique({ where: { id: actor.accountId }, include: { employee: true } });
    if (!account || account.state !== AccountState.ACTIVE || account.kind !== actor.kind ||
      (actor.kind === AccountKind.STAFF && (!account.employee || account.employee.state !== EmployeeState.ACTIVE || account.employee.organizationId !== actor.organizationId))) throw new ForbiddenException("Permission denied");
    return account;
  }

  private async employee(tx: Tx, actor: ProjectActor, employeeId: string) {
    await tx.$queryRaw`SELECT "id" FROM "employees" WHERE "id" = ${employeeId}::uuid FOR SHARE`;
    const row = await tx.employee.findFirst({ where: { id: employeeId, organizationId: actor.organizationId, state: EmployeeState.ACTIVE, account: { state: AccountState.ACTIVE } } });
    if (!row) throw new ConflictException("An active employee is required");
    return row;
  }

  private async project(tx: Tx, actor: ProjectActor, projectId: string, lock = false): Promise<ProjectRow> {
    if (lock) await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR SHARE`;
    const row = await tx.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId } });
    if (!row) throw new NotFoundException("Project not found");
    return row;
  }

  private async projectAccess(tx: Tx, actor: ProjectActor, project: ProjectRow, key = "project.view") {
    await this.activeActor(tx, actor);
    if (actor.kind === AccountKind.OWNER) return;
    const employee = await tx.employee.findUnique({ where: { accountId: actor.accountId } });
    if (!employee || employee.organizationId !== project.organizationId) throw new ForbiddenException("Permission denied");
    const assignment = await tx.projectAssignment.findFirst({ where: { projectId: project.id, organizationId: project.organizationId, employeeId: employee.id, revokedAt: null } });
    if (!assignment || (employee.homeBranchId !== project.branchId && !assignment.crossBranchAuthorized)) throw new ForbiddenException("Permission denied");
    await this.authorization.assertPermission(actor.accountId, key, { kind: "BRANCH", organizationId: project.organizationId, branchId: project.branchId }, tx);
  }

  private async canProjectAccess(tx: Tx, actor: ProjectActor, project: ProjectRow, key = "project.view") {
    try { await this.projectAccess(tx, actor, project, key); return true; }
    catch (error) { if (error instanceof ForbiddenException) return false; throw error; }
  }

  private async managedEmployee(tx: Tx, actor: ProjectActor, target: { id: string; homeBranchId: string; homeTeamId: string }, project?: ProjectRow) {
    if (actor.kind === AccountKind.OWNER) return;
    const manager = await tx.employee.findUnique({ where: { accountId: actor.accountId } });
    if (!manager) throw new ForbiddenException("Manager assignment is required");
    if (project) {
      await this.projectAccess(tx, actor, project, "project.manage");
      await this.authorization.assertPermission(actor.accountId, "task.assign", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
      return;
    }
    if (manager.homeBranchId !== target.homeBranchId || manager.homeTeamId !== target.homeTeamId) throw new ForbiddenException("Manager scope is required");
    await this.authorization.assertPermission(actor.accountId, "task.assign", { kind: "TEAM", organizationId: actor.organizationId, branchId: target.homeBranchId, teamId: target.homeTeamId }, tx);
    if (manager.id === target.id) return;
    const people = await tx.employee.findMany({ where: { organizationId: actor.organizationId, homeBranchId: target.homeBranchId, homeTeamId: target.homeTeamId }, select: { id: true, reportsToId: true } });
    const parent = new Map(people.map((person) => [person.id, person.reportsToId]));
    let current: string | null | undefined = target.id;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      current = parent.get(current);
      if (current === manager.id) return;
    }
    throw new ForbiddenException("Employee is outside the manager's reporting tree");
  }

  /** R-023.b: a deadline grant is separate from assignment and task progress. */
  private async dateAuthority(tx: Tx, actor: ProjectActor, task: TaskRow, project?: ProjectRow | null): Promise<void> {
    await this.activeActor(tx, actor);
    if (actor.kind === AccountKind.OWNER) return;
    const owner = await tx.employee.findUnique({ where: { id: task.primaryOwnerEmployeeId } });
    if (!owner || owner.organizationId !== actor.organizationId) throw new ForbiddenException("Current manager access is required");
    // Existing manager visibility/assignment remains the gate; the date grant
    // adds authority without revealing task history to a date-only grantee.
    await this.managedEmployee(tx, actor, owner, project ?? undefined);
    if (project) {
      await this.authorization.assertPermission(actor.accountId, "task.deadline_change", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
      return;
    }
    await this.authorization.assertPermission(actor.accountId, "task.deadline_change", { kind: "TEAM", organizationId: actor.organizationId, branchId: owner.homeBranchId, teamId: owner.homeTeamId }, tx);
  }

  private async canChangeCommittedDate(tx: Tx, actor: ProjectActor, task: TaskRow, project?: ProjectRow | null): Promise<boolean> {
    if (task.type === TaskType.CLOSEOUT || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION || task.requiresReassignment || project && project.status !== ProjectStatus.ACTIVE) return false;
    try { await this.dateAuthority(tx, actor, task, project); return true; }
    catch (error) { if (error instanceof ForbiddenException) return false; throw error; }
  }

  private async dependencyAuthority(tx: Tx, actor: ProjectActor, dependent: TaskRow, project: ProjectRow) {
    const { account } = await this.taskAccess(tx, actor, dependent);
    if (actor.kind === AccountKind.OWNER || account.employee?.id === dependent.primaryOwnerEmployeeId) return;
    const owner = await tx.employee.findUnique({ where: { id: dependent.primaryOwnerEmployeeId } });
    if (!owner) throw new ForbiddenException("Current task manager access is required");
    await this.managedEmployee(tx, actor, owner, project);
  }

  private dependencyOpen(task: TaskRow, project: ProjectRow): boolean {
    return !!task.projectId && task.type !== TaskType.CLOSEOUT && project.status === ProjectStatus.ACTIVE &&
      task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION && !task.requiresReassignment;
  }

  private async canManageDependencies(tx: Tx, actor: ProjectActor, task: TaskRow, project: ProjectRow | null): Promise<boolean> {
    if (!project || !this.dependencyOpen(task, project)) return false;
    try { await this.dependencyAuthority(tx, actor, task, project); return true; }
    catch (error) { if (error instanceof ForbiddenException) return false; throw error; }
  }

  private async eligibleForProject(tx: Tx, actor: ProjectActor, project: ProjectRow, employeeId: string) {
    const employee = await this.employee(tx, actor, employeeId);
    const assignment = await tx.projectAssignment.findFirst({ where: { projectId: project.id, organizationId: actor.organizationId, employeeId, revokedAt: null } });
    if (!assignment || (employee.homeBranchId !== project.branchId && !assignment.crossBranchAuthorized)) throw new ForbiddenException("Employee lacks a current project assignment");
    await this.authorization.assertPermission(employee.accountId, "project.view", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
    return employee;
  }

  private async managedReportIds(tx: Tx, actor: ProjectActor) {
    const manager = await tx.employee.findUnique({ where: { accountId: actor.accountId } });
    if (!manager) return [] as string[];
    try { await this.authorization.assertPermission(actor.accountId, "task.assign", { kind: "TEAM", organizationId: actor.organizationId, branchId: manager.homeBranchId, teamId: manager.homeTeamId }, tx); }
    catch (error) { if (error instanceof ForbiddenException) return []; throw error; }
    const people = await tx.employee.findMany({ where: { organizationId: actor.organizationId, homeBranchId: manager.homeBranchId, homeTeamId: manager.homeTeamId }, select: { id: true, reportsToId: true } });
    const children = new Map<string, string[]>();
    for (const person of people) if (person.reportsToId) children.set(person.reportsToId, [...(children.get(person.reportsToId) ?? []), person.id]);
    const result = new Set<string>();
    const stack = [...(children.get(manager.id) ?? [])];
    while (stack.length) { const id = stack.pop()!; if (result.has(id) || id === manager.id) continue; result.add(id); stack.push(...(children.get(id) ?? [])); }
    return [...result];
  }

  private async visibleProjectIds(tx: Tx, actor: ProjectActor) {
    if (actor.kind === AccountKind.OWNER) return null;
    const employee = await tx.employee.findUnique({ where: { accountId: actor.accountId } });
    if (!employee) return [] as string[];
    const assignments = await tx.projectAssignment.findMany({ where: { organizationId: actor.organizationId, employeeId: employee.id, revokedAt: null }, include: { project: true } });
    const result: string[] = [];
    for (const assignment of assignments) if ((employee.homeBranchId === assignment.project.branchId || assignment.crossBranchAuthorized) && await this.canProjectAccess(tx, actor, assignment.project)) result.push(assignment.projectId);
    return result;
  }

  /** Current command-equivalent candidate read; a picker never grants participation. */
  async creationOptions(actor: ProjectActor, projectId?: string): Promise<TaskCreationOptions> {
    return this.transaction(async tx => {
      if (actor.kind !== AccountKind.OWNER && actor.kind !== AccountKind.STAFF) throw new ForbiddenException("Permission denied");
      const account = await this.activeActor(tx, actor);
      const project = projectId ? await this.project(tx, actor, projectId) : undefined;
      if (project) {
        await this.projectAccess(tx, actor, project);
        if (project.status !== ProjectStatus.DRAFT && project.status !== ProjectStatus.ACTIVE) throw new ConflictException("Project is unavailable for new delivery work");
      }
      let canAssign = actor.kind === AccountKind.OWNER;
      if (!canAssign && account.employee) {
        try {
          if (project) await this.projectAccess(tx, actor, project, "project.manage");
          await this.authorization.assertPermission(actor.accountId, "task.assign", project
            ? { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }
            : { kind: "TEAM", organizationId: actor.organizationId, branchId: account.employee.homeBranchId, teamId: account.employee.homeTeamId }, tx);
          canAssign = true;
        } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      }
      let candidateIds: string[] | undefined;
      if (project && canAssign) candidateIds = (await tx.projectAssignment.findMany({ where: { projectId: project.id, organizationId: actor.organizationId, revokedAt: null }, select: { employeeId: true } })).map(row => row.employeeId);
      else if (actor.kind === AccountKind.STAFF) candidateIds = [...(account.employee ? [account.employee.id] : []), ...(canAssign ? await this.managedReportIds(tx, actor) : [])];
      const candidates = await tx.employee.findMany({
        where: { organizationId: actor.organizationId, state: EmployeeState.ACTIVE, account: { state: AccountState.ACTIVE }, ...(candidateIds ? { id: { in: candidateIds } } : {}) },
        include: { account: { select: { normalizedEmail: true } } }, orderBy: { createdAt: "asc" }
      });
      const owners: Array<{ id: string; name: string; homeBranchId: string }> = [];
      for (const candidate of candidates) {
        try {
          if (project) await this.eligibleForProject(tx, actor, project, candidate.id);
          if (actor.kind === AccountKind.STAFF && candidate.id !== account.employee?.id) await this.managedEmployee(tx, actor, candidate, project);
          owners.push({ id: candidate.id, name: candidate.account.normalizedEmail, homeBranchId: candidate.homeBranchId });
        } catch (error) { if (!(error instanceof ForbiddenException) && !(error instanceof ConflictException)) throw error; }
      }
      return { actorEmployeeId: account.employee?.id ?? null, project: project ? { id: project.id, title: project.title, status: project.status } : null,
        canAssign, canCreate: owners.length > 0, owners, collaborators: canAssign ? owners : [], readAt: new Date().toISOString() };
    });
  }

  async setup(actor: ProjectActor) {
    return this.transaction(async (tx) => {
      if (actor.kind !== AccountKind.OWNER && actor.kind !== AccountKind.STAFF) throw new ForbiddenException("Permission denied");
      const account = await this.activeActor(tx, actor);
      const roleAssignments = actor.kind === AccountKind.STAFF && account.employee
        ? await tx.employeeJobRoleAssignment.findMany({
          where: { employeeId: account.employee.id, organizationId: actor.organizationId, effectiveTo: null, jobRole: { active: true } },
          select: { jobRole: { select: { creationPresentation: true } } }
        })
        : [];
      const creationProfile = resolveTaskCreationProfile(actor.kind, roleAssignments.map((assignment) => assignment.jobRole.creationPresentation));
      const ids = await this.visibleProjectIds(tx, actor);
      const projectRows = await tx.project.findMany({ where: { organizationId: actor.organizationId, ...(ids === null ? {} : { id: { in: ids } }) }, orderBy: { title: "asc" } });
      const projects: Array<{ id: string; title: string; status: ProjectStatus; branchId: string; canApproveCloseout: boolean }> = [];
      for (const project of projectRows) {
        let canApproveCloseout = false;
        if (project.status === ProjectStatus.CANCELLED && actor.kind === AccountKind.STAFF) {
          canApproveCloseout = account.employee?.id === project.currentLeadEmployeeId;
          if (!canApproveCloseout) {
            try { await this.authorization.assertPermission(actor.accountId, "project.closeout_approve", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx); canApproveCloseout = true; }
            catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
          }
        }
        projects.push({ id: project.id, title: project.title, status: project.status, branchId: project.branchId, canApproveCloseout });
      }
      let canAssign = actor.kind === AccountKind.OWNER;
      const visibleEmployeeIds = new Set<string>(account.employee ? [account.employee.id] : []);
      if (actor.kind === AccountKind.STAFF && account.employee) {
        const manager = account.employee;
        try {
          await this.authorization.assertPermission(actor.accountId, "task.assign", { kind: "TEAM", organizationId: actor.organizationId, branchId: manager.homeBranchId, teamId: manager.homeTeamId }, tx);
          canAssign = true;
          const people = await tx.employee.findMany({ where: { organizationId: actor.organizationId, homeBranchId: manager.homeBranchId, homeTeamId: manager.homeTeamId, state: EmployeeState.ACTIVE }, select: { id: true, reportsToId: true } });
          const children = new Map<string, string[]>();
          for (const person of people) if (person.reportsToId) children.set(person.reportsToId, [...(children.get(person.reportsToId) ?? []), person.id]);
          const stack = [...(children.get(manager.id) ?? [])];
          while (stack.length) { const id = stack.pop()!; if (visibleEmployeeIds.has(id)) continue; visibleEmployeeIds.add(id); stack.push(...(children.get(id) ?? [])); }
        } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
        for (const summary of projects) {
          const project = await tx.project.findUniqueOrThrow({ where: { id: summary.id } });
          try {
            await this.projectAccess(tx, actor, project, "project.manage");
            await this.authorization.assertPermission(actor.accountId, "task.assign", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
            canAssign = true;
            const assignments = await tx.projectAssignment.findMany({ where: { projectId: project.id, revokedAt: null }, select: { employeeId: true } });
            assignments.forEach((assignment) => visibleEmployeeIds.add(assignment.employeeId));
          } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
        }
        for (const project of projects.filter((row) => row.canApproveCloseout)) {
          const assignments = await tx.projectAssignment.findMany({ where: { projectId: project.id, revokedAt: null }, select: { employeeId: true } });
          assignments.forEach((assignment) => visibleEmployeeIds.add(assignment.employeeId));
        }
      }
      const employees = await tx.employee.findMany({ where: { organizationId: actor.organizationId, state: EmployeeState.ACTIVE, account: { state: AccountState.ACTIVE }, ...(actor.kind === AccountKind.OWNER ? {} : { id: { in: [...visibleEmployeeIds] } }) }, include: { account: { select: { normalizedEmail: true } }, homeTeam: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } });
      const planItems = await tx.projectPlanItem.findMany({ where: { organizationId: actor.organizationId, projectId: { in: projects.map((project) => project.id) } }, select: { id: true, projectId: true, kind: true, label: true }, orderBy: [{ projectId: "asc" }, { position: "asc" }] });
      return { actorEmployeeId: account.employee?.id ?? null, creationProfile, projects, planItems, employees: employees.map((row) => ({ id: row.id, name: row.account.normalizedEmail, homeBranchId: row.homeBranchId, homeTeamId: row.homeTeam.id, homeTeamName: row.homeTeam.name })), canAssign };
    });
  }

  async list(actor: ProjectActor, scope: "mine" | "assigned" | "personal" | "all" | "owned" | "created" | "collaborating", offset: number, limit: number, filters: TaskReadRefinements & { metric?: "reviews"; projectId?: string; planItemId?: string; ownerEmployeeId?: string; teamId?: string; q?: string; status?: TaskStatus; phase?: "active" | "waiting" | "review" | "completed"; dateBasis?: "target" | "committed"; dateFrom?: string; dateTo?: string; type?: TaskType; requiresReassignment?: boolean; sort?: TaskListSort } = {}) {
    return this.transaction(async (tx) => {
      const account = await this.activeActor(tx, actor);
      const ids = await this.visibleProjectIds(tx, actor);
      const employeeId = account.employee?.state === EmployeeState.ACTIVE && account.employee.organizationId === actor.organizationId ? account.employee.id : null;
      if ((scope === "personal" || scope === "owned" || scope === "collaborating") && !employeeId) return { total: 0, items: [] };
      const managedProjects: string[] = [];
      if (actor.kind === AccountKind.STAFF && (scope === "assigned" || scope === "all" || scope === "created")) {
        for (const id of ids ?? []) {
          const project = await this.project(tx, actor, id);
          try {
            await this.projectAccess(tx, actor, project, "project.manage");
            await this.authorization.assertPermission(actor.accountId, "task.assign", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
            managedProjects.push(id);
          } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
        }
      }
      const reports = actor.kind === AccountKind.STAFF && (scope === "assigned" || scope === "all" || scope === "created") ? await this.managedReportIds(tx, actor) : [];
      const assignedVisible: Prisma.TaskWhereInput = { OR: [
        { collaborators: { some: { employeeId: employeeId ?? "" } } },
        { projectId: null, primaryOwnerEmployeeId: { in: reports } },
        { projectId: { in: managedProjects } }
      ] };
      const allStaffVisible: Prisma.TaskWhereInput = { OR: [
        { primaryOwnerEmployeeId: employeeId ?? "" },
        { collaborators: { some: { employeeId: employeeId ?? "" } } },
        { projectId: null, primaryOwnerEmployeeId: { in: reports } },
        { projectId: { in: managedProjects } }
      ] };
      const ownership: Prisma.TaskWhereInput = scope === "personal" ? { OR: [{ primaryOwnerEmployeeId: employeeId! }, { collaborators: { some: { employeeId: employeeId! } } }] }
        : scope === "owned" ? { primaryOwnerEmployeeId: employeeId! }
          : scope === "collaborating" ? { collaborators: { some: { employeeId: employeeId! } } }
            : scope === "created" ? actor.kind === AccountKind.OWNER ? { createdById: actor.accountId } : { AND: [allStaffVisible, { createdById: actor.accountId }] }
              : actor.kind === AccountKind.OWNER ? {} : scope === "mine" ? { primaryOwnerEmployeeId: employeeId! } : scope === "assigned" ? assignedVisible : allStaffVisible;
      const phase: Prisma.TaskWhereInput = filters.phase === "active" ? { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION] } } : filters.phase === "waiting" ? { status: TaskStatus.WAITING } : filters.phase === "completed" ? { status: TaskStatus.COMPLETED } : filters.phase === "review" ? { OR: [{ type: TaskType.CORRECTION }, { status: { in: [TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW, TaskStatus.INTERNAL_APPROVED, TaskStatus.CORRECTIONS_REQUIRED, TaskStatus.SUBMITTED_CLIENT_REVIEW, TaskStatus.IN_CLIENT_REVIEW, TaskStatus.CLIENT_APPROVED, TaskStatus.CLIENT_REVISION_REQUIRED] } }] } : {};
      const dateRange = { ...(filters.dateFrom ? { gte: new Date(`${filters.dateFrom}T00:00:00.000Z`) } : {}), ...(filters.dateTo ? { lte: new Date(`${filters.dateTo}T00:00:00.000Z`) } : {}) };
      const dateFilter: Prisma.TaskWhereInput = filters.dateFrom || filters.dateTo ? filters.dateBasis === "committed" ? { committedDueDate: dateRange } : { targetDate: dateRange } : {};
      const search = taskSearchPredicate(filters.q);
      const where: Prisma.TaskWhereInput = { organizationId: actor.organizationId, AND: [ownership, phase, dateFilter, ...taskRefinementPredicates(filters), ...(filters.metric === "reviews" ? [reviewMetricWhere()] : []), ...(filters.type ? [{ type: filters.type }] : []), ...(filters.requiresReassignment !== undefined ? [{ requiresReassignment: filters.requiresReassignment }] : []), ...(ids === null ? [] : [{ OR: [{ projectId: null }, { projectId: { in: ids } }] }]), ...(filters.projectId ? [{ projectId: filters.projectId }] : []), ...(filters.planItemId ? [{ planItemId: filters.planItemId }] : []), ...(filters.ownerEmployeeId ? [{ primaryOwnerEmployeeId: filters.ownerEmployeeId }] : []), ...(filters.teamId ? [{ primaryOwner: { homeTeamId: filters.teamId } }] : []), search, ...(filters.status ? [{ status: filters.status }] : [])] };
      const orderBy = taskReadOrder(filters.sort);
      const [total, items] = await Promise.all([tx.task.count({ where }), tx.task.findMany({ where, include: { primaryOwner: { include: { account: { select: { normalizedEmail: true } } } }, project: { select: { id: true, title: true } } }, orderBy, skip: offset, take: limit })]);
      const childLinks = items.length ? await tx.taskSubtaskLink.findMany({ where: { organizationId: actor.organizationId, childTaskId: { in: items.map(item => item.id) } }, select: { childTaskId: true } }) : [];
      const childIds = new Set(childLinks.map(link => link.childTaskId));
      return { total, items: items.map(item => ({ ...item, ...(childIds.has(item.id) ? { isSubtask: true as const } : {}) })) };
    });
  }

  async attention(actor: ProjectActor, kind: "corrections" | "reassignment", offset: number, limit: number) {
    const permitted: Array<{ id: string; title: string; projectTitle: string | null; reason: string }> = [];
    let scanned = 0;
    while (true) {
      const page = await this.list(actor, kind === "corrections" ? "personal" : "assigned", scanned, 100, { phase: "active", ...(kind === "corrections" ? { type: TaskType.CORRECTION } : { requiresReassignment: true }) });
      for (const task of page.items) {
        try {
          const detail = await this.detail(actor, task.id);
          if (kind === "reassignment" && (!detail.task.requiresReassignment || !detail.capabilities.reassign)) continue;
          if (kind === "corrections" && detail.task.type !== TaskType.CORRECTION) continue;
          permitted.push({ id: task.id, title: task.title, projectTitle: task.project?.title ?? null, reason: kind === "reassignment" ? "Employee exit: a permitted manager must reassign this task before work resumes." : "Correction task assigned to you or including you as a collaborator. Inspect its linked review evidence." });
        } catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
      }
      scanned += page.items.length;
      if (scanned >= page.total || page.items.length === 0) break;
    }
    return { total: permitted.length, items: permitted.slice(offset, offset + limit) };
  }

  private async task(tx: Tx, actor: ProjectActor, id: string, expectedVersion?: number) {
    await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id" = ${id}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
    const row = await tx.task.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!row) throw new NotFoundException("Task not found");
    if (expectedVersion !== undefined && row.version !== expectedVersion) throw new ConflictException("Task changed. Refresh and retry");
    return row;
  }

  private async taskAccess(tx: Tx, actor: ProjectActor, task: TaskRow) {
    const account = await this.activeActor(tx, actor);
    const project = task.projectId ? await this.project(tx, actor, task.projectId) : null;
    if (project) await this.projectAccess(tx, actor, project);
    if (actor.kind === AccountKind.OWNER) return { account, project };
    const employeeId = account.employee!.id;
    if (employeeId !== task.primaryOwnerEmployeeId && !await tx.taskCollaborator.findFirst({ where: { taskId: task.id, employeeId } })) {
      const owner = await tx.employee.findUnique({ where: { id: task.primaryOwnerEmployeeId } });
      if (!owner) throw new ForbiddenException("Permission denied");
      await this.managedEmployee(tx, actor, owner, project ?? undefined);
    }
    return { account, project };
  }

  /** Independent exact source evaluated with the same current command capabilities. */
  async actionable(actor: ProjectActor, offset = 0, limit = 25) {
    return this.db.$transaction(async tx => {
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { timezone: true } });
      const readAt = new Date();
      const result = await withAuthorizationReadTime(tx, readAt, () => this.actionableInTransaction(tx, actor, readAt, organization.timezone));
      return { ...result, items: result.items.slice(offset, offset + limit), offset, limit };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
  }

  async actionableInTransaction(tx: Prisma.TransactionClient, actor: ProjectActor, readAt: Date, timezone: string, maxCandidates = UNBOUNDED_CANDIDATE_SCAN, filters: TaskReadRefinements & { q?: string | undefined } = {}) {
      const account = await this.activeActor(tx, actor);
      // One query more than the cap decides "in range" without a second count.
      const candidates = await tx.task.findMany({ where: { organizationId: actor.organizationId, AND: taskRefinementPredicates(filters),
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION] },
        OR: [...(account.employee ? [{ primaryOwnerEmployeeId: account.employee.id }] : []), { requiresReassignment: true }]
      }, include: { project: { select: { id: true, title: true } }, planItem: { select: { label: true } } }, orderBy: [{ targetDate: "asc" }, { id: "asc" }], take: maxCandidates + 1 });
      // Never silently truncate: a capped scan that would hide work is reported as
      // unavailable, not as a smaller total. Callers surface this as "no complete
      // page or count was published" instead of a plausible-looking partial queue.
      if (candidates.length > maxCandidates) throw new ServiceUnavailableException("Actionable work exceeds the readable bound; no complete page or count was published");
      const links = candidates.length ? await tx.taskSubtaskLink.findMany({ where: { organizationId: actor.organizationId, childTaskId: { in: candidates.map(task => task.id) } }, select: { childTaskId: true } }) : [];
      const childIds = new Set(links.map(link => link.childTaskId));
      const items = [];
      for (const candidate of candidates) {
        try {
          // Reuse current authority policies without fetching per-row detail/history.
          const task = candidate;
          const { project } = await this.taskAccess(tx, actor, task);
          const closeout = task.type === TaskType.CLOSEOUT ? await tx.taskCloseoutApproval.findUnique({ where: { taskId: task.id } }) : null;
          const open = task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION;
          const projectAllowsProgress = !project || project.status === (task.type === TaskType.CLOSEOUT ? ProjectStatus.CANCELLED : ProjectStatus.ACTIVE);
          const approvalActive = task.type !== TaskType.CLOSEOUT || !!closeout && !closeout.revokedAt;
          const progress = open && projectAllowsProgress && approvalActive && !task.requiresReassignment && (actor.kind === AccountKind.OWNER || account.employee?.id === task.primaryOwnerEmployeeId);
          let manager = actor.kind === AccountKind.OWNER;
          if (!manager && task.requiresReassignment) {
            const owner = await tx.employee.findUnique({ where: { id: task.primaryOwnerEmployeeId } });
            if (owner) try { await this.managedEmployee(tx, actor, owner, project ?? undefined); manager = true; } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
          }
          const capabilities = { edit: progress && task.type !== TaskType.CLOSEOUT && !new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW, TaskStatus.INTERNAL_APPROVED, TaskStatus.SUBMITTED_CLIENT_REVIEW, TaskStatus.IN_CLIENT_REVIEW, TaskStatus.CLIENT_APPROVED]).has(task.status), transition: progress, wait: progress && task.status === TaskStatus.IN_PROGRESS, resume: progress && task.status === TaskStatus.WAITING && task.waitingPreviousStatus === TaskStatus.IN_PROGRESS, reassign: manager && open && projectAllowsProgress && approvalActive };
          const reasons = actionableTaskReasons(task, capabilities, account.employee?.id === task.primaryOwnerEmployeeId, readAt, timezone);
          if (!reasons.length || !actionableTaskSearchMatches(task, filters.q)) continue;
          items.push({ source: "task" as const, sourceId: task.id, taskId: task.id, title: task.title,
            project: task.project, responsibility: reasons.includes("reassignment_required") ? "manager" as const : "primary_owner" as const,
            reason: reasons[0]!, reasons, deadline: task.targetDate, priority: task.priority, status: task.status, type: task.type, ownerEmployeeId: task.primaryOwnerEmployeeId, planItemId: task.planItemId, committedDueDate: task.committedDueDate, isSubtask: childIds.has(task.id),
            destination: `/my-work?taskId=${encodeURIComponent(task.id)}`, readAt });
        } catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
      }
      return { source: "task" as const, total: items.length, items, readAt };

  }
  async detail(actor: ProjectActor, id: string) {
    return this.transaction(tx => this.detailInTransaction(actor, id, tx));
  }
  private async detailInTransaction(actor: ProjectActor, id: string, tx: Tx) {
      const task = await tx.task.findFirst({ where: { id, organizationId: actor.organizationId }, include: { primaryOwner: { include: { account: { select: { normalizedEmail: true } } } }, createdBy: { select: { normalizedEmail: true, kind: true } }, project: { select: { id: true, title: true } } } });
      if (!task) throw new NotFoundException("Task not found");
      const { account, project } = await this.taskAccess(tx, actor, task);
      let reassign = actor.kind === AccountKind.OWNER;
      if (actor.kind === AccountKind.STAFF) {
        const owner = await tx.employee.findUnique({ where: { id: task.primaryOwnerEmployeeId } });
        if (owner) {
          try { await this.managedEmployee(tx, actor, owner, project ?? undefined); reassign = true; }
          catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
        }
      }
      const [collaborators, statusChanges, ownerChanges, committedDateChanges, dependencyRows, closeoutApproval, extensionRows] = await Promise.all([
        tx.taskCollaborator.findMany({ where: { taskId: id }, include: { employee: { include: { account: { select: { normalizedEmail: true } } } }, addedBy: { select: { normalizedEmail: true } } } }),
        tx.taskStatusChange.findMany({ where: { taskId: id }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
        tx.taskOwnerChange.findMany({ where: { taskId: id }, include: { actor: { select: { normalizedEmail: true, kind: true } } }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
        tx.taskCommittedDateChange.findMany({ where: { taskId: id }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
        tx.taskDependency.findMany({ where: { dependentTaskId: id, removedAt: null }, include: { predecessorTask: true }, orderBy: [{ addedAt: "asc" }, { id: "asc" }] }),
        tx.taskCloseoutApproval.findUnique({ where: { taskId: id } }),
        tx.approvalRequest.findMany({ where: { organizationId: actor.organizationId, typeKey: EXTENSION_TYPE, sourceType: "task", sourceId: id }, include: { decision: { select: { outcome: true, deciderId: true, reason: true, decidedAt: true } } }, orderBy: [{ requestedAt: "asc" }, { id: "asc" }] })
      ]);
      const predecessors: Array<{ id: string; title: string; status: TaskStatus }> = [];
      for (const edge of dependencyRows) {
        try {
          await this.taskAccess(tx, actor, edge.predecessorTask);
          predecessors.push({ id: edge.predecessorTask.id, title: edge.predecessorTask.title, status: edge.predecessorTask.status });
        } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      }
      // "Assigned by" is the actor of the most recent owner reassignment,
      // falling back to the task creator when it has never been reassigned.
      // Both are read from tasks this caller is already authorized to see,
      // so this exposes no identity that task detail does not already carry.
      const lastOwnerChange = ownerChanges[ownerChanges.length - 1];
      // Guard the optional chaining on the account objects, not just on the
      // relation row: the generated client types `actorId`/`addedById` as
      // nullable, so a null relation must not reach the response.
      const assignedByName = lastOwnerChange?.actor?.normalizedEmail ?? task.createdBy?.normalizedEmail ?? "Unknown";
      const assignedByKind = lastOwnerChange?.actor?.kind ?? task.createdBy?.kind ?? AccountKind.OWNER;
      const open = task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION;
      const projectAllowsProgress = !project || project.status === (task.type === TaskType.CLOSEOUT ? ProjectStatus.CANCELLED : ProjectStatus.ACTIVE);
      const approvalActive = task.type !== TaskType.CLOSEOUT || !!closeoutApproval && !closeoutApproval.revokedAt;
      const progress = open && projectAllowsProgress && approvalActive && !task.requiresReassignment && (actor.kind === AccountKind.OWNER || account.employee?.id === task.primaryOwnerEmployeeId);
      const linkedReview = task.type === TaskType.CORRECTION ? await tx.reviewRound.findFirst({ where: { correctionTaskId: task.id, organizationId: actor.organizationId, projectId: task.projectId! }, select: { taskId: true } }) : null;
      const extensions = [];
      for (const row of extensionRows) {
        const context = extensionContext(row.context);
        let canDecide = false;
        if (row.state === "PENDING" && row.approverId === actor.accountId && actor.accountId !== row.requesterId) {
          try { await this.dateAuthority(tx, actor, task, project); canDecide = true; }
          catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
        }
        extensions.push({ id: row.id, previousDate: context.previousDate, proposedDate: context.proposedDate, reason: row.reason, state: row.state, requesterId: row.requesterId, approverId: row.approverId, requestedAt: row.requestedAt, decision: row.decision, canDecide, canWithdraw: row.state === "PENDING" && actor.kind === AccountKind.OWNER });
      }
      return { task, linkedReviewTaskId: linkedReview?.taskId ?? null, people: { assignedBy: { name: assignedByName, kind: assignedByKind }, collaboratorAdders: collaborators.map((row) => ({ employeeId: row.employeeId, name: row.addedBy?.normalizedEmail ?? assignedByName })) }, collaborators: collaborators.map((row) => ({ employeeId: row.employeeId, name: row.employee.account.normalizedEmail, estimatedHours: row.estimatedHours })), history: { statusChanges, ownerChanges, committedDateChanges }, extensions, dependencies: { predecessors, hasUnfinished: dependencyRows.some((edge) => edge.predecessorTask.status !== TaskStatus.COMPLETED), hiddenCount: dependencyRows.length - predecessors.length }, closeoutApproval, capabilities: { edit: progress && task.type !== TaskType.CLOSEOUT && !new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW, TaskStatus.INTERNAL_APPROVED, TaskStatus.SUBMITTED_CLIENT_REVIEW, TaskStatus.IN_CLIENT_REVIEW, TaskStatus.CLIENT_APPROVED]).has(task.status), transition: progress, wait: progress && task.status === TaskStatus.IN_PROGRESS, resume: progress && task.status === TaskStatus.WAITING && task.waitingPreviousStatus === TaskStatus.IN_PROGRESS, changeCommittedDate: await this.canChangeCommittedDate(tx, actor, task, project), requestExtension: actor.kind === AccountKind.STAFF && account.employee?.id === task.primaryOwnerEmployeeId && this.extensionOpen(task, project) && !extensionRows.some((row) => row.state === "PENDING"), manageDependencies: await this.canManageDependencies(tx, actor, task, project), reassign: reassign && open && projectAllowsProgress && approvalActive, revokeCloseout: actor.kind === AccountKind.OWNER && !!closeoutApproval && !closeoutApproval.revokedAt } };

  }

  private async subtaskParentOpen(tx: Tx, actor: ProjectActor, task: TaskRow, project: ProjectRow | null): Promise<boolean> {
    const structurallyOpen = !!project && project.status === ProjectStatus.ACTIVE && task.type !== TaskType.CLOSEOUT && !task.requiresReassignment &&
      !new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW, TaskStatus.INTERNAL_APPROVED, TaskStatus.SUBMITTED_CLIENT_REVIEW, TaskStatus.IN_CLIENT_REVIEW, TaskStatus.CLIENT_APPROVED, TaskStatus.COMPLETED, TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION]).has(task.status) &&
      !await tx.taskSubtaskLink.findUnique({ where: { childTaskId_organizationId: { childTaskId: task.id, organizationId: task.organizationId } } });
    if (!structurallyOpen || !project) return false;
    const account = await this.activeActor(tx, actor);
    if (actor.kind === AccountKind.OWNER || account.employee?.id === task.primaryOwnerEmployeeId) return true;
    const owner = await tx.employee.findUnique({ where: { id: task.primaryOwnerEmployeeId } });
    if (!owner) return false;
    try { await this.managedEmployee(tx, actor, owner, project); return true; }
    catch (error) { if (error instanceof ForbiddenException) return false; throw error; }
  }

  async subtasks(actor: ProjectActor, taskId: string) {
    return this.transaction(async tx => {
      const task = await tx.task.findFirst({ where: { id: taskId, organizationId: actor.organizationId } });
      if (!task) throw new NotFoundException("Task not found");
      const { project } = await this.taskAccess(tx, actor, task);
      const links = await tx.taskSubtaskLink.findMany({ where: { parentTaskId: taskId, organizationId: actor.organizationId }, include: { childTask: { include: { primaryOwner: { include: { account: { select: { normalizedEmail: true } } } } } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const items: Array<{ id: string; title: string; status: TaskStatus; targetDate: Date; primaryOwnerEmployeeId: string; primaryOwnerName: string; version: number }> = [];
      for (const link of links) {
        try {
          await this.taskAccess(tx, actor, link.childTask);
          const child = link.childTask;
          items.push({ id: child.id, title: child.title, status: child.status, targetDate: child.targetDate, primaryOwnerEmployeeId: child.primaryOwnerEmployeeId, primaryOwnerName: child.primaryOwner.account.normalizedEmail, version: child.version });
        } catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
      }
      const parentLink = await tx.taskSubtaskLink.findUnique({ where: { childTaskId_organizationId: { childTaskId: taskId, organizationId: actor.organizationId } }, include: { parentTask: true } });
      let parent: { id: string; title: string } | null = null;
      if (parentLink) {
        try { await this.taskAccess(tx, actor, parentLink.parentTask); parent = { id: parentLink.parentTask.id, title: parentLink.parentTask.title }; }
        catch (error) { if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error; }
      }
      return { items, parent, isSubtask: !!parentLink, completionBlocked: links.some(link => link.childTask.status !== TaskStatus.COMPLETED), canCreate: await this.subtaskParentOpen(tx, actor, task, project), taskVersion: task.version };
    });
  }

  async createSubtask(actor: ProjectActor, parentTaskId: string, input: CreateTaskInput & { expectedParentVersion: number }) {
    return this.transaction(async tx => {
      const retry = await this.creationRetry(tx, actor, input, { id: parentTaskId, expectedVersion: input.expectedParentVersion });
      if (retry?.task) {
        const parent = await this.task(tx, actor, parentTaskId);
        await this.taskAccess(tx, actor, parent);
        return { task: retry.task, parentVersion: parent.version };
      }
      const preview = await tx.task.findFirst({ where: { id: parentTaskId, organizationId: actor.organizationId }, select: { projectId: true } });
      if (!preview?.projectId) throw new ConflictException("Subtasks require an accessible project parent");
      // Same graph lock order as dependency edits; parent completion edges are graph edges.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${preview.projectId}::text, 0))::text AS lock`;
      const parent = await this.task(tx, actor, parentTaskId, input.expectedParentVersion);
      const { project } = await this.taskAccess(tx, actor, parent);
      if (!await this.subtaskParentOpen(tx, actor, parent, project)) throw new ForbiddenException("Current parent edit or management authority is required to add a subtask");
      if (input.projectId !== undefined && input.projectId !== parent.projectId) throw new ConflictException("Subtask must use the parent project");
      const child = await this.createInTransaction(tx, actor, { ...input, projectId: parent.projectId! }, parentTaskId);
      await tx.taskSubtaskLink.create({ data: { organizationId: actor.organizationId, projectId: parent.projectId!, parentTaskId, childTaskId: child.id, createdById: actor.accountId, reason: input.reason } });
      const updatedParent = await tx.task.update({ where: { id: parentTaskId, version: parent.version }, data: { version: { increment: 1 } } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.updated", subjectType: "task", subjectId: parentTaskId, reason: input.reason,
        before: { version: parent.version }, after: { version: updatedParent.version, subtaskAction: "created", childTaskId: child.id } });
      if (retry) await this.saveCreationReceipt(tx, actor, input.idempotencyKey!, retry.hash, child.id, parentTaskId);
      return { task: child, parentVersion: updatedParent.version };
    });
  }

  async create(actor: ProjectActor, input: CreateTaskInput) {
    return this.transaction(async tx => {
      const retry = await this.creationRetry(tx, actor, input);
      if (retry?.task) return retry.task;
      const task = await this.createInTransaction(tx, actor, input);
      if (retry) await this.saveCreationReceipt(tx, actor, input.idempotencyKey!, retry.hash, task.id);
      return task;
    });
  }

  private async creationRetry(tx: Tx, actor: ProjectActor, input: CreateTaskInput, parent?: { id: string; expectedVersion: number }) {
    if (!input.idempotencyKey) return undefined;
    await this.activeActor(tx, actor);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`task-create:${actor.organizationId}:${actor.accountId}:${input.idempotencyKey}`}, 0))::text AS lock`;
    const hash = taskCreateHash(input, parent);
    const receipt = await tx.taskCreationReceipt.findUnique({ where: { organizationId_actorId_key: { organizationId: actor.organizationId, actorId: actor.accountId, key: input.idempotencyKey } } });
    if (!receipt) return { hash, task: undefined };
    if (receipt.payloadHash !== hash || receipt.command !== (parent ? "CREATE_SUBTASK" : "CREATE_TASK") || receipt.parentTaskId !== (parent?.id ?? null)) throw new ConflictException("Retry key was used for different task details");
    if (parent) {
      const currentParent = await tx.task.findFirst({ where: { id: parent.id, organizationId: actor.organizationId }, select: { projectId: true } });
      if (!currentParent?.projectId) throw new NotFoundException("Task not found");
      // Retain graph -> task lock order on recovery as well as first creation.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${currentParent.projectId}::text, 0))::text AS lock`;
    }
    const task = await this.task(tx, actor, receipt.taskId);
    await this.taskAccess(tx, actor, task);
    return { hash, task };
  }

  private async saveCreationReceipt(tx: Tx, actor: ProjectActor, key: string, hash: string, taskId: string, parentTaskId?: string) {
    await tx.taskCreationReceipt.create({ data: { organizationId: actor.organizationId, actorId: actor.accountId, key, payloadHash: hash, taskId, command: parentTaskId ? "CREATE_SUBTASK" : "CREATE_TASK", parentTaskId: parentTaskId ?? null } });
  }

  /** Domain workers reuse the same task creation, access and evidence rules. */
  async createInTransaction(tx: Tx, actor: ProjectActor, input: CreateTaskInput, parentTaskId?: string) {
      const account = await this.activeActor(tx, actor);
      const ownerId = input.ownerEmployeeId ?? account.employee?.id;
      if (!ownerId) throw new ForbiddenException("A primary owner is required");
      const owner = await this.employee(tx, actor, ownerId);
      if (input.type === TaskType.CLOSEOUT) throw new ForbiddenException("Closeout tasks use a separate approval command");
      if ((input.type === TaskType.NON_PROJECT && input.projectId) || ((input.type === TaskType.PROJECT || input.type === TaskType.CORRECTION || input.type === TaskType.SITE) && !input.projectId)) throw new ConflictException("Task type and project do not match");
      const project = input.projectId ? await this.project(tx, actor, input.projectId, true) : undefined;
      if (project && project.status !== ProjectStatus.DRAFT && project.status !== ProjectStatus.ACTIVE) throw new ConflictException("Project is unavailable for new delivery work");
      if (project) { await this.projectAccess(tx, actor, project); await this.eligibleForProject(tx, actor, project, ownerId); }
      if (input.planItemId && (!project || !await tx.projectPlanItem.findFirst({ where: { id: input.planItemId, projectId: project.id, organizationId: actor.organizationId } }))) throw new ConflictException("Plan item must belong to the task project");
      if (input.tags && new Set(input.tags).size !== input.tags.length) throw new ConflictException("Tags must be distinct");
      if (actor.kind === AccountKind.STAFF && ownerId !== account.employee!.id) await this.managedEmployee(tx, actor, owner, project);
      if (actor.kind === AccountKind.STAFF && ownerId === account.employee!.id && project) await this.projectAccess(tx, actor, project);
      const collaboratorIds = (input.collaborators ?? []).map((row) => row.employeeId);
      if (new Set(collaboratorIds).size !== collaboratorIds.length || collaboratorIds.includes(ownerId)) throw new ConflictException("Collaborators must be distinct from the primary owner");
      for (const collaborator of input.collaborators ?? []) {
        if (project) await this.eligibleForProject(tx, actor, project, collaborator.employeeId);
        else await this.employee(tx, actor, collaborator.employeeId);
        if (actor.kind !== AccountKind.OWNER) await this.managedEmployee(tx, actor, await tx.employee.findUniqueOrThrow({ where: { id: collaborator.employeeId } }), project);
      }
      const reviewRequirement = input.reviewRequirement === TaskReviewRequirement.CLIENT ? TaskReviewRequirement.BOTH : input.reviewRequirement ?? TaskReviewRequirement.NONE;
      if (reviewRequirement === TaskReviewRequirement.BOTH && !project) throw new ConflictException("Review requires a project");
      if (reviewRequirement === TaskReviewRequirement.BOTH) await new ClientPortalScopeService(this.database, this.authorization).staffAuthority(tx, actor, project!.id, "manage");
      const targetDate = new Date(`${input.targetDate}T00:00:00.000Z`);
      if (this.workforce && !input.acknowledgeOverload) for (const employeeId of [ownerId,...collaboratorIds]) if (await this.workforce.assignmentWarning(tx,actor,employeeId)) throw new ConflictException("Overload warning: review employee capacity and acknowledge before assigning work");
      const startDate = input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : undefined;
      if (Number.isNaN(targetDate.getTime()) || startDate && startDate > targetDate) throw new ConflictException("Task dates are invalid");
      const row = await tx.task.create({ data: { organizationId: actor.organizationId, ...(project ? { projectId: project.id } : {}), ...(input.planItemId ? { planItemId: input.planItemId } : {}), tags: input.tags ?? [], checklist: input.checklist ?? [], title: input.title, ...(input.description === undefined ? {} : { description: input.description }), type: input.type, priority: input.priority, targetDate, ...(startDate ? { startDate } : {}), ...(input.estimatedHours === undefined ? {} : { estimatedHours: input.estimatedHours }), primaryOwnerEmployeeId: ownerId, createdById: actor.accountId, reviewRequirement } });
      await tx.taskStatusChange.create({ data: { organizationId: actor.organizationId, taskId: row.id, toStatus: TaskStatus.NOT_STARTED, actorId: actor.accountId, reason: input.reason, taskVersion: 1 } });
      for (const collaborator of input.collaborators ?? []) await tx.taskCollaborator.create({ data: { organizationId: actor.organizationId, taskId: row.id, employeeId: collaborator.employeeId, ...(collaborator.estimatedHours === undefined ? {} : { estimatedHours: collaborator.estimatedHours }), addedById: actor.accountId } });
      const routingAuthorization = reviewRequirement === TaskReviewRequirement.BOTH ? await tx.taskReviewRoutingAuthorization.create({ data: { organizationId: actor.organizationId, projectId: project!.id, taskId: row.id, authorizedById: actor.accountId, reason: input.reason } }) : null;
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.created", subjectType: "task", subjectId: row.id, reason: input.reason, after: { taskId: row.id, projectId: project?.id ?? null, routingAuthorizationId: routingAuthorization?.id ?? null, reviewRequirement, ownerEmployeeId: ownerId, type: row.type, priority: row.priority, targetDate: input.targetDate, version: row.version, planItemId: row.planItemId, tags: row.tags, checklist: row.checklist, ...(parentTaskId ? { parentTaskId } : {}) } });
      return row;
  }

  async assertRecurrenceAuthority(tx: Tx, actor: ProjectActor, taskId: string, expectedTaskVersion?: number) {
    const task = await this.task(tx, actor, taskId, expectedTaskVersion);
    const project = task.projectId ? await this.project(tx, actor, task.projectId, true) : null;
    const { account } = await this.taskAccess(tx, actor, task);
    if (task.type !== TaskType.RECURRING || task.status === TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION || task.requiresReassignment || project && project.status !== ProjectStatus.ACTIVE) throw new ConflictException("Task state does not permit recurrence");
    const owner = await this.employee(tx, actor, task.primaryOwnerEmployeeId);
    if (actor.kind !== AccountKind.OWNER && account.employee?.id !== owner.id) await this.managedEmployee(tx, actor, owner, project ?? undefined);
    return task;
  }

  async assertTaskReadInTransaction(tx: Tx, actor: ProjectActor, taskId: string) {
    const task = await tx.task.findFirst({ where: { id: taskId, organizationId: actor.organizationId } });
    if (!task) throw new NotFoundException("Task not found");
    await this.taskAccess(tx, actor, task);
    return task;
  }

  /** S27 current-source port: authorize the task/management scope before loading any candidate identity. */
  async assistanceCandidates(actor: ProjectActor, tx: Tx, taskId: string, purpose: "PRIMARY_OWNER" | "COLLABORATOR" | "REVIEWER", broaderSearch = false) {
    const task = await tx.task.findFirst({ where: { id: taskId, organizationId: actor.organizationId } });
    if (!task) throw new NotFoundException("Task not found");
    const { account, project } = await this.taskAccess(tx, actor, task);
    if (task.status === TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION || task.status === TaskStatus.COMPLETED || task.requiresReassignment || project && !new Set<ProjectStatus>([ProjectStatus.DRAFT, ProjectStatus.ACTIVE]).has(project.status)) throw new ConflictException("Task is not eligible for an assignment suggestion");
    const currentOwner = await tx.employee.findFirst({ where: { id: task.primaryOwnerEmployeeId, organizationId: actor.organizationId, state: EmployeeState.ACTIVE, account: { state: AccountState.ACTIVE } }, select: { id: true, homeTeamId: true, homeBranchId: true } });
    if (!currentOwner) throw new ConflictException("Current task owner Team is unavailable");
    if (actor.kind !== AccountKind.OWNER) {
      if (project) {
        await this.projectAccess(tx, actor, project);
        await this.authorization.assertPermission(actor.accountId, "task.assign", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
        if (broaderSearch) {
          await this.authorization.assertPermission(actor.accountId, "project.manage", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
          await this.authorization.assertPermission(actor.accountId, "employee.manage", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
        } else await this.managedEmployee(tx, actor, currentOwner, project);
      } else {
        if (broaderSearch) throw new ForbiddenException("Broader search requires an explicitly managed project scope");
        await this.managedEmployee(tx, actor, currentOwner);
      }
    }
    const existingCollaborators = purpose === "COLLABORATOR" ? new Set((await tx.taskCollaborator.findMany({ where: { taskId, organizationId: actor.organizationId }, select: { employeeId: true } })).map((row) => row.employeeId)) : new Set<string>();
    const projectEmployeeIds = project ? new Set((await tx.projectAssignment.findMany({ where: { projectId: project.id, organizationId: actor.organizationId, revokedAt: null }, select: { employeeId: true } })).map((row) => row.employeeId)) : null;
    const candidates = await tx.employee.findMany({ where: { organizationId: actor.organizationId, state: EmployeeState.ACTIVE, account: { state: AccountState.ACTIVE }, ...(broaderSearch ? {} : { homeTeamId: currentOwner.homeTeamId, homeBranchId: currentOwner.homeBranchId }) }, include: { account: { select: { normalizedEmail: true } } }, orderBy: { id: "asc" } });
    const eligible: Array<{ employeeId: string; label: string; teamId: string; branchId: string }> = [];
    for (const candidate of candidates) {
      try {
        if (projectEmployeeIds && !projectEmployeeIds.has(candidate.id)) continue;
        if (project) await this.eligibleForProject(tx, actor, project, candidate.id);
        if (purpose === "COLLABORATOR" && (candidate.id === task.primaryOwnerEmployeeId || existingCollaborators.has(candidate.id))) continue;
        if (actor.kind === AccountKind.STAFF && !project) await this.managedEmployee(tx, actor, candidate);
        eligible.push({ employeeId: candidate.id, label: candidate.employeeCode || candidate.account.normalizedEmail, teamId: candidate.homeTeamId, branchId: candidate.homeBranchId });
      } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
    }
    void account;
    return { task: { id: task.id, projectId: task.projectId, status: task.status, version: task.version, ownerEmployeeId: task.primaryOwnerEmployeeId, reviewRequirement: task.reviewRequirement }, currentTeam: { id: currentOwner.homeTeamId, branchId: currentOwner.homeBranchId }, broaderSearch, candidates: eligible };
  }

  /** S27 outcome port: verify an already-added collaborator without making them a new suggestion candidate. */
  async assistanceCollaboratorOutcome(actor: ProjectActor, tx: Tx, taskId: string, employeeId: string, broaderSearch = false) {
    const scope = await this.assistanceCandidates(actor, tx, taskId, "COLLABORATOR", broaderSearch);
    const [task, membership, employee] = await Promise.all([
      tx.task.findFirst({ where: { id: taskId, organizationId: actor.organizationId } }),
      tx.taskCollaborator.findFirst({ where: { taskId, organizationId: actor.organizationId, employeeId } }),
      tx.employee.findFirst({ where: { id: employeeId, organizationId: actor.organizationId, state: EmployeeState.ACTIVE, account: { state: AccountState.ACTIVE } }, select: { id: true, homeTeamId: true, homeBranchId: true } })
    ]);
    if (!task || !membership || !employee) throw new ConflictException("Current task collaborators do not match the selected employee");
    if (!broaderSearch && (employee.homeTeamId !== scope.currentTeam.id || employee.homeBranchId !== scope.currentTeam.branchId)) throw new ConflictException("Selected collaborator is outside the current Team scope");
    if (task.projectId) {
      const projectMember = await tx.projectAssignment.findFirst({ where: { organizationId: actor.organizationId, projectId: task.projectId, employeeId, revokedAt: null } });
      if (!projectMember) throw new ConflictException("Selected collaborator is no longer a current project member");
      const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId: actor.organizationId } });
      if (!project) throw new ConflictException("Selected collaborator project is unavailable");
      await this.eligibleForProject(tx, actor, project, employeeId);
    }
    return { taskId, employeeId, taskVersion: task.version, currentTeam: scope.currentTeam };
  }

  /** Exact training practical evidence uses the normal task/project access boundary. */
  async assertTrainingPracticalAccess(tx: Tx, actor: ProjectActor, taskId: string, employeeId: string) {
    const task = await tx.task.findFirst({ where: { id: taskId, organizationId: actor.organizationId } });
    if (!task || task.type !== TaskType.TRAINING_PRACTICAL || task.primaryOwnerEmployeeId !== employeeId) throw new NotFoundException("Training practical task unavailable");
    await this.taskAccess(tx, actor, task);
    if (task.requiresReassignment || task.status === TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION) throw new ConflictException("Training practical task is unavailable");
    return task;
  }

  /** Existing SOP evidence follows ordinary read access, including authorized planning/closed work. */
  async assertSopReferenceReadAccess(tx: Tx, actor: ProjectActor, taskId: string) {
    const task = await this.task(tx, actor, taskId);
    await this.taskAccess(tx, actor, task);
    return task;
  }

  /** An exact SOP reference grants no task access and cannot be added to closed work. */
  async assertSopReferenceAuthority(tx: Tx, actor: ProjectActor, taskId: string) {
    const task = await this.task(tx, actor, taskId);
    const project = task.projectId ? await this.project(tx, actor, task.projectId) : null;
    const { account } = await this.taskAccess(tx, actor, task);
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION || task.requiresReassignment || project && project.status !== ProjectStatus.ACTIVE && !(project.status === ProjectStatus.CANCELLED && task.type === TaskType.CLOSEOUT)) throw new ConflictException("Task state does not permit a new SOP reference");
    const owner = await this.employee(tx, actor, task.primaryOwnerEmployeeId);
    if (actor.kind !== AccountKind.OWNER && account.employee?.id !== owner.id) await this.managedEmployee(tx, actor, owner, project ?? undefined);
    return task;
  }

  private async waitingAlertRecipient(tx: Tx, organizationId: string, task: TaskRow, accountId: string): Promise<boolean> {
    const owner = await tx.employee.findUnique({ where: { id: task.primaryOwnerEmployeeId }, include: { homeTeam: true, account: true } });
    if (!owner || owner.organizationId !== organizationId || owner.state !== EmployeeState.ACTIVE || owner.account.state !== AccountState.ACTIVE || !owner.homeTeam.active || !owner.homeTeam.waitingAlertsEnabled || task.status !== TaskStatus.WAITING || task.requiresReassignment || !task.waitingDelayCause) return false;
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account) return false;
    const actor = { accountId, organizationId, kind: account.kind };
    try {
      const { project } = await this.taskAccess(tx, actor, task);
      if (project && project.status !== (task.type === TaskType.CLOSEOUT ? ProjectStatus.CANCELLED : ProjectStatus.ACTIVE)) return false;
      if (task.type === TaskType.CLOSEOUT && !await tx.taskCloseoutApproval.findFirst({ where: { taskId: task.id, revokedAt: null } })) return false;
      if (actor.kind !== AccountKind.OWNER) {
        await this.managedEmployee(tx, actor, owner, project ?? undefined);
        if (accountId === owner.accountId) return false;
      }
      return true;
    } catch (error) { if (error instanceof ForbiddenException || error instanceof ConflictException) return false; throw error; }
  }

  async waitingAlertAuthorized(eventId: string, accountId: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const event = await tx.domainEvent.findUnique({ where: { id: eventId } });
      if (!event || event.eventName !== "task.waiting") return false;
      const payload = event.payload;
      const auditId = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.auditEventId : undefined;
      if (typeof auditId !== "string") return false;
      const audit = await tx.auditEvent.findUnique({ where: { id: auditId } });
      const after = audit?.after;
      if (!audit || audit.organizationId !== event.organizationId || audit.eventKey !== event.eventName || audit.subjectType !== "task" || audit.subjectId !== event.subjectId || !after || typeof after !== "object" || Array.isArray(after)) return false;
      const task = await tx.task.findFirst({ where: { id: event.subjectId, organizationId: event.organizationId } });
      if (!task || after.version !== task.version || typeof after.delayCause !== "string") return false;
      const owner = await tx.employee.findUnique({ where: { id: task.primaryOwnerEmployeeId }, select: { homeTeamId: true } });
      if (!owner || after.ownerEmployeeId !== task.primaryOwnerEmployeeId || after.ownerTeamId !== owner.homeTeamId) return false;
      return this.waitingAlertRecipient(tx, event.organizationId, task, accountId);
    });
  }

  private async queueWaitingAlerts(tx: Tx, task: TaskRow, eventId: string) {
    const candidates = await tx.account.findMany({ where: { state: AccountState.ACTIVE, OR: [{ kind: AccountKind.OWNER }, { kind: AccountKind.STAFF, employee: { organizationId: task.organizationId, state: EmployeeState.ACTIVE } }] }, select: { id: true } });
    const notifications = new NotificationsService({ prisma: tx } as unknown as DatabaseService);
    for (const candidate of candidates) if (await this.waitingAlertRecipient(tx, task.organizationId, task, candidate.id)) {
      await notifications.createForEvent(tx, { eventId, recipientAccountId: candidate.id, channel: NotificationChannel.IN_APP, category: "task.waiting", title: "Task is waiting", body: "An authorized task is waiting. Review its current delay details.", internalRoute: `/?taskId=${task.id}`, critical: false, mandatory: false });
    }
  }

  async dependencyCandidates(actor: ProjectActor, id: string, query = "") {
    return this.transaction(async (tx) => {
      const dependent = await tx.task.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!dependent) throw new NotFoundException("Task not found");
      const project = dependent.projectId ? await this.project(tx, actor, dependent.projectId) : null;
      if (!project || !await this.canManageDependencies(tx, actor, dependent, project)) throw new ForbiddenException("Dependency management is unavailable");
      const rows = await tx.task.findMany({ where: { organizationId: actor.organizationId, projectId: project.id, id: { not: id }, type: { not: TaskType.CLOSEOUT }, ...(query ? { title: { contains: query, mode: "insensitive" } } : {}) }, orderBy: [{ title: "asc" }, { id: "asc" }], take: 200 });
      const candidates: Array<{ id: string; title: string; status: TaskStatus }> = [];
      for (const row of rows) {
        try { await this.taskAccess(tx, actor, row); candidates.push({ id: row.id, title: row.title, status: row.status }); }
        catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      }
      return { items: candidates };
    });
  }

  async addDependency(actor: ProjectActor, id: string, input: { predecessorTaskId: string; expectedVersion: number; reason: string }) {
    return this.dependencyCommand(actor, id, input.predecessorTaskId, input.expectedVersion, input.reason, "add");
  }

  async removeDependency(actor: ProjectActor, id: string, predecessorTaskId: string, input: { expectedVersion: number; reason: string }) {
    return this.dependencyCommand(actor, id, predecessorTaskId, input.expectedVersion, input.reason, "remove");
  }

  private async dependencyCommand(actor: ProjectActor, id: string, predecessorTaskId: string, expectedVersion: number, reason: string, action: "add" | "remove") {
    return this.transaction(async (tx) => {
      const preview = await tx.task.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!preview) throw new NotFoundException("Task not found");
      if (!preview.projectId) throw new ConflictException("Dependencies require a project task");
      // Serialize graph edits before locking individual task rows, including opposite edges.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${preview.projectId}::text, 0))::text AS lock`;
      const dependent = await this.task(tx, actor, id, expectedVersion);
      const project = await this.project(tx, actor, preview.projectId, true);
      if (dependent.projectId !== project.id || !this.dependencyOpen(dependent, project)) throw new ConflictException("Task or project does not permit dependency edits");
      await this.dependencyAuthority(tx, actor, dependent, project);
      const predecessor = await tx.task.findFirst({ where: { id: predecessorTaskId, organizationId: actor.organizationId } });
      if (!predecessor || predecessor.projectId !== project.id || predecessor.type === TaskType.CLOSEOUT || predecessor.id === dependent.id) throw new ConflictException("Predecessor must be another accessible task in the same project");
      await this.taskAccess(tx, actor, predecessor);
      reason = reason.trim();
      if (reason.length < 3 || reason.length > 1000) throw new ConflictException("A dependency reason of 3 to 1000 characters is required");
      const existing = await tx.taskDependency.findFirst({ where: { dependentTaskId: id, predecessorTaskId, removedAt: null } });
      if (action === "add" && existing || action === "remove" && !existing) throw new ConflictException("Dependency link changed. Refresh and retry");
      if (action === "add") await assertNoSubtaskDependencyCycle(tx, actor.organizationId, id, predecessorTaskId);
      const updated = await tx.task.update({ where: { id, version: dependent.version }, data: { version: { increment: 1 }, dependencyRevision: { increment: 1 } } });
      const edge = action === "add"
        ? await tx.taskDependency.create({ data: { organizationId: actor.organizationId, dependentTaskId: id, predecessorTaskId, addedById: actor.accountId, addReason: reason, addedTaskVersion: updated.version } })
        : await tx.taskDependency.update({ where: { id: existing!.id }, data: { removedById: actor.accountId, removeReason: reason, removedTaskVersion: updated.version, removedAt: new Date() } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.updated", subjectType: "task", subjectId: id, reason, before: { version: dependent.version, dependencyRevision: dependent.dependencyRevision }, after: { version: updated.version, dependencyRevision: updated.dependencyRevision, dependencyAction: action === "add" ? "added" : "removed", dependencyId: edge.id, predecessorTaskId } });
      return { taskId: id, version: updated.version, dependencyRevision: updated.dependencyRevision, predecessorTaskId, action };
    });
  }

  async transition(actor: ProjectActor, id: string, input: { toState: "IN_PROGRESS" | "COMPLETED"; expectedVersion: number; reason: string; acknowledgeUnfinishedDependencies?: true | undefined }) {
    return this.transaction(async (tx) => {
      const row = await this.task(tx, actor, id, input.expectedVersion);
      const { account, project } = await this.taskAccess(tx, actor, row);
      if (actor.kind !== AccountKind.OWNER && account.employee?.id !== row.primaryOwnerEmployeeId) throw new ForbiddenException("Only the primary owner may progress the task");
      if (row.requiresReassignment) throw new ConflictException("A manager must reassign this task before it resumes");
      if (project && project.status !== (row.type === TaskType.CLOSEOUT ? ProjectStatus.CANCELLED : ProjectStatus.ACTIVE)) throw new ConflictException("Project status does not permit task progress");
      if (row.type === TaskType.CLOSEOUT) {
        const approval = await tx.taskCloseoutApproval.findUnique({ where: { taskId: id } });
        if (!approval || approval.revokedAt) throw new ConflictException("Closeout approval is unavailable");
      }
      let transition;
      try { transition = evaluateTaskStateTransition(row.status, input.toState, row.reviewRequirement !== TaskReviewRequirement.NONE); }
      catch (error) { throw new ConflictException(error instanceof Error ? error.message : "Invalid task transition"); }
      // Hold predecessor rows through commit so completion cannot change the
      // acknowledged set between the start decision and its deferred SQL guard.
      if (input.toState === TaskStatus.IN_PROGRESS) await tx.$queryRaw`
        SELECT predecessor."id" FROM "task_dependencies" edge
        JOIN "tasks" predecessor ON predecessor."id" = edge."predecessorTaskId"
        WHERE edge."dependentTaskId" = ${id}::uuid AND edge."removedAt" IS NULL
        ORDER BY predecessor."id" FOR SHARE OF predecessor`;
      const unfinished = input.toState === TaskStatus.IN_PROGRESS ? await tx.taskDependency.findMany({ where: { dependentTaskId: id, removedAt: null, predecessorTask: { status: { not: TaskStatus.COMPLETED } } }, select: { predecessorTaskId: true }, orderBy: { predecessorTaskId: "asc" } }) : [];
      const unfinishedPredecessorIds = unfinished.map((edge) => edge.predecessorTaskId);
      if (unfinishedPredecessorIds.length > 0 && !input.acknowledgeUnfinishedDependencies) throw new ConflictException("Unfinished dependencies require explicit acknowledgement before starting");
      if (unfinishedPredecessorIds.length === 0 && input.acknowledgeUnfinishedDependencies) throw new ConflictException("No unfinished dependencies require acknowledgement");
      if (input.toState === TaskStatus.COMPLETED) await assertSubtasksCompleted(tx, actor.organizationId, id);
      const updated = await tx.task.update({ where: { id, version: row.version }, data: { status: input.toState, version: { increment: 1 } } });
      await tx.taskStatusChange.create({ data: { organizationId: actor.organizationId, taskId: id, fromStatus: row.status, toStatus: input.toState, actorId: actor.accountId, reason: input.reason, taskVersion: updated.version, ...(transition.previousState ? { previousStatus: transition.previousState } : {}), ...(unfinishedPredecessorIds.length ? { earlyStartAcknowledged: true, unfinishedPredecessorIds } : {}) } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: input.toState === TaskStatus.IN_PROGRESS ? "task.started" : "task.completed", subjectType: "task", subjectId: id, reason: input.reason, before: { status: row.status, version: row.version }, after: { status: updated.status, version: updated.version, ...(unfinishedPredecessorIds.length ? { earlyStartAcknowledged: true, unfinishedPredecessorIds } : {}) } });
      if (input.toState === TaskStatus.COMPLETED) {
        if (row.type === TaskType.CLOSEOUT && row.projectId) await externalRevocationNotices(tx, row.projectId);
        await pauseTimeTimers(tx, { organizationId: actor.organizationId, taskId: id, actorId: actor.accountId, reason: input.reason });
        const dependentEdges = await tx.taskDependency.findMany({ where: { predecessorTaskId: id, removedAt: null, dependentTask: { status: TaskStatus.WAITING, requiresReassignment: false } }, include: { dependentTask: { include: { primaryOwner: { include: { account: true } } } } } });
        const notifications = new NotificationsService(this.database);
        for (const edge of dependentEdges) {
          const dependent = edge.dependentTask;
          if (dependent.waitingDelayCause === null || dependent.primaryOwner.state !== EmployeeState.ACTIVE || dependent.primaryOwner.account.state !== AccountState.ACTIVE) continue;
          const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.dependency_completed", subjectType: "task", subjectId: dependent.id, reason: "Linked predecessor completed", after: { dependentTaskId: dependent.id, predecessorTaskId: id, version: dependent.version } });
          await notifications.createForEvent(tx, { eventId, recipientAccountId: dependent.primaryOwner.accountId, channel: NotificationChannel.IN_APP, category: "task.dependency_completed", title: "A task dependency is complete", body: "A linked predecessor is complete. Review the waiting task before resuming it.", internalRoute: `/?taskId=${dependent.id}`, mandatory: true });
        }
      }
      return updated;
    });
  }

  async wait(actor: ProjectActor, id: string, input: { expectedVersion: number; reason: string; delayCause: string; responsibleParty?: string | undefined }) {
    return this.waitingCommand(actor, id, "wait", input);
  }

  async resume(actor: ProjectActor, id: string, input: { expectedVersion: number; reason: string }) {
    return this.waitingCommand(actor, id, "resume", input);
  }

  async changeCommittedDate(actor: ProjectActor, id: string, input: { expectedVersion: number; committedDueDate: string; reason: string }) {
    return this.transaction(async (tx) => {
      const row = await this.task(tx, actor, id, input.expectedVersion);
      const project = row.projectId ? await this.project(tx, actor, row.projectId, true) : null;
      if (row.type === TaskType.CLOSEOUT) throw new ConflictException("Approved closeout due dates cannot change through this command");
      if (row.status === TaskStatus.COMPLETED || row.status === TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION || row.requiresReassignment) throw new ConflictException("Task state does not permit a committed-date change");
      if (project?.status !== undefined && project.status !== ProjectStatus.ACTIVE) throw new ConflictException("Project status does not permit a committed-date change");
      await this.dateAuthority(tx, actor, row, project);
      const reason = input.reason.trim();
      if (reason.length < 3 || reason.length > 1000) throw new ConflictException("A committed-date reason of 3 to 1000 characters is required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.committedDueDate)) throw new ConflictException("Committed due date is invalid");
      const nextDate = new Date(`${input.committedDueDate}T00:00:00.000Z`);
      if (Number.isNaN(nextDate.getTime()) || nextDate.toISOString().slice(0, 10) !== input.committedDueDate) throw new ConflictException("Committed due date is invalid");
      const oldDate = row.committedDueDate?.toISOString().slice(0, 10) ?? null;
      if (oldDate === input.committedDueDate) throw new ConflictException("Committed due date must change");
      const updated = await tx.task.update({ where: { id, version: row.version }, data: { committedDueDate: nextDate, version: { increment: 1 } } });
      await tx.taskCommittedDateChange.create({ data: { organizationId: actor.organizationId, taskId: id, oldDate: row.committedDueDate, newDate: nextDate, actorId: actor.accountId, reason, taskVersion: updated.version } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.deadline_changed", subjectType: "task", subjectId: id, reason, before: { committedDueDate: oldDate, version: row.version }, after: { committedDueDate: input.committedDueDate, version: updated.version } });
      return updated;
    });
  }

  private extensionOpen(task: TaskRow, project: ProjectRow | null): boolean {
    return task.type !== TaskType.CLOSEOUT && !!task.committedDueDate &&
      task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION &&
      !task.requiresReassignment && (!project || project.status === ProjectStatus.ACTIVE);
  }

  private extensionDate(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ConflictException("Proposed date is invalid");
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ConflictException("Proposed date is invalid");
    return date;
  }

  async extensionApprovers(actor: ProjectActor, id: string) {
    return this.transaction(async (tx) => {
      const task = await tx.task.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!task) throw new NotFoundException("Task not found");
      const { account, project } = await this.taskAccess(tx, actor, task);
      if (actor.kind !== AccountKind.STAFF || account.employee?.id !== task.primaryOwnerEmployeeId || !this.extensionOpen(task, project)) throw new ForbiddenException("Extension request is unavailable");
      const owner = await tx.account.findFirst({ where: { kind: AccountKind.OWNER, state: AccountState.ACTIVE }, select: { id: true, normalizedEmail: true } });
      const items: Array<{ accountId: string; name: string; kind: AccountKind }> = owner ? [{ accountId: owner.id, name: owner.normalizedEmail, kind: AccountKind.OWNER }] : [];
      const candidates = await tx.account.findMany({ where: { kind: AccountKind.STAFF, state: AccountState.ACTIVE, employee: { organizationId: actor.organizationId, state: EmployeeState.ACTIVE } }, select: { id: true, normalizedEmail: true }, orderBy: [{ normalizedEmail: "asc" }, { id: "asc" }] });
      for (const candidate of candidates) {
        if (candidate.id === actor.accountId) continue;
        try {
          const approverActor = { accountId: candidate.id, organizationId: actor.organizationId, kind: AccountKind.STAFF };
          await this.taskAccess(tx, approverActor, task);
          await this.dateAuthority(tx, approverActor, task, project);
          items.push({ accountId: candidate.id, name: candidate.normalizedEmail, kind: AccountKind.STAFF });
        } catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
      }
      return { items };
    });
  }

  async requestExtension(actor: ProjectActor, id: string, input: { expectedVersion: number; proposedDate: string; approverAccountId: string; reason: string }) {
    return this.transaction(async (tx) => {
      const task = await this.task(tx, actor, id, input.expectedVersion);
      const project = task.projectId ? await this.project(tx, actor, task.projectId, true) : null;
      const { account } = await this.taskAccess(tx, actor, task);
      if (actor.kind !== AccountKind.STAFF || account.employee?.id !== task.primaryOwnerEmployeeId || !this.extensionOpen(task, project)) throw new ForbiddenException("Only the current primary owner may request an extension");
      const date = this.extensionDate(input.proposedDate);
      if (date <= task.committedDueDate!) throw new ConflictException("An extension must move the committed date later");
      const reason = input.reason.trim();
      if (reason.length < 3 || reason.length > 1000) throw new ConflictException("An extension reason of 3 to 1000 characters is required");
      const selected = await tx.account.findUnique({ where: { id: input.approverAccountId } });
      if (!selected || selected.state !== AccountState.ACTIVE || selected.id === actor.accountId) throw new ForbiddenException("Selected approver is unavailable");
      const approverActor = { accountId: selected.id, organizationId: actor.organizationId, kind: selected.kind };
      await this.taskAccess(tx, approverActor, task);
      await this.dateAuthority(tx, approverActor, task, project);
      if (await tx.approvalRequest.findFirst({ where: { organizationId: actor.organizationId, typeKey: EXTENSION_TYPE, sourceId: id, state: "PENDING" } })) throw new ConflictException("A deadline extension is already pending");
      const latest = await tx.approvalRequest.findFirst({ where: { organizationId: actor.organizationId, typeKey: EXTENSION_TYPE, sourceId: id }, orderBy: { sourceGeneration: "desc" }, select: { sourceGeneration: true } });
      const context: ExtensionContext = { taskId: id, previousDate: task.committedDueDate!.toISOString().slice(0, 10), proposedDate: input.proposedDate, ownerEmployeeId: task.primaryOwnerEmployeeId, approverAccountId: selected.id, taskVersion: task.version };
      const request = await this.approvals.createRequest(tx, actor, EXTENSION_TYPE, { sourceType: "task", sourceId: id, sourceGeneration: (latest?.sourceGeneration ?? 0) + 1, reason, context });
      return { approvalId: request.id, state: request.state };
    });
  }

  async decideExtension(actor: ProjectActor, taskId: string, approvalId: string, input: { outcome: "APPROVED" | "REJECTED"; reason: string }) {
    return this.transaction(async (tx) => {
      const request = await tx.approvalRequest.findFirst({ where: { id: approvalId, organizationId: actor.organizationId, typeKey: EXTENSION_TYPE, sourceType: "task", sourceId: taskId } });
      if (!request) throw new NotFoundException("Extension request not found");
      await this.approvals.decide(tx, actor, approvalId, input);
      return { approvalId, outcome: input.outcome };
    });
  }

  async withdrawExtension(actor: ProjectActor, taskId: string, approvalId: string, reason: string) {
    return this.transaction(async (tx) => {
      const request = await tx.approvalRequest.findFirst({ where: { id: approvalId, organizationId: actor.organizationId, typeKey: EXTENSION_TYPE, sourceType: "task", sourceId: taskId } });
      if (!request) throw new NotFoundException("Extension request not found");
      const withdrawn = await this.approvals.withdraw(tx, actor, approvalId, reason.trim());
      return { approvalId: withdrawn.id, state: withdrawn.state };
    });
  }

  private extensionHandler(): ApprovalHandler {
    return {
      typeKey: EXTENSION_TYPE,
      canSelfApprove: false,
      resolveApprover: async (tx, actor, input) => {
        if (input.sourceType !== "task") throw new ForbiddenException("Invalid extension source");
        const context = extensionContext(input.context);
        if (context.taskId !== input.sourceId) throw new ForbiddenException("Invalid extension source");
        const task = await tx.task.findFirst({ where: { id: context.taskId, organizationId: actor.organizationId } });
        if (!task) throw new NotFoundException("Task not found");
        const { account, project } = await this.taskAccess(tx, { ...actor, kind: AccountKind.STAFF }, task);
        if (account.employee?.id !== task.primaryOwnerEmployeeId || account.employee.id !== context.ownerEmployeeId || context.taskVersion !== task.version || !this.extensionOpen(task, project) ||
          task.committedDueDate?.toISOString().slice(0, 10) !== context.previousDate || this.extensionDate(context.proposedDate) <= task.committedDueDate) throw new ConflictException("Extension request is stale");
        const selected = await tx.account.findUnique({ where: { id: context.approverAccountId } });
        if (!selected || selected.state !== AccountState.ACTIVE || selected.id === actor.accountId) throw new ForbiddenException("Selected approver is unavailable");
        const approverActor = { accountId: selected.id, organizationId: actor.organizationId, kind: selected.kind };
        await this.taskAccess(tx, approverActor, task);
        await this.dateAuthority(tx, approverActor, task, project);
        return { accountId: selected.id, level: selected.kind === AccountKind.OWNER ? "Owner" : "Scoped manager" };
      },
      canView: async (tx, actor, request) => {
        try {
          const account = await this.activeActor(tx, { ...actor, kind: (await tx.account.findUniqueOrThrow({ where: { id: actor.accountId } })).kind });
          if (actor.accountId !== request.requesterId && actor.accountId !== request.approverId && account.kind !== AccountKind.OWNER) return false;
          const task = await tx.task.findFirst({ where: { id: request.sourceId, organizationId: actor.organizationId } });
          if (!task) return false;
          await this.taskAccess(tx, { ...actor, kind: account.kind }, task);
          return true;
        } catch (error) { if (error instanceof ForbiddenException || error instanceof NotFoundException) return false; throw error; }
      },
      canDecide: async (tx, actor, request, context) => {
        if (context.delegated || request.approverId !== actor.accountId) return false;
        const candidate = await tx.account.findUnique({ where: { id: actor.accountId } });
        const task = await tx.task.findFirst({ where: { id: request.sourceId, organizationId: actor.organizationId } });
        if (!candidate || !task) return false;
        const project = task.projectId ? await this.project(tx, { ...actor, kind: candidate.kind }, task.projectId) : null;
        try {
          const approverActor = { ...actor, kind: candidate.kind };
          await this.taskAccess(tx, approverActor, task);
          await this.dateAuthority(tx, approverActor, task, project);
          return true;
        }
        catch (error) { if (error instanceof ForbiddenException) return false; throw error; }
      },
      canWithdraw: async (tx, actor, request) => {
        const candidate = await tx.account.findUnique({ where: { id: actor.accountId } });
        if (candidate?.kind !== AccountKind.OWNER) return false;
        const task = await tx.task.findFirst({ where: { id: request.sourceId, organizationId: actor.organizationId } });
        if (!task) return false;
        await this.taskAccess(tx, { ...actor, kind: candidate.kind }, task);
        return true;
      },
      projectCard: async (tx, request) => {
        const context = extensionContext(request.context);
        const [task, requester] = await Promise.all([
          tx.task.findUnique({ where: { id: context.taskId }, select: { title: true } }),
          tx.account.findUnique({ where: { id: request.requesterId }, select: { normalizedEmail: true } })
        ]);
        return { title: "Deadline extension", summary: `${context.previousDate} → ${context.proposedDate}`, subjectLabel: task?.title ?? "Task", requesterLabel: requester?.normalizedEmail ?? "Employee", levelLabel: request.approvalLevel };
      },
      onDecision: async (tx, request, decision, deciderId) => {
        if (decision.outcome !== "APPROVED") return;
        const context = extensionContext(request.context);
        const actor = { accountId: deciderId, organizationId: request.organizationId, kind: (await tx.account.findUniqueOrThrow({ where: { id: deciderId } })).kind };
        const task = await this.task(tx, actor, context.taskId);
        const project = task.projectId ? await this.project(tx, actor, task.projectId, true) : null;
        await this.taskAccess(tx, actor, task);
        await this.dateAuthority(tx, actor, task, project);
        if (context.taskVersion !== task.version || !this.extensionOpen(task, project) || task.primaryOwnerEmployeeId !== context.ownerEmployeeId ||
          task.committedDueDate?.toISOString().slice(0, 10) !== context.previousDate) throw new ConflictException("Extension request is stale. No deadline changed");
        const nextDate = this.extensionDate(context.proposedDate);
        if (nextDate <= task.committedDueDate!) throw new ConflictException("Extension request is stale. No deadline changed");
        const updated = await tx.task.update({ where: { id: task.id, version: task.version }, data: { committedDueDate: nextDate, version: { increment: 1 } } });
        await tx.taskCommittedDateChange.create({ data: { organizationId: request.organizationId, taskId: task.id, oldDate: task.committedDueDate, newDate: nextDate, actorId: deciderId, reason: decision.reason.trim(), taskVersion: updated.version, extensionApprovalId: request.id } });
        await recordProjectEvent(tx, { organizationId: request.organizationId, actorId: deciderId, eventName: "task.deadline_changed", subjectType: "task", subjectId: task.id, reason: decision.reason.trim(), before: { committedDueDate: context.previousDate, version: task.version }, after: { committedDueDate: context.proposedDate, version: updated.version, extensionApprovalId: request.id } });
      }
    };
  }

  private async waitingCommand(actor: ProjectActor, id: string, command: "wait" | "resume", input: { expectedVersion: number; reason: string; delayCause?: string | undefined; responsibleParty?: string | undefined }) {
    return this.transaction(async (tx) => {
      const row = await this.task(tx, actor, id, input.expectedVersion);
      const { account, project } = await this.taskAccess(tx, actor, row);
      if (actor.kind !== AccountKind.OWNER && account.employee?.id !== row.primaryOwnerEmployeeId) throw new ForbiddenException("Only the primary owner may progress the task");
      if (row.requiresReassignment) throw new ConflictException("A manager must reassign this task before it resumes");
      if (project && project.status !== (row.type === TaskType.CLOSEOUT ? ProjectStatus.CANCELLED : ProjectStatus.ACTIVE)) throw new ConflictException("Project status does not permit task progress");
      if (row.type === TaskType.CLOSEOUT && !await tx.taskCloseoutApproval.findFirst({ where: { taskId: id, revokedAt: null } })) throw new ConflictException("Closeout approval is unavailable");
      let transition;
      try {
        transition = command === "wait" ? evaluateTaskWaiting(row.status, input.reason, input.delayCause ?? "") : evaluateTaskResume(row.status, row.waitingPreviousStatus, row.requiresReassignment, input.reason);
      } catch (error) { throw new ConflictException(error instanceof Error ? error.message : "Invalid waiting transition"); }
      const responsibleParty = command === "wait" ? input.responsibleParty?.trim() ?? null : row.waitingResponsibleParty;
      if (responsibleParty !== null && (responsibleParty.length < 1 || responsibleParty.length > 160)) throw new ConflictException("Responsible party must be 1 to 160 characters");
      const delayCause = command === "wait" ? input.delayCause!.trim() : row.waitingDelayCause;
      if (command === "wait") await pauseTimeTimers(tx, { organizationId: actor.organizationId, taskId: id, actorId: actor.accountId, reason: input.reason });
      const updated = await tx.task.update({ where: { id, version: row.version }, data: {
        status: transition.to, waitingPreviousStatus: command === "wait" ? row.status : null,
        waitingReason: command === "wait" ? transition.reason! : null, waitingDelayCause: command === "wait" ? delayCause : null,
        waitingResponsibleParty: command === "wait" ? responsibleParty : null, version: { increment: 1 }
      } });
      await tx.taskStatusChange.create({ data: { organizationId: actor.organizationId, taskId: id, fromStatus: row.status, toStatus: transition.to, previousStatus: transition.previousState ?? null, actorId: actor.accountId, reason: transition.reason!, delayCause, responsibleParty, taskVersion: updated.version } });
      const owner = await tx.employee.findUniqueOrThrow({ where: { id: row.primaryOwnerEmployeeId }, select: { homeTeamId: true } });
      const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: command === "wait" ? "task.waiting" : "task.started", subjectType: "task", subjectId: id, reason: transition.reason!, before: { status: row.status, version: row.version }, after: { status: updated.status, version: updated.version, previousStatus: transition.previousState ?? null, delayCause, responsibleParty, ownerEmployeeId: row.primaryOwnerEmployeeId, ownerTeamId: owner.homeTeamId, ...(command === "resume" ? { resumedFromWaiting: true } : {}) } });
      if (command === "wait") await this.queueWaitingAlerts(tx, updated, eventId);
      return updated;
    });
  }

  async reassign(actor: ProjectActor, id: string, input: { newOwnerEmployeeId: string; expectedVersion: number; reason: string; acknowledgeOverload?: boolean | undefined }) {
    return this.transaction(async (tx) => {
      const row = await this.task(tx, actor, id, input.expectedVersion);
      await this.taskAccess(tx, actor, row);
      const project = row.projectId ? await this.project(tx, actor, row.projectId, true) : undefined;
      const target = project ? await this.eligibleForProject(tx, actor, project, input.newOwnerEmployeeId) : await this.employee(tx, actor, input.newOwnerEmployeeId);
      await this.managedEmployee(tx, actor, target, project);
      if (this.workforce && !input.acknowledgeOverload && await this.workforce.assignmentWarning(tx,actor,target.id)) throw new ConflictException("Overload warning: review employee capacity and acknowledge before reassigning work");
      if (row.primaryOwnerEmployeeId === target.id || row.status === TaskStatus.COMPLETED || row.status === TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION) throw new ConflictException("Task cannot be reassigned");
      if (project && project.status !== (row.type === TaskType.CLOSEOUT ? ProjectStatus.CANCELLED : ProjectStatus.ACTIVE)) throw new ConflictException("Project status does not permit task reassignment");
      if (row.type === TaskType.CLOSEOUT && !(await tx.taskCloseoutApproval.findFirst({ where: { taskId: id, revokedAt: null } }))) throw new ConflictException("Closeout approval is unavailable");
      const resumed = row.requiresReassignment ? row.waitingPreviousStatus === TaskStatus.NOT_STARTED ? TaskStatus.NOT_STARTED : TaskStatus.IN_PROGRESS : row.status;
      if (row.requiresReassignment && !row.waitingPreviousStatus) throw new ConflictException("Task resume history is unavailable");
      const updated = await tx.task.update({ where: { id, version: row.version }, data: { primaryOwnerEmployeeId: target.id, status: resumed, requiresReassignment: false, ...(row.requiresReassignment ? { waitingPreviousStatus: null, waitingReason: null, waitingDelayCause: null, waitingResponsibleParty: null } : {}), version: { increment: 1 } } });
      const promotedCollaborator = await tx.taskCollaborator.findFirst({ where: { taskId: id, employeeId: target.id } });
      if (promotedCollaborator) await tx.taskCollaborator.delete({ where: { id: promotedCollaborator.id } });
      await tx.taskOwnerChange.create({ data: { organizationId: actor.organizationId, taskId: id, oldOwnerEmployeeId: row.primaryOwnerEmployeeId, newOwnerEmployeeId: target.id, actorId: actor.accountId, reason: input.reason, taskVersion: updated.version } });
      if (row.status !== resumed) await tx.taskStatusChange.create({ data: { organizationId: actor.organizationId, taskId: id, fromStatus: row.status, toStatus: resumed, previousStatus: row.waitingPreviousStatus, actorId: actor.accountId, reason: input.reason, taskVersion: updated.version } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.assigned", subjectType: "task", subjectId: id, reason: input.reason, before: { ownerEmployeeId: row.primaryOwnerEmployeeId, status: row.status, version: row.version }, after: { ownerEmployeeId: target.id, status: updated.status, version: updated.version, ...(promotedCollaborator ? { promotedCollaboratorEstimatedHours: promotedCollaborator.estimatedHours === null ? null : Number(promotedCollaborator.estimatedHours) } : {}) } });
      return updated;
    });
  }

  /** Called by the Owner employee-exit command inside its transaction. */
  async waitForEmployeeExit(tx: Tx, organizationId: string, employeeId: string, actorId: string) {
    const rows = await tx.task.findMany({ where: { organizationId, primaryOwnerEmployeeId: employeeId, status: { notIn: [TaskStatus.COMPLETED, TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION] } }, orderBy: { id: "asc" } });
    const affected: string[] = [];
    for (const row of rows) {
      await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
      const current = await tx.task.findUniqueOrThrow({ where: { id: row.id } });
      if (current.primaryOwnerEmployeeId !== employeeId) continue;
      const transition = evaluateEmployeeExitTask(current.status);
      if (!transition.changed) continue;
      const reason = transition.reason!;
      const updated = await tx.task.update({ where: { id: row.id, version: current.version }, data: { status: TaskStatus.WAITING, requiresReassignment: true, waitingPreviousStatus: current.status, waitingReason: reason, waitingDelayCause: null, waitingResponsibleParty: null, version: { increment: 1 } } });
      await tx.taskStatusChange.create({ data: { organizationId, taskId: row.id, fromStatus: current.status, toStatus: TaskStatus.WAITING, previousStatus: current.status, actorId, reason, taskVersion: updated.version } });
      await recordProjectEvent(tx, { organizationId, actorId, eventName: "task.waiting", subjectType: "task", subjectId: row.id, reason, before: { ownerEmployeeId: employeeId, status: current.status }, after: { ownerEmployeeId: employeeId, status: TaskStatus.WAITING, requiresReassignment: true, version: updated.version } });
      affected.push(row.id);
    }
    return affected;
  }

  /** Called by the Owner cancellation command inside its project transaction. */
  async stopForProjectCancellation(tx: Tx, organizationId: string, projectId: string, projectStatusChangeId: string, actorId: string, reason: string) {
    const rows = await tx.task.findMany({ where: { organizationId, projectId, type: { not: TaskType.CLOSEOUT }, status: { notIn: [TaskStatus.COMPLETED, TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION] } }, orderBy: { id: "asc" } });
    const affected: string[] = [];
    for (const row of rows) {
      await tx.$queryRaw`SELECT "id" FROM "tasks" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
      const current = await tx.task.findUniqueOrThrow({ where: { id: row.id } });
      const transition = evaluateProjectCancellationTask(current.status, true, reason);
      if (!transition.changed) continue;
      const updated = await tx.task.update({ where: { id: row.id, version: current.version }, data: { status: TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION, requiresReassignment: false, waitingPreviousStatus: null, waitingReason: null, waitingDelayCause: null, waitingResponsibleParty: null, version: { increment: 1 } } });
      await tx.taskStatusChange.create({ data: { organizationId, taskId: row.id, fromStatus: current.status, toStatus: updated.status, previousStatus: current.status, actorId, reason, taskVersion: updated.version, projectStatusChangeId } });
      await recordProjectEvent(tx, { organizationId, actorId, eventName: "task.stopped", subjectType: "task", subjectId: row.id, reason, before: { status: current.status }, after: { status: updated.status, projectStatusChangeId, version: updated.version } });
      affected.push(row.id);
    }
    return affected;
  }

  async createCloseout(actor: ProjectActor, input: { projectId: string; ownerEmployeeId: string; title: string; workScope: string; targetDate: string; priority: TaskPriority; reason: string }) {
    return this.transaction(async (tx) => {
      const account = await this.activeActor(tx, actor);
      const project = await this.project(tx, actor, input.projectId, true);
      if (project.status !== ProjectStatus.CANCELLED) throw new ConflictException("Closeout requires a Cancelled project");
      if (actor.kind !== AccountKind.STAFF || !account.employee) throw new ForbiddenException("Assigned Project Lead or granted Team Leader approval is required");
      await this.projectAccess(tx, actor, project);
      if (account.employee.id !== project.currentLeadEmployeeId) {
        await this.authorization.assertPermission(actor.accountId, "project.closeout_approve", { kind: "BRANCH", organizationId: actor.organizationId, branchId: project.branchId }, tx);
      }
      await this.eligibleForProject(tx, actor, project, input.ownerEmployeeId);
      const targetDate = new Date(`${input.targetDate}T00:00:00.000Z`);
      if (Number.isNaN(targetDate.getTime())) throw new ConflictException("Target date is invalid");
      const row = await tx.task.create({ data: { organizationId: actor.organizationId, projectId: project.id, title: input.title, description: input.workScope, type: TaskType.CLOSEOUT, priority: input.priority, targetDate, primaryOwnerEmployeeId: input.ownerEmployeeId, createdById: actor.accountId } });
      await tx.taskStatusChange.create({ data: { organizationId: actor.organizationId, taskId: row.id, toStatus: TaskStatus.NOT_STARTED, actorId: actor.accountId, reason: input.reason, taskVersion: 1 } });
      await tx.taskCloseoutApproval.create({ data: { organizationId: actor.organizationId, taskId: row.id, approverId: actor.accountId, reason: input.reason, workScope: input.workScope } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.created", subjectType: "task", subjectId: row.id, reason: input.reason, after: { taskId: row.id, projectId: project.id, ownerEmployeeId: input.ownerEmployeeId, type: TaskType.CLOSEOUT, priority: input.priority, targetDate: input.targetDate, version: 1 } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.closeout_approved", subjectType: "task", subjectId: row.id, reason: input.reason, after: { taskId: row.id, projectId: project.id, workScope: input.workScope, ownerEmployeeId: input.ownerEmployeeId, targetDate: input.targetDate } });
      return row;
    });
  }

  async revokeCloseout(actor: ProjectActor, id: string, reason: string) {
    if (actor.kind !== AccountKind.OWNER) throw new ForbiddenException("Owner access is required");
    return this.transaction(async (tx) => {
      await this.activeActor(tx, actor);
      const task = await this.task(tx, actor, id);
      if (task.type !== TaskType.CLOSEOUT) throw new ConflictException("Task is not closeout work");
      const approval = await tx.taskCloseoutApproval.findUnique({ where: { taskId: id } });
      if (!approval || approval.revokedAt) throw new ConflictException("Closeout approval is unavailable");
      await tx.taskCloseoutApproval.update({ where: { id: approval.id }, data: { revokedAt: new Date(), revokedById: actor.accountId, revocationReason: reason } });
        await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.updated", subjectType: "task", subjectId: id, reason, before: { closeoutApprovalRevoked: false }, after: { closeoutApprovalRevoked: true } });
        if (task.projectId) await externalRevocationNotices(tx, task.projectId);
      return { revoked: true };
    });
  }

  async edit(actor: ProjectActor, id: string, input: { expectedVersion: number; reason: string; title: string; description?: string | undefined; targetDate: string; startDate?: string | undefined; estimatedHours?: number | undefined; priority: TaskPriority; planItemId?: string | null | undefined; tags?: string[] | undefined; checklist?: Array<{ label: string; checked: boolean }> | undefined }) {
    return this.transaction(async (tx) => {
      const row = await this.task(tx, actor, id, input.expectedVersion);
      const { account, project } = await this.taskAccess(tx, actor, row);
      if (actor.kind !== AccountKind.OWNER && account.employee?.id !== row.primaryOwnerEmployeeId) throw new ForbiddenException("Only the primary owner may edit this task");
      if (new Set<TaskStatus>([TaskStatus.SUBMITTED_INTERNAL_REVIEW, TaskStatus.IN_INTERNAL_REVIEW, TaskStatus.INTERNAL_APPROVED, TaskStatus.SUBMITTED_CLIENT_REVIEW, TaskStatus.IN_CLIENT_REVIEW, TaskStatus.CLIENT_APPROVED, TaskStatus.COMPLETED, TaskStatus.STOPPED_DUE_TO_PROJECT_CANCELLATION]).has(row.status) || row.requiresReassignment) throw new ConflictException("Task cannot be edited in this state");
      if (project && project.status !== (row.type === TaskType.CLOSEOUT ? ProjectStatus.CANCELLED : ProjectStatus.ACTIVE)) throw new ConflictException("Project status does not permit editing");
      if (row.type === TaskType.CLOSEOUT) throw new ConflictException("Approved closeout scope and date cannot be edited");
      if (input.planItemId && (!project || !await tx.projectPlanItem.findFirst({ where: { id: input.planItemId, projectId: project.id, organizationId: actor.organizationId } }))) throw new ConflictException("Plan item must belong to the task project");
      if (input.tags && new Set(input.tags).size !== input.tags.length) throw new ConflictException("Tags must be distinct");
      const targetDate = new Date(`${input.targetDate}T00:00:00.000Z`);
      const startDate = input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : null;
      if (Number.isNaN(targetDate.getTime()) || startDate && startDate > targetDate) throw new ConflictException("Task dates are invalid");
      const updated = await tx.task.update({ where: { id, version: row.version }, data: { title: input.title, description: input.description ?? null, targetDate, startDate, estimatedHours: input.estimatedHours ?? null, priority: input.priority, ...(input.planItemId === undefined ? {} : { planItemId: input.planItemId }), ...(input.tags === undefined ? {} : { tags: input.tags }), ...(input.checklist === undefined ? {} : { checklist: input.checklist }), version: { increment: 1 } } });
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "task.updated", subjectType: "task", subjectId: id, reason: input.reason, before: { title: row.title, description: row.description, targetDate: row.targetDate.toISOString().slice(0, 10), startDate: row.startDate?.toISOString().slice(0, 10) ?? null, estimatedHours: row.estimatedHours === null ? null : Number(row.estimatedHours), priority: row.priority, planItemId: row.planItemId, tags: row.tags, checklist: row.checklist, version: row.version }, after: { title: updated.title, description: updated.description, targetDate: updated.targetDate.toISOString().slice(0, 10), startDate: updated.startDate?.toISOString().slice(0, 10) ?? null, estimatedHours: updated.estimatedHours === null ? null : Number(updated.estimatedHours), priority: updated.priority, planItemId: updated.planItemId, tags: updated.tags, checklist: updated.checklist, version: updated.version } });
      return updated;
    });
  }

  async cancelProject(actor: ProjectActor, projectId: string, input: { expectedVersion: number; reason: string; clientAccessEndTimes?: { grantId: string; expectedVersion: number; expiresAt: string }[] | undefined }) {
    if (actor.kind !== AccountKind.OWNER) throw new ForbiddenException("Owner access is required");
    // Native NAS revocation is a human action outside PostgreSQL. Preserve the
    // pending request in its own transaction before rejecting finalization.
    const preflight = () => this.transaction(async tx => {
      await this.activeActor(tx, actor);
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid AND "organizationId"=${actor.organizationId}::uuid FOR UPDATE`;
      const project = await this.project(tx, actor, projectId);
      if (project.version !== input.expectedVersion) throw new ConflictException("Project changed. Refresh and retry");
      const links = await externalCancellationBlockers(tx, projectId);
      if (links.length && [ProjectStatus.DRAFT, ProjectStatus.ACTIVE, ProjectStatus.ON_HOLD].includes(project.status as "DRAFT" | "ACTIVE" | "ON_HOLD")) {
        const pending = await tx.projectCancellationRequest.findFirst({ where: { projectId, reason: input.reason } });
        if (!pending) {
          const request = await tx.projectCancellationRequest.create({ data: { organizationId: actor.organizationId, projectId, requesterId: actor.accountId, reason: input.reason } });
          await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "project.cancellation_requested", subjectType: "project", subjectId: projectId, reason: input.reason, after: { requestId: request.id, status: project.status, nativeLinkBlockerIds: links.map(link => link.id) } });
        }
      }
      return links;
    });
    const blockers = await preflight();
    if (blockers.length) throw new ConflictException({ message: "Confirm native CAD link cancellation before finalizing project cancellation", nativeLinkBlockers: blockers });
    return this.transaction(async (tx) => {
      await this.activeActor(tx, actor);
      await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
      const project = await this.project(tx, actor, projectId);
      if (project.version !== input.expectedVersion) throw new ConflictException("Project changed. Refresh and retry");
        if (project.status !== ProjectStatus.DRAFT && project.status !== ProjectStatus.ACTIVE && project.status !== ProjectStatus.ON_HOLD) throw new ConflictException("Project cannot be cancelled from this state");
        await cancelExternalGrants(tx, actor.accountId, projectId, input.reason);
      const grants = await tx.clientPortalGrant.findMany({ where: { projectId, organizationId: actor.organizationId, revokedAt: null }, orderBy: { id: "asc" } });
      const endTimes = input.clientAccessEndTimes ?? [];
      if (new Set(endTimes.map((row) => row.grantId)).size !== endTimes.length || endTimes.some((row) => !grants.some((grant) => grant.id === row.grantId))) throw new ConflictException("Client access end times must match current project grants");
      for (const grant of grants) {
        const end = endTimes.find((row) => row.grantId === grant.id);
        const expiresAt = end ? new Date(end.expiresAt) : grant.expiresAt;
        if (end && end.expectedVersion !== grant.version) throw new ConflictException("Client access changed. Refresh and retry");
        if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new ConflictException("Owner-selected future end time is required for each client grant");
        if (end) {
          const updatedGrant = await tx.clientPortalGrant.update({ where: { id: grant.id, version: grant.version }, data: { expiresAt, version: { increment: 1 } } });
          const beforeAccess = { primary: grant.primary, expiresAt: grant.expiresAt?.toISOString() ?? null, revokedAt: null };
          const access = { primary: updatedGrant.primary, expiresAt: expiresAt.toISOString(), revokedAt: null };
          const eventId = await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "client.access_changed", subjectType: "client_access", subjectId: grant.id, reason: input.reason, before: { access: beforeAccess }, after: { projectId, accountId: grant.accountId, version: updatedGrant.version, access } });
          const event = await tx.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
          await tx.clientPortalGrantChange.create({ data: { organizationId: actor.organizationId, projectId, grantId: grant.id, grantVersion: updatedGrant.version, actorId: actor.accountId, reason: input.reason, before: beforeAccess, after: access, auditEventId: (event.payload as { auditEventId: string }).auditEventId } });
        }
      }
      const packages = await tx.clientReviewPackage.findMany({ where: { projectId, organizationId: actor.organizationId, status: "OPEN" }, orderBy: { id: "asc" } });
      for (const item of await tx.clientReviewItem.findMany({ where: { projectId, status: { in: ["PENDING", "IN_REVIEW"] } }, orderBy: { id: "asc" } })) {
        const withdrawn = await tx.clientReviewItem.update({ where: { id: item.id, version: item.version }, data: { status: "WITHDRAWN", version: { increment: 1 } } });
        await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "client.review_withdrawn", subjectType: "client_review_item", subjectId: item.id, reason: input.reason, before: { status: item.status, version: item.version }, after: { projectId, itemId: item.id, packageId: item.packageId, status: withdrawn.status, version: withdrawn.version } });
      }
      for (const batch of packages) {
        const withdrawn = await tx.clientReviewPackage.update({ where: { id: batch.id, version: batch.version }, data: { status: "WITHDRAWN", version: { increment: 1 } } });
        await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "client.review_withdrawn", subjectType: "client_review_package", subjectId: batch.id, reason: input.reason, before: { status: batch.status, version: batch.version }, after: { projectId, packageId: batch.id, status: withdrawn.status, version: withdrawn.version } });
      }
      await pauseTimeTimers(tx, { organizationId: actor.organizationId, projectId, actorId: actor.accountId, reason: input.reason });
      const updated = await tx.project.update({ where: { id: projectId, version: project.version }, data: { status: ProjectStatus.CANCELLED, version: { increment: 1 } } });
      const change = await tx.projectStatusChange.create({ data: { projectId, organizationId: actor.organizationId, fromStatus: project.status, toStatus: ProjectStatus.CANCELLED, projectVersion: updated.version, reason: input.reason, actorId: actor.accountId } });
      const stoppedTaskIds = await this.stopForProjectCancellation(tx, actor.organizationId, projectId, change.id, actor.accountId, input.reason);
      await recordProjectEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, eventName: "project.cancelled", subjectType: "project", subjectId: projectId, reason: input.reason, before: { status: project.status, version: project.version }, after: { status: updated.status, version: updated.version, stoppedTaskCount: stoppedTaskIds.length } });
        return { project: updated, stoppedTaskIds };
      }).catch(async (error: unknown) => {
        const response = error instanceof ConflictException ? error.getResponse() : null;
        if (response && typeof response === "object" && "nativeLinkBlockers" in response) await preflight();
        throw error;
      });
  }
}
