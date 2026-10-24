export const DOMAIN_EVENT_CATALOGUE = {
  "ai.run_created": { producer: "S27 assistance", subjectType: "ai_run", schemaVersion: 1 },
  "ai.decision_recorded": { producer: "S27 assistance", subjectType: "ai_decision", schemaVersion: 1 },
  "automation.record_changed": {producer:"S26 automation",subjectType:"automation_record",schemaVersion:1},
  "automation.run_created": {producer:"S26 automation",subjectType:"automation_run",schemaVersion:1},
  "skill.catalogue_created": { producer: "S18 skills", subjectType: "skill_catalogue", schemaVersion: 1 },
  "skill.change_requested": { producer: "S18 skills", subjectType: "skill_change_request", schemaVersion: 1 },
  "skill.rating_changed": { producer: "S18 skills", subjectType: "skill_rating", schemaVersion: 1 },
  "library.version_created": { producer: "S18 library", subjectType: "library_record", schemaVersion: 1 },
  "library.published": { producer: "S18 library", subjectType: "library_record", schemaVersion: 1 },
  "library.publish_requested": { producer: "S18 library", subjectType: "library_version", schemaVersion: 1 },
  "library.file_uploaded": { producer: "S18 library", subjectType: "library_file", schemaVersion: 1 },
  "library.acknowledged": { producer: "S18 library", subjectType: "library_version", schemaVersion: 1 },
  "library.referenced": { producer: "S18 library", subjectType: "library_reference", schemaVersion: 1 },
  "training.changed": { producer: "S18 training", subjectType: "training_assignment", schemaVersion: 1 },
  "training.attempt_recorded": { producer: "S18 training", subjectType: "training_assignment", schemaVersion: 1 },
  "integration.calendar_changed": { producer: "S25 calendar", subjectType: "integration_calendar_event", schemaVersion: 1 },
  "integration.subscription_changed": { producer: "S25 calendar", subjectType: "integration_subscription", schemaVersion: 1 },
  "integration.connector_changed": { producer: "S25 website", subjectType: "integration_connector", schemaVersion: 1 },
  "integration.delivery_changed": { producer: "S25 website", subjectType: "integration_delivery", schemaVersion: 1 },
  "report.finalized": { producer: "S24 reports", subjectType: "report_snapshot", schemaVersion: 1 },
  "dashboard.rule_changed": { producer: "S24 schedules", subjectType: "dashboard_rule", schemaVersion: 1 },
  "dashboard.reminder_created": { producer: "S24 reminders", subjectType: "personal_reminder", schemaVersion: 1 },
  "dashboard.delivered": { producer: "S24 schedules", subjectType: "dashboard_run", schemaVersion: 1 },
  "external.changed": { producer: "S21 external portals", subjectType: "external_record", schemaVersion: 1 },
  "site.changed": { producer: "S20 Site", subjectType: "site_record", schemaVersion: 1 },
  "site.workspace_changed": { producer: "S20 Site", subjectType: "site_workspace", schemaVersion: 1 },
  "workforce.changed": { producer: "S17 workforce", subjectType: "workforce_record", schemaVersion: 1 },
  "workforce.credited": { producer: "S17 workforce", subjectType: "workforce_ledger", schemaVersion: 1 },
  "time.logged": { producer: "S16 time", subjectType: "time_entry", schemaVersion: 1 },
  "time.changed": { producer: "S16 time", subjectType: "time_entry", schemaVersion: 1 },
  "time.started": { producer: "S16 time", subjectType: "time_timer", schemaVersion: 1 },
  "time.timer_changed": { producer: "S16 time", subjectType: "time_timer", schemaVersion: 1 },


  "time.approved": { producer: "S16 time", subjectType: "time_entry", schemaVersion: 1 },
  "time.export_requested": { producer: "S16 time", subjectType: "time_delivery", schemaVersion: 1 },
  "turnkey.release_created": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "turnkey.release_replaced": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "turnkey.cost_requested": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "turnkey.cost_decided": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "turnkey.materials_selected": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "turnkey.procurement_requested": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "turnkey.procurement_decided": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "turnkey.progress_changed": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "turnkey.cost_shared": { producer: "S19 Turnkey", subjectType: "turnkey_release", schemaVersion: 1 },
  "gallery.entry_added": { producer: "S15 galleries", subjectType: "gallery_entry", schemaVersion: 1 },
  "portfolio.prepared": { producer: "S15 portfolio", subjectType: "portfolio_publication", schemaVersion: 1 },
  "portfolio.published": { producer: "S15 portfolio", subjectType: "portfolio_publication", schemaVersion: 1 },
  "portfolio.withdrawn": { producer: "S15 portfolio", subjectType: "portfolio_publication", schemaVersion: 1 },
  "client.review_sent": { producer: "S14 client review", subjectType: "client_review_package", schemaVersion: 1 },
  "client.review_started": { producer: "S14 client review", subjectType: "client_review_item", schemaVersion: 1 },
  "client.item_decided": { producer: "S14 client review", subjectType: "client_item_decision", schemaVersion: 1 },
  "client.commented": { producer: "S14 client review", subjectType: "client_comment", schemaVersion: 1 },
  "client.reference_uploaded": { producer: "S14 client review", subjectType: "client_reference", schemaVersion: 1 },
  "client.item_access_changed": { producer: "S14 client review", subjectType: "client_item_access", schemaVersion: 1 },
  "client.revision_classified": { producer: "S14 client review", subjectType: "client_classification", schemaVersion: 1 },
  "client.correction_assigned": { producer: "S14 client review", subjectType: "client_correction", schemaVersion: 1 },
  "client.correction_resumed": { producer: "S14 client review", subjectType: "client_correction", schemaVersion: 1 },
  "client.final_approved": { producer: "S14 client review", subjectType: "client_final_approval", schemaVersion: 1 },
  "client.review_withdrawn": { producer: "S14 client review", subjectType: "client_review_package", schemaVersion: 1 },
  "client.access_changed": { producer: "S14 client portal", subjectType: "client_access", schemaVersion: 1 },
  "revision.state_changed": { producer: "S12 revisions", subjectType: "document_revision", schemaVersion: 1 },
  "drawing.client_review_selected": { producer: "S12 revisions", subjectType: "drawing", schemaVersion: 1 },
  "transmittal.acknowledged": { producer: "S12 issue", subjectType: "transmittal", schemaVersion: 1 },
  "task.recurrence_configured": { producer: "S10 recurrence", subjectType: "task_recurrence", schemaVersion: 1 },
  "task.recurrence_paused": { producer: "S10 recurrence", subjectType: "task_recurrence", schemaVersion: 1 },
  "task.recurrence_resumed": { producer: "S10 recurrence", subjectType: "task_recurrence", schemaVersion: 1 },
  "task.recurrence_generated": { producer: "S10 recurrence", subjectType: "task_recurrence", schemaVersion: 1 },
  "template.version_created": { producer: "S08 templates", subjectType: "project_template", schemaVersion: 1 },
  "project.template_applied": { producer: "S08 templates", subjectType: "project", schemaVersion: 1 },
  "project.plan_item_completed": { producer: "S08 templates", subjectType: "project", schemaVersion: 1 },
  "project.gate_overridden": { producer: "S08 templates", subjectType: "project", schemaVersion: 1 },
  "organization.created": { producer: "S03 organization", subjectType: "organization", schemaVersion: 1 },
  "organization.branch.created": { producer: "S03 organization", subjectType: "branch", schemaVersion: 1 },
  "organization.branch.updated": { producer: "S03 organization", subjectType: "branch", schemaVersion: 1 },
  "organization.team.created": { producer: "S03 organization", subjectType: "team", schemaVersion: 1 },
  "organization.team.updated": { producer: "S03 organization", subjectType: "team", schemaVersion: 1 },
  "organization.job_role.created": { producer: "S03 organization", subjectType: "job_role", schemaVersion: 1 },
  "organization.job_role.updated": { producer: "S03 organization", subjectType: "job_role", schemaVersion: 1 },
  "organization.employee.created": { producer: "S03 organization", subjectType: "employee", schemaVersion: 1 },
  "organization.employee.membership_changed": { producer: "S03 organization", subjectType: "employee", schemaVersion: 1 },
  "organization.employee.job_roles_changed": { producer: "S03 organization", subjectType: "employee", schemaVersion: 1 },
  "organization.employee.suspended": { producer: "S03 organization", subjectType: "employee", schemaVersion: 1 },
  "organization.employee.exited": { producer: "S09 tasks", subjectType: "employee", schemaVersion: 1 },
  "authorization.role_permission.changed": { producer: "S03 authorization", subjectType: "role_permission", schemaVersion: 1 },
  "authorization.employee_permission.changed": { producer: "S03 authorization", subjectType: "employee_permission", schemaVersion: 1 },
  "audit.corrected": { producer: "S04 audit", subjectType: "audit_event", schemaVersion: 1 },
  "audit.retention.notice_interval.updated": { producer: "S04 audit", subjectType: "audit_retention_configuration", schemaVersion: 1 },
  "audit.retention.hold.placed": { producer: "S04 audit", subjectType: "audit_event", schemaVersion: 1 },
  "audit.retention.hold.released": { producer: "S04 audit", subjectType: "audit_event", schemaVersion: 1 },
  "audit.retention.notice.acknowledged": { producer: "S04 audit", subjectType: "audit_event", schemaVersion: 1 },
  "project.created": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.activated": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.on_hold": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.scope_changed": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.completed": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.archived": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.assignment_changed": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.lead_changed": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.transferred": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.scope_policy_changed": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.scope_requested": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.cancellation_requested": { producer: "S07 projects", subjectType: "project", schemaVersion: 1 },
  "project.cancelled": { producer: "S09 tasks", subjectType: "project", schemaVersion: 1 },
  "task.created": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.assigned": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.updated": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.stopped": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.closeout_approved": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.started": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.waiting": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.overdue": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.completed": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.deadline_changed": { producer: "S09 tasks", subjectType: "task", schemaVersion: 1 },
  "task.dependency_completed": { producer: "S10 task dependencies", subjectType: "task", schemaVersion: 1 },
  "review.routing_changed": { producer: "Task review routing", subjectType: "review_routing", schemaVersion: 1 },
  "review.requested": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "review.started": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "review.correction_requested": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "review.approved": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "review.assigned": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "review.commented": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "review.correction_assigned": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "review.category_changed": { producer: "S13 review", subjectType: "review_category", schemaVersion: 1 },
  "review.escalated": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "review.withdrawn": { producer: "S13 review", subjectType: "review", schemaVersion: 1 },
  "client.review_requested": { producer: "S14 client", subjectType: "client_review", schemaVersion: 1 },
  "client.revision_requested": { producer: "S14 client", subjectType: "client_review", schemaVersion: 1 },
  "client.approved": { producer: "S14 client", subjectType: "client_review", schemaVersion: 1 },
  "document.uploaded": { producer: "S11 documents", subjectType: "document", schemaVersion: 1 },
  "document.folder_created": { producer: "S11 documents", subjectType: "document_folder", schemaVersion: 1 },
  "document.folder_provisioned": { producer: "S11 documents", subjectType: "document_folder", schemaVersion: 1 },
  "document.folder_failed": { producer: "S11 documents", subjectType: "document_folder", schemaVersion: 1 },
  "document.access_granted": { producer: "S11 documents", subjectType: "document_grant", schemaVersion: 1 },
  "document.access_revoked": { producer: "S11 documents", subjectType: "document_grant", schemaVersion: 1 },
  "document.upload_aborted": { producer: "S11 documents", subjectType: "document_upload", schemaVersion: 1 },
  "revision.created": { producer: "S12 revisions", subjectType: "revision", schemaVersion: 1 },
  "document.approved": { producer: "S13 review", subjectType: "document", schemaVersion: 1 },
  "document.issued": { producer: "S12 issue", subjectType: "document_revision", schemaVersion: 1 },
  "document.superseded": { producer: "S12 issue", subjectType: "document_revision", schemaVersion: 1 },



  "leave.requested": { producer: "S17 workforce", subjectType: "leave_request", schemaVersion: 1 },
  "leave.approved": { producer: "S17 workforce", subjectType: "leave_request", schemaVersion: 1 },
  "attendance.checked_in": { producer: "S17 workforce", subjectType: "attendance", schemaVersion: 1 },
  "employee_performance.changed": { producer: "S23 analytics", subjectType: "employee_performance", schemaVersion: 1 },
  "project_health.changed": { producer: "S23 analytics", subjectType: "project_health", schemaVersion: 1 },
  "capacity.threshold_exceeded": { producer: "S17 workforce", subjectType: "capacity", schemaVersion: 1 },
  "approval.requested": { producer: "S05 approvals", subjectType: "approval_request", schemaVersion: 1 },
  "organization.settings.changed": { producer: "S10 task scheduling", subjectType: "organization", schemaVersion: 1 },
  "approval.delegated": { producer: "S05 approvals", subjectType: "approval_request", schemaVersion: 1 },
  "approval.withdrawn": { producer: "S05 approvals", subjectType: "approval_request", schemaVersion: 1 },
  "approval.decided": { producer: "S05 approvals", subjectType: "approval_request", schemaVersion: 1 },
  "crm.lead.created": { producer: "S06 CRM", subjectType: "lead", schemaVersion: 1 },
  "crm.lead.updated": { producer: "S06 CRM", subjectType: "lead", schemaVersion: 1 },
  "crm.lead.stage_changed": { producer: "S06 CRM", subjectType: "lead", schemaVersion: 1 },
  "crm.lead.activity_recorded": { producer: "S06 CRM", subjectType: "lead_activity", schemaVersion: 1 },
  "crm.client.created": { producer: "S06 CRM", subjectType: "client", schemaVersion: 1 },
  "crm.client.updated": { producer: "S06 CRM", subjectType: "client", schemaVersion: 1 },
  "crm.source.created": { producer: "S06 CRM", subjectType: "crm_source", schemaVersion: 1 },
  "crm.source.updated": { producer: "S06 CRM", subjectType: "crm_source", schemaVersion: 1 }
} as const;

export type DomainEventName = keyof typeof DOMAIN_EVENT_CATALOGUE;

export function isDomainEventName(value: string): value is DomainEventName {
  return Object.hasOwn(DOMAIN_EVENT_CATALOGUE, value);
}

export function assertSafeDomainPayload(eventName: string, payload: unknown): void {
  if (!isDomainEventName(eventName) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Domain event payload is invalid");
  }
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 8) throw new Error("Domain event payload is too deep");
    if (value === null || typeof value === "boolean" || typeof value === "number") return;
    if (typeof value === "string") {
      if (value.length > 2000 || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)
        || /\bBearer\s+\S+/i.test(value)
        || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
        || /(?:[A-Za-z]:\\|\\\\[^\\]+\\|\/(?:mnt|nas|srv|volume|shares?)\/)/i.test(value)) {
        throw new Error("Sensitive value cannot be stored in a domain event");
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((item) => inspect(item, depth + 1)); return; }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        if (/(?:password|passkey|credential|session|csrf|token|recovery|secret|private.?key|nas.?path|file.?path|storage.?key)/i.test(key)) {
          throw new Error("Sensitive field cannot be stored in a domain event");
        }
        inspect(nested, depth + 1);
      }
      return;
    }
    throw new Error("Domain event payload contains an unsupported value");
  };
  inspect(payload, 0);
  if (JSON.stringify(payload).length > 8000) throw new Error("Domain event payload is too large");
}
