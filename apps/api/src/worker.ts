import { ReviewRoutingService } from "./review-routing.service.js";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { DatabaseService } from "./database.service.js";
import { IdentityService } from "./identity.service.js";
import { NotificationWorker } from "./notification-worker.js";
import { AuditRetentionService } from "./audit-retention.service.js";
import { TaskRecurrenceService } from "./task-recurrence.service.js";
import { WorkforceService } from "./workforce.service.js";
import { ExternalPortalService } from "./external-portal.service.js";
import { DashboardService } from "./dashboard.service.js";
import { AutomationService } from "./automation.service.js";
import { RUNTIME_CONFIG, type RuntimeConfig } from "./config.js";
import { WorkerHealth } from "./worker-health.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  const database = app.get(DatabaseService);
  const identity = app.get(IdentityService);
  const notificationWorker = app.get(NotificationWorker);
  const auditRetention = app.get(AuditRetentionService);
  const recurrence = app.get(TaskRecurrenceService);
  const workforce=app.get(WorkforceService);
  const externalPortal = app.get(ExternalPortalService);
  const dashboard=app.get(DashboardService);
  const automation=app.get(AutomationService);
  const config = app.get<RuntimeConfig>(RUNTIME_CONFIG);
  const health = new WorkerHealth(config.workerHealthPath);
  await health.track("database", 90_000, () => database.check());
  console.info("Workspace worker process ready.");

  const interval = setInterval(() => {
    void health.track("database", 90_000, () => database.check()).catch(() => console.error("Worker database readiness failed."));
  }, 30_000);
  const identityCleanup = setInterval(() => {
    void health.track("identity", 2 * 60 * 60_000, () => identity.cleanupExpired()).catch(() => console.error("Identity cleanup failed."));
  }, 60 * 60_000);
  const notificationDelivery = setInterval(() => {
    void health.track("notifications", 5 * 60_000, () => notificationWorker.runBatch()).catch(() => console.error("Notification processing failed."));
  }, 5_000);
  const runAuditRetention = async (): Promise<void> => {
    try {
      await health.track("audit-retention", 2 * 60 * 60_000, async () => {
        await auditRetention.scheduleDueNotices();
        await auditRetention.purgeEligibleEvents();
      });
    } catch {
      console.error("Audit retention processing failed.");
    }
  };
  void runAuditRetention();
  const auditRetentionProcessing = setInterval(() => void runAuditRetention(), 60 * 60_000);
  let recurrenceRunning = false;
  const runRecurrence = async (): Promise<void> => {
    if (recurrenceRunning) return;
    recurrenceRunning = true;
    try { await health.track("recurrence", 5 * 60_000, () => recurrence.runBatch()); }
    catch { console.error("Task recurrence processing failed."); }
    finally { recurrenceRunning = false; }
  };
  void runRecurrence();
  const recurrenceProcessing = setInterval(() => void runRecurrence(), 60_000);
  const runWorkforceRetention=()=>{void health.track("workforce-retention",2*60*60_000,()=>workforce.scheduleSelfieNotices().then(()=>workforce.purgeExpiredSelfies())).catch(()=>console.error("Workforce retention notice processing failed."));void health.track("workforce-entitlements",2*60*60_000,()=>workforce.runScheduledEntitlements()).catch(()=>console.error("Workforce entitlement processing failed."));};
  runWorkforceRetention();const workforceRetentionProcessing=setInterval(runWorkforceRetention,60*60_000);
  let nativeRevocationRunning = false;
  const runNativeRevocationNotices = async (): Promise<void> => {
    if (nativeRevocationRunning) return;
    nativeRevocationRunning = true;
    try { await health.track("external-revocation", 5 * 60_000, () => externalPortal.scheduleNativeRevocationNotices()); }
    catch { console.error("External native revocation notice processing failed."); }
    finally { nativeRevocationRunning = false; }
  };
  void runNativeRevocationNotices();
  const nativeRevocationProcessing = setInterval(() => void runNativeRevocationNotices(), 60_000);
  let dashboardRunning=false;
  const runDashboard=async()=>{if(dashboardRunning)return;dashboardRunning=true;try{await health.track("dashboard",5*60_000,()=>dashboard.runBatch());}catch{console.error("Dashboard scheduling failed.");}finally{dashboardRunning=false;}};
  void runDashboard();
  let automationRunning=false;
  const runAutomation=async()=>{if(automationRunning)return;automationRunning=true;try{await health.track("automation",5*60_000,()=>automation.runBatch());}catch{console.error("Automation processing failed.");}finally{automationRunning=false;}};
  void runAutomation();
  const automationProcessing=setInterval(()=>void runAutomation(),60_000);
  const dashboardProcessing=setInterval(()=>void runDashboard(),60_000);

  const reviewRouting = app.get(ReviewRoutingService);
  let routingRunning = false;
  const runRouting = async () => { if (routingRunning) return; routingRunning = true; try { await health.track("review-routing", 5 * 60_000, () => reviewRouting.runBatch()); } catch { console.error("Review routing processing failed."); } finally { routingRunning = false; } };
  void runRouting();
  const reviewRoutingProcessing = setInterval(() => void runRouting(), 5_000);

  const shutdown = async (): Promise<void> => {
    clearInterval(reviewRoutingProcessing);
    clearInterval(interval);
    clearInterval(identityCleanup);
    clearInterval(notificationDelivery);
    clearInterval(auditRetentionProcessing);
    clearInterval(recurrenceProcessing);
    clearInterval(workforceRetentionProcessing);
    clearInterval(nativeRevocationProcessing);
    clearInterval(dashboardProcessing);
    clearInterval(automationProcessing);
    await app.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void bootstrap();
