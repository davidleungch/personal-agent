CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"status" text NOT NULL,
	"workflow_phase" text NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"model_profile" text NOT NULL,
	"result_summary" text,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "automation_runs_id_automation_id_unique" UNIQUE("id","automation_id"),
	CONSTRAINT "automation_runs_trigger_check" CHECK ("automation_runs"."trigger" in ('scheduled', 'manual', 'command')),
	CONSTRAINT "automation_runs_scheduled_for_check" CHECK (("automation_runs"."trigger" = 'scheduled' and "automation_runs"."scheduled_for" is not null) or ("automation_runs"."trigger" <> 'scheduled' and "automation_runs"."scheduled_for" is null)),
	CONSTRAINT "automation_runs_status_check" CHECK ("automation_runs"."status" in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human', 'succeeded', 'failed', 'blocked', 'cancelled')),
	CONSTRAINT "automation_runs_checkpoint_object_check" CHECK (jsonb_typeof("automation_runs"."checkpoint") = 'object'),
	CONSTRAINT "automation_runs_attempt_check" CHECK ("automation_runs"."attempt" >= 0),
	CONSTRAINT "automation_runs_model_profile_check" CHECK ("automation_runs"."model_profile" in ('fast', 'balanced', 'reasoning')),
	CONSTRAINT "automation_runs_claim_fields_check" CHECK (("automation_runs"."claimed_by" is null and "automation_runs"."claimed_at" is null and "automation_runs"."lease_expires_at" is null) or ("automation_runs"."claimed_by" is not null and "automation_runs"."claimed_at" is not null and "automation_runs"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Hong_Kong' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"model_profile" text NOT NULL,
	"tool_policy" text NOT NULL,
	"completion_mode" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_model_profile_check" CHECK ("automations"."model_profile" in ('fast', 'balanced', 'reasoning')),
	CONSTRAINT "automations_schedule_check" CHECK ("automations"."schedule" ~ '^[^[:space:]]+([[:space:]]+[^[:space:]]+){4}$'),
	CONSTRAINT "automations_completion_mode_check" CHECK ("automations"."completion_mode" in ('continue', 'stop_after_success')),
	CONSTRAINT "automations_version_check" CHECK ("automations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "command_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"intent_type" text,
	"structured_result" jsonb,
	"error_summary" text,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "command_requests_status_check" CHECK ("command_requests"."status" in ('pending', 'processing', 'needs_input', 'completed', 'failed')),
	CONSTRAINT "command_requests_intent_type_check" CHECK ("command_requests"."intent_type" is null or "command_requests"."intent_type" in ('query', 'action', 'automation_create', 'automation_update', 'planning_discussion', 'product_change', 'development_fix', 'system_command')),
	CONSTRAINT "command_requests_structured_result_object_check" CHECK ("command_requests"."structured_result" is null or jsonb_typeof("command_requests"."structured_result") = 'object'),
	CONSTRAINT "command_requests_claim_fields_check" CHECK (("command_requests"."claimed_by" is null and "command_requests"."claimed_at" is null and "command_requests"."lease_expires_at" is null) or ("command_requests"."claimed_by" is not null and "command_requests"."claimed_at" is not null and "command_requests"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "development_attempt_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"safe_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_attempt_events_attempt_sequence_unique" UNIQUE("attempt_id","sequence"),
	CONSTRAINT "development_attempt_events_sequence_check" CHECK ("development_attempt_events"."sequence" > 0),
	CONSTRAINT "development_attempt_events_kind_check" CHECK ("development_attempt_events"."kind" in ('transition', 'harness', 'tool', 'test', 'git', 'budget', 'teardown')),
	CONSTRAINT "development_attempt_events_status_check" CHECK ("development_attempt_events"."status" in ('started', 'success', 'failed', 'unknown', 'blocked')),
	CONSTRAINT "development_attempt_events_metadata_object_check" CHECK (jsonb_typeof("development_attempt_events"."safe_metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "development_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"harness_adapter" text NOT NULL,
	"model_profile" text NOT NULL,
	"base_commit" text NOT NULL,
	"candidate_commit" text,
	"candidate_ref" text,
	"sandbox_id" text NOT NULL,
	"context_manifest" jsonb,
	"context_digest" text,
	"budget" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" integer DEFAULT 1 NOT NULL,
	"failure_class" text,
	"safe_summary" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_attempts_task_number_unique" UNIQUE("task_id","attempt_number"),
	CONSTRAINT "development_attempts_number_check" CHECK ("development_attempts"."attempt_number" = 1),
	CONSTRAINT "development_attempts_role_check" CHECK ("development_attempts"."role" = 'implementer'),
	CONSTRAINT "development_attempts_status_check" CHECK ("development_attempts"."status" in ('preparing', 'implementing', 'testing', 'capturing_candidate', 'succeeded', 'interrupted', 'failed', 'cancelled')),
	CONSTRAINT "development_attempts_harness_check" CHECK ("development_attempts"."harness_adapter" = 'pi'),
	CONSTRAINT "development_attempts_model_profile_check" CHECK ("development_attempts"."model_profile" in ('fast', 'balanced', 'reasoning')),
	CONSTRAINT "development_attempts_base_commit_check" CHECK ("development_attempts"."base_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "development_attempts_candidate_commit_check" CHECK ("development_attempts"."candidate_commit" is null or "development_attempts"."candidate_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "development_attempts_candidate_pair_check" CHECK (("development_attempts"."candidate_commit" is null and "development_attempts"."candidate_ref" is null) or ("development_attempts"."candidate_commit" is not null and "development_attempts"."candidate_ref" is not null)),
	CONSTRAINT "development_attempts_succeeded_candidate_check" CHECK (("development_attempts"."status" = 'succeeded') = ("development_attempts"."candidate_commit" is not null)),
	CONSTRAINT "development_attempts_context_pair_check" CHECK (("development_attempts"."context_manifest" is null and "development_attempts"."context_digest" is null) or ("development_attempts"."context_manifest" is not null and "development_attempts"."context_digest" is not null)),
	CONSTRAINT "development_attempts_context_manifest_object_check" CHECK ("development_attempts"."context_manifest" is null or jsonb_typeof("development_attempts"."context_manifest") = 'object'),
	CONSTRAINT "development_attempts_context_digest_check" CHECK ("development_attempts"."context_digest" is null or "development_attempts"."context_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "development_attempts_budget_object_check" CHECK (jsonb_typeof("development_attempts"."budget") = 'object'),
	CONSTRAINT "development_attempts_usage_object_check" CHECK (jsonb_typeof("development_attempts"."usage") = 'object'),
	CONSTRAINT "development_attempts_lease_fields_check" CHECK (("development_attempts"."lease_owner" is null and "development_attempts"."lease_expires_at" is null) or ("development_attempts"."lease_owner" is not null and "development_attempts"."lease_expires_at" is not null)),
	CONSTRAINT "development_attempts_lease_generation_check" CHECK ("development_attempts"."lease_generation" > 0),
	CONSTRAINT "development_attempts_completion_check" CHECK (("development_attempts"."status" in ('succeeded', 'failed', 'cancelled') and "development_attempts"."completed_at" is not null) or ("development_attempts"."status" not in ('succeeded', 'failed', 'cancelled') and "development_attempts"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "development_review_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"review_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"safe_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_review_events_review_sequence_unique" UNIQUE("review_id","sequence"),
	CONSTRAINT "development_review_events_sequence_check" CHECK ("development_review_events"."sequence" > 0),
	CONSTRAINT "development_review_events_kind_check" CHECK ("development_review_events"."kind" in ('transition', 'harness', 'tool', 'check', 'integrity', 'cleanup', 'finalization')),
	CONSTRAINT "development_review_events_status_check" CHECK ("development_review_events"."status" in ('started', 'success', 'failed', 'unknown', 'blocked')),
	CONSTRAINT "development_review_events_metadata_object_check" CHECK (jsonb_typeof("development_review_events"."safe_metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "development_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"implementer_attempt_id" uuid NOT NULL,
	"role" text DEFAULT 'reviewer' NOT NULL,
	"status" text NOT NULL,
	"harness_adapter" text NOT NULL,
	"model_profile" text NOT NULL,
	"base_commit" text NOT NULL,
	"candidate_commit" text NOT NULL,
	"candidate_ref" text NOT NULL,
	"retention_ref" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"context_manifest" jsonb,
	"context_digest" text,
	"context_policy" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"lease_owner" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"lease_generation" integer DEFAULT 1 NOT NULL,
	"cleanup_status" text DEFAULT 'pending' NOT NULL,
	"decision" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_class" text,
	"safe_summary" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_reviews_task_unique" UNIQUE("task_id"),
	CONSTRAINT "development_reviews_implementer_attempt_unique" UNIQUE("implementer_attempt_id"),
	CONSTRAINT "development_reviews_role_check" CHECK ("development_reviews"."role" = 'reviewer'),
	CONSTRAINT "development_reviews_status_check" CHECK ("development_reviews"."status" in ('preparing', 'reviewing', 'finalizing', 'interrupted', 'succeeded', 'failed')),
	CONSTRAINT "development_reviews_harness_check" CHECK ("development_reviews"."harness_adapter" = 'pi'),
	CONSTRAINT "development_reviews_model_profile_check" CHECK ("development_reviews"."model_profile" in ('fast', 'balanced', 'reasoning')),
	CONSTRAINT "development_reviews_base_commit_check" CHECK ("development_reviews"."base_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "development_reviews_candidate_commit_check" CHECK ("development_reviews"."candidate_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "development_reviews_candidate_ref_check" CHECK ("development_reviews"."candidate_ref" ~ '^refs/personal-agent/development-attempts/[0-9a-f-]{36}$'),
	CONSTRAINT "development_reviews_retention_ref_check" CHECK ("development_reviews"."retention_ref" = 'refs/personal-agent/reviews/' || "development_reviews"."id"::text),
	CONSTRAINT "development_reviews_context_pair_check" CHECK (("development_reviews"."context_manifest" is null and "development_reviews"."context_digest" is null) or ("development_reviews"."context_manifest" is not null and "development_reviews"."context_digest" is not null)),
	CONSTRAINT "development_reviews_context_manifest_object_check" CHECK ("development_reviews"."context_manifest" is null or (jsonb_typeof("development_reviews"."context_manifest") = 'object' and jsonb_exists("development_reviews"."context_manifest", 'authorityReferences') and jsonb_typeof("development_reviews"."context_manifest"->'authorityReferences') = 'array' and jsonb_array_length("development_reviews"."context_manifest"->'authorityReferences') between 1 and 512)),
	CONSTRAINT "development_reviews_context_digest_check" CHECK ("development_reviews"."context_digest" is null or "development_reviews"."context_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "development_reviews_budget_object_check" CHECK (jsonb_typeof("development_reviews"."budget") = 'object'),
	CONSTRAINT "development_reviews_context_policy_object_check" CHECK (jsonb_typeof("development_reviews"."context_policy") = 'object'),
	CONSTRAINT "development_reviews_usage_object_check" CHECK (jsonb_typeof("development_reviews"."usage") = 'object'),
	CONSTRAINT "development_reviews_findings_array_check" CHECK (jsonb_typeof("development_reviews"."findings") = 'array' and jsonb_array_length("development_reviews"."findings") <= 64),
	CONSTRAINT "development_reviews_decision_findings_check" CHECK (("development_reviews"."decision" is null and jsonb_array_length("development_reviews"."findings") = 0) or ("development_reviews"."decision" = 'APPROVE' and jsonb_array_length("development_reviews"."findings") = 0) or ("development_reviews"."decision" = 'REQUEST_CHANGES' and jsonb_array_length("development_reviews"."findings") between 1 and 64)),
	CONSTRAINT "development_reviews_proposal_state_check" CHECK ("development_reviews"."decision" is null or "development_reviews"."status" in ('finalizing', 'succeeded', 'failed')),
	CONSTRAINT "development_reviews_cleanup_status_check" CHECK ("development_reviews"."cleanup_status" in ('pending', 'failed', 'succeeded')),
	CONSTRAINT "development_reviews_lease_generation_check" CHECK ("development_reviews"."lease_generation" > 0),
	CONSTRAINT "development_reviews_completion_check" CHECK (("development_reviews"."status" in ('succeeded', 'failed') and "development_reviews"."completed_at" is not null) or ("development_reviews"."status" not in ('succeeded', 'failed') and "development_reviews"."completed_at" is null)),
	CONSTRAINT "development_reviews_proposal_prerequisites_check" CHECK ("development_reviews"."status" not in ('finalizing', 'succeeded') or ("development_reviews"."decision" is not null and "development_reviews"."context_digest" is not null and "development_reviews"."context_manifest" is not null)),
	CONSTRAINT "development_reviews_finalization_check" CHECK (("development_reviews"."status" = 'succeeded' and "development_reviews"."decision" is not null and "development_reviews"."context_digest" is not null and "development_reviews"."context_manifest" is not null and "development_reviews"."cleanup_status" = 'succeeded' and "development_reviews"."failure_class" is null and "development_reviews"."safe_summary" is not null and "development_reviews"."completed_at" is not null and "development_reviews"."finalized_at" is not null) or ("development_reviews"."status" <> 'succeeded' and "development_reviews"."finalized_at" is null))
);
--> statement-breakpoint
CREATE TABLE "development_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"approved_spec" text NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"status" text NOT NULL,
	"base_commit" text NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"authority_invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_tasks_status_check" CHECK ("development_tasks"."status" in ('ready', 'preparing', 'implementing', 'testing', 'candidate_ready', 'blocked', 'failed', 'cancelled')),
	CONSTRAINT "development_tasks_base_commit_check" CHECK ("development_tasks"."base_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "development_tasks_max_attempts_check" CHECK ("development_tasks"."max_attempts" = 1),
	CONSTRAINT "development_tasks_acceptance_criteria_array_check" CHECK (jsonb_typeof("development_tasks"."acceptance_criteria") = 'array' and jsonb_array_length("development_tasks"."acceptance_criteria") > 0)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" uuid,
	"evidence_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_payload_object_check" CHECK (jsonb_typeof("evidence"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_scope_key_unique" UNIQUE("scope","key"),
	CONSTRAINT "idempotency_records_state_check" CHECK ("idempotency_records"."state" in ('reserved', 'confirmed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "model_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"role" text NOT NULL,
	"model_profile" text NOT NULL,
	"execution_model_id" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_outcome" text NOT NULL,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "model_invocations_role_check" CHECK ("model_invocations"."role" in ('intent_router', 'extractor', 'general', 'planner', 'verification')),
	CONSTRAINT "model_invocations_model_profile_check" CHECK ("model_invocations"."model_profile" in ('fast', 'balanced', 'reasoning')),
	CONSTRAINT "model_invocations_status_check" CHECK ("model_invocations"."status" in ('started', 'succeeded', 'failed')),
	CONSTRAINT "model_invocations_latency_check" CHECK ("model_invocations"."latency_ms" is null or "model_invocations"."latency_ms" >= 0),
	CONSTRAINT "model_invocations_usage_object_check" CHECK (jsonb_typeof("model_invocations"."usage") = 'object'),
	CONSTRAINT "model_invocations_schema_outcome_check" CHECK ("model_invocations"."schema_outcome" in ('not_requested', 'valid', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_payload_object_check" CHECK (jsonb_typeof("run_events"."payload") = 'object'),
	CONSTRAINT "run_events_from_status_check" CHECK ("run_events"."from_status" is null or "run_events"."from_status" in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human', 'succeeded', 'failed', 'blocked', 'cancelled')),
	CONSTRAINT "run_events_to_status_check" CHECK ("run_events"."to_status" is null or "run_events"."to_status" in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human', 'succeeded', 'failed', 'blocked', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"side_effect_class" text NOT NULL,
	"idempotency_key" text,
	"input_summary" text,
	"output_summary" text,
	"external_id" text,
	"failure_class" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tool_calls_id_run_id_unique" UNIQUE("id","run_id"),
	CONSTRAINT "tool_calls_attempt_check" CHECK ("tool_calls"."attempt" > 0),
	CONSTRAINT "tool_calls_status_check" CHECK ("tool_calls"."status" in ('success', 'failed', 'unknown')),
	CONSTRAINT "tool_calls_side_effect_class_check" CHECK ("tool_calls"."side_effect_class" in ('read_only', 'reversible', 'consequential'))
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_attempt_events" ADD CONSTRAINT "development_attempt_events_attempt_id_development_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."development_attempts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_attempts" ADD CONSTRAINT "development_attempts_task_id_development_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."development_tasks"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_review_events" ADD CONSTRAINT "development_review_events_review_id_development_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."development_reviews"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_reviews" ADD CONSTRAINT "development_reviews_task_id_development_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."development_tasks"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_reviews" ADD CONSTRAINT "development_reviews_implementer_attempt_id_development_attempts_id_fk" FOREIGN KEY ("implementer_attempt_id") REFERENCES "public"."development_attempts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_tool_call_run_fk" FOREIGN KEY ("tool_call_id","run_id") REFERENCES "public"."tool_calls"("id","run_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_automation_scheduled_for_uidx" ON "automation_runs" USING btree ("automation_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_one_active_uidx" ON "automation_runs" USING btree ("automation_id") WHERE "automation_runs"."status" in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human');--> statement-breakpoint
CREATE INDEX "automation_runs_claim_idx" ON "automation_runs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "automation_runs_lease_expiry_idx" ON "automation_runs" USING btree ("lease_expires_at") WHERE "automation_runs"."lease_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "automations_due_idx" ON "automations" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "command_requests_claim_idx" ON "command_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "development_attempts_lease_idx" ON "development_attempts" USING btree ("lease_expires_at") WHERE "development_attempts"."lease_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "development_reviews_claim_idx" ON "development_reviews" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "development_tasks_claim_idx" ON "development_tasks" USING btree ("status","created_at");
--> statement-breakpoint
CREATE FUNCTION reject_run_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'run_events are append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER run_events_append_only
BEFORE UPDATE OR DELETE ON "run_events"
FOR EACH ROW EXECUTE FUNCTION reject_run_event_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_development_task_contract() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.authority_invalidated_at IS NOT NULL
		AND NEW.authority_invalidated_at IS DISTINCT FROM OLD.authority_invalidated_at THEN
		RAISE EXCEPTION 'development task authority invalidation is immutable' USING ERRCODE = '55000';
	END IF;
	IF OLD.status = 'candidate_ready' AND NEW.status = 'blocked'
		AND OLD.authority_invalidated_at IS NULL THEN
		NEW.authority_invalidated_at := clock_timestamp();
	END IF;
	IF OLD.status <> 'ready' OR NEW.status <> 'ready' THEN
		IF NEW.approved_spec IS DISTINCT FROM OLD.approved_spec
			OR NEW.acceptance_criteria IS DISTINCT FROM OLD.acceptance_criteria
			OR NEW.base_commit IS DISTINCT FROM OLD.base_commit
			OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
			OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
			RAISE EXCEPTION 'development task contract is immutable after execution starts' USING ERRCODE = '55000';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER development_tasks_protect_contract
BEFORE UPDATE ON "development_tasks"
FOR EACH ROW EXECUTE FUNCTION protect_development_task_contract();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_development_attempt_binding() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	task_base_commit text;
	task_max_attempts integer;
BEGIN
	SELECT base_commit, max_attempts
	INTO task_base_commit, task_max_attempts
	FROM development_tasks
	WHERE id = NEW.task_id;

	IF task_base_commit IS NULL THEN
		RAISE EXCEPTION 'development task does not exist' USING ERRCODE = '23503';
	END IF;
	IF NEW.base_commit <> task_base_commit THEN
		RAISE EXCEPTION 'attempt base commit must match task base commit' USING ERRCODE = '23514';
	END IF;
	IF NEW.attempt_number > task_max_attempts THEN
		RAISE EXCEPTION 'attempt number exceeds task budget' USING ERRCODE = '23514';
	END IF;
	IF NEW.candidate_ref IS NOT NULL
		AND NEW.candidate_ref <> 'refs/personal-agent/development-attempts/' || NEW.id::text THEN
		RAISE EXCEPTION 'candidate ref must be the trusted attempt ref' USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.candidate_commit IS NOT NULL AND (
		NEW.task_id IS DISTINCT FROM OLD.task_id
		OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
		OR NEW.role IS DISTINCT FROM OLD.role
		OR NEW.base_commit IS DISTINCT FROM OLD.base_commit
		OR NEW.candidate_commit IS DISTINCT FROM OLD.candidate_commit
		OR NEW.candidate_ref IS DISTINCT FROM OLD.candidate_ref
	) THEN
		RAISE EXCEPTION 'captured development candidate provenance is immutable' USING ERRCODE = '55000';
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.candidate_commit IS NOT NULL
		AND OLD.failure_class IS NOT NULL
		AND NEW.failure_class IS DISTINCT FROM OLD.failure_class THEN
		RAISE EXCEPTION 'development candidate integrity invalidation is immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER development_attempts_enforce_binding
BEFORE INSERT OR UPDATE ON "development_attempts"
FOR EACH ROW EXECUTE FUNCTION enforce_development_attempt_binding();
--> statement-breakpoint
CREATE FUNCTION reject_development_attempt_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'development_attempt_events are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER development_attempt_events_append_only
BEFORE UPDATE OR DELETE ON "development_attempt_events"
FOR EACH ROW EXECUTE FUNCTION reject_development_attempt_event_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_development_review_binding() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	task_row development_tasks%ROWTYPE;
	attempt_row development_attempts%ROWTYPE;
	finding jsonb;
	manifest_entry jsonb;
	policy_path jsonb;
	authority_reference jsonb;
	architecture_path text;
BEGIN
	SELECT * INTO task_row FROM development_tasks WHERE id = NEW.task_id;
	SELECT * INTO attempt_row FROM development_attempts WHERE id = NEW.implementer_attempt_id;
	IF task_row.id IS NULL OR attempt_row.id IS NULL THEN
		RAISE EXCEPTION 'review task and implementer attempt must exist' USING ERRCODE = '23503';
	END IF;
	IF (task_row.authority_invalidated_at IS NOT NULL
		AND (TG_OP = 'INSERT' OR NEW.status = 'succeeded'))
		OR attempt_row.task_id <> NEW.task_id
		OR attempt_row.role <> 'implementer'
		OR attempt_row.status <> 'succeeded'
		OR attempt_row.base_commit <> NEW.base_commit
		OR attempt_row.candidate_commit <> NEW.candidate_commit
		OR attempt_row.candidate_ref <> NEW.candidate_ref
		OR task_row.base_commit <> NEW.base_commit
		OR NEW.retention_ref <> 'refs/personal-agent/reviews/' || NEW.id::text THEN
		RAISE EXCEPTION 'review must bind the exact succeeded implementation candidate' USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'INSERT' AND task_row.status <> 'candidate_ready' THEN
		RAISE EXCEPTION 'only candidate_ready tasks may be reviewed' USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'UPDATE' THEN
		IF NEW.task_id IS DISTINCT FROM OLD.task_id
			OR NEW.implementer_attempt_id IS DISTINCT FROM OLD.implementer_attempt_id
			OR NEW.base_commit IS DISTINCT FROM OLD.base_commit
			OR NEW.candidate_commit IS DISTINCT FROM OLD.candidate_commit
			OR NEW.candidate_ref IS DISTINCT FROM OLD.candidate_ref
			OR NEW.retention_ref IS DISTINCT FROM OLD.retention_ref
			OR NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id
			OR NEW.budget IS DISTINCT FROM OLD.budget
			OR NEW.model_profile IS DISTINCT FROM OLD.model_profile
			OR NEW.context_policy IS DISTINCT FROM OLD.context_policy
			OR (OLD.context_digest IS NOT NULL AND NEW.context_digest IS DISTINCT FROM OLD.context_digest)
			OR (OLD.context_manifest IS NOT NULL AND NEW.context_manifest IS DISTINCT FROM OLD.context_manifest)
			OR (OLD.decision IS NOT NULL AND NEW.decision IS DISTINCT FROM OLD.decision)
			OR (OLD.decision IS NOT NULL AND NEW.findings IS DISTINCT FROM OLD.findings) THEN
			RAISE EXCEPTION 'review candidate, policy, context, and proposal bindings are immutable' USING ERRCODE = '55000';
		END IF;
	END IF;

	IF jsonb_typeof(NEW.context_policy) <> 'object'
		OR NOT (NEW.context_policy ?& ARRAY['forbiddenPaths', 'readablePaths', 'relevantPaths'])
		OR EXISTS (
			SELECT 1 FROM jsonb_object_keys(NEW.context_policy) key
			WHERE key NOT IN ('forbiddenPaths', 'readablePaths', 'relevantPaths')
		)
		OR jsonb_typeof(NEW.context_policy->'forbiddenPaths') <> 'array'
		OR jsonb_typeof(NEW.context_policy->'readablePaths') <> 'array'
		OR jsonb_typeof(NEW.context_policy->'relevantPaths') <> 'array'
		OR jsonb_array_length(NEW.context_policy->'forbiddenPaths') > 64
		OR jsonb_array_length(NEW.context_policy->'readablePaths') NOT BETWEEN 1 AND 64
		OR jsonb_array_length(NEW.context_policy->'relevantPaths') > 64 THEN
		RAISE EXCEPTION 'review context policy has an invalid durable structure' USING ERRCODE = '23514';
	END IF;
	FOR policy_path IN
		SELECT value FROM jsonb_array_elements(NEW.context_policy->'forbiddenPaths')
		UNION ALL SELECT value FROM jsonb_array_elements(NEW.context_policy->'readablePaths')
	LOOP
		IF jsonb_typeof(policy_path) <> 'string'
			OR char_length(policy_path #>> '{}') NOT BETWEEN 1 AND 500
			OR btrim(policy_path #>> '{}') <> policy_path #>> '{}'
			OR (policy_path #>> '{}') LIKE '/%'
			OR (policy_path #>> '{}') LIKE '%\%'
			OR ((policy_path #>> '{}') <> '.' AND (policy_path #>> '{}') ~ '(^|/)(\.{1,2})($|/)|//|/$') THEN
			RAISE EXCEPTION 'review context policy contains an invalid scoped path' USING ERRCODE = '23514';
		END IF;
	END LOOP;
	FOR policy_path IN SELECT value FROM jsonb_array_elements(NEW.context_policy->'relevantPaths')
	LOOP
		IF jsonb_typeof(policy_path) <> 'string'
			OR char_length(policy_path #>> '{}') NOT BETWEEN 1 AND 500
			OR btrim(policy_path #>> '{}') <> policy_path #>> '{}'
			OR (policy_path #>> '{}') = '.'
			OR (policy_path #>> '{}') LIKE '/%'
			OR (policy_path #>> '{}') LIKE '%\%'
			OR (policy_path #>> '{}') ~ '(^|/)(\.{1,2})($|/)|//|/$' THEN
			RAISE EXCEPTION 'review context policy contains an invalid relevant path' USING ERRCODE = '23514';
		END IF;
	END LOOP;

	IF NEW.context_manifest IS NOT NULL THEN
		IF jsonb_typeof(NEW.context_manifest) <> 'object'
			OR NOT (NEW.context_manifest ?& ARRAY['authorityReferences', 'entries', 'totalBytes'])
			OR EXISTS (
				SELECT 1 FROM jsonb_object_keys(NEW.context_manifest) key
				WHERE key NOT IN ('authorityReferences', 'entries', 'totalBytes')
			)
			OR jsonb_typeof(NEW.context_manifest->'authorityReferences') <> 'array'
			OR jsonb_array_length(NEW.context_manifest->'authorityReferences') NOT BETWEEN 1 AND 512
			OR jsonb_typeof(NEW.context_manifest->'entries') <> 'array'
			OR jsonb_array_length(NEW.context_manifest->'entries') > 256
			OR jsonb_typeof(NEW.context_manifest->'totalBytes') <> 'number'
			OR (NEW.context_manifest->>'totalBytes') !~ '^(0|[1-9][0-9]*)$'
			OR (NEW.context_manifest->>'totalBytes')::numeric > 9007199254740991 THEN
			RAISE EXCEPTION 'review context manifest has an invalid durable structure' USING ERRCODE = '23514';
		END IF;
		FOR manifest_entry IN SELECT value FROM jsonb_array_elements(NEW.context_manifest->'entries')
		LOOP
			IF jsonb_typeof(manifest_entry) <> 'object'
				OR NOT (manifest_entry ?& ARRAY['blobId', 'bytes', 'path', 'source'])
				OR EXISTS (
					SELECT 1 FROM jsonb_object_keys(manifest_entry) key
					WHERE key NOT IN ('blobId', 'bytes', 'path', 'source')
				)
				OR jsonb_typeof(manifest_entry->'blobId') <> 'string'
				OR (manifest_entry->>'blobId') !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
				OR jsonb_typeof(manifest_entry->'bytes') <> 'number'
				OR (manifest_entry->>'bytes') !~ '^(0|[1-9][0-9]*)$'
				OR (manifest_entry->>'bytes')::numeric > 9007199254740991
				OR jsonb_typeof(manifest_entry->'path') <> 'string'
				OR char_length(manifest_entry->>'path') NOT BETWEEN 1 AND 500
				OR btrim(manifest_entry->>'path') <> manifest_entry->>'path'
				OR (manifest_entry->>'path') LIKE '/%'
				OR (manifest_entry->>'path') LIKE '%\%'
				OR (manifest_entry->>'path') ~ '(^|/)(\.{1,2})($|/)|//|/$'
				OR jsonb_typeof(manifest_entry->'source') <> 'string'
				OR (manifest_entry->>'source') NOT IN ('authority', 'repository') THEN
				RAISE EXCEPTION 'review context manifest contains an invalid entry' USING ERRCODE = '23514';
			END IF;
		END LOOP;
		IF (NEW.context_manifest->>'totalBytes')::numeric <> COALESCE((
			SELECT sum((entry->>'bytes')::numeric)
			FROM jsonb_array_elements(NEW.context_manifest->'entries') entry
		), 0) THEN
			RAISE EXCEPTION 'review context manifest byte total is inconsistent' USING ERRCODE = '23514';
		END IF;
		IF (
			SELECT count(*) <> count(DISTINCT value)
			FROM jsonb_array_elements(NEW.context_manifest->'authorityReferences')
		) THEN
			RAISE EXCEPTION 'review authority references must be unique' USING ERRCODE = '23514';
		END IF;
		FOR authority_reference IN SELECT value FROM jsonb_array_elements(NEW.context_manifest->'authorityReferences')
		LOOP
			IF jsonb_typeof(authority_reference) <> 'string'
				OR char_length(authority_reference #>> '{}') NOT BETWEEN 1 AND 500
				OR btrim(authority_reference #>> '{}') <> authority_reference #>> '{}'
				OR (authority_reference #>> '{}') !~ '^[^#]+#[a-z0-9][a-z0-9-]{0,199}$' THEN
				RAISE EXCEPTION 'review context manifest contains an invalid authority reference' USING ERRCODE = '23514';
			END IF;
			architecture_path := split_part(authority_reference #>> '{}', '#', 1);
			IF architecture_path LIKE '/%'
				OR architecture_path LIKE '%\%'
				OR architecture_path ~ '(^|/)(\.{1,2})($|/)|//|/$'
				OR NOT EXISTS (
					SELECT 1 FROM jsonb_array_elements(NEW.context_manifest->'entries') entry
					WHERE entry->>'source' = 'authority' AND entry->>'path' = architecture_path
				) THEN
				RAISE EXCEPTION 'review authority reference is not bound to a governing blob' USING ERRCODE = '23514';
			END IF;
		END LOOP;
	END IF;

	FOR finding IN SELECT value FROM jsonb_array_elements(NEW.findings)
	LOOP
		IF jsonb_typeof(finding) <> 'object'
			OR NOT (finding ?& ARRAY['severity', 'category', 'finding', 'requiredCorrection', 'acceptanceCriterionId', 'architectureReference'])
			OR EXISTS (
				SELECT 1 FROM jsonb_object_keys(finding) key
				WHERE key NOT IN ('severity', 'category', 'finding', 'requiredCorrection', 'acceptanceCriterionId', 'architectureReference', 'relevantPath')
			)
			OR jsonb_typeof(finding->'severity') <> 'string'
			OR (finding->>'severity') NOT IN ('critical', 'high', 'medium', 'low')
			OR jsonb_typeof(finding->'category') <> 'string'
			OR (finding->>'category') NOT IN ('acceptance', 'architecture', 'correctness', 'maintainability', 'scope', 'security', 'testing')
			OR jsonb_typeof(finding->'finding') <> 'string'
			OR char_length(finding->>'finding') NOT BETWEEN 1 AND 4000
			OR btrim(finding->>'finding') <> finding->>'finding'
			OR jsonb_typeof(finding->'requiredCorrection') <> 'string'
			OR char_length(finding->>'requiredCorrection') NOT BETWEEN 1 AND 4000
			OR btrim(finding->>'requiredCorrection') <> finding->>'requiredCorrection'
			OR jsonb_typeof(finding->'acceptanceCriterionId') <> 'string'
			OR char_length(finding->>'acceptanceCriterionId') NOT BETWEEN 1 AND 100
			OR (finding->>'acceptanceCriterionId') !~ '^[a-z0-9][a-z0-9_-]{0,99}$'
			OR jsonb_typeof(finding->'architectureReference') <> 'string'
			OR char_length(finding->>'architectureReference') NOT BETWEEN 1 AND 500
			OR (finding->>'architectureReference') !~ '^[^#]+#[a-z0-9][a-z0-9-]{0,199}$' THEN
			RAISE EXCEPTION 'review findings require a strict durable structure' USING ERRCODE = '23514';
		END IF;
		IF NEW.context_manifest IS NULL THEN
			RAISE EXCEPTION 'review findings require a durable context manifest' USING ERRCODE = '23514';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM jsonb_array_elements(task_row.acceptance_criteria) criterion
			WHERE criterion->>'id' = finding->>'acceptanceCriterionId'
		) THEN
			RAISE EXCEPTION 'review finding references an unknown acceptance criterion' USING ERRCODE = '23514';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM jsonb_array_elements_text(NEW.context_manifest->'authorityReferences') reference
			WHERE reference = finding->>'architectureReference'
		) THEN
			RAISE EXCEPTION 'review finding references unresolved governing authority' USING ERRCODE = '23514';
		END IF;
		IF finding ? 'relevantPath' AND (
			jsonb_typeof(finding->'relevantPath') <> 'string'
			OR char_length(finding->>'relevantPath') NOT BETWEEN 1 AND 500
			OR btrim(finding->>'relevantPath') <> finding->>'relevantPath'
			OR (finding->>'relevantPath') LIKE '/%'
			OR (finding->>'relevantPath') LIKE '%\%'
			OR (finding->>'relevantPath') ~ '(^|/)(\.{1,2})($|/)|//|/$'
			OR NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements(NEW.context_manifest->'entries') entry
				WHERE entry->>'source' = 'repository' AND entry->>'path' = finding->>'relevantPath'
			)
		) THEN
			RAISE EXCEPTION 'review finding path is not bound to the exact candidate context' USING ERRCODE = '23514';
		END IF;
	END LOOP;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER development_reviews_enforce_binding
BEFORE INSERT OR UPDATE ON "development_reviews"
FOR EACH ROW EXECUTE FUNCTION enforce_development_review_binding();
--> statement-breakpoint
CREATE FUNCTION reject_development_review_history_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'development review history is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER development_review_events_append_only
BEFORE UPDATE OR DELETE ON "development_review_events"
FOR EACH ROW EXECUTE FUNCTION reject_development_review_history_mutation();
--> statement-breakpoint
CREATE TRIGGER development_reviews_no_delete
BEFORE DELETE ON "development_reviews"
FOR EACH ROW EXECUTE FUNCTION reject_development_review_history_mutation();
--> statement-breakpoint
CREATE FUNCTION enforce_development_review_authority() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  key text;
  value jsonb;
  maximum numeric;
BEGIN
  IF jsonb_typeof(NEW.budget) <> 'object'
    OR NOT (NEW.budget ?& ARRAY[
      'maxCommandMs', 'maxCommandOutputBytes', 'maxContextBytes', 'maxCostUsdMicros',
      'maxDiffBytes', 'maxModelInvocations', 'maxTokens', 'maxToolCalls',
      'maxWallClockMs', 'maxWorkspaceBytes'
    ])
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.budget)) <> 10 THEN
    RAISE EXCEPTION 'review budget has an invalid durable structure' USING ERRCODE = '23514';
  END IF;
  FOR key, value IN SELECT * FROM jsonb_each(NEW.budget)
  LOOP
    maximum := CASE key
      WHEN 'maxCommandMs' THEN 1800000
      WHEN 'maxCommandOutputBytes' THEN 10000000
      WHEN 'maxContextBytes' THEN 2000000
      WHEN 'maxCostUsdMicros' THEN 9007199254740991
      WHEN 'maxDiffBytes' THEN 100000000
      WHEN 'maxModelInvocations' THEN 20
      WHEN 'maxTokens' THEN 10000000
      WHEN 'maxToolCalls' THEN 10000
      WHEN 'maxWallClockMs' THEN 86400000
      WHEN 'maxWorkspaceBytes' THEN 2000000000
      ELSE NULL
    END;
    IF maximum IS NULL
      OR jsonb_typeof(value) <> 'number'
      OR (value #>> '{}') !~ '^(0|[1-9][0-9]*)$'
      OR (value #>> '{}')::numeric > maximum
      OR (key <> 'maxCostUsdMicros' AND (value #>> '{}')::numeric < 1) THEN
      RAISE EXCEPTION 'review budget contains an invalid value' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF jsonb_typeof(NEW.usage) <> 'object'
    OR NOT (NEW.usage ?& ARRAY[
      'commandMs', 'commandOutputBytes', 'costUsdMicros', 'inputTokens',
      'modelInvocations', 'outputTokens', 'toolCalls'
    ])
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.usage)) <> 7 THEN
    RAISE EXCEPTION 'review usage has an invalid durable structure' USING ERRCODE = '23514';
  END IF;
  FOR key, value IN SELECT * FROM jsonb_each(NEW.usage)
  LOOP
    IF jsonb_typeof(value) <> 'number'
      OR (value #>> '{}') !~ '^(0|[1-9][0-9]*)$'
      OR (value #>> '{}')::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'review usage contains an invalid value' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF (NEW.usage->>'modelInvocations')::numeric > (NEW.budget->>'maxModelInvocations')::numeric
    OR (NEW.usage->>'inputTokens')::numeric + (NEW.usage->>'outputTokens')::numeric > (NEW.budget->>'maxTokens')::numeric
    OR (NEW.usage->>'costUsdMicros')::numeric > (NEW.budget->>'maxCostUsdMicros')::numeric
    OR (NEW.usage->>'toolCalls')::numeric > (NEW.budget->>'maxToolCalls')::numeric
    OR (NEW.usage->>'commandOutputBytes')::numeric > (NEW.budget->>'maxCommandOutputBytes')::numeric
    OR (NEW.usage->>'commandMs')::numeric > (NEW.budget->>'maxWallClockMs')::numeric THEN
    RAISE EXCEPTION 'review usage exceeds its durable budget' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'preparing'
      OR NEW.context_manifest IS NOT NULL
      OR NEW.context_digest IS NOT NULL
      OR NEW.decision IS NOT NULL
      OR NEW.findings <> '[]'::jsonb
      OR NEW.cleanup_status <> 'pending'
      OR NEW.failure_class IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.finalized_at IS NOT NULL
      OR NEW.lease_generation <> 1
      OR NEW.usage <> '{"commandMs":0,"commandOutputBytes":0,"costUsdMicros":0,"inputTokens":0,"modelInvocations":0,"outputTokens":0,"toolCalls":0}'::jsonb THEN
      RAISE EXCEPTION 'review must begin in the initial preparing state' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'preparing' AND NEW.status IN ('reviewing', 'interrupted'))
      OR (OLD.status = 'reviewing' AND NEW.status IN ('finalizing', 'interrupted'))
      OR (OLD.status = 'finalizing' AND NEW.status IN ('succeeded', 'failed'))
      OR (OLD.status = 'interrupted' AND NEW.status = 'failed')
    ) THEN
      RAISE EXCEPTION 'invalid durable review state transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_generation IS DISTINCT FROM OLD.lease_generation THEN
      IF NEW.lease_generation <> OLD.lease_generation + 1
        OR OLD.lease_expires_at > clock_timestamp()
        OR NEW.lease_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'invalid durable review lease replacement' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner THEN
      RAISE EXCEPTION 'review lease owner requires a new generation' USING ERRCODE = '23514';
    ELSIF NEW.lease_expires_at > OLD.lease_expires_at
      AND OLD.lease_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'expired review lease cannot be renewed' USING ERRCODE = '23514';
    END IF;
    IF NEW.cleanup_status IS DISTINCT FROM OLD.cleanup_status AND NOT (
      OLD.cleanup_status IN ('pending', 'failed')
      AND NEW.cleanup_status IN ('failed', 'succeeded')
      AND NEW.status IN ('finalizing', 'interrupted')
    ) THEN
      RAISE EXCEPTION 'invalid durable review cleanup transition' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('reviewing', 'finalizing', 'succeeded')
    AND (NEW.context_manifest IS NULL OR NEW.context_digest IS NULL) THEN
    RAISE EXCEPTION 'active review state requires durable context' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('finalizing', 'succeeded') AND NEW.decision IS NULL THEN
    RAISE EXCEPTION 'final review state requires a durable proposal' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'succeeded' AND (
    NEW.cleanup_status <> 'succeeded'
    OR NEW.failure_class IS NOT NULL
    OR NEW.safe_summary IS NULL
    OR char_length(NEW.safe_summary) NOT BETWEEN 1 AND 2000
    OR btrim(NEW.safe_summary) <> NEW.safe_summary
    OR NEW.completed_at IS NULL
    OR NEW.finalized_at IS NULL
  ) THEN
    RAISE EXCEPTION 'authoritative review is missing finalization prerequisites' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER development_reviews_enforce_authority
BEFORE INSERT OR UPDATE ON "development_reviews"
FOR EACH ROW EXECUTE FUNCTION enforce_development_review_authority();
