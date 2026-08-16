-- Completion is a provider/database two-phase operation. Persisting this
-- state lets a later request reconcile an object that was committed by S3
-- immediately before the app process crashed.
alter table "__AGENT_SCHEMA__"."agent_asset_uploads"
  drop constraint if exists agent_asset_upload_status;

alter table "__AGENT_SCHEMA__"."agent_asset_uploads"
  add constraint agent_asset_upload_status check (status in ('uploading', 'completing', 'ready', 'failed'));
