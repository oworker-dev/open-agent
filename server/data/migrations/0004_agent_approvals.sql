-- Approval state is a projection of Eve's input.requested events. Keeping it
-- outside the event payload makes reloads and multi-instance deployments
-- deterministic without putting secrets in the approval table.
create table if not exists "__AGENT_SCHEMA__"."agent_session_approvals" (
  request_id text primary key,
  session_id text not null,
  turn_id text,
  tool_call_id text not null,
  tool_name text not null,
  input jsonb not null default '{}'::jsonb,
  status text not null default 'requested',
  selection text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint agent_session_approval_status check (status in ('requested', 'approved', 'rejected', 'expired', 'cancelled')),
  constraint agent_session_approval_selection check (selection is null or selection in ('approve', 'reject')),
  constraint agent_session_approval_input_object check (jsonb_typeof(input) = 'object')
);

create index if not exists agent_session_approvals_pending_idx
  on "__AGENT_SCHEMA__"."agent_session_approvals" (session_id, status, created_at);

create index if not exists agent_session_approvals_turn_idx
  on "__AGENT_SCHEMA__"."agent_session_approvals" (session_id, turn_id, created_at);
