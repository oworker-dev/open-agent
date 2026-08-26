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
- Only about 1.3 GiB free disk during the run; this is below a production
  operating threshold and invalidates any claim of long-term storage capacity.

## Evidence

| Workload | Result | Measured values |
| --- | --- | --- |
| 100 idle SSE streams | Pass | 0 errors, 0 unexpected disconnects, handshake p95 185ms |
| 500 idle SSE streams across 32 durable sessions | Pass | 500/500 HTTP 200, all handshakes established in 30.7s, held 10s |
| 257 idle SSE streams on one durable session | Fail by test design | 256 established; the 257th timed out. This is a per-session fan-out boundary, not a server-wide user limit |
| 2 simple live AgentRuns, concurrency 1 | Pass for host admission/error gate | 0 errors, admission p95 102ms, Provider completion p95 57.4s; this is an upstream/route latency observation, not a host saturation result |
| 4 simple live AgentRuns, concurrency 2 | Host gate pass; Provider latency observation | 0 errors, admission p95 192ms, completion p95 28.9s in the earlier 20s budget run; the capacity runner now uses a 60s observation budget and records resource/event-loop metrics separately |
| 4 live AgentRuns, concurrency 4 | Pass | 0 errors, admission p95 198ms, completion p95 165.0s, event-loop p95 20.5ms |
| 8 live AgentRuns, concurrency 8 | Pass | 0 errors, admission p95 319ms, completion p95 104.7s, event-loop p95 20.6ms |
| 16 live AgentRuns, concurrency 16 | Pass | 0 errors, admission p95 665ms, completion p95 132.0s, event-loop p95 20.7ms |
| 32 live AgentRuns, concurrency 32 | Fail | 16/32 failed during inspection/settlement (502 or timeout), error rate 50%; event-loop p95 20.6ms |
| 100 MiB multipart upload | Pass | 1 upload, 38.72 MiB/s, ownership isolation passed |

The AgentRun result is not classified as a server saturation limit: the run
was error-free and the latency includes the live Provider. It does mean the
current deployment does not meet the configured 20-second completion SLO even
at this tiny active workload.

## Current capacity conclusion

The current single-server evidence supports these **verified operating levels**:

- **500 concurrently connected online sessions** (one SSE stream per user),
  with all connections established and held for 10 seconds. This is a lower
  bound for this topology, not a proven maximum; a 1,000-connection attempt
  did not produce complete, trustworthy evidence and is not claimed.
- **16 concurrently executing AgentRuns**, with 0% measured errors in the
  controlled run. At 32, the error rate was 50%, so the production admission
  ceiling should remain below 32 until the database, sandbox, and Provider
  pools are isolated and retested.

These figures are measured separately. They do **not** mean that 500 users can
all run Agent tasks at once. A user with an idle open session consumes an SSE
connection; an executing task additionally consumes workflow/database capacity,
Provider quota/latency, and usually a sandbox. The maximum stable mixed workload
has not yet been established. Ten thousand or one hundred thousand users cannot
be claimed from this evidence.

The capacity runner now starts AgentRun levels at 1 and records RSS, heap, and
event-loop delay. It treats admission latency, error rate, throughput, and
resource ceilings as the host gate; Provider completion latency remains a
separate reported SLO. This separation prevents a slow model response from
being “fixed” by arbitrary event or payload limits and prevents a passing
Provider call from being mistaken for a saturated host.

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
recorded separately. Until that run is completed, use 500 online connections
and 16 active turns as conservative deployment planning numbers, not marketing
capacity.

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
