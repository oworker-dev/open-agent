alter table "__AGENT_SCHEMA__"."agent_preview_files"
  add column if not exists asset_id text;

alter table "__AGENT_SCHEMA__"."agent_preview_files"
  alter column content drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_preview_file_storage'
      and conrelid = '"__AGENT_SCHEMA__"."agent_preview_files"'::regclass
  ) then
    alter table "__AGENT_SCHEMA__"."agent_preview_files"
      add constraint agent_preview_file_storage
      check ((content is not null)::integer + (asset_id is not null)::integer = 1) not valid;
  end if;
end $$;

alter table "__AGENT_SCHEMA__"."agent_preview_files"
  validate constraint agent_preview_file_storage;

create index if not exists agent_preview_files_asset_idx
  on "__AGENT_SCHEMA__"."agent_preview_files" (asset_id)
  where asset_id is not null;

create index if not exists agent_previews_expiry_idx
  on "__AGENT_SCHEMA__"."agent_previews" (expires_at, preview_id);

alter table "__AGENT_SCHEMA__"."agent_artifacts"
  add column if not exists asset_id text;

alter table "__AGENT_SCHEMA__"."agent_artifacts"
  alter column content drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_artifact_storage'
      and conrelid = '"__AGENT_SCHEMA__"."agent_artifacts"'::regclass
  ) then
    alter table "__AGENT_SCHEMA__"."agent_artifacts"
      add constraint agent_artifact_storage
      check ((content is not null)::integer + (asset_id is not null)::integer = 1) not valid;
  end if;
end $$;

alter table "__AGENT_SCHEMA__"."agent_artifacts"
  validate constraint agent_artifact_storage;

create index if not exists agent_artifacts_asset_idx
  on "__AGENT_SCHEMA__"."agent_artifacts" (asset_id)
  where asset_id is not null;

create index if not exists agent_artifacts_expiry_idx
  on "__AGENT_SCHEMA__"."agent_artifacts" (expires_at, artifact_id);
