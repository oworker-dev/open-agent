create table if not exists "__AGENT_SCHEMA__"."agent_subagent_sessions" (
  child_session_id text primary key,
  agent_id text,
  parent_session_id text not null references "__AGENT_SCHEMA__"."agent_session_owners"(session_id),
  call_id text,
  tool_name text,
  name text,
  nickname text not null,
  task text,
  status text not null default 'starting',
  wait_policy text not null default 'wait',
  depth integer not null default 1,
  tenant_id text not null,
  principal_id text not null,
  principal_type text not null,
  issuer text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  constraint agent_subagent_status check (status in ('starting','running','waiting','completed','failed','interrupted','closed')),
  constraint agent_subagent_wait_policy check (wait_policy in ('wait','no-wait')),
  constraint agent_subagent_depth_valid check (depth between 1 and 32),
  constraint agent_subagent_nickname_valid check (nickname <> ''),
  constraint agent_subagent_owner_match check (tenant_id <> '' and principal_id <> '' and principal_type <> '')
);

create index if not exists agent_subagent_parent_idx
  on "__AGENT_SCHEMA__"."agent_subagent_sessions" (tenant_id, principal_id, parent_session_id, created_at);

create index if not exists agent_subagent_agent_idx
  on "__AGENT_SCHEMA__"."agent_subagent_sessions" (agent_id)
  where agent_id is not null;
