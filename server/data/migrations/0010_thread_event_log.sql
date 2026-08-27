create table if not exists "__AGENT_SCHEMA__"."agent_thread_events" (
  tenant_id text not null,
  principal_id text not null,
  storage_key text not null,
  thread_id text not null,
  event_index bigint not null,
  event_id text not null,
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, principal_id, storage_key, thread_id, event_index),
  unique (tenant_id, principal_id, storage_key, thread_id, event_id),
  constraint agent_thread_event_index check (event_index >= 0),
  constraint agent_thread_event_object check (jsonb_typeof(event) = 'object')
);

-- Existing installations keep their metadata row as the source of truth for
-- thread preferences/status, but move the potentially unbounded event array to
-- the append-only log. The deterministic legacy key makes this migration
-- repeatable even for old events that did not carry meta.id.
insert into "__AGENT_SCHEMA__"."agent_thread_events" (
  tenant_id,
  principal_id,
  storage_key,
  thread_id,
  event_index,
  event_id,
  event
)
select
  c.tenant_id,
  c.principal_id,
  c.storage_key,
  thread->>'id',
  (entry.ordinality - 1)::bigint,
  coalesce(entry.value->'meta'->>'id', 'legacy:' || (entry.ordinality - 1)::text),
  entry.value
from "__AGENT_SCHEMA__"."agent_thread_collections" c
cross join lateral jsonb_array_elements(coalesce(c.collection->'threads', '[]'::jsonb)) as thread
cross join lateral jsonb_array_elements(coalesce(thread->'events', '[]'::jsonb))
  with ordinality as entry(value, ordinality)
where thread->>'id' is not null
on conflict (tenant_id, principal_id, storage_key, thread_id, event_id) do nothing;

update "__AGENT_SCHEMA__"."agent_thread_collections" c
set collection = jsonb_set(
  c.collection,
  '{threads}',
  coalesce((
    select jsonb_agg(thread - 'events' order by coalesce((thread->>'updatedAt')::double precision, 0) desc)
    from jsonb_array_elements(coalesce(c.collection->'threads', '[]'::jsonb)) as thread
  ), '[]'::jsonb),
  true
)
where exists (
  select 1
    from jsonb_array_elements(coalesce(c.collection->'threads', '[]'::jsonb)) as thread
   where jsonb_array_length(coalesce(thread->'events', '[]'::jsonb)) > 0
);
