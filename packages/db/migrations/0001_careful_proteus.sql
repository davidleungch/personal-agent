CREATE TABLE "ci_validation_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"validation_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"retry_class" text NOT NULL,
	"sequence" integer NOT NULL,
	"safe_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_validation_actions_key_unique" UNIQUE("validation_id","action_key"),
	CONSTRAINT "ci_validation_actions_sequence_unique" UNIQUE("validation_id","sequence"),
	CONSTRAINT "ci_validation_actions_kind_check" CHECK ("ci_validation_actions"."kind" in ('publication', 'trigger', 'observation')),
	CONSTRAINT "ci_validation_actions_status_check" CHECK ("ci_validation_actions"."status" in ('started', 'success', 'failed', 'unknown')),
	CONSTRAINT "ci_validation_actions_retry_class_check" CHECK ("ci_validation_actions"."retry_class" in ('retry_safe', 'reconciliation_required', 'no_automatic_retry')),
	CONSTRAINT "ci_validation_actions_metadata_check" CHECK (jsonb_typeof("ci_validation_actions"."safe_metadata") = 'object'),
	CONSTRAINT "ci_validation_actions_receipt_check" CHECK ("ci_validation_actions"."receipt" is null or jsonb_typeof("ci_validation_actions"."receipt") = 'object'),
	CONSTRAINT "ci_validation_actions_sequence_check" CHECK ("ci_validation_actions"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "ci_validations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"validation_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"target_ref" text DEFAULT 'refs/heads/main' NOT NULL,
	"base_commit" text NOT NULL,
	"candidate_commit" text NOT NULL,
	"candidate_ref" text NOT NULL,
	"policy_revision" text NOT NULL,
	"policy_digest" text NOT NULL,
	"authority_catalog_digest" text NOT NULL,
	"required_checks_digest" text NOT NULL,
	"status" text NOT NULL,
	"failure_class" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" integer DEFAULT 1 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"infrastructure_retry_count" integer DEFAULT 0 NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ci_validations_binding_unique" UNIQUE("task_id","attempt_id","review_id","candidate_commit","policy_digest","required_checks_digest"),
	CONSTRAINT "ci_validations_validation_id_unique" UNIQUE("validation_id"),
	CONSTRAINT "ci_validations_target_ref_check" CHECK ("ci_validations"."target_ref" = 'refs/heads/main'),
	CONSTRAINT "ci_validations_base_commit_check" CHECK ("ci_validations"."base_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "ci_validations_candidate_commit_check" CHECK ("ci_validations"."candidate_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "ci_validations_candidate_ref_check" CHECK ("ci_validations"."candidate_ref" ~ '^refs/personal-agent/development-attempts/[0-9a-f-]{36}$'),
	CONSTRAINT "ci_validations_digest_check" CHECK ("ci_validations"."policy_digest" ~ '^[0-9a-f]{64}$' and "ci_validations"."authority_catalog_digest" ~ '^[0-9a-f]{64}$' and "ci_validations"."required_checks_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ci_validations_status_check" CHECK ("ci_validations"."status" in ('pending', 'running', 'succeeded', 'needs_human')),
	CONSTRAINT "ci_validations_lease_fields_check" CHECK (("ci_validations"."lease_owner" is null and "ci_validations"."lease_expires_at" is null) or ("ci_validations"."lease_owner" is not null and "ci_validations"."lease_expires_at" is not null)),
	CONSTRAINT "ci_validations_lease_generation_check" CHECK ("ci_validations"."lease_generation" > 0),
	CONSTRAINT "ci_validations_retry_check" CHECK ("ci_validations"."infrastructure_retry_count" between 0 and 1),
	CONSTRAINT "ci_validations_receipt_check" CHECK ("ci_validations"."receipt" is null or jsonb_typeof("ci_validations"."receipt") = 'object')
);
--> statement-breakpoint
CREATE TABLE "development_release_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"release_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"retry_class" text,
	"safe_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_release_events_sequence_unique" UNIQUE("release_id","sequence"),
	CONSTRAINT "development_release_events_sequence_check" CHECK ("development_release_events"."sequence" > 0),
	CONSTRAINT "development_release_events_status_check" CHECK ("development_release_events"."status" in ('started', 'success', 'failed', 'unknown', 'blocked')),
	CONSTRAINT "development_release_events_retry_class_check" CHECK ("development_release_events"."retry_class" is null or "development_release_events"."retry_class" in ('retry_safe', 'reconciliation_required', 'no_automatic_retry')),
	CONSTRAINT "development_release_events_metadata_check" CHECK (jsonb_typeof("development_release_events"."safe_metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "development_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"validation_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"target_ref" text DEFAULT 'refs/heads/main' NOT NULL,
	"environment_id" text NOT NULL,
	"base_commit" text NOT NULL,
	"candidate_commit" text NOT NULL,
	"candidate_ref" text NOT NULL,
	"policy_revision" text NOT NULL,
	"policy_digest" text NOT NULL,
	"authority_catalog_digest" text NOT NULL,
	"required_checks_digest" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"lease_owner" text,
	"lease_generation" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"reservation_operation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_releases_task_unique" UNIQUE("task_id"),
	CONSTRAINT "development_releases_reservation_unique" UNIQUE("reservation_operation_id"),
	CONSTRAINT "development_releases_target_ref_check" CHECK ("development_releases"."target_ref" = 'refs/heads/main'),
	CONSTRAINT "development_releases_commit_check" CHECK ("development_releases"."base_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' and "development_releases"."candidate_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "development_releases_candidate_ref_check" CHECK ("development_releases"."candidate_ref" ~ '^refs/personal-agent/development-attempts/[0-9a-f-]{36}$'),
	CONSTRAINT "development_releases_digest_check" CHECK ("development_releases"."policy_digest" ~ '^[0-9a-f]{64}$' and "development_releases"."authority_catalog_digest" ~ '^[0-9a-f]{64}$' and "development_releases"."required_checks_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "development_releases_status_check" CHECK ("development_releases"."status" in ('merge_pending', 'merged', 'build_pending', 'deploy_pending', 'verifying', 'deployed', 'needs_human')),
	CONSTRAINT "development_releases_lease_fields_check" CHECK (("development_releases"."lease_owner" is null and "development_releases"."lease_expires_at" is null) or ("development_releases"."lease_owner" is not null and "development_releases"."lease_expires_at" is not null)),
	CONSTRAINT "development_releases_lease_generation_check" CHECK ("development_releases"."lease_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "phase2d_environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"policy_id" uuid NOT NULL,
	"environment_id" text NOT NULL,
	"active_release_id" uuid,
	"reservation_release_id" uuid,
	"reservation_operation_id" text,
	"current_release_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phase2d_environments_environment_unique" UNIQUE("environment_id"),
	CONSTRAINT "phase2d_environments_policy_environment_unique" UNIQUE("policy_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "phase2d_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"remote_url" text NOT NULL,
	"target_ref" text DEFAULT 'refs/heads/main' NOT NULL,
	"environment_id" text NOT NULL,
	"policy_revision" text NOT NULL,
	"policy_digest" text NOT NULL,
	"authority_catalog_digest" text NOT NULL,
	"required_checks_digest" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phase2d_policies_repository_environment_unique" UNIQUE("repository_id","environment_id"),
	CONSTRAINT "phase2d_policies_target_ref_check" CHECK ("phase2d_policies"."target_ref" = 'refs/heads/main'),
	CONSTRAINT "phase2d_policies_policy_digest_check" CHECK ("phase2d_policies"."policy_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "phase2d_policies_authority_digest_check" CHECK ("phase2d_policies"."authority_catalog_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "phase2d_policies_checks_digest_check" CHECK ("phase2d_policies"."required_checks_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ci_validation_actions" ADD CONSTRAINT "ci_validation_actions_validation_id_ci_validations_id_fk" FOREIGN KEY ("validation_id") REFERENCES "public"."ci_validations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "ci_validations" ADD CONSTRAINT "ci_validations_task_id_development_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."development_tasks"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "ci_validations" ADD CONSTRAINT "ci_validations_attempt_id_development_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."development_attempts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "ci_validations" ADD CONSTRAINT "ci_validations_review_id_development_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."development_reviews"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "ci_validations" ADD CONSTRAINT "ci_validations_policy_id_phase2d_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."phase2d_policies"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_release_events" ADD CONSTRAINT "development_release_events_release_id_development_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."development_releases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_releases" ADD CONSTRAINT "development_releases_task_id_development_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."development_tasks"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_releases" ADD CONSTRAINT "development_releases_attempt_id_development_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."development_attempts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_releases" ADD CONSTRAINT "development_releases_review_id_development_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."development_reviews"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_releases" ADD CONSTRAINT "development_releases_validation_id_ci_validations_id_fk" FOREIGN KEY ("validation_id") REFERENCES "public"."ci_validations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "development_releases" ADD CONSTRAINT "development_releases_policy_id_phase2d_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."phase2d_policies"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "phase2d_environments" ADD CONSTRAINT "phase2d_environments_policy_id_phase2d_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."phase2d_policies"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "ci_validations_claim_idx" ON "ci_validations" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "development_releases_environment_idx" ON "development_releases" USING btree ("environment_id","status");