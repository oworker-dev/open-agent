# Production Roadmap

This is the execution order for taking Open Agent from the current alpha
implementation to a web Codex-class product that can be embedded by Muses.
The roadmap separates the neutral Agent kernel from host adapters and from the
reference assistant-ui client. A feature is not complete when its browser
projection looks plausible; it is complete only when its durable protocol,
recovery behavior, authorization, and tests are complete.

## Current boundary

Open Agent remains a standalone, host-neutral Agent service. Eve owns the model
loop, durable sessions, provider retry, context compaction, sandbox execution,
and native subagent events. Open Agent owns the product-level session
controller, mailbox, public contracts, host adapters, and web projection.
Muses is the first host and may provide model credentials, canvas tools, an
object store, and billing, but none of those types belong in the kernel.

The kernel and reference Web client now pass the local production regression
gates. Public release still requires a real host deployment and its external
capacity and observability evidence; a local green test run is not a substitute
for that topology.

| Area | Current state | Production consequence |
| --- | --- | --- |
| Eve session durability and reconnect | Implemented and covered by local tests | Keep Eve as the source of truth; harden deployed failure paths |
| Main-session mailbox/steering | Implemented for the main session | Extend the same contract to child sessions and make all state server-authoritative |
| Child sessions | Native durable snapshots, guarded navigation, shared AgentThreadView, child Composer, and bounded legacy-Eve fallback are implemented | Run host-scale lifecycle and fan-out evidence before public release |
| Message edit/append | Main-session UI and mailbox paths exist | Formalize operation IDs, thread versions, idempotency, and child parity |
| Approvals and ask | Eve pause/resume exists | Persist request lifecycle so refresh cannot reopen completed requests; Composer must become the active approval surface |
| Tool streaming | Eve partial/result events exist for authored generators | Add typed deltas and custom UI for patch, terminal, todo, and image tools |
| Attachments | assistant-ui uploads immediately with real progress through a host-replaceable adapter; production S3 uses short-lived direct multipart PUT targets while filesystem development keeps bounded proxy parts; PostgreSQL stores ETags/metadata only and completion verifies size, identity, and streamed SHA-256 | Run the 100 MiB direct-upload gate against real PostgreSQL + selected S3/OSS with bucket CORS, Host JWT, scanner, quota, retention, and lifecycle evidence |
| Result artifacts | Static preview and bounded artifact stores exist | Keep as output projection; do not use it for user uploads |
| Vision | `view_image` validates signatures, bounds payloads, resizes oversized images, and emits typed file output | Verify provider capability negotiation and visual rendering across hosts |
| Host SDK and Muses bridge | Contracts, client, host, UI, and MCP packages exist as alpha artifacts | Publish only after cross-host, auth, quota, and failure conformance |
| Capacity | Deterministic unit/build gates, non-destructive root-tree retention audit, versioned Workflow archive export/checksum validation, disk-safe sequential and mixed capacity matrices, continuous target metrics, Workflow storage deltas, explicit connection-versus-distinct-session evidence, and real Docker sandbox admission/lifecycle evidence exist | No current real 1k/5k/10k distinct-session run, deployed SLO, target-backend sandbox evidence at scale, isolated archive restore/replay drill, or ten-thousand-user capacity report |

The current upload and vision contract is specified in
[Assets, Uploads, And Vision](./assets-and-vision.md). That document is a
dependency of the milestones below.

## Non-negotiable invariants

1. Every durable operation has a stable server identity, an idempotency key,
   an authenticated owner, and a monotonic state transition.
2. Eve events and server records are authoritative. Browser state is a cache
   and projection; it cannot invent a child status, approval result, retry, or
   asset ownership.
3. A session, not a user or canvas, is the default history and sandbox
   boundary. A user, project, or canvas may own many sessions.
4. Large bytes stay in object storage. Messages, event history, and Postgres
   rows contain metadata and references only.
5. The Agent kernel must work with no Muses host capabilities. Host tools,
   models, skills, MCP servers, storage, and billing are injected contracts.
6. Provider slowness, a broken stream, a worker crash, or a browser refresh
   must result in a visible recoverable state, never an invented completed
   result or a permanently disabled Composer.

## P0: durable session control plane

The local P0 acceptance suite is green: root and child recovery use durable
cursors, mailbox operations are idempotent, approval state survives refresh,
and the stop/send control no longer remounts during a live stream. Remaining
work in this section is deployment evidence and host-level authorization
conformance.

P0 must finish before adding more visual polish or more node types. It removes
the conditions that currently make a long task appear stuck.

### Session controller

Create one `AgentSessionController` used by both root and child sessions. It
owns:

- stable session/thread identity and URL addressing;
- history hydration from a server cursor rather than replaying from index zero;
- one live stream reader plus bounded ordered catch-up on reconnect;
- send, append/steer, edit, cancel, retry, approval, ask, and queue operations;
- active turn, waiting, failed, cancelled, and terminal boundaries;
- host authorization and session ownership checks.

`AgentThreadView` and the child view must consume this controller through the
same assistant-ui runtime. A child page is not a special read-only stream
component.

### Message operation state machine

Every message submission and queue operation has:

```text
queued -> delivering -> accepted -> committed
                         |          |
                         v          v
                       failed     cancelled
                         |
                         v
                  submission-ambiguous
```

Each record carries `clientMessageId`, `serverSubmissionId`, `sessionId`,
`expectedTurnId`, creation time, attempt count, and the last durable cursor.
The server deduplicates by idempotency key. A late event cannot overwrite a
terminal state. A lost response is ambiguous and is reconciled from durable
events; it is never blindly replayed.

### Main and child message semantics

- A follow-up while a turn is running is queued in FIFO order and injected at
  the next Eve model-step boundary. It does not cancel the current provider
  call or branch the conversation.
- A waiting session starts one ordinary next turn.
- Edit-last-message remains deliberately constrained to the latest user
  message. It must use a server operation that removes the old turn projection
  at a durable boundary and resubmits one replacement with a new operation ID;
  it must not rely on local array truncation or sandbox snapshots.
- Root and child sessions expose identical send, append, edit, cancel, retry,
  approval, and ask APIs. Authorization prevents a user from crossing a
  parent/child tenant boundary.

### P0 acceptance

- Refreshing a running root or child session loads history immediately and
  resumes only from the stored cursor.
- Closing the tab, losing SSE, restarting the mailbox worker, or receiving a
  late provider event does not duplicate a message or leave a permanently
  blocked queue.
- An approval accepted before refresh remains completed and cannot reappear as
  an enabled request.
- A failed turn is attributed to the exact turn interval that failed, with a
  recoverable retry or edit action attached to that message.

## P1: Codex-style agent supervisor

The neutral child-session records, nickname projection, URL navigation, and
shared Composer path are implemented. The Muses host E2E still needs real
Workspace/Project/Canvas identifiers and a configured Host JWT/Provider broker;
those values cannot be fabricated in this repository.

Eve supplies durable child sessions but not the full Codex control plane. Add a
neutral Supervisor service and records:

```text
agent_threads
agent_children
agent_operations
agent_mailbox_items
```

Each child stores parent/root thread, child session, nickname, role, status,
current turn, sandbox identity, lifecycle state, timestamps, and usage.

### Public operations

Expose typed operations equivalent to:

- `spawn_agent`
- `send_input`
- `resume_agent`
- `wait_agent`
- `interrupt_agent`
- `close_agent`
- `list_children`

The parent model may wait for a child or continue without waiting. A child has
its own durable conversation and Composer, and the user can open it by stable
thread/session URL. `send_input` uses the same mailbox and safe-boundary rules
as user steering; it is not a browser-only event.

Enforce tenant-scoped concurrency, maximum depth, maximum fan-out, execution
budget, and a lifecycle lease. Parent cancellation recursively interrupts
children, while close/archive is an explicit idempotent operation. A child
that is already completed must not be shown as running because a parent event
arrived late.

### P1 acceptance

- A child has a nickname, independent URL, history hydration, live reconnect,
  send/append/edit, approval, and cancellation behavior identical to root.
- The parent can observe `spawned`, `running`, `waiting`, `completed`,
  `failed`, `interrupted`, and `closed` from durable status records.
- A parent can choose wait or no-wait, and a worker restart does not orphan a
  child timer or lose its result.
- Depth/fan-out/active-turn limits fail with typed errors before consuming
  provider or sandbox capacity.

## P1: tool execution and incremental presentation

The model-facing tool contract remains small and neutral. The UI may render
known tools with custom components; unknown tools use the generic assistant-ui
fallback.

### File changes

Keep one Codex-style `apply_patch` model primitive with Add, Update, Delete,
optional move, and status transitions. Internally normalize the patch into
file-change events. The UI labels the semantic operation as create, edit, or
delete and streams a diff; do not create three divergent model tools.

### Incremental events

Aggregate partial events by `toolCallId` and replace the projected value rather
than appending duplicate JSON. At minimum support:

- patch paths, hunk text, added/deleted line counts, and status;
- terminal command, live output tail, exit status, and duration;
- todo/queue items as a read-only plan;
- `view_image` asset metadata and preview;
- final `action.result` that freezes the component.

Use one `tool-fallback` for a single invocation. Use a group only when the
runtime actually runs a parallel set. Tool headers are borderless and known
tools do not expose raw `ToolInput`/`ToolOutput` JSON as their primary view.

### Error and retry attribution

Provider retry, tool failure, approval pause, and terminal failure are events in
the turn interval that produced them. The UI must never add a generic retry
message to the next user turn or show a fake reasoning timer. Eve remains the
owner of provider retry; the client reports observed waiting/reconnect state
without claiming an unobserved attempt.

## P1: approvals, ask, and composer control

Persist every input request with request ID, child/root session, turn, status,
selection, and resolution time. The current browser-only closed-ID set is not
authoritative.

The active unresolved approval temporarily takes over the Composer, matching
Codex's interaction: details are collapsed by default, the title identifies the
operation in Chinese/localized copy, and explicit `拒绝`/`批准` actions resolve
one queued request at a time. After resolution the historical message is a
disabled summary. Ask requests use the same lifecycle storage but retain their
question-specific UI.

Appending a message while approvals are pending must create one mailbox item,
not one duplicate per approval component. Approval queues are server ordered
and are restored after refresh.

## P1: assistant-ui reference experience

The default web client follows assistant-ui primitives and Codex's quiet visual
hierarchy. This is a reusable reference implementation, not a requirement that
hosts use React.

- Use `ThreadList`, `Thread`, `Composer`, `Message`, `ActionBar`,
  `ContextDisplay`, `ModelSelector`, `ToolFallback`, `ToolGroup`,
  `ApprovalCard`, `Queue`, `Attachment`, `MessageScroller`, and
  `DiffViewer` where their semantics apply.
- Keep reasoning collapsed and borderless. Show “正在思考” until real
  reasoning arrives; then update the summary and elapsed time from observed
  timestamps. Do not render a permanent “Reasoning” placeholder.
- Use one send/stop control, correct focus and keyboard behavior, a clearly
  selected thread row, and an automatic scroll policy that respects a user's
  intentional upward scroll.
- Markdown, code, math, and CJK rendering must be covered by visual tests.
- Action bars appear only in the correct terminal context: last user message
  can edit, completed Agent delivery can copy, and in-progress turns expose
  neither misleading copy nor retry.

### Two-column secondary view

After the control plane is stable, add a resizable secondary pane with its own
header and tabs:

1. home: child-agent list and session-asset cards;
2. child list: status, nickname, role, elapsed time, and open action;
3. asset list: files, images, websites, and media with owner/status;
4. content: child conversation or asset preview/download.

Web previews use an authenticated `WebPreview` surface and a bounded static
preview contract. Text/Markdown can render; source archives and complex files
download instead of growing a full IDE. `artifact-card` is a result projection
that opens the corresponding asset tab.

Mobile uses a sheet/drawer for the secondary pane and keeps the root Composer
visible; tabs must not shrink the primary conversation below a usable width.

## P1: uploads and vision

Implement the contract in [Assets, Uploads, And Vision](./assets-and-vision.md):

- object-store multipart/resumable uploads with a 100 MiB baseline;
- asset references in messages, quota and ownership checks;
- read-only session-scoped sandbox mounts;
- Codex-style `view_image` with bounded model-facing conversion;
- assistant-ui Attachment cards in composer, user message, and tool output.

This milestone is complete only when a user can upload a 100 MiB image or
archive, refresh, have the Agent use the mounted path, and inspect an image with
the vision model without loading the full file into Node, Postgres, or an Eve
event.

## P2: host integration and production capacity

### Host integration

Muses supplies adapters for model registry/credentials, object storage, canvas
capabilities, billing, and tenant quotas. Open Agent consumes snapshots and
interfaces; it does not import Muses admin tables or decide which provider key
is valid. A different host can replace each adapter.

### Resource admission

Separate these limits:

- online SSE/WebSocket connections;
- active model turns;
- active child turns and fan-out;
- active sandboxes and mounted bytes;
- concurrent multipart uploads;
- provider/tool concurrency;
- tenant byte, token, and credit quota.

Add worker leases, sandbox admission queues, backpressure, database indexes and
TTL jobs, stream/event fan-out, object-store lifecycle rules, and cold session
recovery. A single server cannot run ten thousand trusted 2 vCPU sandboxes; the
system must make that constraint explicit instead of accepting unbounded work.

The current self-hosted runtime now has a PostgreSQL-backed AgentRun admission
gate (`AGENT_MAX_ACTIVE_RUNS_TOTAL` and
`AGENT_MAX_ACTIVE_RUNS_PER_TENANT`). It serializes only the short reservation
transaction, preserves idempotent replays, and returns a typed `429` with a
retry hint when capacity is exhausted. This is the first safety boundary; a
future distributed scheduler should move queued work behind the same contract
instead of removing the gate or adding process-local semaphores.

The Agent PostgreSQL pool now has bounded connection checkout and idle-client
timeouts (`AGENT_DATABASE_CONNECTION_TIMEOUT_MS` and
`AGENT_DATABASE_IDLE_TIMEOUT_MS`). The active-run query is backed by partial
indexes on status and tenant, so admission remains cheap as terminal history
grows. `npm run doctor:host` provides read-only host/cgroup/Docker evidence and
fails closed for low free disk or memory before a load test starts.

Sandbox allocation remains lazy per durable session. Docker compute is stopped
after a durable idle boundary and reattached to the preserved `/workspace` on
the next sandbox call. Physical deletion is never inferred from a terminal
AgentRun; it requires the owner-authorized session-deletion tombstone. The host
doctor reports both running and stopped sandbox inventory because stopped
containers release CPU/RAM but retain disk and inode cost.

The run reconciler closes only stale pre-Eve reservations as
`submission-ambiguous`; it never resets an active Eve session or blindly
replays uncertain work. This prevents a process crash during admission from
permanently consuming the active-run gate.

### Capacity and chaos gates

The release test matrix includes:

1. 1k/5k/10k idle streams;
2. 100/500/1000 active turns with slow providers;
3. child fan-out and depth-limit pressure;
4. concurrent 100 MiB+ multipart uploads and interrupted parts;
5. stream disconnect/reconnect and browser refresh;
6. provider timeout, rate limit, malformed stream, and retry exhaustion;
7. mailbox worker crash between admission and commit;
8. Postgres/object-store latency and partial outages;
9. sandbox admission, reaping, and cross-tenant isolation.

Collect CPU, memory, event-loop lag, database pool usage, queue age, provider
latency/error rate, object-store throughput, active sandboxes, mount bytes,
reconnect count, and SLO/error-budget data. Keep prompts and sensitive outputs
out of telemetry.

## Delivery order

The dependency order is intentionally strict:

1. P0 session controller, durable state machine, and approval persistence;
2. P1 supervisor and child-session parity;
3. P1 typed tool deltas and error attribution;
4. P1 object-store AssetStore, 100 MiB upload, sandbox mount, and `view_image`;
5. P1 assistant-ui visual conformance and attachment surfaces;
6. P2 secondary pane, asset tabs, and website/file previews;
7. P2 host adapters, quotas, chaos tests, and capacity report;
8. deployed production conformance on the selected sandbox, database, provider,
   and object-store topology.

UI polish may proceed alongside contract work only when it does not change the
wire protocol. No feature is promoted to Muses or advertised as production
ready until its corresponding durable and failure tests pass.

## Release decision

Open Agent is ready for a public production release only after the P0/P1
acceptance gates, physical sandbox isolation, object-store and provider failure
evidence, deployed observability, quota/billing reconciliation, package
conformance, and cross-host Muses integration have all passed. The current
honest status is: **local production regression green; external deployment
gates pending**. The service is no longer a UI-only prototype, but it must not
be advertised as fully Codex-equivalent until those external gates are run.
