-- Keep context clear and re-import progress durable. Clear has no Eve
-- idempotency key, so a claimed clear is reconciled from facts, never replayed.
alter table "__AGENT_SCHEMA__"."agent_mailbox_items"
  add column if not exists edit_plan jsonb,
  add column if not exists cancellation_requested_at timestamptz;
