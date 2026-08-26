-- Admission checks count only non-terminal runs. Keep both the global status
-- and tenant-scoped count indexable without widening the normal owner index.
create index if not exists agent_runs_active_status_idx
  on "__AGENT_SCHEMA__"."agent_runs" (status)
  where status in ('submitting', 'running', 'waiting-input', 'waiting-authorization');

create index if not exists agent_runs_active_tenant_idx
  on "__AGENT_SCHEMA__"."agent_runs" (tenant_id)
  where status in ('submitting', 'running', 'waiting-input', 'waiting-authorization');
