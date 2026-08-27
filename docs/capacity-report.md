# Single-server capacity report

This is a measured baseline for the current preview topology. It is not a
promise of public capacity and it does not equate idle browser users with
simultaneous Agent execution.

## Test environment

- 4 vCPU, 7.3 GiB RAM, no swap
- Node 24.19.0
- Next Web + Eve Runtime + mailbox/cleanup workers on one host
- PostgreSQL World and Agent database on local containers
- Workflow pool 22, Workflow workers 20, Agent database pool 10
- The guarded 2026-08-26 run started with about 2.9 GiB free disk (the
  configured minimum is 2 GiB). This is enough for the test but still a narrow
  margin for long-term production storage.

## Evidence

| Workload | Result | Measured values |
| --- | --- | --- |
| 100 idle SSE streams | Pass | 0 errors, 0 unexpected disconnects, handshake p95 250ms |
| 250 pooled idle SSE followers | Pass | 250/250 established, 0 unexpected disconnects, handshake p95 237ms |
| 500 idle SSE streams through the legacy Next proxy | Fail (superseded) | 500 established, handshake p95 29.8s, 256 unexpected disconnects during hold; the fixed 256-socket upstream agent was the cause |
| 1,000 idle SSE streams through the legacy Next proxy | Fail (superseded) | 1,000 established, handshake p95 29.8s, 768 unexpected disconnects during hold; the fixed 256-socket upstream agent was the cause |
| 500 pooled SSE followers through the dedicated gateway | Pass | 500/500 established, 0 errors, 0 unexpected disconnects, handshake p95 261ms |
| 1,000 pooled SSE followers through the dedicated gateway | Pass | 1,000/1,000 established in 1.88s, 0 errors, 0 unexpected disconnects, handshake p95 402ms; sampled gateway RSS peaked at 160 MiB and Eve RSS at 389 MiB |
| 2 simple live AgentRuns, concurrency 1 | Pass for host admission/error gate | 0 errors, admission p95 102ms, Provider completion p95 57.4s; this is an upstream/route latency observation, not a host saturation result |
| 4 simple live AgentRuns, concurrency 2 | Host gate pass; Provider latency observation | 0 errors, admission p95 192ms, completion p95 28.9s in the earlier 20s budget run; the capacity runner now uses a 60s observation budget and records resource/event-loop metrics separately |
| 4 live AgentRuns, concurrency 4 | Pass | 0 errors, admission p95 198ms, completion p95 165.0s, event-loop p95 20.5ms |
| 8 live AgentRuns, concurrency 8 | Pass | 0 errors, admission p95 319ms, completion p95 104.7s, event-loop p95 20.6ms |
| 12 live AgentRuns, concurrency 12 | Pass | 0 errors, admission p95 638ms, completion p95 10.5s, event-loop p95 30.9ms |
| 16 live AgentRuns, concurrency 16 | Fail | 1/16 failed during inspection/settlement (502), error rate 6.25%; successful admission p95 1.05s, completion p95 14.3s |
| 20 idle streams + 2 live AgentRuns (mixed smoke) | Pass | 0 errors, stream handshake p95 52ms, AgentRun completion p95 4.7s |
| 20 idle streams + 2 live AgentRuns (mixed smoke with target metrics) | Pass | 0 errors, stream handshake p95 83ms, AgentRun completion p95 6.4s, target Web RSS 230->258MiB, event-loop p95 <=21ms, Agent DB pool wait 0 |
| 100 MiB multipart upload | Pass | 1 upload, 38.72 MiB/s, ownership isolation passed |

The current production process was rechecked on 2026-08-27 with a disk-safe
smoke campaign. One hundred independent durable-session SSE followers passed
with 0 errors and 0 unexpected disconnects (handshake p95 156ms); one live
AgentRun passed in 3.25s, and a mixed 20-stream/1-run envelope also passed.
All synthetic Eve sessions were reset and removed by the verifier. These
results confirm the current deployment path, but remain operating points rather
than a maximum-capacity claim.

The public preview now terminates traffic in a dedicated loopback-only gateway
instead of asking Next's compiled rewrite proxy to carry Eve streams. The
legacy proxy instantiated a fixed `maxSockets: 256` HTTP agent and applied a
30-second proxy timeout. That combination explains the wave-shaped 256/768
disconnect counts and roughly 30-second handshakes at 500/1,000 followers.
After the routing change, pooled 500- and 1,000-follower gates both passed. The
1,000-follower sample used one durable Eve session to isolate network/stream
fan-out from Provider and session-creation load. Sampled gateway RSS rose from
about 131 MiB to 160 MiB, Eve RSS from about 250 MiB to 389 MiB, and Next
remained near 224 MiB. Peak one-second CPU samples were 32% for the gateway and
127% for Eve on the four-vCPU host. These are useful stream-server
measurements, but are not distinct-session or distinct-user evidence.

The AgentRun result is not classified as a server saturation limit: the run
was error-free and the latency includes the live Provider. It does mean the
current deployment does not meet the configured 20-second completion SLO even
at this tiny active workload.

## Current capacity conclusion

The current single-server evidence supports these **verified operating levels**:

- **1,000 concurrent pooled SSE follower connections**, with all connections
  established and held for five seconds and zero unexpected disconnects. This
  is connection/fan-out evidence over one durable session, not proof of 1,000
  distinct online users. The separate disk-safe campaign verified **100
  distinct durable sessions**; a larger one-session-per-connection campaign is
  still required before increasing the distinct-session planning number.
- **12 concurrently executing AgentRuns**, with 0% measured errors in the
  controlled run. At 16, one run failed inspection/settlement (6.25% error),
  so production admission should remain at or below 12 until the Provider,
  Workflow, and database pools are isolated and retested.

These figures are measured separately. They do **not** mean that 1,000 users can
all run Agent tasks at once. A user with an idle open session consumes an SSE
connection; an executing task additionally consumes workflow/database capacity,
Provider quota/latency, and usually a sandbox. The maximum stable mixed workload
has not yet been established. Ten thousand or one hundred thousand users cannot
be claimed from this evidence.

The capacity runner now starts AgentRun levels at 1 and records load-generator
RSS, heap, and event-loop delay. These client-side values are diagnostic only;
they are not target-server capacity evidence. A deployment capacity run must
collect Web/Eve/worker RSS and event-loop lag, database-pool wait, Workflow
queue age, sandbox count, and reconnect/error rates from the target host. It
treats admission latency and error rate as the local gate; Provider completion
latency remains a separately reported SLO. This separation prevents a slow
model response from being “fixed” by arbitrary event or payload limits and
prevents a passing Provider call from being mistaken for a saturated host.

The runner performs a filesystem preflight and refuses to start load when free
space is below `AGENT_CAPACITY_MIN_FREE_DISK_BYTES` (2 GiB by default). This is
a safety stop, not a data-retention policy: it does not delete or rewrite
Workflow history.

It also requires `AGENT_HOST_JWT_SECRET`, `AGENT_HOST_JWT_ISSUER`, and
`AGENT_HOST_JWT_AUDIENCE` before launching any child load generator. Missing
credentials produce a failed preflight evidence record without opening a single
stream or AgentRun.

Use `npm run doctor:host` for the broader host preflight. It reports effective
CPU and cgroup limits, available memory, swap, Docker reachability, and disk
without changing the host. The default gate requires 2 GiB free disk and 512
MiB available memory; these are safety margins, not capacity claims. It also
reports running and stopped Eve session sandboxes. Optional
`AGENT_HOST_MAX_DOCKER_SANDBOX_CONTAINERS` and
`AGENT_HOST_MAX_RUNNING_DOCKER_SANDBOXES` thresholds turn unexpected workspace
or compute growth into a failed preflight instead of silently consuming the
host.

Docker sandboxes are lazy and idle compute is stopped after
`AGENT_DOCKER_IDLE_TIMEOUT_MS`; stopped containers retain `/workspace` and still
consume disk/inodes. Long-lived sessions therefore do not imply permanently
running compute, but they still require an explicit storage budget and
user-authorized deletion lifecycle. Microsandbox or a remote microVM service is
the production recommendation for mutually untrusted tenants and elastic
compute; changing backends does not remove Provider, Workflow, database, or
object-store bottlenecks.

The lazy-allocation boundary was rechecked against the live production build:
two no-tool seed sessions completed and were retired while the Eve session
container inventory remained at 960 stopped containers and zero running
containers. This proves text-only conversations no longer allocate Docker
workspaces. The historical stopped inventory was not deleted because it
contains user-owned durable workspaces without explicit retirement evidence.

The next capacity run must use a disk-safe isolated database and report at
least 100/250/500/1k/5k/10k idle streams, controlled 4/8/12/16/25/50/100 active
turns, and explicit mixed envelopes. Distinct-user evidence requires one
durable session per stream; pooled follower tests remain useful but must be
reported only as connection fan-out. Real
Provider latency, Provider quota, Workflow queue age, database pool wait,
sandbox allocation, CPU, RSS, event-loop lag, and reconnect rate must be
recorded separately. Until that run is completed, use 1,000 pooled follower
connections, 100 distinct durable sessions, and 12 active turns as separate
conservative deployment planning numbers, not a single inferred user or
marketing-capacity number.

The capacity matrix now also exercises online and active workloads at the same
time through `verify:mixed-capacity`: it runs the idle stream and AgentRun
verifiers concurrently and records both child reports plus target metrics
throughout the window. A 20-stream/2-run smoke envelope now passes with
target metrics enabled; this is still only a protocol smoke result, not a large
mixed-workload capacity claim. The Workflow streamer may log Node's
`MaxListenersExceededWarning` when more than ten followers intentionally attach
to one stream; this is a warning threshold, not evidence of a leak. The
streamer patch removes listeners on EOF, errors, and cancellation, and should be
monitored under repeated same-stream follower tests.

The AgentRun verifier retires every synthetic Eve session it creates after the
measurement (and records attempted, retired, and failed cleanup counts in the
evidence). This keeps capacity runs from leaving resumable Workflow roots that
would otherwise be re-enqueued on the next runtime restart. Historical user
sessions and Muses host sessions are never selected by that cleanup path.

## Storage finding

The 2026-08-27 read-only audit confirms that the local Workflow database is
storage-heavy: roughly 657 MiB of relation storage, with
`workflow_stream_chunks` at about 540 MiB and 987 MiB of uncompressed payload
across 64,093 chunks. The snapshot contains 753 runs, of which 80 are still
`running` (40 retained session roots and their 40 active child/turn records);
these are historical
user or Muses-host sessions and are not safe to infer as abandoned from age
alone. Earlier capacity runs left additional synthetic roots; the verifier now
retires those through Eve's reset lifecycle, and the cleanup was confirmed with
zero `LOAD_READY` roots remaining. `npm run reap:workflow` is now strictly
read-only and reports candidates as complete root trees. Direct SQL deletion is
not a production reconciliation strategy; no hot-history purge is authorized
until a versioned archive and isolated restore/replay drill exist.

At the same audit point the host had about 1.34 GiB free disk, below the
capacity runner's 2 GiB default safety margin. The v2 preflight correctly
refused to start a new matrix. Run the next capacity campaign on an isolated
database volume with enough headroom; lowering the margin on this host would
turn the load generator into a production-data availability risk.
