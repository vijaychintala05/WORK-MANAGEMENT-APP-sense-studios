import { ReviewRoutingService } from "./review-routing.service.js";
import { IntegrationService } from "./integration.service.js";
import { IntegrationController } from "./integration.controller.js";
import { SiteService } from "./site.service.js";
import { SiteController } from "./site.controller.js";
import { Module } from "@nestjs/common";
import { TimeController } from "./time.controller.js";
import { TimeService } from "./time.service.js";
import { TimeWorker } from "./time-worker.js";
import { WorkforceController } from "./workforce.controller.js";
import { WorkforceService } from "./workforce.service.js";
import { PerformanceController } from "./performance.controller.js";
import { PerformanceService } from "./performance.service.js";
import { DashboardService } from "./dashboard.service.js";
import { DashboardController } from "./dashboard.controller.js";
import { AutomationService } from "./automation.service.js";
import { AutomationController } from "./automation.controller.js";
import { AiAssistanceController } from "./ai-assistance.controller.js";
import { AiAssistanceService } from "./ai-assistance.service.js";
import { APP_GUARD } from "@nestjs/core";
import { loadRuntimeConfig, RUNTIME_CONFIG } from "./config.js";
import { DATABASE_PROBE, DatabaseService } from "./database.service.js";
import { HealthController } from "./health.controller.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";
import { AuthGuard } from "./auth.guard.js";
import { OrganizationController } from "./organization.controller.js";
import { OrganizationService } from "./organization.service.js";
import { AuthorizationService } from "./authorization.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { BrevoEmailAdapter } from "./brevo-email.js";
import { CURRENT_RECIPIENT_AUTHORIZATION_PREDICATE, NotificationWorker, OperationalRecipientPredicate, PersistedVerifiedAddressPredicate, VERIFIED_ADDRESS_PREDICATE } from "./notification-worker.js";
import { AuditRetentionController } from "./audit-retention.controller.js";
import { AuditRetentionService } from "./audit-retention.service.js";
import { EmailVerificationService } from "./email-verification.service.js";
import { ApprovalService } from "./approval.service.js";
import { ApprovalsController } from "./approvals.controller.js";
import { CrmController } from "./crm.controller.js";
import { CrmService } from "./crm.service.js";
import { ProjectController } from "./project.controller.js";
import { ProjectService } from "./project.service.js";
import { ProjectWorkflowService } from "./project-workflow.service.js";
import { ProjectTemplateService } from "./project-template.service.js";
import { ProjectTemplateController } from "./project-template.controller.js";
import { TaskController } from "./task.controller.js";
import { TaskService } from "./task.service.js";
import { MyWorkController } from "./my-work.controller.js";
import { MyWorkService } from "./my-work.service.js";
import { TaskRecurrenceController } from "./task-recurrence.controller.js";
import { TaskRecurrenceService } from "./task-recurrence.service.js";
import { DocumentController } from "./document.controller.js";
import { DocumentService } from "./document.service.js";
import { RevisionController } from "./revision.controller.js";
import { RevisionService } from "./revision.service.js";
import { ReviewController } from "./review.controller.js";
import { ReviewService } from "./review.service.js";
import { ClientPortalIdentityService } from "./client-portal-identity.service.js";
import { ClientPortalIdentityController } from "./client-portal-identity.controller.js";
import { ClientPortalAccessService } from "./client-portal-access.service.js";
import { ClientPortalAccessController } from "./client-portal-access.controller.js";
import { ClientPortalScopeService } from "./client-portal-scope.service.js";
import { ClientPortalFilesService } from "./client-portal-files.service.js";
import { ClientPortalScopeController } from "./client-portal-scope.controller.js";
import { ClientReviewService } from "./client-review.service.js";
import { ClientReviewController } from "./client-review.controller.js";
import { ClientPortalReviewController } from "./client-portal-review.controller.js";
import { GalleryController, PortfolioController, ClientGalleryController, PublicPortfolioController } from "./gallery.controller.js";
import { GalleryService } from "./gallery.service.js";
import { SkillsController } from "./skills.controller.js";
import { SkillsService } from "./skills.service.js";
import { LibraryController } from "./library.controller.js";
import { LibraryService } from "./library.service.js";
import { TrainingController } from "./training.controller.js";
import { TrainingService } from "./training.service.js";
import { TurnkeyService } from "./turnkey.service.js";
import { TurnkeyController, ClientTurnkeyController } from "./turnkey.controller.js";
import { ExternalPortalService } from "./external-portal.service.js";
import { ExternalPortalIdentityService } from "./external-portal-identity.service.js";
import { ExternalPortalIdentityController } from "./external-portal-identity.controller.js";
import { ExternalPortalController } from "./external-portal.controller.js";
import { ExternalAccessController } from "./external-access.controller.js";

@Module({
  controllers: [MyWorkController, AiAssistanceController, AutomationController, IntegrationController, DashboardController, PerformanceController, ExternalPortalIdentityController, ExternalPortalController, ExternalAccessController, SiteController, WorkforceController, TimeController, SkillsController, LibraryController, TrainingController, TurnkeyController, ClientTurnkeyController, HealthController, IdentityController, OrganizationController, NotificationsController, AuditRetentionController, ApprovalsController, CrmController, ProjectController, ProjectTemplateController, TaskController, TaskRecurrenceController, DocumentController, RevisionController, ReviewController, ClientPortalIdentityController, ClientPortalAccessController, ClientPortalScopeController, ClientReviewController, ClientPortalReviewController, GalleryController, PortfolioController, ClientGalleryController, PublicPortfolioController],
  providers: [
    DatabaseService,
    { provide: DATABASE_PROBE, useExisting: DatabaseService },
    MyWorkService,
    ExternalPortalService,
    ExternalPortalIdentityService,
    SiteService,
    WorkforceService,
    PerformanceService,
    DashboardService,
    AutomationService,
    AiAssistanceService,
    IntegrationService,
    TimeService,
    TimeWorker,
    SkillsService,
    LibraryService,
    TrainingService,
    { provide: RUNTIME_CONFIG, useFactory: loadRuntimeConfig },
    IdentityService,
    OrganizationService,
    AuthorizationService,
    AuditRetentionService,
    EmailVerificationService,
    ApprovalService,
    CrmService,
    ProjectService,
    ProjectWorkflowService,
    ProjectTemplateService,
    TaskService,
    TaskRecurrenceService,
    DocumentService,
    RevisionService,
    ReviewService,
    ReviewRoutingService,
    ClientPortalIdentityService,
    ClientPortalAccessService,
    ClientPortalScopeService,
    ClientPortalFilesService,
    GalleryService,
    TurnkeyService,
    ClientReviewService,
    NotificationsService,
    { provide: BrevoEmailAdapter, useFactory: (config: ReturnType<typeof loadRuntimeConfig>) => new BrevoEmailAdapter({ apiKey: config.brevoApiKey, senderEmail: config.brevoSenderEmail, senderName: config.brevoSenderName }) , inject: [RUNTIME_CONFIG] },
    { provide: VERIFIED_ADDRESS_PREDICATE, useClass: PersistedVerifiedAddressPredicate },
    { provide: CURRENT_RECIPIENT_AUTHORIZATION_PREDICATE, useClass: OperationalRecipientPredicate },
    NotificationWorker,
    { provide: APP_GUARD, useClass: AuthGuard }
  ]
})
export class AppModule {}
