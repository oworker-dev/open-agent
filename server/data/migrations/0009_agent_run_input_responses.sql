create table if not exists "__AGENT_SCHEMA__"."agent_run_input_responses" (
  response_id text primary key,
  run_id text not null references "__AGENT_SCHEMA__"."agent_runs"(run_id) on delete cascade,
  idempotency_key text not null,
  request_fingerprint text not null,
  request_ids text[] not null,
  input_responses jsonb not null,
  status text not null default 'submitting',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, idempotency_key),
  constraint agent_run_input_response_status check (
    status in ('submitting', 'accepted', 'failed', 'submission-ambiguous')
  ),
  constraint agent_run_input_response_requests check (
    cardinality(request_ids) between 1 and 16
  ),
  constraint agent_run_input_response_payload check (
    jsonb_typeof(input_responses) = 'array'
  )
);

create index if not exists agent_run_input_responses_requests_idx
  on "__AGENT_SCHEMA__"."agent_run_input_responses" using gin (request_ids);
