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
| 4 simple live AgentRuns, concurrency 2 | SLO fail | 0 errors, admission p95 192ms, completion p95 28.9s vs 20s budget |
| 100 MiB multipart upload | Pass | 1 upload, 38.72 MiB/s, ownership isolation passed |

The AgentRun result is not classified as a server saturation limit: the run
was error-free and the latency includes the live Provider. It does mean the
current deployment does not meet the configured 20-second completion SLO even
at this tiny active workload.

## Current capacity conclusion

The only measured stable level is **100 idle SSE connections**. The maximum
stable level for online users, active Agent turns, or sandboxes is **not yet
established**. Ten thousand or one hundred thousand users cannot be claimed
from this evidence.

The next capacity run must use a disk-safe isolated database and report at
least 1k/5k/10k idle streams plus controlled 10/25/50/100 active turns. Real
Provider latency, Provider quota, Workflow queue age, database pool wait,
sandbox allocation, CPU, RSS, event-loop lag, and reconnect rate must be
recorded separately.

## Storage finding

The local Workflow database currently contains roughly 634 MiB. The
`workflow_stream_chunks` table accounts for roughly 532 MiB across 88 runs;
individual runs have reached approximately 153 MiB and 82 MiB. The Postgres
World package documents no general workflow-run cleanup. `npm run reap:workflow`
now provides a default dry-run report and an explicitly confirmed cleanup path,
but it must be reviewed with a backup and a verified session/archive policy
before deletion is enabled in production.
