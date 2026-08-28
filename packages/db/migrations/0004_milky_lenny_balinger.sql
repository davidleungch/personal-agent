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
CREATE TABLE "development_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"approved_spec" text NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"status" text NOT NULL,
	"base_commit" text NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_tasks_status_check" CHECK ("development_tasks"."status" in ('ready', 'preparing', 'implementing', 'testing', 'candidate_ready', 'blocked', 'failed', 'cancelled')),
	CONSTRAINT "development_tasks_base_commit_check" CHECK ("development_tasks"."base_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "development_tasks_max_attempts_check" CHECK ("development_tasks"."max_attempts" = 1),
	CONSTRAINT "development_tasks_acceptance_criteria_array_check" CHECK (jsonb_typeof("development_tasks"."acceptance_criteria") = 'array' and jsonb_array_length("development_tasks"."acceptance_criteria") > 0)
);
--> statement-breakpoint
ALTER TABLE "development_attempt_events" ADD CONSTRAINT "development_attempt_events_attempt_id_development_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."development_attempts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_attempts" ADD CONSTRAINT "development_attempts_task_id_development_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."development_tasks"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "development_attempts_lease_idx" ON "development_attempts" USING btree ("lease_expires_at") WHERE "development_attempts"."lease_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "development_tasks_claim_idx" ON "development_tasks" USING btree ("status","created_at");
--> statement-breakpoint
CREATE FUNCTION protect_development_task_contract() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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
CREATE FUNCTION enforce_development_attempt_binding() RETURNS trigger
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
