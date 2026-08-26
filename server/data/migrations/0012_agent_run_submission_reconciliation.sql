-- A crash between durable reservation and Eve session creation leaves a
-- `submitting` row with no session handle. The reconciler only scans this
-- narrow state; the partial index keeps it bounded as terminal history grows.
create index if not exists agent_runs_stale_submission_idx
  on "__AGENT_SCHEMA__"."agent_runs" (updated_at)
  where status = 'submitting';
