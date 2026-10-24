-- Extend the canonical event catalogue without replacing historical members.
DO $$ DECLARE prior_expression TEXT;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior_expression FROM pg_constraint WHERE conrelid='domain_events'::regclass AND conname='domain_events_eventName_catalogue_check';
 IF prior_expression IS NULL THEN RAISE EXCEPTION 'Existing domain event catalogue required'; END IF;
 ALTER TABLE domain_events DROP CONSTRAINT "domain_events_eventName_catalogue_check";
 EXECUTE format('ALTER TABLE domain_events ADD CONSTRAINT "domain_events_eventName_catalogue_check" CHECK ((%s) OR "eventName"=''review.routing_changed'')',prior_expression);
END $$;
CREATE FUNCTION task_review_evidence_digest(e JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
 SELECT encode(sha256(convert_to('{"kind":'||(e->'kind')::text||',"fileId":'||coalesce((e->'fileId')::text,'null')||',"blobId":'||coalesce((e->'blobId')::text,'null')||',"sha256":'||coalesce((e->'sha256')::text,'null')||',"url":'||coalesce((e->'url')::text,'null')||'}','UTF8')),'hex')
$$;
CREATE FUNCTION "task_review_publisher_authority"(actor_id UUID,project_id UUID,permission_key TEXT,allow_lead BOOLEAN) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE project_row "projects"%ROWTYPE; account_row "accounts"%ROWTYPE; employee_row "employees"%ROWTYPE;
BEGIN
 SELECT * INTO project_row FROM "projects" WHERE "id"=project_id FOR SHARE;
 SELECT * INTO account_row FROM "accounts" WHERE "id"=actor_id FOR SHARE;
 IF project_row."id" IS NULL OR account_row."state" IS DISTINCT FROM 'ACTIVE' OR project_row."status" NOT IN ('DRAFT','ACTIVE') THEN RETURN false; END IF;
 IF account_row."kind"='OWNER' THEN RETURN true; END IF;
 IF account_row."kind"<>'STAFF' THEN RETURN false; END IF;
 SELECT * INTO employee_row FROM "employees" WHERE "accountId"=actor_id FOR SHARE;
 IF employee_row."id" IS NULL OR employee_row."state"<>'ACTIVE' OR employee_row."organizationId"<>project_row."organizationId" THEN RETURN false; END IF;
 PERFORM 1 FROM "project_assignments" a WHERE a."projectId"=project_id AND a."organizationId"=project_row."organizationId" AND a."employeeId"=employee_row."id" AND a."revokedAt" IS NULL AND (employee_row."homeBranchId"=project_row."branchId" OR a."crossBranchAuthorized") FOR SHARE;
 IF NOT FOUND OR NOT "s14_branch_permission"(employee_row."id",project_row."organizationId",project_row."branchId",'project.view') THEN RETURN false; END IF;
 RETURN allow_lead AND project_row."currentLeadEmployeeId"=employee_row."id" OR "s14_branch_permission"(employee_row."id",project_row."organizationId",project_row."branchId",permission_key);
END $$;
-- Prospective work evidence only. Existing submissions/items are not rewritten.
ALTER TABLE "client_review_items" ADD COLUMN "workSubmissionId" UUID;
CREATE UNIQUE INDEX "client_review_items_workSubmissionId_key" ON "client_review_items"("workSubmissionId");
ALTER TABLE "client_review_items" ADD CONSTRAINT "client_review_items_work_submission_scope_fkey" FOREIGN KEY ("workSubmissionId","organizationId","projectId") REFERENCES "review_submissions"("id","organizationId","projectId") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "task_review_routing_authorizations" (
 "id" UUID PRIMARY KEY, "organizationId" UUID NOT NULL, "projectId" UUID NOT NULL,
 "taskId" UUID NOT NULL, "authorizedById" UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMPTZ(3),
 "reason" VARCHAR(1000) NOT NULL CHECK(length(btrim("reason")) BETWEEN 3 AND 1000),
 UNIQUE("id","organizationId","projectId"),
 FOREIGN KEY("taskId","organizationId") REFERENCES "tasks"("id","organizationId") ON DELETE RESTRICT,
 FOREIGN KEY("projectId","organizationId") REFERENCES "projects"("id","organizationId") ON DELETE RESTRICT
);
CREATE INDEX "task_review_routing_authorizations_taskId_createdAt_idx" ON "task_review_routing_authorizations"("taskId","createdAt");
CREATE UNIQUE INDEX "task_review_one_active_authorization" ON "task_review_routing_authorizations"("taskId") WHERE "revokedAt" IS NULL;
CREATE TABLE "task_review_routing_attempts" (
 "id" UUID PRIMARY KEY, "organizationId" UUID NOT NULL, "projectId" UUID NOT NULL, "taskId" UUID NOT NULL,
 "submissionId" UUID NOT NULL, "authorizationId" UUID NOT NULL,
 UNIQUE("submissionId","authorizationId"),
 "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK("status" IN ('PENDING','BLOCKED','SENT')),
 "blockedReason" VARCHAR(240), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 FOREIGN KEY("submissionId","organizationId","projectId") REFERENCES "review_submissions"("id","organizationId","projectId") ON DELETE RESTRICT,
 FOREIGN KEY("authorizationId","organizationId","projectId") REFERENCES "task_review_routing_authorizations"("id","organizationId","projectId") ON DELETE RESTRICT,
 FOREIGN KEY("taskId","organizationId") REFERENCES "tasks"("id","organizationId") ON DELETE RESTRICT
);
CREATE INDEX "task_review_routing_attempts_status_updatedAt_idx" ON "task_review_routing_attempts"("status","updatedAt");

CREATE FUNCTION "task_review_work_evidence_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence JSONB; exact_blob "file_blob_metadata"%ROWTYPE; exact_file "documents"%ROWTYPE;
BEGIN
 evidence := NEW."taskSnapshot"->'workEvidence';
 IF evidence IS NULL OR jsonb_typeof(evidence)<>'object' OR coalesce(evidence->>'kind','') NOT IN ('DRAWING','FILE','LINK') OR coalesce(evidence->>'digest','') !~ '^[a-f0-9]{64}$' OR evidence->>'digest' IS DISTINCT FROM task_review_evidence_digest(evidence) THEN RAISE EXCEPTION 'New review submissions require exact file or link evidence'; END IF;
 IF evidence->>'kind'='LINK' THEN
  IF NEW."revisionId" IS NOT NULL OR evidence->>'fileId' IS NOT NULL OR evidence->>'blobId' IS NOT NULL OR evidence->>'sha256' IS NOT NULL OR coalesce(evidence->>'url','') !~ '^https://[^/@[:space:]]+\.[^/@[:space:]]+' OR length(evidence->>'url')>2048 THEN RAISE EXCEPTION 'Invalid submitted link evidence'; END IF;
 ELSE
  SELECT * INTO exact_blob FROM "file_blob_metadata" WHERE "id"=(evidence->>'blobId')::uuid AND "organizationId"=NEW."organizationId";
  SELECT * INTO exact_file FROM "documents" WHERE "id"=(evidence->>'fileId')::uuid AND "organizationId"=NEW."organizationId" AND "projectId"=NEW."projectId";
  IF exact_blob."id" IS NULL OR exact_file."id" IS NULL OR exact_blob."documentId"<>exact_file."id" OR exact_blob."sha256" IS DISTINCT FROM evidence->>'sha256' OR evidence->>'url' IS NOT NULL THEN RAISE EXCEPTION 'Submitted file evidence must match exact project storage'; END IF;
  IF evidence->>'kind'='DRAWING' THEN
   IF NOT EXISTS(SELECT 1 FROM "document_revisions" r WHERE r."id"=NEW."revisionId" AND r."projectId"=NEW."projectId" AND r."organizationId"=NEW."organizationId" AND r."fileId"=exact_file."id" AND r."blobId"=exact_blob."id" AND r."sha256"=exact_blob."sha256") THEN RAISE EXCEPTION 'Submitted drawing evidence must match its exact revision'; END IF;
  ELSIF NEW."revisionId" IS NOT NULL THEN RAISE EXCEPTION 'Generic evidence cannot create drawing approval'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "task_review_work_evidence_insert" BEFORE INSERT ON "review_submissions" FOR EACH ROW EXECUTE FUNCTION "task_review_work_evidence_guard"();

CREATE FUNCTION "task_review_client_evidence_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission "review_submissions"%ROWTYPE; evidence JSONB;
BEGIN
 IF NEW."workSubmissionId" IS NULL THEN
  IF EXISTS(SELECT 1 FROM "review_submissions" s WHERE s."taskId"=NEW."taskId" AND s."taskSnapshot" ? 'workEvidence') THEN RAISE EXCEPTION 'Prospective work requires its exact submission binding'; END IF;
  IF NEW."revisionId" IS NULL THEN RAISE EXCEPTION 'New client review items require file or link evidence'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO submission FROM "review_submissions" WHERE "id"=NEW."workSubmissionId" AND "organizationId"=NEW."organizationId" AND "projectId"=NEW."projectId" AND "taskId"=NEW."taskId";
 evidence := submission."taskSnapshot"->'workEvidence';
 IF submission."id" IS NULL OR evidence IS NULL OR NEW."snapshot"->'workEvidence' IS DISTINCT FROM evidence OR NEW."snapshot"->>'workSubmissionId' IS DISTINCT FROM submission."id"::text OR NEW."revisionId" IS DISTINCT FROM submission."revisionId" OR NOT EXISTS(SELECT 1 FROM "review_rounds" r WHERE r."submissionId"=submission."id" AND r."status"='APPROVED') OR EXISTS(SELECT 1 FROM "review_submissions" newer WHERE newer."taskId"=NEW."taskId" AND newer."roundNumber">submission."roundNumber") THEN RAISE EXCEPTION 'Client publication requires the latest exact internally approved work'; END IF;
 IF NEW."snapshot"->>'title' IS DISTINCT FROM submission."taskSnapshot"->>'title' OR NEW."snapshot"->'description' IS DISTINCT FROM submission."taskSnapshot"->'description' OR NEW."snapshot"->>'ownerEmployeeId' IS DISTINCT FROM submission."taskSnapshot"->>'ownerEmployeeId' OR NEW."snapshot"->'tags' IS DISTINCT FROM submission."taskSnapshot"->'tags' OR NEW."snapshot"->'checklist' IS DISTINCT FROM submission."taskSnapshot"->'checklist' OR NEW."snapshot"->'planItemId' IS DISTINCT FROM submission."taskSnapshot"->'planItemId' THEN RAISE EXCEPTION 'Published work scope differs from internally approved work'; END IF;
 IF NEW."snapshot"->>'fileId' IS DISTINCT FROM evidence->>'fileId' OR NEW."snapshot"->>'blobId' IS DISTINCT FROM evidence->>'blobId' OR NEW."snapshot"->>'sha256' IS DISTINCT FROM evidence->>'sha256' THEN RAISE EXCEPTION 'Client file identity differs from internally approved work'; END IF;
 RETURN NEW;
END $$;
-- INSERT-only: legacy null evidence must not block later legitimate decisions.
CREATE TRIGGER "task_review_client_evidence_insert" BEFORE INSERT ON "client_review_items" FOR EACH ROW EXECUTE FUNCTION "task_review_client_evidence_guard"();

CREATE FUNCTION "task_review_routing_identity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Routing history cannot be deleted'; END IF;
 IF TG_TABLE_NAME='task_review_routing_authorizations' THEN
  IF TG_OP='UPDATE' THEN
   IF to_jsonb(NEW)-'revokedAt' IS DISTINCT FROM to_jsonb(OLD)-'revokedAt' OR OLD."revokedAt" IS NOT NULL OR NEW."revokedAt" IS NULL THEN RAISE EXCEPTION 'Routing authorization is immutable except one-way revocation'; END IF;
  ELSE
   IF NEW."revokedAt" IS NOT NULL OR NOT EXISTS(SELECT 1 FROM "tasks" t WHERE t."id"=NEW."taskId" AND t."organizationId"=NEW."organizationId" AND t."projectId"=NEW."projectId" AND t."reviewRequirement"='BOTH') THEN RAISE EXCEPTION 'Routing authorization requires its exact BOTH project task'; END IF;
  END IF;
 ELSE
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['status','blockedReason','updatedAt'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','blockedReason','updatedAt'] OR OLD."status"='SENT' AND NEW."status"<>'SENT') THEN RAISE EXCEPTION 'Routing attempt identity and sent state are immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM "task_review_routing_authorizations" a JOIN "review_submissions" s ON s."taskId"=a."taskId" JOIN "review_rounds" r ON r."submissionId"=s."id" WHERE a."id"=NEW."authorizationId" AND a."taskId"=NEW."taskId" AND a."projectId"=NEW."projectId" AND s."id"=NEW."submissionId" AND r."status"='APPROVED') THEN RAISE EXCEPTION 'Routing requires approved work and matching authorization'; END IF;
  IF NEW."status"='SENT' AND NOT EXISTS(SELECT 1 FROM "client_review_items" WHERE "workSubmissionId"=NEW."submissionId") THEN RAISE EXCEPTION 'Sent routing requires exact published evidence'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "task_review_authorization_identity" BEFORE INSERT OR UPDATE OR DELETE ON "task_review_routing_authorizations" FOR EACH ROW EXECUTE FUNCTION "task_review_routing_identity_guard"();
CREATE TRIGGER "task_review_attempt_identity" BEFORE INSERT OR UPDATE OR DELETE ON "task_review_routing_attempts" FOR EACH ROW EXECUTE FUNCTION "task_review_routing_identity_guard"();

CREATE OR REPLACE FUNCTION "s14_final_item_snapshot"(package_id UUID) RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',i."id",'itemVersion',i."version",'decisionId',d."id",'taskId',i."taskId",'revisionId',i."revisionId",'drawingId',i."snapshot"->'drawingId','fileId',i."snapshot"->'fileId','blobId',i."snapshot"->'blobId','sha256',i."snapshot"->'sha256') || CASE WHEN i."workSubmissionId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('workSubmissionId',i."workSubmissionId",'evidenceDigest',i."snapshot"->'workEvidence'->'digest') END ORDER BY i."id"),'[]'::jsonb)
 FROM "client_review_items" i LEFT JOIN "client_item_decisions" d ON d."itemId"=i."id" WHERE i."packageId"=package_id
$$;

-- Retain exact legacy evidence equality; new link URLs remain in scoped immutable work snapshots, not event payloads.
CREATE OR REPLACE FUNCTION "check_s14_review_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_row "audit_events"%ROWTYPE; event_key TEXT; task_row "tasks"%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='client_review_packages' THEN
  event_key:=CASE WHEN TG_OP='INSERT' THEN 'client.review_sent' WHEN NEW."status"='APPROVED' THEN 'client.final_approved' ELSE 'client.review_withdrawn' END;
  IF NOT EXISTS(SELECT 1 FROM "audit_events" a WHERE a."organizationId"=NEW."organizationId" AND a."subjectId"=NEW."id"::text AND a."eventKey"=event_key AND a."after"->>'packageId'=NEW."id"::text AND a."after"->>'version'=NEW."version"::text AND "s14_canonical_audit"(a."id",NEW."organizationId",NEW."projectId",a."actorId",event_key,NEW."id")) THEN RAISE EXCEPTION 'Client package mutation requires canonical evidence'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM "client_review_items" WHERE "packageId"=NEW."id") THEN RAISE EXCEPTION 'Client package requires at least one exact item'; END IF;
  IF NEW."status"='APPROVED' AND NOT EXISTS(SELECT 1 FROM "client_final_approvals" WHERE "packageId"=NEW."id") THEN RAISE EXCEPTION 'Client package approval requires Primary final evidence'; END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   SELECT * INTO task_row FROM "tasks" WHERE "id"=NEW."taskId";
   IF NEW."snapshot"->>'taskId' IS DISTINCT FROM NEW."taskId"::text OR NEW."snapshot"->>'taskVersion' IS DISTINCT FROM task_row."version"::text OR NEW."snapshot"->>'title' IS DISTINCT FROM task_row."title" OR NEW."snapshot"->>'ownerEmployeeId' IS DISTINCT FROM task_row."primaryOwnerEmployeeId"::text OR NEW."snapshot"->>'reviewRequirement' IS DISTINCT FROM task_row."reviewRequirement"::text OR NEW."snapshot"->>'revisionId' IS DISTINCT FROM NEW."revisionId"::text THEN RAISE EXCEPTION 'Client item requires immutable exact task snapshot'; END IF;
   IF NEW."snapshot"->>'description' IS DISTINCT FROM task_row."description" OR NEW."snapshot"->>'targetDate' IS DISTINCT FROM task_row."targetDate"::text OR NEW."snapshot"->>'startDate' IS DISTINCT FROM task_row."startDate"::text OR NEW."snapshot"->>'planItemId' IS DISTINCT FROM task_row."planItemId"::text OR NEW."snapshot"->'estimatedHours' IS DISTINCT FROM coalesce(to_jsonb(task_row."estimatedHours"),'null'::jsonb) OR NEW."snapshot"->'tags' IS DISTINCT FROM to_jsonb(task_row."tags") OR NEW."snapshot"->'checklist' IS DISTINCT FROM task_row."checklist" THEN RAISE EXCEPTION 'Client task content snapshot must preserve every submitted field'; END IF;
   IF NEW."revisionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "document_revisions" r JOIN "revision_approval_facts" f ON f."revisionId"=r."id" AND f."kind"='INTERNAL' JOIN "documents" d ON d."id"=r."fileId" WHERE r."id"=NEW."revisionId" AND r."isCurrent" AND r."state" IN ('APPROVED','ISSUED') AND NEW."snapshot"->>'drawingId'=r."drawingId"::text AND NEW."snapshot"->>'fileId'=r."fileId"::text AND NEW."snapshot"->>'blobId'=r."blobId"::text AND NEW."snapshot"->>'sha256'=r."sha256") THEN RAISE EXCEPTION 'Client drawing item requires current exact internally approved content'; END IF;
   event_key:='client.review_sent';
  ELSE
   event_key:=CASE NEW."status" WHEN 'IN_REVIEW' THEN 'client.review_started' WHEN 'WITHDRAWN' THEN 'client.review_withdrawn' ELSE 'client.item_decided' END;
   IF NEW."status" IN ('APPROVED','REVISION_REQUIRED','REJECTED') AND NOT EXISTS(SELECT 1 FROM "client_item_decisions" d WHERE d."itemId"=NEW."id" AND d."kind"::text=NEW."status"::text) THEN RAISE EXCEPTION 'Client item state requires its immutable exact decision'; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "audit_events" a WHERE a."organizationId"=NEW."organizationId" AND a."eventKey"=event_key AND a."after"->>'itemId'=NEW."id"::text AND a."after"->>'version'=NEW."version"::text AND (TG_OP<>'INSERT' OR a."after"->'snapshot'=CASE WHEN NEW."workSubmissionId" IS NOT NULL AND NEW."snapshot"->'workEvidence'->>'kind'='LINK' THEN jsonb_set(NEW."snapshot",'{workEvidence,url}','null'::jsonb) ELSE NEW."snapshot" END) AND "s14_canonical_audit"(a."id",NEW."organizationId",NEW."projectId",a."actorId",event_key,a."subjectId"::uuid)) THEN RAISE EXCEPTION 'Client item mutation requires canonical exact evidence'; END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION task_review_routing_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='task_review_routing_authorizations' THEN
  IF TG_OP='INSERT' AND NOT task_review_publisher_authority(NEW."authorizedById",NEW."projectId",'client.review_manage',true) THEN RAISE EXCEPTION 'Current client publishing authority required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a."organizationId"=NEW."organizationId" AND a."subjectId"=NEW."taskId"::text AND a.xmin::text=pg_current_xact_id()::text AND a."eventKey" IN ('task.created','task.updated') AND a."after"->>'projectId'=NEW."projectId"::text AND ((TG_OP='UPDATE' AND (a."after"->'revokedRoutingAuthorizations'->>NEW."id"::text)::timestamptz IS NOT DISTINCT FROM NEW."revokedAt") OR TG_OP='INSERT' AND a."actorId"=NEW."authorizedById" AND a."after"->>'routingAuthorizationId'=NEW."id"::text) AND task_review_publisher_authority(a."actorId",NEW."projectId",'client.review_manage',true) AND s11_canonical_delivery(a."id")) THEN RAISE EXCEPTION 'Routing authorization changes require canonical current-publisher evidence'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a."organizationId"=NEW."organizationId" AND a."subjectId"=NEW."id"::text AND a.xmin::text=pg_current_xact_id()::text AND a."eventKey"='review.routing_changed' AND a."after"->>'projectId'=NEW."projectId"::text AND a."after"->>'submissionId'=NEW."submissionId"::text AND a."after"->>'status'=NEW."status" AND a."after"->>'blockedReason' IS NOT DISTINCT FROM NEW."blockedReason" AND s11_canonical_delivery(a."id")) THEN RAISE EXCEPTION 'Routing attempts require canonical state evidence'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER task_review_authorization_audit AFTER INSERT OR UPDATE ON task_review_routing_authorizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION task_review_routing_audit_guard();
CREATE CONSTRAINT TRIGGER task_review_attempt_audit AFTER INSERT OR UPDATE ON task_review_routing_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION task_review_routing_audit_guard();

GRANT SELECT, INSERT, UPDATE ON task_review_routing_authorizations, task_review_routing_attempts TO sense_app_runtime;
