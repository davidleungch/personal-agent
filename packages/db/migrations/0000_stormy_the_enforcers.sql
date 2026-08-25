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
	"model_profile" text NOT NULL,
	"execution_model_id" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_outcome" text NOT NULL,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
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
	CONSTRAINT "run_events_payload_object_check" CHECK (jsonb_typeof("run_events"."payload") = 'object')
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
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_tool_call_run_fk" FOREIGN KEY ("tool_call_id","run_id") REFERENCES "public"."tool_calls"("id","run_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_automation_scheduled_for_uidx" ON "automation_runs" USING btree ("automation_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_one_active_uidx" ON "automation_runs" USING btree ("automation_id") WHERE "automation_runs"."status" in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human');--> statement-breakpoint
CREATE INDEX "automation_runs_claim_idx" ON "automation_runs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "command_requests_claim_idx" ON "command_requests" USING btree ("status","created_at");