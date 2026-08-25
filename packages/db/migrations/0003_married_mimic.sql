ALTER TABLE "model_invocations" ADD COLUMN "role" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_invocations" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_role_check" CHECK ("model_invocations"."role" in ('intent_router', 'extractor', 'general', 'planner', 'verification'));
