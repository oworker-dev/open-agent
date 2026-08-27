-- The event table primary key already has this exact column order. Keeping a
-- second identical btree doubles index maintenance for the append-heavy path
-- without enabling any additional query shape.
drop index concurrently if exists "__AGENT_SCHEMA__"."agent_thread_events_scope_idx";
