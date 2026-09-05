alter table "__AGENT_SCHEMA__"."agent_previews"
  add column if not exists alias text,
  add column if not exists version text;

alter table "__AGENT_SCHEMA__"."agent_artifacts"
  add column if not exists alias text,
  add column if not exists version text;
