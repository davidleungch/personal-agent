-- Phase 2D M1: narrow PostgreSQL authority gates.
--
-- These routines are deliberately small and typed.  They are the only write
-- surface granted to the production Phase 2D roles; table ownership remains a
-- bootstrap/maintenance concern.  M1 stops at durable admission and exact CI
-- evidence.  It does not authorize a remote merge or a deployment.

SET search_path = pg_catalog, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phase2d_ci_coordinator') THEN
    CREATE ROLE phase2d_ci_coordinator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phase2d_ci_issuer') THEN
    CREATE ROLE phase2d_ci_issuer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phase2d_release_runner') THEN
    CREATE ROLE phase2d_release_runner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- Keep the new terminal-state invariants present even when this migration is
-- applied over the already-created 0001 tables.  The schema module declares
-- the same names for clean Drizzle introspection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ci_validations_terminal_fields_check') THEN
    ALTER TABLE public.ci_validations ADD CONSTRAINT ci_validations_terminal_fields_check CHECK (
      (status IN ('pending', 'running') AND completed_at IS NULL AND receipt IS NULL AND failure_class IS NULL)
      OR (status = 'succeeded' AND completed_at IS NOT NULL AND receipt IS NOT NULL AND failure_class IS NULL)
      OR (status = 'needs_human' AND completed_at IS NOT NULL AND receipt IS NULL AND failure_class IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ci_validations_lease_status_check') THEN
    ALTER TABLE public.ci_validations ADD CONSTRAINT ci_validations_lease_status_check CHECK (
      (status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ci_validation_actions_completion_check') THEN
    ALTER TABLE public.ci_validation_actions ADD CONSTRAINT ci_validation_actions_completion_check CHECK (
      (status = 'started' AND completed_at IS NULL) OR (status <> 'started' AND completed_at IS NOT NULL)
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_assert_candidate(
  p_task_id uuid,
  p_attempt_id uuid,
  p_review_id uuid,
  p_policy_id uuid,
  p_candidate_commit text,
  p_candidate_ref text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task public.development_tasks%ROWTYPE;
  v_attempt public.development_attempts%ROWTYPE;
  v_parent public.development_attempts%ROWTYPE;
  v_parent_review public.development_reviews%ROWTYPE;
  v_latest public.development_attempts%ROWTYPE;
  v_review public.development_reviews%ROWTYPE;
  v_policy public.phase2d_policies%ROWTYPE;
  v_number integer := 0;
  v_count integer := 0;
  v_expected_base text;
BEGIN
  SELECT * INTO v_task FROM public.development_tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'development task does not exist' USING ERRCODE = '55000';
  END IF;
  IF v_task.status <> 'approved_candidate'
     OR v_task.approved_at IS NULL
     OR v_task.authority_invalidated_at IS NOT NULL
     OR v_task.needs_human_reason IS NOT NULL THEN
    RAISE EXCEPTION 'task is not an exact approved candidate' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_policy FROM public.phase2d_policies WHERE id = p_policy_id;
  IF NOT FOUND OR NOT v_policy.enabled OR v_policy.target_ref <> 'refs/heads/main' THEN
    RAISE EXCEPTION 'phase 2D policy is unavailable' USING ERRCODE = '55000';
  END IF;
  IF p_candidate_commit !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR p_candidate_ref !~ '^refs/personal-agent/development-attempts/[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'candidate identity is malformed' USING ERRCODE = '23514';
  END IF;

  SELECT count(*), max(attempt_number)
    INTO v_count, v_number
    FROM public.development_attempts
   WHERE task_id = p_task_id;
  IF v_count < 1 OR v_number <> v_count THEN
    RAISE EXCEPTION 'attempt lineage has a gap' USING ERRCODE = '55000';
  END IF;

  v_number := 0;
  v_expected_base := v_task.base_commit;
  FOR v_attempt IN
    SELECT * FROM public.development_attempts
     WHERE task_id = p_task_id ORDER BY attempt_number
  LOOP
    v_number := v_number + 1;
    IF v_attempt.attempt_number <> v_number
       OR v_attempt.base_commit <> v_expected_base
       OR v_attempt.candidate_ref IS DISTINCT FROM ('refs/personal-agent/development-attempts/' || v_attempt.id::text)
       OR (v_number = 1 AND (v_attempt.fix_iteration IS NOT NULL OR v_attempt.source_review_id IS NOT NULL OR v_attempt.parent_candidate_commit IS NOT NULL))
       OR (v_number > 1 AND (v_attempt.fix_iteration IS DISTINCT FROM v_number - 1 OR v_attempt.source_review_id IS NULL OR v_attempt.parent_candidate_commit IS DISTINCT FROM v_parent.candidate_commit)) THEN
      RAISE EXCEPTION 'candidate lineage is not complete' USING ERRCODE = '55000';
    END IF;
    IF v_number > 1 THEN
      SELECT * INTO v_parent_review
        FROM public.development_reviews
       WHERE id = v_attempt.source_review_id
         AND implementer_attempt_id = v_parent.id
         AND task_id = p_task_id;
      IF NOT FOUND OR v_parent_review.status <> 'succeeded'
         OR v_parent_review.decision <> 'REQUEST_CHANGES'
         OR v_parent_review.finalized_at IS NULL
         OR v_parent_review.failure_class IS NOT NULL THEN
        RAISE EXCEPTION 'fix source review is not bound to its parent' USING ERRCODE = '55000';
      END IF;
    END IF;
    v_parent := v_attempt;
    v_expected_base := v_attempt.candidate_commit;
  END LOOP;

  SELECT * INTO v_latest FROM public.development_attempts
   WHERE task_id = p_task_id ORDER BY attempt_number DESC LIMIT 1;
  IF v_latest.id <> p_attempt_id
     OR v_latest.status <> 'succeeded'
     OR v_latest.failure_class IS NOT NULL
     OR v_latest.candidate_commit IS NULL
     OR v_latest.candidate_commit <> p_candidate_commit
     OR v_latest.candidate_ref <> p_candidate_ref THEN
    RAISE EXCEPTION 'latest attempt is not the requested exact candidate' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_review FROM public.development_reviews
   WHERE id = p_review_id;
  IF NOT FOUND
     OR v_review.task_id <> p_task_id
     OR v_review.implementer_attempt_id <> v_latest.id
     OR v_review.status <> 'succeeded'
     OR v_review.decision <> 'APPROVE'
     OR jsonb_typeof(v_review.findings) <> 'array'
     OR jsonb_array_length(v_review.findings) <> 0
     OR v_review.failure_class IS NOT NULL
     OR v_review.cleanup_status <> 'succeeded'
     OR v_review.finalized_at IS NULL
     OR v_review.completed_at IS NULL
     OR v_review.base_commit <> v_task.base_commit
     OR v_review.candidate_commit <> v_latest.candidate_commit
     OR v_review.candidate_ref <> v_latest.candidate_ref
     OR v_review.context_manifest IS NULL
     OR v_review.context_digest IS NULL
     OR jsonb_typeof(v_review.context_manifest) <> 'object'
     OR jsonb_typeof(v_review.context_manifest->'authorityReferences') <> 'array'
     OR jsonb_array_length(v_review.context_manifest->'authorityReferences') < 1 THEN
    RAISE EXCEPTION 'independent exact candidate review is not final' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(v_review.context_manifest->'entries') IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_review.context_manifest->'entries') AS e(value)
       WHERE value->>'source' = 'authority'
         AND coalesce(value->>'path', '') <> ''
         AND value->>'path' !~ '(^/|(^|/)\.\.?(/|$))'
         AND value->>'blobId' ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_review.context_manifest->'entries') AS e(value)
       WHERE value->>'source' IS DISTINCT FROM 'authority'
         AND value->>'source' IS DISTINCT FROM 'repository'
     ) THEN
    RAISE EXCEPTION 'review authority catalog paths or blobs are malformed' USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_create_ci_validation(
  p_validation_row_id uuid,
  p_validation_id text,
  p_task_id uuid,
  p_attempt_id uuid,
  p_review_id uuid,
  p_policy_id uuid,
  p_candidate_commit text,
  p_candidate_ref text
) RETURNS public.ci_validations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task public.development_tasks%ROWTYPE;
  v_attempt public.development_attempts%ROWTYPE;
  v_review public.development_reviews%ROWTYPE;
  v_policy public.phase2d_policies%ROWTYPE;
  v_existing public.ci_validations%ROWTYPE;
  v_result public.ci_validations%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_validation_id IS NULL OR btrim(p_validation_id) = '' OR length(p_validation_id) > 500 THEN
    RAISE EXCEPTION 'validation identity is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task FROM public.development_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'development task does not exist' USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM public.development_attempts WHERE task_id = p_task_id ORDER BY attempt_number FOR UPDATE;
  PERFORM 1 FROM public.development_reviews WHERE task_id = p_task_id
    ORDER BY (SELECT attempt_number FROM public.development_attempts a WHERE a.id = implementer_attempt_id) FOR UPDATE;
  SELECT * INTO v_policy FROM public.phase2d_policies WHERE id = p_policy_id;
  PERFORM public.phase2d_assert_candidate(p_task_id, p_attempt_id, p_review_id, p_policy_id, p_candidate_commit, p_candidate_ref);

  SELECT * INTO v_existing FROM public.ci_validations
   WHERE task_id = p_task_id AND attempt_id = p_attempt_id AND review_id = p_review_id
     AND candidate_commit = p_candidate_commit AND policy_digest = v_policy.policy_digest
     AND required_checks_digest = v_policy.required_checks_digest
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.validation_id <> p_validation_id THEN
      RAISE EXCEPTION 'validation identity conflicts with an existing binding' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  SELECT clock_timestamp() INTO v_now;
  INSERT INTO public.ci_validations (
    id, validation_id, task_id, attempt_id, review_id, policy_id, repository_id,
    target_ref, base_commit, candidate_commit, candidate_ref, policy_revision,
    policy_digest, authority_catalog_digest, required_checks_digest, status,
    lease_generation, deadline_at, infrastructure_retry_count, created_at, updated_at
  ) VALUES (
    p_validation_row_id, p_validation_id, p_task_id, p_attempt_id, p_review_id, p_policy_id,
    v_policy.repository_id, v_policy.target_ref, v_task.base_commit, p_candidate_commit,
    p_candidate_ref, v_policy.policy_revision, v_policy.policy_digest,
    v_policy.authority_catalog_digest, v_policy.required_checks_digest, 'pending',
    1, v_now + interval '60 minutes', 0, v_now, v_now
  ) RETURNING * INTO v_result;
  RETURN v_result;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_claim_ci_validation(
  p_validation_row_id uuid,
  p_runner_id text
) RETURNS public.ci_validations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.ci_validations%ROWTYPE;
  v_now timestamptz;
  v_generation integer;
  v_result public.ci_validations%ROWTYPE;
BEGIN
  IF p_runner_id IS NULL OR btrim(p_runner_id) = '' THEN
    RAISE EXCEPTION 'CI runner fence is malformed' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CI validation does not exist' USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM public.development_tasks WHERE id = v_row.task_id FOR UPDATE;
  PERFORM 1 FROM public.development_attempts WHERE task_id = v_row.task_id ORDER BY attempt_number FOR UPDATE;
  PERFORM 1 FROM public.development_reviews WHERE task_id = v_row.task_id
    ORDER BY (SELECT attempt_number FROM public.development_attempts a WHERE a.id = implementer_attempt_id) FOR UPDATE;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id FOR UPDATE;
  PERFORM public.phase2d_assert_candidate(v_row.task_id, v_row.attempt_id, v_row.review_id, v_row.policy_id, v_row.candidate_commit, v_row.candidate_ref);
  SELECT clock_timestamp() INTO v_now;
  IF v_row.deadline_at <= v_now OR v_row.status NOT IN ('pending', 'running') THEN
    RAISE EXCEPTION 'CI validation is not claimable' USING ERRCODE = '55000';
  END IF;
  IF v_row.status = 'running' AND (v_row.lease_expires_at IS NULL OR v_row.lease_expires_at > v_now) THEN
    RAISE EXCEPTION 'CI validation lease is still active' USING ERRCODE = '55P03';
  END IF;
  v_generation := CASE WHEN v_row.status = 'running' THEN v_row.lease_generation + 1 ELSE v_row.lease_generation END;
  UPDATE public.ci_validations SET
    status = 'running', lease_owner = p_runner_id, lease_generation = v_generation,
    lease_expires_at = v_now + interval '90 seconds', started_at = coalesce(started_at, v_now),
    completed_at = NULL, updated_at = v_now
   WHERE id = p_validation_row_id
   RETURNING * INTO v_result;
  RETURN v_result;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_heartbeat_ci_validation(
  p_validation_row_id uuid,
  p_runner_id text,
  p_lease_generation integer
) RETURNS public.ci_validations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_row public.ci_validations%ROWTYPE; v_now timestamptz; v_result public.ci_validations%ROWTYPE;
BEGIN
  IF p_runner_id IS NULL OR btrim(p_runner_id) = '' OR p_lease_generation < 1 THEN
    RAISE EXCEPTION 'CI runner fence is malformed' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CI validation does not exist' USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM public.development_tasks WHERE id = v_row.task_id FOR UPDATE;
  PERFORM 1 FROM public.development_attempts WHERE task_id = v_row.task_id ORDER BY attempt_number FOR UPDATE;
  PERFORM 1 FROM public.development_reviews WHERE task_id = v_row.task_id
    ORDER BY (SELECT attempt_number FROM public.development_attempts a WHERE a.id = implementer_attempt_id) FOR UPDATE;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id FOR UPDATE;
  PERFORM public.phase2d_assert_candidate(v_row.task_id, v_row.attempt_id, v_row.review_id, v_row.policy_id, v_row.candidate_commit, v_row.candidate_ref);
  SELECT clock_timestamp() INTO v_now;
  IF v_row.status <> 'running' OR v_row.lease_owner IS DISTINCT FROM p_runner_id
     OR v_row.lease_generation <> p_lease_generation OR v_row.lease_expires_at IS NULL
     OR v_row.lease_expires_at <= v_now OR v_row.deadline_at <= v_now OR v_row.receipt IS NOT NULL THEN
    RAISE EXCEPTION 'CI validation lease is not current' USING ERRCODE = '55000';
  END IF;
  UPDATE public.ci_validations SET lease_expires_at = v_now + interval '90 seconds', updated_at = v_now
   WHERE id = p_validation_row_id RETURNING * INTO v_result;
  RETURN v_result;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_ci_action_intent(
  p_action_id uuid,
  p_validation_row_id uuid,
  p_runner_id text,
  p_lease_generation integer,
  p_action_key text,
  p_kind text,
  p_retry_class text,
  p_safe_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS public.ci_validation_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.ci_validations%ROWTYPE;
  v_existing public.ci_validation_actions%ROWTYPE;
  v_result public.ci_validation_actions%ROWTYPE;
  v_now timestamptz;
  v_sequence integer;
BEGIN
  IF p_runner_id IS NULL OR btrim(p_runner_id) = '' OR p_lease_generation < 1 THEN
    RAISE EXCEPTION 'CI runner fence is malformed' USING ERRCODE = '22023';
  END IF;
  IF p_action_key IS NULL OR p_action_key !~ '^[a-z0-9._/-]{1,128}$'
     OR p_kind NOT IN ('publication', 'trigger', 'observation')
     OR p_retry_class NOT IN ('retry_safe', 'reconciliation_required', 'no_automatic_retry')
     OR p_safe_metadata IS NULL OR jsonb_typeof(p_safe_metadata) <> 'object' THEN
    RAISE EXCEPTION 'invalid typed CI action intent' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CI validation does not exist' USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM public.development_tasks WHERE id = v_row.task_id FOR UPDATE;
  PERFORM 1 FROM public.development_attempts WHERE task_id = v_row.task_id ORDER BY attempt_number FOR UPDATE;
  PERFORM 1 FROM public.development_reviews WHERE task_id = v_row.task_id
    ORDER BY (SELECT attempt_number FROM public.development_attempts a WHERE a.id = implementer_attempt_id) FOR UPDATE;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id FOR UPDATE;
  PERFORM public.phase2d_assert_candidate(v_row.task_id, v_row.attempt_id, v_row.review_id, v_row.policy_id, v_row.candidate_commit, v_row.candidate_ref);
  SELECT clock_timestamp() INTO v_now;
  IF v_row.status <> 'running' OR v_row.lease_owner IS DISTINCT FROM p_runner_id
     OR v_row.lease_generation <> p_lease_generation OR v_row.lease_expires_at IS NULL
     OR v_row.lease_expires_at <= v_now OR v_row.deadline_at <= v_now OR v_row.receipt IS NOT NULL THEN
    RAISE EXCEPTION 'CI validation lease is not current' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_existing FROM public.ci_validation_actions
   WHERE validation_id = p_validation_row_id AND action_key = p_action_key;
  IF FOUND THEN
    IF v_existing.status <> 'started' OR v_existing.kind <> p_kind
       OR v_existing.retry_class <> p_retry_class OR v_existing.safe_metadata <> p_safe_metadata THEN
      RAISE EXCEPTION 'conflicting duplicate CI action intent' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  SELECT coalesce(max(sequence), 0) + 1 INTO v_sequence
    FROM public.ci_validation_actions WHERE validation_id = p_validation_row_id;
  IF v_sequence > 64 THEN
    RAISE EXCEPTION 'CI action journal limit exceeded' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.ci_validation_actions (
    id, validation_id, action_key, kind, status, retry_class, sequence,
    safe_metadata, started_at, created_at
  ) VALUES (p_action_id, p_validation_row_id, p_action_key, p_kind, 'started', p_retry_class,
            v_sequence, p_safe_metadata, v_now, v_now)
  RETURNING * INTO v_result;
  RETURN v_result;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_ci_action_outcome(
  p_outcome_id uuid,
  p_validation_row_id uuid,
  p_runner_id text,
  p_lease_generation integer,
  p_action_key text,
  p_status text,
  p_retry_class text,
  p_receipt jsonb DEFAULT NULL,
  p_safe_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS public.ci_validation_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.ci_validations%ROWTYPE;
  v_intent public.ci_validation_actions%ROWTYPE;
  v_existing public.ci_validation_actions%ROWTYPE;
  v_result public.ci_validation_actions%ROWTYPE;
  v_now timestamptz;
  v_sequence integer;
  v_outcome_key text := p_action_key || '/outcome';
BEGIN
  IF p_runner_id IS NULL OR btrim(p_runner_id) = '' OR p_lease_generation < 1 THEN
    RAISE EXCEPTION 'CI runner fence is malformed' USING ERRCODE = '22023';
  END IF;
  IF p_action_key IS NULL OR p_action_key !~ '^[a-z0-9._/-]{1,128}$'
     OR p_status NOT IN ('success', 'failed', 'unknown')
     OR p_retry_class NOT IN ('retry_safe', 'reconciliation_required', 'no_automatic_retry')
     OR p_safe_metadata IS NULL OR jsonb_typeof(p_safe_metadata) <> 'object'
     OR (p_receipt IS NOT NULL AND jsonb_typeof(p_receipt) <> 'object') THEN
    RAISE EXCEPTION 'invalid typed CI action outcome' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CI validation does not exist' USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM public.development_tasks WHERE id = v_row.task_id FOR UPDATE;
  PERFORM 1 FROM public.development_attempts WHERE task_id = v_row.task_id ORDER BY attempt_number FOR UPDATE;
  PERFORM 1 FROM public.development_reviews WHERE task_id = v_row.task_id
    ORDER BY (SELECT attempt_number FROM public.development_attempts a WHERE a.id = implementer_attempt_id) FOR UPDATE;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id FOR UPDATE;
  PERFORM public.phase2d_assert_candidate(v_row.task_id, v_row.attempt_id, v_row.review_id, v_row.policy_id, v_row.candidate_commit, v_row.candidate_ref);
  SELECT clock_timestamp() INTO v_now;
  IF v_row.status <> 'running' OR v_row.lease_owner IS DISTINCT FROM p_runner_id
     OR v_row.lease_generation <> p_lease_generation OR v_row.lease_expires_at IS NULL
     OR v_row.lease_expires_at <= v_now OR v_row.deadline_at <= v_now OR v_row.receipt IS NOT NULL THEN
    RAISE EXCEPTION 'CI validation lease is not current' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_intent FROM public.ci_validation_actions
   WHERE validation_id = p_validation_row_id AND action_key = p_action_key;
  IF NOT FOUND OR v_intent.status <> 'started' THEN
    RAISE EXCEPTION 'CI action outcome requires a durable intent' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_existing FROM public.ci_validation_actions
   WHERE validation_id = p_validation_row_id AND action_key = v_outcome_key;
  IF FOUND THEN
    IF v_existing.status <> p_status OR v_existing.retry_class <> p_retry_class
       OR v_existing.receipt IS DISTINCT FROM p_receipt OR v_existing.safe_metadata <> p_safe_metadata THEN
      RAISE EXCEPTION 'conflicting duplicate CI action outcome' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  IF v_intent.retry_class <> p_retry_class THEN
    RAISE EXCEPTION 'CI action outcome retry class conflicts with intent' USING ERRCODE = '23505';
  END IF;
  SELECT coalesce(max(sequence), 0) + 1 INTO v_sequence
    FROM public.ci_validation_actions WHERE validation_id = p_validation_row_id;
  IF v_sequence > 64 THEN
    RAISE EXCEPTION 'CI action journal limit exceeded' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.ci_validation_actions (
    id, validation_id, action_key, kind, status, retry_class, sequence,
    safe_metadata, receipt, started_at, completed_at, created_at
  ) VALUES (p_outcome_id, p_validation_row_id, v_outcome_key, v_intent.kind, p_status,
            p_retry_class, v_sequence, p_safe_metadata, p_receipt, v_intent.started_at,
            v_now, v_now) RETURNING * INTO v_result;
  RETURN v_result;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_issue_ci_success(
  p_validation_row_id uuid,
  p_receipt jsonb,
  p_runner_id text,
  p_lease_generation integer
) RETURNS public.ci_validations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.ci_validations%ROWTYPE;
  v_policy public.phase2d_policies%ROWTYPE;
  v_task public.development_tasks%ROWTYPE;
  v_now timestamptz;
  v_metric jsonb;
  v_gate jsonb;
  v_result public.ci_validations%ROWTYPE;
  v_required_count integer;
  v_gate_count integer;
BEGIN
  IF p_runner_id IS NULL OR btrim(p_runner_id) = '' OR p_lease_generation < 1 THEN
    RAISE EXCEPTION 'CI runner fence is malformed' USING ERRCODE = '22023';
  END IF;
  IF p_receipt IS NULL OR jsonb_typeof(p_receipt) <> 'object' THEN
    RAISE EXCEPTION 'CI receipt must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CI validation does not exist' USING ERRCODE = '55000'; END IF;
  SELECT * INTO v_task FROM public.development_tasks WHERE id = v_row.task_id FOR UPDATE;
  PERFORM 1 FROM public.development_attempts WHERE task_id = v_row.task_id ORDER BY attempt_number FOR UPDATE;
  PERFORM 1 FROM public.development_reviews WHERE task_id = v_row.task_id
    ORDER BY (SELECT attempt_number FROM public.development_attempts a WHERE a.id = implementer_attempt_id) FOR UPDATE;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id FOR UPDATE;
  SELECT * INTO v_policy FROM public.phase2d_policies WHERE id = v_row.policy_id;
  PERFORM public.phase2d_assert_candidate(v_row.task_id, v_row.attempt_id, v_row.review_id, v_row.policy_id, v_row.candidate_commit, v_row.candidate_ref);
  IF v_row.receipt IS NOT NULL OR v_row.status <> 'running'
     OR v_row.lease_owner IS DISTINCT FROM p_runner_id
     OR v_row.lease_generation <> p_lease_generation THEN
    RAISE EXCEPTION 'CI validation receipt is already frozen or terminal' USING ERRCODE = '55000';
  END IF;
  IF p_receipt->>'validationId' IS DISTINCT FROM v_row.validation_id
     OR p_receipt->>'repositoryId' IS DISTINCT FROM v_row.repository_id
     OR p_receipt->>'validatedCommit' IS DISTINCT FROM v_row.candidate_commit
     OR p_receipt->>'checkoutCommit' IS DISTINCT FROM v_row.candidate_commit
     OR p_receipt->>'policyDigest' IS DISTINCT FROM v_row.policy_digest
     OR p_receipt->>'policyRevision' IS DISTINCT FROM v_row.policy_revision
     OR p_receipt->>'workflowRevision' IS DISTINCT FROM v_row.policy_revision
     OR p_receipt->>'requiredChecksDigest' IS DISTINCT FROM v_row.required_checks_digest
     OR p_receipt->>'authorityCatalogDigest' IS DISTINCT FROM v_row.authority_catalog_digest
     OR coalesce(p_receipt->>'sourceTreeDigest', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_receipt->>'runId', '') = '' OR coalesce(p_receipt->>'workflowRevision', '') = ''
     OR coalesce((p_receipt->>'runAttempt')::integer, 0) < 1 THEN
    RAISE EXCEPTION 'CI receipt is not bound to the exact candidate' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_receipt->'coverage') <> 'object' THEN
    RAISE EXCEPTION 'CI receipt coverage is missing' USING ERRCODE = '55000';
  END IF;
  FOREACH v_metric IN ARRAY ARRAY[p_receipt->'coverage'->'branches', p_receipt->'coverage'->'functions', p_receipt->'coverage'->'lines', p_receipt->'coverage'->'statements']
  LOOP
    IF jsonb_typeof(v_metric) <> 'object'
       OR (v_metric->>'covered') IS NULL OR (v_metric->>'total') IS NULL
       OR (v_metric->>'percentage') IS NULL
       OR (v_metric->>'covered')::integer < 0 OR (v_metric->>'total')::integer < 0
       OR (v_metric->>'covered')::integer > (v_metric->>'total')::integer
       OR (v_metric->>'covered')::integer <> (v_metric->>'total')::integer
       OR (v_metric->>'percentage')::numeric < 0 OR (v_metric->>'percentage')::numeric > 100
       OR (v_metric->>'percentage')::numeric <> 100 THEN
      RAISE EXCEPTION 'CI coverage is not exactly 100 percent' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF jsonb_typeof(p_receipt->'gates') <> 'array' THEN
    RAISE EXCEPTION 'CI gate results are missing' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_required_count FROM jsonb_array_elements(v_policy.required_check_names);
  SELECT count(*) INTO v_gate_count FROM jsonb_array_elements(p_receipt->'gates');
  IF v_gate_count <> v_required_count
     OR (SELECT count(DISTINCT value->>'name') FROM jsonb_array_elements(p_receipt->'gates') AS x(value)) <> v_gate_count
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_receipt->'gates') AS x(value) WHERE value->>'status' <> 'passed' OR coalesce(value->>'summary', '') = '')
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_policy.required_check_names) AS r(value)
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_receipt->'gates') AS x(gate)
         WHERE x.gate->>'name' = r.value #>> '{}'
       )
     ) THEN
    RAISE EXCEPTION 'CI required checks are not an exact passing set' USING ERRCODE = '55000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF v_row.lease_expires_at IS NULL OR v_row.lease_expires_at <= v_now
     OR v_row.deadline_at <= v_now THEN
    RAISE EXCEPTION 'CI validation lease is not current' USING ERRCODE = '55000';
  END IF;
  UPDATE public.ci_validations SET status = 'succeeded', receipt = p_receipt,
    lease_owner = NULL, lease_expires_at = NULL, completed_at = v_now, updated_at = v_now,
    failure_class = NULL WHERE id = p_validation_row_id RETURNING * INTO v_result;
  RETURN v_result;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_fail_ci_validation(
  p_validation_row_id uuid,
  p_runner_id text,
  p_lease_generation integer,
  p_failure_class text
) RETURNS public.ci_validations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.ci_validations%ROWTYPE;
  v_now timestamptz;
  v_result public.ci_validations%ROWTYPE;
BEGIN
  IF p_runner_id IS NULL OR btrim(p_runner_id) = '' OR p_lease_generation < 1 THEN
    RAISE EXCEPTION 'CI runner fence is malformed' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CI validation does not exist' USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM public.development_tasks WHERE id = v_row.task_id FOR UPDATE;
  PERFORM 1 FROM public.development_attempts WHERE task_id = v_row.task_id ORDER BY attempt_number FOR UPDATE;
  PERFORM 1 FROM public.development_reviews WHERE task_id = v_row.task_id
    ORDER BY (SELECT attempt_number FROM public.development_attempts a WHERE a.id = implementer_attempt_id) FOR UPDATE;
  SELECT * INTO v_row FROM public.ci_validations WHERE id = p_validation_row_id FOR UPDATE;
  SELECT clock_timestamp() INTO v_now;
  IF v_row.status <> 'running' OR v_row.lease_owner IS DISTINCT FROM p_runner_id
     OR v_row.lease_generation <> p_lease_generation OR v_row.lease_expires_at IS NULL
     OR v_row.lease_expires_at <= v_now OR v_row.deadline_at <= v_now
     OR btrim(coalesce(p_failure_class, '')) = '' THEN
    RAISE EXCEPTION 'CI validation lease is not current' USING ERRCODE = '55000';
  END IF;
  UPDATE public.ci_validations SET status = 'needs_human', failure_class = p_failure_class,
    lease_owner = NULL, lease_expires_at = NULL, completed_at = v_now, updated_at = v_now
   WHERE id = p_validation_row_id RETURNING * INTO v_result;
  RETURN v_result;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_admit_release(
  p_release_id uuid,
  p_reservation_operation_id text,
  p_environment_id text,
  p_policy_id uuid,
  p_validation_row_id uuid,
  p_runner_id text
) RETURNS public.development_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_environment public.phase2d_environments%ROWTYPE;
  v_policy public.phase2d_policies%ROWTYPE;
  v_validation public.ci_validations%ROWTYPE;
  v_task public.development_tasks%ROWTYPE;
  v_attempt public.development_attempts%ROWTYPE;
  v_review public.development_reviews%ROWTYPE;
  v_existing public.development_releases%ROWTYPE;
  v_release public.development_releases%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_environment_id IS NULL OR btrim(p_environment_id) = ''
     OR p_reservation_operation_id IS NULL OR btrim(p_reservation_operation_id) = '' THEN
    RAISE EXCEPTION 'release reservation identity is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_environment FROM public.phase2d_environments
   WHERE environment_id = p_environment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release environment is not enrolled' USING ERRCODE = '55000'; END IF;
  SELECT * INTO v_policy FROM public.phase2d_policies WHERE id = p_policy_id;
  IF NOT FOUND OR NOT v_policy.enabled OR v_policy.environment_id <> p_environment_id THEN
    RAISE EXCEPTION 'release policy is unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_validation FROM public.ci_validations WHERE id = p_validation_row_id;
  IF NOT FOUND OR v_validation.policy_id <> p_policy_id OR v_validation.status <> 'succeeded' OR v_validation.receipt IS NULL THEN
    RAISE EXCEPTION 'exact successful CI evidence is required' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_task FROM public.development_tasks WHERE id = v_validation.task_id FOR UPDATE;
  PERFORM 1 FROM public.development_attempts WHERE task_id = v_validation.task_id ORDER BY attempt_number FOR UPDATE;
  PERFORM 1 FROM public.development_reviews WHERE task_id = v_validation.task_id
    ORDER BY (SELECT attempt_number FROM public.development_attempts a WHERE a.id = implementer_attempt_id) FOR UPDATE;
  SELECT * INTO v_validation FROM public.ci_validations WHERE id = p_validation_row_id FOR UPDATE;
  PERFORM public.phase2d_assert_candidate(v_validation.task_id, v_validation.attempt_id, v_validation.review_id, v_validation.policy_id, v_validation.candidate_commit, v_validation.candidate_ref);
  SELECT * INTO v_existing FROM public.development_releases WHERE task_id = v_task.id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.candidate_commit <> v_validation.candidate_commit OR v_existing.validation_id <> v_validation.id THEN
      RAISE EXCEPTION 'release binding conflicts with existing release' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;
  IF v_environment.reservation_release_id IS NOT NULL OR v_environment.active_release_id IS NOT NULL THEN
    RAISE EXCEPTION 'release environment is reserved or active' USING ERRCODE = '55P03';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  INSERT INTO public.development_releases (
    id, task_id, attempt_id, review_id, validation_id, policy_id, repository_id,
    target_ref, environment_id, base_commit, candidate_commit, candidate_ref,
    policy_revision, policy_digest, authority_catalog_digest, required_checks_digest,
    status, lease_owner, lease_generation, lease_expires_at, reservation_operation_id,
    created_at, updated_at
  ) VALUES (
    p_release_id, v_task.id, v_validation.attempt_id, v_validation.review_id, v_validation.id,
    v_policy.id, v_policy.repository_id, v_policy.target_ref, p_environment_id,
    v_task.base_commit, v_validation.candidate_commit, v_validation.candidate_ref,
    v_policy.policy_revision, v_policy.policy_digest, v_policy.authority_catalog_digest,
    v_policy.required_checks_digest, 'merge_pending', p_runner_id, 1,
    v_now + interval '90 seconds', p_reservation_operation_id, v_now, v_now
  ) RETURNING * INTO v_release;
  UPDATE public.phase2d_environments SET reservation_release_id = v_release.id,
    reservation_operation_id = p_reservation_operation_id, updated_at = v_now
   WHERE id = v_environment.id;
  INSERT INTO public.development_release_events (
    id, release_id, sequence, kind, status, safe_metadata, created_at
  ) VALUES (
    p_release_id, v_release.id, 1, 'admission', 'success',
    jsonb_build_object('candidate_commit', v_release.candidate_commit, 'validation_id', v_validation.id), v_now
  );
  RETURN v_release;
END
$$;

-- Receipts and journals are frozen/append-only facts.  The gate routines above
-- are the only intended path for the corresponding state changes.
CREATE OR REPLACE FUNCTION public.phase2d_reject_ci_action_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'CI action journal is append-only' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_protect_ci_validation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CI validation history is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.receipt IS NOT NULL AND (NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'successful CI receipt is frozen' USING ERRCODE = '55000';
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.review_id IS DISTINCT FROM OLD.review_id OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.repository_id IS DISTINCT FROM OLD.repository_id OR NEW.base_commit IS DISTINCT FROM OLD.base_commit
     OR NEW.candidate_commit IS DISTINCT FROM OLD.candidate_commit OR NEW.candidate_ref IS DISTINCT FROM OLD.candidate_ref
     OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision OR NEW.policy_digest IS DISTINCT FROM OLD.policy_digest
     OR NEW.authority_catalog_digest IS DISTINCT FROM OLD.authority_catalog_digest
     OR NEW.required_checks_digest IS DISTINCT FROM OLD.required_checks_digest THEN
    RAISE EXCEPTION 'CI validation binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.phase2d_reject_release_event_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'release event journal is append-only' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS ci_validation_actions_append_only ON public.ci_validation_actions;
CREATE TRIGGER ci_validation_actions_append_only
BEFORE UPDATE OR DELETE ON public.ci_validation_actions
FOR EACH ROW EXECUTE FUNCTION public.phase2d_reject_ci_action_mutation();
DROP TRIGGER IF EXISTS ci_validations_protect_binding ON public.ci_validations;
CREATE TRIGGER ci_validations_protect_binding
BEFORE UPDATE OR DELETE ON public.ci_validations
FOR EACH ROW EXECUTE FUNCTION public.phase2d_protect_ci_validation();
DROP TRIGGER IF EXISTS development_release_events_append_only ON public.development_release_events;
CREATE TRIGGER development_release_events_append_only
BEFORE UPDATE OR DELETE ON public.development_release_events
FOR EACH ROW EXECUTE FUNCTION public.phase2d_reject_release_event_mutation();

-- Production roles have no table DML or DDL authority.  They receive only the
-- exact operation required for their job; owner/maintenance access remains a
-- separately controlled bootstrap privilege.
REVOKE ALL ON TABLE public.development_tasks, public.development_attempts,
  public.development_reviews, public.phase2d_policies, public.phase2d_environments,
  public.ci_validations, public.ci_validation_actions, public.development_releases,
  public.development_release_events FROM phase2d_ci_coordinator, phase2d_ci_issuer,
  phase2d_release_runner;
REVOKE ALL ON SCHEMA public FROM phase2d_ci_coordinator, phase2d_ci_issuer, phase2d_release_runner;
GRANT USAGE ON SCHEMA public TO phase2d_ci_coordinator, phase2d_ci_issuer, phase2d_release_runner;
GRANT EXECUTE ON FUNCTION public.phase2d_create_ci_validation(uuid,text,uuid,uuid,uuid,uuid,text,text),
  public.phase2d_claim_ci_validation(uuid,text),
  public.phase2d_heartbeat_ci_validation(uuid,text,integer),
  public.phase2d_ci_action_intent(uuid,uuid,text,integer,text,text,text,jsonb),
  public.phase2d_ci_action_outcome(uuid,uuid,text,integer,text,text,text,jsonb,jsonb)
  TO phase2d_ci_coordinator;
GRANT EXECUTE ON FUNCTION public.phase2d_issue_ci_success(uuid,jsonb,text,integer)
  TO phase2d_ci_issuer;
GRANT EXECUTE ON FUNCTION public.phase2d_fail_ci_validation(uuid,text,integer,text)
  TO phase2d_ci_coordinator;
GRANT EXECUTE ON FUNCTION public.phase2d_admit_release(uuid,text,text,uuid,uuid,text)
  TO phase2d_release_runner;
REVOKE ALL ON FUNCTION public.phase2d_assert_candidate(uuid,uuid,uuid,uuid,text,text),
  public.phase2d_create_ci_validation(uuid,text,uuid,uuid,uuid,uuid,text,text),
  public.phase2d_claim_ci_validation(uuid,text),
  public.phase2d_heartbeat_ci_validation(uuid,text,integer),
  public.phase2d_ci_action_intent(uuid,uuid,text,integer,text,text,text,jsonb),
  public.phase2d_ci_action_outcome(uuid,uuid,text,integer,text,text,text,jsonb,jsonb),
  public.phase2d_issue_ci_success(uuid,jsonb,text,integer),
  public.phase2d_fail_ci_validation(uuid,text,integer,text),
  public.phase2d_admit_release(uuid,text,text,uuid,uuid,text),
  public.phase2d_reject_ci_action_mutation(), public.phase2d_protect_ci_validation(),
  public.phase2d_reject_release_event_mutation()
  FROM PUBLIC;

-- Never let a Phase 2D production role create DDL, switch roles, or directly
-- update the evidence tables even if a future bootstrap grants table SELECT.
REVOKE CREATE ON SCHEMA public FROM phase2d_ci_coordinator, phase2d_ci_issuer, phase2d_release_runner;
