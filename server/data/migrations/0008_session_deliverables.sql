create index if not exists agent_previews_session_owner_idx
  on "__AGENT_SCHEMA__"."agent_previews"
  (tenant_id, principal_id, session_id, created_at desc);

create index if not exists agent_artifacts_session_owner_idx
  on "__AGENT_SCHEMA__"."agent_artifacts"
  (tenant_id, principal_id, session_id, created_at desc);
