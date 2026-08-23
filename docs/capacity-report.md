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
| 2 simple live AgentRuns, concurrency 1 | Pass for host admission/error gate | 0 errors, admission p95 102ms, Provider completion p95 57.4s; this is an upstream/route latency observation, not a host saturation result |
| 4 simple live AgentRuns, concurrency 2 | Host gate pass; Provider latency observation | 0 errors, admission p95 192ms, completion p95 28.9s in the earlier 20s budget run; the capacity runner now uses a 60s observation budget and records resource/event-loop metrics separately |
| 100 MiB multipart upload | Pass | 1 upload, 38.72 MiB/s, ownership isolation passed |

The AgentRun result is not classified as a server saturation limit: the run
was error-free and the latency includes the live Provider. It does mean the
current deployment does not meet the configured 20-second completion SLO even
at this tiny active workload.

## Current capacity conclusion

The only measured stable level currently suitable for an external capacity
claim is **100 idle SSE connections**. Two real Provider AgentRuns at
concurrency 1 completed without errors, but their p95 was 57.4 seconds; that
is an upstream latency signal, not proof of a server concurrency limit. The
maximum stable level for active Agent turns or sandboxes is therefore **not
yet established**. Ten thousand or one hundred thousand users cannot be
claimed from this evidence.

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

The next capacity run must use a disk-safe isolated database and report at
least 1k/5k/10k idle streams plus controlled 10/25/50/100 active turns. Real
Provider latency, Provider quota, Workflow queue age, database pool wait,
sandbox allocation, CPU, RSS, event-loop lag, and reconnect rate must be
recorded separately.

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
