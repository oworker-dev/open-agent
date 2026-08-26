-- Older append checkpoints assigned indexes before replay deduplication. If a
-- duplicated event was skipped, later fresh events could retain a higher
-- offset and leave a hole. Absolute transcript windows require a contiguous
-- collection-event index, so repair only affected threads without changing
-- their durable event order or identity.
do $migration$
begin
  create temporary table thread_event_reindex on commit drop as
  select
    tenant_id,
    principal_id,
    storage_key,
    thread_id,
    event_id,
    event_index,
    row_number() over (
      partition by tenant_id, principal_id, storage_key, thread_id
      order by event_index asc
    ) - 1 as next_index
  from "__AGENT_SCHEMA__"."agent_thread_events";

  if exists (
    select 1 from thread_event_reindex where event_index <> next_index
  ) then
    -- Move affected rows above their current range first. This avoids primary
    -- key collisions while the final contiguous indexes are installed.
    with affected as (
      select distinct tenant_id, principal_id, storage_key, thread_id
      from thread_event_reindex
      where event_index <> next_index
    ), bounds as (
      select
        e.tenant_id,
        e.principal_id,
        e.storage_key,
        e.thread_id,
        max(e.event_index) + 1 as offset
      from "__AGENT_SCHEMA__"."agent_thread_events" e
      join affected a using (tenant_id, principal_id, storage_key, thread_id)
      group by e.tenant_id, e.principal_id, e.storage_key, e.thread_id
    )
    update "__AGENT_SCHEMA__"."agent_thread_events" e
       set event_index = e.event_index + bounds.offset
      from bounds
     where e.tenant_id = bounds.tenant_id
       and e.principal_id = bounds.principal_id
       and e.storage_key = bounds.storage_key
       and e.thread_id = bounds.thread_id;

    update "__AGENT_SCHEMA__"."agent_thread_events" e
       set event_index = ranked.next_index
      from thread_event_reindex ranked
     where e.tenant_id = ranked.tenant_id
       and e.principal_id = ranked.principal_id
       and e.storage_key = ranked.storage_key
       and e.thread_id = ranked.thread_id
       and e.event_id = ranked.event_id;
  end if;
end
$migration$;
