# Self-hosted Deployment Runbook

This runbook describes the supported self-hosted alpha topology. It does not
claim that an unverified deployment is production-ready.

## Topology

Run Agent Web, Eve Runtime, and the mailbox worker as separate Node.js 24
processes. Use three separate state boundaries:

1. Host product data may contain the `open_agent` product schema for thread,
   ownership, AgentRun, extension, and deletion-authorization records.
2. Eve must use a physically separate PostgreSQL database for its Workflow
   World. A schema or queue prefix is not enough to isolate incompatible
   Workflow runtime generations.
3. Each Muses host deployment keeps its own Workflow World database outside the
   Eve database.

The mailbox worker is part of the Web follow-up durability path. It polls the
authenticated internal Web dispatcher and must be deployed at least once per
Agent Web database. Multiple worker replicas are safe: PostgreSQL leases and
per-session FIFO blockers prevent duplicate delivery. Do not replace it with a
browser timer or a client-owned session retry loop.

Use a unique `WORKFLOW_POSTGRES_JOB_PREFIX` for every World. The supported Eve
prefix is `open_agent_`; the Muses host uses `muses_` in its own database.

Set `AGENT_DEPLOYMENT_TENANCY` explicitly. The documented Docker topology is a
single-tenant alpha/staging baseline. A deployment serving mutually untrusted
tenants must use a reviewed microVM backend such as microsandbox or Vercel
Sandbox; the production doctor rejects multi-tenant Docker.

## Preflight

Pin the exact source revision and container digest. Load secrets from the target
secret manager, then run:

```bash
npm ci
npm run verify:ci
npm run doctor:production
```

The doctor must pass in the same environment used for the build. In particular,
`AGENT_EMBED_ALLOWED_ORIGINS` and `EVE_NEXT_PRODUCTION_PORT` are build inputs.
The standard build checks the generated route manifest and fails unless
`/embed` contains those exact frame ancestors. Keep this artifact check in the
release pipeline; a healthy standalone page does not prove Host embedding works.
`AGENT_PUBLIC_BASE_URL` and `AGENT_PREVIEW_SIGNING_SECRET` are mandatory in
production. The former must be a public HTTPS origin without a path; the latter
must be at least 32 bytes. They sign expiring website-preview and artifact links.
The filesystem preview/artifact and asset stores are local-development
fallbacks and must not be used by a production deployment; `AGENT_DATABASE_URL`
is required. For the built-in asset path set
`AGENT_ASSET_STORAGE_BACKEND=s3` and provide the S3-compatible endpoint,
bucket, access key, and secret. Asset metadata and multipart state stay in the
Agent PostgreSQL schema; object bytes stay in S3/MinIO/R2. A custom `host`
adapter remains supported for deployments that use a different object store.
Configure bucket CORS to allow browser-origin `PUT` from every intended Web
origin and expose the `ETag` response header. Production S3 uploads are direct:
Next.js signs and acknowledges parts but must not proxy their bytes. Keep
`AGENT_ASSET_UPLOAD_URL_TTL_SECONDS` between 60 and 3600 seconds.
Run one `npm run start:asset-cleanup` worker per deployment, or schedule
`npm run reap:assets` with the deployment's job runner (using the same database
and object-store credentials). It removes expired completed objects and aborts
expired multipart uploads; set `AGENT_ASSET_CLEANUP_INTERVAL_MS` and
`AGENT_ASSET_CLEANUP_LIMIT` to bound cadence and work per pass. Do not rely on
request traffic to perform retention cleanup. `AGENT_ASSET_MAX_BYTES` limits a
single object and `AGENT_ASSET_QUOTA_BYTES` is the aggregate authenticated
tenant/principal reservation limit; the latter is mandatory for built-in S3
production and is checked atomically under a PostgreSQL advisory lock. Host
AssetStore adapters must provide equivalent atomic quota enforcement and
malware/content scanning before marking an object ready.

Asset scanning is a host capability, not a Muses-specific implementation.
Register an `AssetScanner` with `configureAssetScanner()` before using the
built-in S3 adapter. Production defaults to `AGENT_ASSET_SCAN_MODE=required`
and fails closed when no scanner is registered; `AGENT_ASSET_SCAN_MODE=disabled`
is accepted only outside production. `import_asset` and any host sandbox mount
must admit only assets whose `scanStatus` is `clean` or explicitly `disabled`.
The standalone reference server can register its bundled constant-memory clamd
INSTREAM adapter by setting `AGENT_ASSET_CLAMAV_HOST`, optional
`AGENT_ASSET_CLAMAV_PORT`, and `AGENT_ASSET_CLAMAV_TIMEOUT_MS`. Configure
clamd's `StreamMaxLength` at or above `AGENT_ASSET_MAX_BYTES`, keep the clamd
port on a private network, and include scanner saturation and outage behavior
in the staged load gate. Muses and other hosts may replace this adapter through
the same `AssetScanner` contract.
`AGENT_SANDBOX_IMAGE` must also be an immutable OCI digest. Build the repository
`sandbox/Dockerfile`, publish it to the deployment registry, and run
`npm run verify:sandbox-runtime` against that exact digest. The gate verifies
Node/npm, Python, Git, FFmpeg, ImageMagick, and Playwright/Chromium without
network access.
Do not continue when the doctor reports a shared Workflow database, implicit
sandbox backend, missing deployment tenancy, multi-tenant Docker, missing
telemetry, test fixture model, or disabled Shell approval.

Bootstrap each database once and run product migrations before accepting
traffic:

```bash
WORKFLOW_POSTGRES_URL=postgres://... npx --package=@workflow/world-postgres bootstrap
AGENT_DATABASE_URL=postgres://... npm run db:migrate
```

Build and start Eve before Agent Web and the mailbox worker. The complete
environment example and commands are in the root README. Health checks must
verify the Eve health route, the Agent Web route, PostgreSQL connectivity, the
worker's authenticated dispatcher response, and telemetry export. Production
requires independent `AGENT_MAILBOX_WORKER_SECRET` and
`AGENT_MAILBOX_DISPATCH_SECRET` values, each at least 32 bytes.

Start the worker after Agent Web is healthy:

```bash
AGENT_WEB_INTERNAL_URL=https://agent.example.com \
AGENT_MAILBOX_WORKER_SECRET='replace-with-32-byte-secret' \
AGENT_MAILBOX_DISPATCH_SECRET='replace-with-another-32-byte-secret' \
  npm run start:mailbox-worker
```

For the Docker backend, also run the terminal sandbox cleanup worker. It only
selects sessions whose latest AgentRun is terminal, whose retention window has
elapsed, and which have no queued follow-up or active child. The worker first
retires the exact Eve session, records the owner-scoped deletion authorization,
then invokes the exact-session reaper with a bounded limit. It never performs a
 broad container deletion and it leaves an authorization ledger for retries.

```bash
AGENT_SANDBOX_TERMINAL_RETENTION_HOURS=168 \
AGENT_SANDBOX_CLEANUP_INTERVAL_MS=900000 \
AGENT_SANDBOX_CLEANUP_MAX_SESSIONS=25 \
  npm run start:sandbox-cleanup
```

The production wrapper starts both cleanup workers. Keep the terminal retention
long enough for normal follow-up conversations; deleting a completed AgentRun
does not immediately delete its sandbox because the durable session may still
be reopened. Microsandbox and Vercel Sandbox deployments use their backend
lifecycle controls instead of this Docker-specific worker.

Inspection and busy-session failures are deferred with bounded backoff. A
transport failure after admission begins is marked `submission-ambiguous` and
must never be replayed automatically. The authoritative Eve
`message.received` hook retries transient product-database failures and can
promote that row directly to `committed` after a lost HTTP response. If no such
durable confirmation arrives, the item remains blocked for explicit operator
resolution; matching message text is not sufficient evidence.

## User-visible delivery

The supported first release delivers two bounded result types:

- `publish_preview` copies a completed static website from `/workspace` into
  PostgreSQL and returns a signed URL to its entrypoint and static assets.
- `publish_artifact` copies one completed file (up to 25 MiB) and returns a
  signed URL suitable for a Python result, image, audio/video render, PDF,
  archive, or other generated output.

Both records are scoped to the authenticated tenant, principal, and Eve
session. URLs are bearer links and expire according to
`AGENT_PREVIEW_TTL_SECONDS`; the raw sandbox filesystem and arbitrary ports are
never exposed. Long-running dev servers and WebSocket previews require the
future Preview Gateway release gate described in the architecture document.

For a Muses-hosted deployment, configure the Agent's OpenAI-compatible client
against the private Host broker:

```bash
OPENAI_API_KEY="$MUSES_AGENT_PROVIDER_BROKER_SECRET"
OPENAI_BASE_URL="https://muses.example.com/api/internal/agent-provider/v1"
```

The same-host self-hosted topology may use the loopback Muses origin over HTTP;
non-loopback origins must use HTTPS. The broker secret is a service credential,
not a model Provider key. Rotate it independently and never expose it to Web UI
configuration, session state, tools, Skills, MCP connections, or sandboxes.
Muses must have an active `llm` Provider Connection whose allowlist accepts the
selected `AGENT_MODEL_ID`. A healthy Agent process with no such connection is
not a successful production preflight.

Set `AGENT_MODEL_MAX_OUTPUT_TOKENS` to the maximum output budget for one model
step. The default deployment value is 4096. Keep it distinct from cumulative
session and AgentRun budgets: compatible gateways may reserve or reject quota
from this per-request value before any output is generated.

## Compiled MCP Connections

Runtime Config and administrator metadata never create outbound MCP code. A
deployment that enables MCP must add an authored `agent/connections/*.ts` file
that calls `createBrokeredMcpConnection()` from
`@oworker/open-agent-mcp-adapter`. Pin the exact adapter id/version, HTTPS
endpoint, discovery description, tool allowlist, and write-tool approval list
in that source file. Publish the same id/version in the deployment extension
catalog and Profile; a tenant installation and AgentRun may only narrow that
compiled maximum.

The adapter sends a private credential broker only the contract version,
adapter id/version, Eve session id, and authenticated actor/principal/tenant.
The broker must verify installation state and resolve its opaque credential
reference server-side, then return a bounded bearer token with an optional
expiry. Keep the broker service token in the deployment secret manager. Never
place it, a credential reference, or a third-party token in Runtime Config,
AgentRun policy, session attributes, model input, tool input, events, or the
sandbox.

Run `npm run verify:mcp-conformance` before promotion. It proves a real
Streamable HTTP connection, compiled allowlist, durable write approval and
resume, next-boundary revocation, and credential absence from emitted evidence.
It uses a brokered/out-of-band fixture; production OAuth providers still require
staged consent, refresh, denial, and revocation tests.

## Rollout And Rollback

- Deploy an immutable image and record its Git commit, package version, Eve
  version, database migration revision, model catalog, and extension catalog.
- Keep the previous image available. Application rollback is allowed only when
  its database and Workflow spec versions can read all persisted state.
- Stop new traffic before changing a Workflow runtime generation. Never point a
  different Workflow major/spec at an existing World as a rollback shortcut.
- Use canary traffic and compare completion rate, p95 turn latency, provider
  error rate, sandbox allocation failures, cancellation settlement, token/cost
  reconciliation, and queue backlog before promotion.
- Abort rollout on authorization leakage, cross-session sandbox access, lost
  continuation state, unbounded queue growth, or missing audit/telemetry export.

## Data Lifecycle

Thread deletion first retires the Eve durable session and only then writes a
database-authorized sandbox tombstone. Schedule the Docker reaper with bounded
retention and removal limits. Export both the reaper JSON result and tombstone
state to durable audit storage. Container age alone never authorizes deletion.

Define and publish retention periods for thread snapshots, AgentRun events,
extension audits, host invocation audits, Workflow history, telemetry, provider
usage, and backups. A customer deletion request must cover every store and must
produce an auditable completion record. Backup restores must be tested into an
isolated environment without starting workers against production queues.

## Observability And Privacy

Agent Web, Eve, Muses, and the collector must share W3C trace context. Durable
queue work uses Span Links. Dashboards should cover turn and tool latency,
Provider status, mailbox and Workflow queue backlog, cancellation, sandbox allocation/reaping,
token/cache usage, projected cost, and host capability failures.

Keep full prompts and outputs out of spans, logs, and exception stacks. Run the
private-probe verification against the deployed collector before using private
customer content. Configure sampler, retention, access control, and deletion at
the collector; the local mock collector is evidence tooling only.

## Incident Actions

1. Disable affected Host capabilities or revoke the extension version.
2. Stop new Agent turns while preserving databases and queue evidence.
3. Rotate exposed Provider, Host JWT, HMAC, database, and collector credentials.
4. Capture redacted run, trace, deployment, queue, and audit identifiers.
5. Restore service through a reviewed image or configuration rollback.
6. Reconcile provider charges, host credits, unfinished runs, and sandbox state.
7. Record the cause, affected tenants, deletion/notification duties, and a
   regression test before reopening traffic.

The selected production sandbox, real third-party MCP OAuth lifecycle, provider billing,
deployed dashboards, SLO/load evidence, abuse controls, and deletion proof are
still release gates tracked in the architecture document.

Run `npm run verify:live-autonomy` first against the staged Agent Web and Eve
deployment. It must complete a real Provider-backed website task, execute
sandbox tools, call `publish_preview`, and read the signed HTML through the
deployment route. Record the run id, duration, Provider model/config revision,
input/output/cache tokens, tool count, preview id, and correlated trace id. A
functional pass with excessive latency or spend is not an SLO pass.

Use `npm run verify:load` against the staged Agent Web and Eve deployment before
traffic promotion. Set total runs above concurrency, include a warmup phase, and
configure explicit admission p95, completion p95/p99, maximum error-rate, and
minimum throughput budgets for the intended traffic class. Set
`AGENT_LOAD_EVIDENCE_PATH` and retain the versioned JSON report with the release;
it includes the applied budgets, p50/p95/p99/max latency, throughput, failures,
event count, and idempotency results without credentials or prompts. A local
deterministic pass is only a regression baseline. Production capacity evidence
must use the target Provider, database, queue, sandbox backend, autoscaling, and
collector configuration, and must be repeated after material topology changes.

Run `npm run verify:asset-load` against the staged Agent Web when validating the
object-store path. The bounded gate defaults to two concurrent 100 MiB uploads
(eight uploads are the maximum configured concurrency), uses the server-advertised
multipart chunk size, retries a deliberately truncated first part, verifies the
completion checksum and beginning/end range reads, and checks that another tenant
cannot read the completed asset. It also checks that a different principal in the
same tenant cannot read it, so a passing run covers both tenant and principal
ownership boundaries. The gate fails unless the server advertises direct
object-store transfer, so a filesystem/proxied pass cannot be mistaken for
production evidence. Set `AGENT_ASSET_LOAD_TOTAL_UPLOADS` above
`AGENT_ASSET_LOAD_CONCURRENCY` for a fuller run, and use
`AGENT_ASSET_LOAD_SIZE_BYTES` (for example `100MiB`) only within the 10 GiB asset
limit. `AGENT_HOST_JWT_SECRET`, `AGENT_HOST_JWT_ISSUER`, and
`AGENT_HOST_JWT_AUDIENCE` are required. Headless AgentRun tokens must also
carry the `agent:runs` scope. Set
`AGENT_ASSET_LOAD_EVIDENCE_PATH` to retain the redacted JSON report; it records
part retry counts, throughput, upload latency, and isolation status, never file
bytes or credentials. This is a bounded capacity/regression gate, not evidence
that a deployment meets the full 1k/5k/10k stream or tenant SLO matrix.

Host JWTs for the interactive control plane use separate least-privilege
scopes. Grant only the operations that the embedding surface exposes:

| Surface | Read scope | Mutation scope |
| --- | --- | --- |
| Session history and state | `agent:sessions:read` | `agent:sessions:write` |
| Session deletion | - | `agent:sessions:delete` |
| Child-agent supervisor | `agent:subagents:read` | `agent:subagents:write` |
| Durable approvals | `agent:approvals:read` | Resolution continues through the authenticated Eve input request |
| Mailbox item status | `agent:mailbox:read` | `agent:mailbox:write` |

`agent:runs`, `asset:read`, and `asset:write` remain independent. A token with
one scope does not inherit another. The standalone Web surface does not mint a
Host JWT; it uses its opaque HttpOnly owner cookie through `/api/standalone/*`
and can access only records claimed by that owner.

Keep Eve pinned to an exact version. Before any cross-minor upgrade, replay
representative persistent sessions against an isolated copy of the Workflow
World and prove migration compatibility. Do not let a new runtime version take
ownership of the production World until that replay gate passes and rollback has
been rehearsed.
