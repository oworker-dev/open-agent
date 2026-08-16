import { quoteIdentifier } from "../server/data/agent-database.ts";

/**
 * Build the terminal-session query used by the Docker sandbox cleanup worker.
 *
 * A parent session must remain intact while any descendant is still active.
 * The recursive CTE starts at active children and walks up the subagent tree,
 * carrying the authenticated owner tuple so a malformed or cross-owner row
 * can never block (or authorize) cleanup for another tenant or issuer.
 */
export function buildTerminalSandboxSessionQuery(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return `
    with recursive active_subagent_ancestors(
      ancestor_session_id,
      tenant_id,
      principal_id,
      principal_type,
      issuer,
      child_path,
      depth
    ) as (
      select
        child.parent_session_id,
        child.tenant_id,
        child.principal_id,
        child.principal_type,
        child.issuer,
        array[child.child_session_id]::text[],
        1
      from ${schema}."agent_subagent_sessions" child
      where child.status in ('starting', 'running', 'waiting')
      union all
      select
        parent.parent_session_id,
        parent.tenant_id,
        parent.principal_id,
        parent.principal_type,
        parent.issuer,
        active.child_path || parent.child_session_id,
        active.depth + 1
      from ${schema}."agent_subagent_sessions" parent
      join active_subagent_ancestors active
        on parent.child_session_id = active.ancestor_session_id
       and parent.tenant_id = active.tenant_id
       and parent.principal_id = active.principal_id
       and parent.principal_type = active.principal_type
       and coalesce(parent.issuer, '') = coalesce(active.issuer, '')
      where active.depth < 32
        and not parent.child_session_id = any(active.child_path)
    )
    select distinct on (r.eve_session_id)
      r.eve_session_id as "sessionId",
      o.tenant_id as "tenantId",
      o.principal_id as "principalId",
      o.principal_type as "principalType",
      o.issuer,
      r.updated_at as "updatedAt"
    from ${schema}."agent_runs" r
    join ${schema}."agent_session_owners" o on o.session_id = r.eve_session_id
    where r.eve_session_id is not null
      and r.status in ('completed', 'failed', 'cancelled', 'submission-ambiguous')
      and r.updated_at < now() - ($1::bigint * interval '1 millisecond')
      and not exists (
        select 1 from ${schema}."agent_runs" active
        where active.eve_session_id = r.eve_session_id
          and active.status in ('submitting', 'running', 'waiting-input', 'waiting-authorization')
      )
      and not exists (
        select 1 from ${schema}."agent_mailbox_items" mailbox
        where mailbox.session_id = r.eve_session_id
          and mailbox.status in ('queued', 'delivering', 'accepted')
      )
      and not exists (
        select 1
        from active_subagent_ancestors active_child
        where active_child.ancestor_session_id = r.eve_session_id
          and active_child.tenant_id = o.tenant_id
          and active_child.principal_id = o.principal_id
          and active_child.principal_type = o.principal_type
          and coalesce(active_child.issuer, '') = coalesce(o.issuer, '')
      )
      and o.issuer = $3
    order by r.eve_session_id, r.updated_at desc
    limit $2
  `;
}
