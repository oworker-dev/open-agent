-- Bind asset ownership to the complete authenticated identity. Existing
-- installations predate these columns; legacy rows use the historical user
-- principal type and remain compatible with standalone browser sessions.
alter table "__AGENT_SCHEMA__"."agent_assets"
  add column if not exists principal_type text,
  add column if not exists issuer text;

alter table "__AGENT_SCHEMA__"."agent_asset_uploads"
  add column if not exists principal_type text,
  add column if not exists issuer text;

update "__AGENT_SCHEMA__"."agent_assets"
   set principal_type = coalesce(principal_type, 'user')
 where principal_type is null;

update "__AGENT_SCHEMA__"."agent_asset_uploads"
   set principal_type = coalesce(principal_type, 'user')
 where principal_type is null;

create index if not exists agent_assets_identity_idx
  on "__AGENT_SCHEMA__"."agent_assets" (tenant_id, principal_id, principal_type, issuer, created_at desc);
