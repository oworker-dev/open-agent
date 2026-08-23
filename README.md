# open-agent

`open-agent` is a standalone, Web-first autonomous agent. It targets a Codex-like
product shape while keeping the runtime independent of Muses, canvases, image
generation, presentations, and other host-specific domains.

Muses is the first host, not a compile-time dependency. Host capabilities must be
provided as authenticated tools, skills, connections, or client context.

## Current status

The project has a working Eve runtime and a reusable assistant-ui Web workspace:

- durable multi-turn sessions and reconnectable event streams;
- model and reasoning selection;
- reasoning, tools, human approval, authorization, usage, and cost projections;
- multiple local threads, responsive navigation, English and Simplified Chinese;
- immediate optimistic sending, visible thread selection, inline rename, and searchable model selection;
- Context usage disclosure plus host-injected `/` Skill/command and `@` context discovery;
- cancellation, failed-turn continuation, hard-refresh recovery, and supervised
  half-open stream replacement from the last UI-observed cursor;
- a server-owned follow-up mailbox with strict per-session FIFO, leases, and
  ambiguous-admission protection, including Codex-style active-turn steering
  at the next model-step boundary;
- inspectable sub-agent sessions with Active/Done navigation, independent
  durable stream recovery, elapsed time, terminal-state repair, and explicit
  cancellation;
- per-durable-session Eve sandbox behavior;
- PostgreSQL-backed session ownership and injectable account thread storage;
- Host JWT enforcement across create, continue, stream, cancel, and reset routes.
- buildable Contracts, Client, Host, and React UI alpha SDK packages;
- optional iframe, native `AgentWorkspace`, and custom-host UI integration paths;
- authenticated, resumable 8 MiB-chunk asset uploads (including 100 MiB+ files), session asset listing, a PostgreSQL-metadata + S3-compatible production AssetStore, sandbox `import_asset`, and bounded `view_image` inspection.
- assistant-ui primitives and shadcn/ui-compatible base components exported for reusable host composition.
- authenticated static website previews and generic artifact delivery for Python, image, audio, video, and document outputs.

This is an integration preview, not a completed production release. The current
delivery path publishes immutable static files and bounded artifacts; it does
not yet proxy long-running development servers or arbitrary sandbox ports.
Real third-party MCP OAuth, billing reconciliation, deployed telemetry, and
security evidence remain release gates. Host-published Skill manifests and
content are now part of the versioned Runtime Config contract. The standalone
Agent runtime has a repeatable real-Provider autonomy E2E on the local
PostgreSQL production topology. That evidence does not substitute for a staged
or deployed Provider, database, collector, load, and failure conformance run. See
[Architecture](docs/architecture.md), the
[deployment runbook](docs/deployment.md), and the
[release runbook](docs/releasing.md).

## Requirements

- Node.js 24
- Docker for the current local sandbox selection
- `OPENAI_API_KEY`
- optional `OPENAI_BASE_URL` and `AGENT_MODEL_ID`

Do not put credentials in the repository or browser storage.

When Muses is the Host, `OPENAI_API_KEY` is the private Muses broker secret,
not an upstream model credential, and `OPENAI_BASE_URL` points to
`/api/internal/agent-provider/v1`. Muses resolves an Admin-managed `llm`
Provider Connection for each requested model and streams the Responses API
result back to Eve. The upstream credential remains inside the Muses server
request and never enters Agent state, the browser, or the sandbox. A standalone
deployment may still use its own OpenAI-compatible Provider directly.

## Development

Run with a Node 24 shell:

```bash
npm install
npm run dev
```

The Next.js app and Eve development runtime are mounted on one origin by
`withEve()`. The default Web URL is `http://127.0.0.1:3000`.

When follow-up queuing is enabled, start the mailbox worker in a third process:

```bash
AGENT_WEB_INTERNAL_URL=http://127.0.0.1:3000 \
AGENT_MAILBOX_WORKER_SECRET='local-worker-secret-at-least-32-bytes' \
AGENT_MAILBOX_DISPATCH_SECRET='local-dispatch-secret-at-least-32-bytes' \
  npm run start:mailbox-worker
```

The worker is application infrastructure, not part of Eve's model loop. Eve
does not provide the product-level durable FIFO for concurrent Web clients. The
worker dispatches one persisted item at a time: a running session with a durable
turn ID receives an `expectedTurnId` steering delivery at the next safe model
boundary, while a waiting session receives a normal next-turn delivery. If the
expected turn settles during admission, Eve removes the stale steering marker
and preserves the message as an ordinary next turn. The browser fallback
remains available for hosts that do not provide a mailbox, but it is not durable
across a closed tab or process restart.

The mailbox commit hook retries transient product-database failures before it
fails the turn. Every delivery carries a stable `clientMessageId`; its durable
`message.received` event is authoritative even when the dispatcher HTTP response
was lost. The event may atomically promote a `submission-ambiguous` item to
`committed`, unblocking strict FIFO without replaying the message. The composer
removes the pending item only after observing that exact ID.

For a remote development preview, bind Next to all interfaces and pass the
current hostname or IP through `AGENT_DEV_ALLOWED_ORIGINS`. Keep that value in
the process environment rather than source control so dynamic addresses do not
become deployment configuration.

## Verification

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
npm run verify:provider-failures
npm run verify:mcp-conformance
```

The default browser suite keeps provider-dependent output out of deterministic
regression tests. Run the live provider continuation check explicitly:

```bash
RUN_AGENT_LIVE_E2E=1 npm run test:e2e -- --grep "real conversation"
```

`verify:provider-failures` boots a real Eve runtime against a fault-injecting
OpenAI Responses-compatible server. It proves that HTTP 408, 429, and 5xx
responses are retried only by Eve and recover on the third Provider request;
recognized network disconnects and timeouts use the same Eve-owned retry
budget, and the AI SDK does not multiply those attempts with its own retry loop. It also
proves that a hung request and a stream interrupted after Provider output emit
`step.failed` and `turn.failed`, park at `session.waiting`, and accept a
successful follow-up in the same durable session without `session.failed`.

Against an already running production topology, verify a real autonomous
sandbox-to-preview task with:

```bash
AGENT_LIVE_E2E_BASE_URL=http://127.0.0.1:3100 \
AGENT_LIVE_E2E_PREVIEW_ORIGIN=http://127.0.0.1:3100 \
AGENT_HOST_JWT_SECRET=... \
AGENT_HOST_JWT_ISSUER=... \
AGENT_HOST_JWT_AUDIENCE=... \
npm run verify:live-autonomy
```

The gate submits a real Provider-backed Headless AgentRun, proves idempotent
admission, requires sandbox file or Shell execution, requires
`publish_preview`, and reads the signed HTML back through the public preview
route. `AGENT_LIVE_E2E_PREVIEW_ORIGIN` may point at a loopback deployment while
`AGENT_PUBLIC_BASE_URL` remains the production HTTPS origin. The default task
allows five minutes of Agent execution plus one minute for observation; record
completion latency and token/cache usage from its JSON result.

The Muses bridge verification is an explicit live-provider check, not a
deterministic unit test:

```bash
MUSES_AGENT_SERVICE_URL=http://127.0.0.1:3100 \
MUSES_E2E_USER_ID=... \
MUSES_E2E_WORKSPACE_ID=... \
MUSES_E2E_PROJECT_ID=... \
MUSES_E2E_CANVAS_ID=... \
MUSES_E2E_DEPLOYMENT_ID=... \
MUSES_E2E_WORKFLOW_INPUT_ID=prompt \
MUSES_E2E_RUNTIME_CONFIG_JSON='{"contractVersion":"0.1.0",...full snapshot...}' \
MUSES_AGENT_HOST_JWT_SECRET=... \
MUSES_AGENT_HOST_JWT_ISSUER=... \
MUSES_AGENT_HOST_JWT_AUDIENCE=... \
npm run verify:muses-host-e2e
```

`MUSES_E2E_RUNTIME_CONFIG_JSON` must be the complete versioned Runtime Config
snapshot published by the Host; the abbreviated value above is only a shell
placeholder and is rejected by the preflight. The verifier also requires a
32-byte Host JWT secret and fails before making a network request when required
configuration is missing or malformed. The `MUSES_AGENT_HOST_JWT_*` values are
the Muses-side signing configuration; the Agent deployment verifies the same
secret under its `AGENT_HOST_JWT_*` names.

The script refreshes its short-lived Host JWT on every request, verifies
idempotent replay, and asserts the semantic Host event chain and Workflow
output. A live Provider may still reject or time out a model request; use
`scripts/mock-openai-responses.mjs` for a deterministic protocol check.

## Self-hosted alpha build

For a single-tenant self-hosted alpha build, use the PostgreSQL Workflow World
during both build and runtime. Bootstrap its schema once against the target
database:

```bash
WORKFLOW_POSTGRES_URL=postgres://... npx --package=@workflow/world-postgres bootstrap
AGENT_DATABASE_URL=postgres://... npm run db:migrate
```

Build both services with the same Eve port baked into the Next rewrite:

```bash
AGENT_DEPLOYMENT_TENANCY=single-tenant \
AGENT_SANDBOX_BACKEND=docker \
AGENT_SANDBOX_IMAGE=ghcr.io/oworker/open-agent-sandbox@sha256:... \
AGENT_PUBLIC_BASE_URL=https://agent.example.com \
AGENT_PREVIEW_SIGNING_SECRET='replace-with-32-byte-secret' \
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://... \
WORKFLOW_POSTGRES_JOB_PREFIX=open_agent_ \
  npm run build:eve
AGENT_DEPLOYMENT_TENANCY=single-tenant \
AGENT_SANDBOX_BACKEND=docker \
AGENT_EMBED_ALLOWED_ORIGINS=https://muses.example.com \
EVE_NEXT_PRODUCTION_PORT=4275 npm run build
```

`npm run build:eve` always compiles `@workflow/world-postgres` into the Eve
artifact. `start:preview` and `doctor:production` reject an artifact whose
compiled manifest falls back to the local disk World; setting only the runtime
environment is too late. Use `npm run build:eve:local` only for an explicit
local-disk development build.

This Docker topology is for a trusted single-tenant operator or staging
baseline. Eve 0.31.1 does not expose Docker CPU, memory, PID, Linux capability,
or non-root controls through its backend. `doctor:production` therefore rejects
Docker when `AGENT_DEPLOYMENT_TENANCY=multi-tenant`; use a reviewed microVM
backend such as microsandbox or Vercel Sandbox before admitting mutually
untrusted tenants.

`npm run build` verifies the generated Next.js route manifest after compilation.
It fails if `/embed` does not contain the exact origins from
`AGENT_EMBED_ALLOWED_ORIGINS`; this prevents a fail-closed
`frame-ancestors 'none'` artifact from being promoted as a working Host
integration.

Eve documents automatic local runtime startup from `next start`, but the
installed Next.js 16.3 preview does not currently invoke that resolver reliably.
For local production verification, start the two official services explicitly:

```bash
AGENT_DEPLOYMENT_TENANCY=single-tenant \
AGENT_SANDBOX_BACKEND=docker \
AGENT_SANDBOX_IMAGE=ghcr.io/oworker/open-agent-sandbox@sha256:... \
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://... \
WORKFLOW_POSTGRES_JOB_PREFIX=open_agent_ \
  npm run start:eve -- --port 4275
AGENT_RUNTIME_URL=http://127.0.0.1:4275 \
EVE_NEXT_PRODUCTION_PORT=4275 npm start -- -p 3100
```

Verify `http://127.0.0.1:3100/eve/v1/health` before sending a turn. Vercel uses
generated service routes and does not use this two-process local fallback.

Run `npm run doctor:production` with the deployment environment before building.
It fails when Node is not 24, a production sandbox backend is implicit, the Eve
World shares the Agent product database, the queue prefix can collide with
Muses, deployment tenancy is missing, a multi-tenant deployment selects Docker,
build-time CSP/port values are missing, or Host credentials are partial.
`AGENT_EMBED_ALLOWED_ORIGINS` and `EVE_NEXT_PRODUCTION_PORT` are build inputs;
setting them only when `next start` runs cannot repair an already built image.
`AGENT_PUBLIC_BASE_URL` and `AGENT_PREVIEW_SIGNING_SECRET` are also mandatory
production inputs. They make preview and artifact links absolute, signed, and
time-limited. Production requires PostgreSQL, so `.eve/previews` and
`.eve/artifacts` are development fallbacks only.
Production also requires `AGENT_SANDBOX_IMAGE` pinned by OCI sha256 digest.
[`sandbox/Dockerfile`](sandbox/Dockerfile) defines the reviewed Node, Python,
Git, FFmpeg, ImageMagick, and Playwright/Chromium runtime. Build and publish it
as an immutable image, then run `npm run verify:sandbox-runtime` against the
published digest before promotion.
The Agent Web API and Eve runtime both register OpenTelemetry through
`@vercel/otel`. Configure `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or the Vercel
collector) in both processes and use the same collector as Muses. Synchronous
HTTP hops propagate W3C context. Eve's durable queue is an asynchronous boundary,
so the accepted Agent turn uses an OpenTelemetry Span Link to the originating
Web request instead of pretending the queued work is a synchronous child span.
Full prompts and model outputs are disabled; AgentRun, correlation, Profile,
Project, Canvas, session, and turn identifiers remain available for joins.
Provider errors are reduced to status and retry classification before entering
the durable event log, because upstream SDK exception messages may contain the
request body and would otherwise leak through OpenTelemetry exception stacks.

Every direct Provider HTTP/SSE request has a hard deadline configured by
`AGENT_PROVIDER_HTTP_TIMEOUT_MS` (10 minutes by default). Eve is the only
automatic retry authority: transient 408, 429, and 5xx failures receive Eve's
bounded three-attempt policy. A stream interruption may also be retried after
text or reasoning output, because no external action has occurred. Once the
Provider stream reaches a tool-input, tool-call, tool-result, or opaque raw
boundary, an interruption ends the current turn as a recoverable failure while
preserving the stable session; replaying that step could duplicate an external
side effect. Caller cancellation remains distinct and propagates as Eve's
normal cancellation flow.

The Web client treats descendant `input.requested` events as part of the owning
root task even though Eve preserves the child turn id. A parent may therefore
emit `turn.completed` and `session.waiting` while a child remains parked for
approval; the execution stays expanded, ordinary Composer input is disabled,
and the proxied approval remains actionable. A later root `turn.started`
clears that waiting state. For stale browser streams, the client performs a
bounded read-only durable-tail probe after a no-progress interval. It switches
to recovery only when the server has events the live connection missed, so a
slow Provider is not misreported as a reconnect.

`AGENT_MODEL_MAX_OUTPUT_TOKENS` (4096 by default) bounds one Provider request.
It prevents compatible gateways from reserving an unnecessarily large output
budget before every Agent step. This is independent from Eve's cumulative
session limits and the Host-owned AgentRun policy budget; deployments may tune
it to a model's real output capacity and commercial policy.

Production browser traffic must carry a short-lived host JWT. Configure
`AGENT_HOST_JWT_SECRET`, `AGENT_HOST_JWT_ISSUER`, and
`AGENT_HOST_JWT_AUDIENCE` from the deployment secret manager. Tokens must
contain `sub` and a non-empty `tenantId`; optional `actorType` is `user` or
`service`. Local loopback development remains available through Eve's
`localDev()` authenticator.

`AGENT_DATABASE_URL` is mandatory whenever Host JWT auth is enabled. Eve records
the immutable `tenantId + principalId` owner on `session.started`; every later
session-specific request checks that owner before exposing events or accepting
work. Agent product tables use `AGENT_DATABASE_SCHEMA` (default `open_agent`)
and may live in the host product database. The Eve Workflow World must use a
physically separate database: Workflow runtime generations with incompatible
spec versions cannot safely share a `workflow` schema or worker queue.

`AGENT_RUNTIME_URL` names the Eve origin or deployment base path before
`/eve/v1`; the Eve client appends its protocol routes. The adapter also repairs
the common trailing `/eve/v1` misconfiguration to prevent duplicated paths.
`AGENT_RUN_CANCELLATION_GRACE_MS` controls the bounded cooperative-cancel window
before the service terminally resets an exclusive Headless AgentRun session.

The runtime accepts two versioned profiles: `general-purpose@0.1.0` is
host-neutral, while `muses-platform@0.1.0` enables the same Agent runtime with
Muses-specific host instructions. Profile selection is validated at the
Headless AgentRun boundary and projected into the Eve session; a host cannot
invent a profile by changing a Workflow node.

## Headless AgentRun API

The service exposes a framework-neutral run contract for hosts and Workflow
nodes. Eve `sessionId` is an internal harness handle; callers use the stable
`runId` returned by the API:

```text
POST   /api/agent/runs
GET    /api/agent/runs/:runId
GET    /api/agent/runs/:runId/events?after=cursor
DELETE /api/agent/runs/:runId
```

Every request requires a Host JWT with the `agent:runs` scope and is scoped to
its verified `tenantId + principalId`. Start requests require an idempotency
key. Replaying
the same semantic request returns the original run without submitting another
model turn; reusing the key for a different request returns `409`.

The event endpoint projects Eve events into the versioned Agent contract and
reports token usage, cache reads/writes, and provider cost when Eve supplies
them. Events are returned in bounded pages (up to 200 per response); advance
with `nextCursor` and stop when a page is empty. This keeps inspection latency
independent of the total size of a long-running event stream. `DELETE` first requests Eve cooperative cancellation and records
`cancellationRequestedAt`. If Eve does not emit `turn.cancelled` within the
bounded grace window, the service terminally resets that AgentRun's exclusive
session and records `cancelled`. Late provider completion cannot overwrite the
cancelled state or publish a result. Inspection and event reads repeat the same
idempotent reconciliation after interrupted cancellation requests.

The draft does not yet provide per-run credit reservations or deployed
collector, dashboard, retention, and cost-reconciliation evidence. Those remain
explicit release gates rather than hidden behavior.

Against a running deterministic production topology, exercise concurrent
Headless runs with:

```bash
AGENT_LOAD_BASE_URL=http://127.0.0.1:3111 \
AGENT_LOAD_PROVIDER_DEBUG_URL=http://127.0.0.1:4291/debug/state \
AGENT_LOAD_CONCURRENCY=8 \
AGENT_LOAD_TOTAL_RUNS=32 \
AGENT_LOAD_WARMUP_RUNS=4 \
AGENT_LOAD_P95_ADMISSION_MS=2000 \
AGENT_LOAD_P95_COMPLETION_MS=20000 \
AGENT_LOAD_MAX_ERROR_RATE=0 \
AGENT_LOAD_EVIDENCE_PATH=.tmp/load-evidence.json \
  npm run verify:load
```

The gate uses a bounded worker pool and checks admission and completion latency,
error rate, optional throughput and p99 budgets, per-run result and event
isolation, Usage, cursor exhaustion, and idempotent replay without additional
Provider calls. The optional evidence path receives a versioned, secret-free
JSON report even when a budget fails. This is a repeatable single-host baseline,
not target-deployment capacity proof.

For the single-server capacity matrix, set
`AGENT_LOAD_COMPLETION_SLO_MODE=observe`. That mode still records Provider
completion p50/p95/p99, but the pass/fail gate uses local admission, error rate,
and throughput dimensions; it also records RSS, heap, and event-loop delay.
Use the default `enforce` mode for a true end-to-end Provider SLO gate. A slow
upstream response must not be “fixed” by truncating durable events or imposing
an arbitrary per-session payload limit.

Use the separate authenticated durable-stream gate for idle online capacity. It
creates one real waiting session, opens cursor-addressed follower streams, holds
them without model work, and records handshake latency, disconnects, and load
client memory. Run 100 first, then 1k/5k/10k only on the selected deployment:

```bash
AGENT_STREAM_LOAD_BASE_URL=http://127.0.0.1:3100 \
AGENT_STREAM_LOAD_TOTAL=1000 \
AGENT_STREAM_LOAD_CONCURRENCY=250 \
AGENT_STREAM_LOAD_HOLD_MS=30000 \
AGENT_STREAM_LOAD_EVIDENCE_PATH=.tmp/idle-stream-load-evidence.json \
  npm run verify:stream-load
```

## Docker sandbox retention

Eve's Docker backend preserves `/workspace` in a long-lived container for each
durable session. Stopping the Agent server stops sandbox compute but intentionally
keeps the container so the next server can reattach. Deletion is therefore an
application retention decision, not an Eve server-shutdown side effect.

The operator reaper is conservative and prints a JSON dry-run by default:

```bash
EVE_SANDBOX_RETENTION_HOURS=168 \
EVE_SANDBOX_REAPER_MAX_REMOVALS=50 \
  npm run reap:sandboxes

# Apply exactly the previously reviewed policy.
EVE_SANDBOX_RETENTION_HOURS=168 \
EVE_SANDBOX_REAPER_MAX_REMOVALS=50 \
  npm run reap:sandboxes -- --apply
```

It only owns containers with Eve's session labels and name convention, skips
running and protected sessions, rechecks ownership immediately before deletion,
and limits every invocation. Emergency deletion of a running sandbox requires
both `--include-running` and the exact `--session-id`; neither flag alone is
accepted. `EVE_SANDBOX_PROTECTED_SESSION_IDS` is a comma-separated protection
list. `--apply` also requires `AGENT_DATABASE_URL` and atomically claims a
session tombstone written only after Eve was retired; container age alone never
authorizes deletion. Production operations must schedule this command and ship
its JSON plus the persisted tombstone lifecycle to durable audit storage.

## Host integration

`AgentWorkspace` accepts transport and per-turn host hooks without importing a
host product into the Agent core:

```tsx
import { AgentWorkspace, createHttpAgentThreadStorage } from "@oworker/open-agent-ui";
import "@oworker/open-agent-ui/styles.css";

const threadStorage = createHttpAgentThreadStorage({
  getAccessToken: () => hostSession.agentAccessToken(),
});

<AgentWorkspace
  agentName="general-agent"
  client={{
    host: "",
    headers: async () => ({ "x-host-csrf": await getCsrfToken() }),
    prepareSend: (input) => ({
      ...input,
      clientContext: { route: window.location.pathname },
    }),
  }}
  defaultPreferences={{ modelId: "provider/model", reasoning: "high" }}
  models={[{ contextWindowTokens: 272000, id: "provider/model", label: "Model" }]}
  productName="Agent"
  reasoningLevels={["low", "medium", "high"]}
/>
```

Hosts can also inject authenticated thread persistence. The storage adapter
owns account/database access; `AgentWorkspace` consumes a versioned thread
index, hydrates selected transcripts on demand when the adapter supports it,
and serializes writes so rapid stream events cannot reorder them:

```tsx
<AgentWorkspace
  agentName="general-agent"
  defaultPreferences={{ modelId: "provider/model", reasoning: "high" }}
  models={[{ contextWindowTokens: 272000, id: "provider/model", label: "Model" }]}
  productName="Agent"
  reasoningLevels={["low", "medium", "high"]}
  threadStorage={threadStorage}
  onStorageError={reportHostStorageFailure}
/>
```

For server-backed threads, hosts should also provide `onDeleteThread`. The
reference Muses embed calls `DELETE /api/agent/sessions/:sessionId`. The service
retires Eve by that stable session ID first, then records a database-authorized
sandbox tombstone for asynchronous reaping. A failed retirement leaves the
thread and sandbox visible.

The bundled HTTP adapter uses `If-Match` revisions and sends only changed thread
metadata plus append-only event deltas for normal streaming. Existing transcript
events are never copied into every checkpoint request; an edit/resend uses an
explicit replacement snapshot. A competing client receives `409`; the workspace
reloads the current index, merges by thread update time, and retries at most three
times. Persistent conflicts remain visible through `onStorageError` and never
become unbounded write loops. Normal checkpoints use only event deltas; the
legacy `PUT` full snapshot route has a separate 64 MiB compatibility guard and
is not a session or context-window limit. Large assets remain object-storage
references and large transcripts are hydrated by thread rather than collection.
Production PostgreSQL deployments must apply migration `0010_thread_event_log.sql`;
it backfills legacy JSONB events and moves subsequent append checkpoints to the
bounded event log. The JSONB collection remains a metadata/compatibility snapshot,
while `loadThread` rehydrates the selected transcript from the event log.

The server remains authoritative for identity, model entitlement, tool access,
and billing. Browser headers and `clientContext` are untrusted input.

## Tools and fixed evals

Eve supplies the general-purpose file, Shell, Web, todo, clarification,
Skill, and subagent loop. Open Agent preserves those framework executors and
overrides only the `bash` approval policy. `AGENT_BASH_APPROVAL_MODE=risky`
parks destructive, publishing, infrastructure-mutating, and external write
commands for durable user approval. Unattended service/runtime principals are
denied instead of approving themselves. Production rejects `never`.

Each Eve sub-agent has an independent durable session and stream. The Web UI
can inspect, reconnect to, and cancel that session. Eve's built-in `agent` copy
shares the root sandbox; a declared specialist uses its own sandbox unless
configured otherwise. Open Agent enables Eve 0.31.1 persistent subagent
sessions: a completed child parks, receives a stable `agentId`, and can be
continued by the parent on a later model step. Open Agent patches the Eve turn
driver with Codex-style root-session steering at safe model boundaries; it still
does not expose detached/no-wait children, injection into a busy child, or a
public close lifecycle. Open Agent does not replace Eve's model loop or display
fake controls for operations the runtime cannot perform.

Run the deterministic Harness suite against a real Docker sandbox:

```bash
npm run eval:fixed
```

The suite covers host-neutral file write/read, Shell execution, checkpoints,
tool failure recovery, durable approval, cancellation, cross-turn sandbox
continuity, repeated Eve context compaction, static website preview delivery,
Python artifact delivery, and ImageMagick/FFmpeg media rendering. The standalone profile does not force a
host-specific Skill; Skills are published and granted by the active runtime
configuration. The compaction case preserves
exact facts, active todo state, and sandbox contents across two checkpoints,
and proves that Eve resets read-before-write evidence after summarization so an
existing file must be read again before it can be changed. It uses
`AGENT_EVAL_FIXTURE_MODEL` and a small
`AGENT_EVAL_CONTEXT_WINDOW_TOKENS` only inside the runner;
`doctor:production` rejects both test controls in production.

## Skill and MCP control plane

The effective deployment catalog merges code-reviewed built-in adapters with
the version-pinned extension manifests in the authenticated Runtime Config.
Tenant operators with the Host JWT scope `agent.extensions.manage` can inspect,
enable, or revoke that effective catalog through:

```text
GET    /api/agent/extensions
PUT    /api/agent/extensions/:extensionId/:version
DELETE /api/agent/extensions/:extensionId/:version
```

The `PUT` body accepts only an optional `credentialRef`. It must be an opaque
`vault://...` or `vercel-connect://...` locator; raw credentials are rejected.
Audit records persist state transitions and whether a credential was
configured, never the reference or secret. Revocation is checked before a
Headless AgentRun starts and again when an Eve session starts or continues.
It prevents future calls; it cannot roll back a side effect that already
completed, so write capabilities still require approval and idempotency.

The current standalone catalog contains `software-task@1.0.0`. Runtime Config can
publish tenant procedure text as a dynamic Skill without rebuilding the Agent.
It can also publish MCP lifecycle metadata, but Eve MCP connection adapters are
build-time capabilities: a manifest alone does not create a network connection.
AgentRun policy resolution fails closed when MCP metadata has no matching
compiled adapter. `@oworker/open-agent-mcp-adapter` now provides the reviewed,
host-neutral connection factory: a deployment must import it from an authored
`agent/connections/*.ts` file and pin the endpoint, tool allowlist, approval
list, broker endpoint, and exact adapter version in source. No MCP is advertised
by the standalone profile because it imports no connection.

`npm run verify:mcp-conformance` compiles a temporary consuming Agent, starts a
real Streamable HTTP MCP server and private credential broker, and proves
authorized discovery/read, allowlist filtering, durable approval/resume for a
write, revocation at the next boundary, and absence of broker or third-party
credentials from Agent events. This closes the brokered/out-of-band credential
adapter contract; it does not replace a real provider OAuth consent, refresh,
revocation, and denial test.

Headless hosts use the same versioned Run contract through the buildable
`@oworker/open-agent-contracts` and `@oworker/open-agent-client` workspace packages.
`createAgentRunClient()` provides start, inspect, incremental events, and
cancellation without exposing Eve session identifiers or importing a host
product. It resolves a short-lived token for every request, rejects credential
forwarding redirects by default, and validates successful responses against the
advertised contract version. The host is responsible for issuing a JWT whose
`sub`, `tenantId`, and `actorType` identify the immutable owner.

The `@oworker/open-agent-client/eve-session` subpath adapts Eve's interactive session
implementation to a host-neutral cursor, turn, event, continuation,
cancellation, and reset interface. Hosts that own their UI can use this path
without importing `AgentWorkspace` or loading the iframe.

`@oworker/open-agent-host` owns the signed Host Capability client, verification, and
registry primitives. Application membership and business authorization remain
the host's responsibility.

`@oworker/open-agent-ui` owns the host-neutral React `AgentWorkspace`, thread storage,
event projection, assistant-ui based primitives, and a precompiled stylesheet.
The host must inject its reviewed model catalog and defaults; identity,
entitlement, billing, and tool policy remain server-authoritative. Both the
standalone page and optional `/embed` adapter consume this package rather than
private component source.

[`examples/custom-host-react`](examples/custom-host-react) is the inverse proof:
it imports no UI package and owns every DOM element while using
`@oworker/open-agent-client/eve-session` for rotating credentials, streaming,
continuation, approval, cancellation, and refresh recovery.

Run `npm run verify:sdk-packages` to build, pack, install, and import all SDK
artifacts in empty npm and pnpm consumers. Versioned GitHub prerelease tarballs
are available for host integration, while npm publication remains disabled
until the repository license, stable release policy, and cross-host conformance
gates are complete.

## Host Capability bridge

When `AGENT_HOST_TOOLS_URL` and `AGENT_HOST_TOOLS_SECRET` are configured in the
Eve runtime, the runtime exposes `host_capabilities` and `host_invoke` as
dynamic tools. Both the Web process and the separate Eve process must receive
the same URL and secret. They are
absent from standalone sessions when the bridge is not configured, so the Agent
remains useful without Muses. Requests use a short-lived HMAC signature over
timestamp, method, path, and body, and carry tenant, raw principal, project, and
canvas scope. User calls require Eve approval; explicitly marked service actors
may proceed only for owner/admin Workspace members.

Muses implements the first bridge at:

```text
GET  /api/studio/agent-host-tools/capabilities
POST /api/studio/agent-host-tools/invoke
```

The bridge maps only registered capabilities to the Muses operation gateway:
canvas inspection/placement, Workflow catalog inspection/invocation, bounded
server-side Workflow run waiting that does not spend LLM calls on polling, and
versioned Workflow draft create/command/validate/publish. It never exposes a
database handle or internal Agent state. Configure the same 32+ character HMAC
secret as `MUSES_AGENT_HOST_TOOLS_SECRET` in Muses and
`AGENT_HOST_TOOLS_SECRET` in this service.
