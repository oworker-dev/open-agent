-- Asset bytes belong in an object store (S3/R2/GCS or a host adapter), never
-- in PostgreSQL bytea columns. This migration stores only upload and ownership
-- metadata so hosts can replace the storage implementation without changing
-- the Agent message contract.

create table if not exists "__AGENT_SCHEMA__"."agent_assets" (
  asset_id text primary key,
  tenant_id text not null,
  principal_id text not null,
  session_id text not null,
  message_id text,
  filename text not null,
  media_type text not null,
  size_bytes bigint not null,
  checksum_sha256 text,
  storage_key text not null,
  status text not null default 'uploading',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_asset_filename_safe check (
    filename <> '' and filename not like '%/%' and filename not like '%\\%'
  ),
  constraint agent_asset_size_valid check (size_bytes > 0),
  constraint agent_asset_status check (status in ('uploading', 'ready', 'failed', 'expired')),
  constraint agent_asset_storage_key_safe check (storage_key <> '' and storage_key not like '/%' and storage_key not like '%..%')
);

create index if not exists agent_assets_owner_idx
  on "__AGENT_SCHEMA__"."agent_assets" (tenant_id, principal_id, created_at desc);
create index if not exists agent_assets_session_idx
  on "__AGENT_SCHEMA__"."agent_assets" (session_id, created_at desc);
create index if not exists agent_assets_expiry_idx
  on "__AGENT_SCHEMA__"."agent_assets" (expires_at)
  where expires_at is not null;

create table if not exists "__AGENT_SCHEMA__"."agent_asset_uploads" (
  upload_id text primary key,
  asset_id text not null unique references "__AGENT_SCHEMA__"."agent_assets"(asset_id) on delete cascade,
  tenant_id text not null,
  principal_id text not null,
  session_id text not null,
  chunk_size_bytes integer not null,
  declared_size_bytes bigint not null,
  part_count integer not null,
  provider_upload_id text,
  status text not null default 'uploading',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_asset_upload_status check (status in ('uploading', 'ready', 'failed')),
  constraint agent_asset_upload_size_valid check (declared_size_bytes > 0 and chunk_size_bytes > 0 and part_count > 0)
);

alter table "__AGENT_SCHEMA__"."agent_asset_uploads"
  add column if not exists provider_upload_id text;

create index if not exists agent_asset_uploads_owner_idx
  on "__AGENT_SCHEMA__"."agent_asset_uploads" (tenant_id, principal_id, updated_at desc);

create table if not exists "__AGENT_SCHEMA__"."agent_asset_parts" (
  upload_id text not null references "__AGENT_SCHEMA__"."agent_asset_uploads"(upload_id) on delete cascade,
  part_number integer not null,
  size_bytes integer not null,
  etag text,
  storage_key text not null,
  created_at timestamptz not null default now(),
  primary key (upload_id, part_number),
  constraint agent_asset_part_number_valid check (part_number > 0 and size_bytes > 0),
  constraint agent_asset_part_storage_key_safe check (storage_key <> '' and storage_key not like '/%' and storage_key not like '%..%')
);
