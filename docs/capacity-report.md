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
| 250 idle SSE streams across an independent durable-session pool | Pass | 250/250 established, 0 unexpected disconnects, handshake p95 237ms |
| 500 idle SSE streams across an independent durable-session pool | Fail | 500 established, handshake p95 29.8s, 256 unexpected disconnects during hold |
| 1,000 idle SSE streams across an independent durable-session pool | Fail | 1,000 established, handshake p95 29.8s, 768 unexpected disconnects during hold |
| 2 simple live AgentRuns, concurrency 1 | Pass for host admission/error gate | 0 errors, admission p95 102ms, Provider completion p95 57.4s; this is an upstream/route latency observation, not a host saturation result |
| 4 simple live AgentRuns, concurrency 2 | Host gate pass; Provider latency observation | 0 errors, admission p95 192ms, completion p95 28.9s in the earlier 20s budget run; the capacity runner now uses a 60s observation budget and records resource/event-loop metrics separately |
| 4 live AgentRuns, concurrency 4 | Pass | 0 errors, admission p95 198ms, completion p95 165.0s, event-loop p95 20.5ms |
| 8 live AgentRuns, concurrency 8 | Pass | 0 errors, admission p95 319ms, completion p95 104.7s, event-loop p95 20.6ms |
| 12 live AgentRuns, concurrency 12 | Pass | 0 errors, admission p95 638ms, completion p95 10.5s, event-loop p95 30.9ms |
| 16 live AgentRuns, concurrency 16 | Fail | 1/16 failed during inspection/settlement (502), error rate 6.25%; successful admission p95 1.05s, completion p95 14.3s |
| 20 idle streams + 2 live AgentRuns (mixed smoke) | Pass | 0 errors, stream handshake p95 52ms, AgentRun completion p95 4.7s |
| 100 MiB multipart upload | Pass | 1 upload, 38.72 MiB/s, ownership isolation passed |

The AgentRun result is not classified as a server saturation limit: the run
was error-free and the latency includes the live Provider. It does mean the
current deployment does not meet the configured 20-second completion SLO even
at this tiny active workload.

## Current capacity conclusion

The current single-server evidence supports these **verified operating levels**:

- **250 concurrently connected online sessions** (one SSE stream per user),
  with all connections established and held for five seconds and zero
  unexpected disconnects. The 500-stream attempt failed its stability SLO, so
  250 is the current verified lower bound for this exact host/topology.
- **12 concurrently executing AgentRuns**, with 0% measured errors in the
  controlled run. At 16, one run failed inspection/settlement (6.25% error),
  so production admission should remain at or below 12 until the Provider,
  Workflow, and database pools are isolated and retested.

These figures are measured separately. They do **not** mean that 500 users can
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

Use `npm run doctor:host` for the broader host preflight. It reports effective
CPU and cgroup limits, available memory, swap, Docker reachability, and disk
without changing the host. The default gate requires 2 GiB free disk and 512
MiB available memory; these are safety margins, not capacity claims.

The next capacity run must use a disk-safe isolated database and report at
least 1k/5k/10k idle streams plus controlled 10/25/50/100 active turns. Real
Provider latency, Provider quota, Workflow queue age, database pool wait,
sandbox allocation, CPU, RSS, event-loop lag, and reconnect rate must be
recorded separately. Until that run is completed, use 250 online connections
and 12 active turns as conservative deployment planning numbers, not marketing
capacity.

The sequential matrix does not exercise online and active workloads at the same
time. Use `npm run verify:mixed-capacity` for that envelope: it runs the idle
stream and AgentRun verifiers concurrently and records both child reports plus
before/after target metrics. No mixed-workload result has been measured for this
The mixed verifier has now been exercised with a 20-stream/2-run smoke
envelope. This is only a protocol smoke result; no large mixed-workload
capacity claim is made until target metrics are configured and a clean host run
completes.

## Storage finding

The local Workflow database currently contains roughly 634 MiB. The
`workflow_stream_chunks` table currently reports roughly 532 MiB of relation
storage (about 979 MiB of uncompressed chunk payload across 56k chunks). The
Workflow World has 276 scanned runs, including 132 `running` rows from the
long-running local test history; the latest retention dry-run protected 81
active roots and selected zero deletions. Those active rows must be reconciled
through the Eve lifecycle and an archived-session policy before cleanup; direct
SQL deletion is not a valid production fix. The Postgres World package
documents no general workflow-run cleanup. `npm run reap:workflow` provides a
default dry-run report and an explicitly confirmed terminal-run cleanup path,
but it must be reviewed with a backup and a verified session/archive policy
before deletion is enabled in production.
