-- Asset byte completion and content safety are separate lifecycles. Existing
-- rows are pending so a production deployment cannot treat historical objects
-- as scanned merely because they were uploaded before this migration.
alter table "__AGENT_SCHEMA__"."agent_assets"
  add column if not exists scan_status text not null default 'pending';

alter table "__AGENT_SCHEMA__"."agent_assets"
  drop constraint if exists agent_asset_scan_status;

alter table "__AGENT_SCHEMA__"."agent_assets"
  add constraint agent_asset_scan_status check (
    scan_status in ('disabled', 'pending', 'scanning', 'clean', 'rejected', 'error')
  );

create index if not exists agent_assets_scan_status_idx
  on "__AGENT_SCHEMA__"."agent_assets" (scan_status, created_at desc);
