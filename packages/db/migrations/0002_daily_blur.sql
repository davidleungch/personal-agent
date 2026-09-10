ALTER TABLE "ci_validation_actions" DROP CONSTRAINT "ci_validation_actions_key_unique";--> statement-breakpoint
ALTER TABLE "phase2d_policies" ADD COLUMN "required_check_names" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "ci_validation_actions_key_idx" ON "ci_validation_actions" USING btree ("validation_id","action_key","sequence");--> statement-breakpoint
ALTER TABLE "phase2d_policies" ADD CONSTRAINT "phase2d_policies_check_names_check" CHECK (jsonb_typeof("phase2d_policies"."required_check_names") = 'array' and jsonb_array_length("phase2d_policies"."required_check_names") > 0);
--> statement-breakpoint
ALTER TABLE "ci_validation_actions" ADD CONSTRAINT "ci_validation_actions_completion_check" CHECK (("ci_validation_actions"."status" = 'started' and "ci_validation_actions"."completed_at" is null) or ("ci_validation_actions"."status" <> 'started' and "ci_validation_actions"."completed_at" is not null));
--> statement-breakpoint
ALTER TABLE "ci_validations" ADD CONSTRAINT "ci_validations_terminal_fields_check" CHECK (("ci_validations"."status" in ('pending', 'running') and "ci_validations"."completed_at" is null and "ci_validations"."receipt" is null and "ci_validations"."failure_class" is null) or ("ci_validations"."status" = 'succeeded' and "ci_validations"."completed_at" is not null and "ci_validations"."receipt" is not null and "ci_validations"."failure_class" is null) or ("ci_validations"."status" = 'needs_human' and "ci_validations"."completed_at" is not null and "ci_validations"."receipt" is null and "ci_validations"."failure_class" is not null));
--> statement-breakpoint
ALTER TABLE "ci_validations" ADD CONSTRAINT "ci_validations_lease_status_check" CHECK (("ci_validations"."status" = 'running') = ("ci_validations"."lease_owner" is not null and "ci_validations"."lease_expires_at" is not null));
