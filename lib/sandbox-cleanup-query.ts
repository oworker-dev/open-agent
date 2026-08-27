import { quoteIdentifier } from "../server/data/agent-database.ts";

/** Select only deletion tombstones created after explicit session retirement. */
export function buildReadySandboxDeletionQuery(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return `
    select deletion.session_id as "sessionId"
    from ${schema}."agent_sandbox_deletions" deletion
    where deletion.not_before <= now()
      and (
        deletion.status in ('authorized', 'failed')
        or (
          deletion.status = 'claimed'
          and deletion.claim_expires_at < now()
        )
      )
    order by deletion.not_before asc, deletion.requested_at asc
    limit $1
  `;
}
