ALTER TABLE "automations" ADD CONSTRAINT "automations_completion_mode_check" CHECK ("automations"."completion_mode" in ('continue', 'stop_after_success'));--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_from_status_check" CHECK ("run_events"."from_status" is null or "run_events"."from_status" in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human', 'succeeded', 'failed', 'blocked', 'cancelled'));--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_to_status_check" CHECK ("run_events"."to_status" is null or "run_events"."to_status" in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human', 'succeeded', 'failed', 'blocked', 'cancelled'));--> statement-breakpoint
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
