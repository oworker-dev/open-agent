create table if not exists "__AGENT_SCHEMA__"."workflow_archives" (
  root_run_id text primary key,
  status text not null default 'pending',
  source_completed_at timestamptz not null,
  archive_created_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  claim_token uuid,
  claim_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  object_key text,
  object_sha256 text,
  manifest_sha256 text,
  object_size_bytes bigint,
  record_count bigint,
  run_count integer,
  last_error text,
  archived_at timestamptz,
  restore_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_archives_status check (status in ('pending', 'claimed', 'completed', 'failed')),
  constraint workflow_archives_root_run_id check (length(root_run_id) between 1 and 512),
  constraint workflow_archives_attempt_count check (attempt_count >= 0),
  constraint workflow_archives_claim check (
    (status = 'claimed' and claim_token is not null and claim_expires_at is not null)
    or (status <> 'claimed' and claim_token is null and claim_expires_at is null)
  ),
  constraint workflow_archives_object_sha256 check (object_sha256 is null or object_sha256 ~ '^[a-f0-9]{64}$'),
  constraint workflow_archives_manifest_sha256 check (manifest_sha256 is null or manifest_sha256 ~ '^[a-f0-9]{64}$'),
  constraint workflow_archives_object_size check (object_size_bytes is null or object_size_bytes >= 0),
  constraint workflow_archives_record_count check (record_count is null or record_count >= 0),
  constraint workflow_archives_run_count check (run_count is null or run_count >= 1)
);

create index if not exists workflow_archives_ready_idx
  on "__AGENT_SCHEMA__"."workflow_archives" (next_attempt_at, updated_at, root_run_id)
  where status in ('pending', 'failed', 'claimed');

create index if not exists workflow_archives_completed_idx
  on "__AGENT_SCHEMA__"."workflow_archives" (archived_at, root_run_id)
  where status = 'completed';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'workflow_archives_completed_values'
       and conrelid = '"__AGENT_SCHEMA__"."workflow_archives"'::regclass
  ) then
    alter table "__AGENT_SCHEMA__"."workflow_archives"
      add constraint workflow_archives_completed_values check (
        status <> 'completed'
        or (
          object_key is not null
          and object_sha256 is not null
          and manifest_sha256 is not null
          and object_size_bytes is not null
          and record_count is not null
          and run_count is not null
          and archived_at is not null
        )
      ) not valid;
  end if;
end $$;

alter table "__AGENT_SCHEMA__"."workflow_archives"
  validate constraint workflow_archives_completed_values;

create table if not exists "__AGENT_SCHEMA__"."workflow_archive_discovery" (
  singleton boolean primary key default true check (singleton),
  cursor_completed_at timestamptz,
  cursor_root_run_id text,
  updated_at timestamptz not null default now(),
  constraint workflow_archive_discovery_cursor check (
    (cursor_completed_at is null and cursor_root_run_id is null)
    or (cursor_completed_at is not null and cursor_root_run_id is not null)
  )
);

insert into "__AGENT_SCHEMA__"."workflow_archive_discovery" (singleton)
values (true)
on conflict (singleton) do nothing;
