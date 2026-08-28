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
| 20 pooled streams + 1 live AgentRun after resource hardening | Pass | 20/20 streams, 0 unexpected disconnects, handshake p95 72ms; 1/1 run, admission 211ms, completion 3.73s; target RSS peaked at 238.45 MiB, event-loop sample max 26.1ms, Agent DB pool wait 0 |
| 100 MiB multipart upload | Pass | 1 upload, 38.72 MiB/s, ownership isolation passed |

The current production process was rechecked on 2026-08-27 with a disk-safe
smoke campaign. One hundred independent durable-session SSE followers passed
with 0 errors and 0 unexpected disconnects (handshake p95 156ms); one live
AgentRun passed in 3.25s, and a mixed 20-stream/1-run envelope also passed.
All synthetic Eve sessions were reset and removed by the verifier. These
results confirm the current deployment path, but remain operating points rather
than a maximum-capacity claim.

After the sandbox-admission, publication-storage, and client-projection changes,
a second disk-gated mixed smoke passed on 2026-08-27. It used 20 concurrent SSE
followers over one synthetic durable session plus one live AgentRun, collected
target metrics for the whole 24.5-second window, and retired both synthetic
sessions through Eve reset. This is deployment-regression evidence only: the
shared stream session deliberately minimizes durable writes and does not raise
the distinct-session or active-run planning numbers below.

After the accepted-session recovery hardening, a disk-safe post-hardening
regression ran on 2026-08-28. It passed 20 pooled SSE followers (0 errors, 0
unexpected disconnects, handshake p95 80 ms), one live AgentRun (0 errors,
completion 3.02 s), and a concurrent 20-stream/1-run envelope (0 errors,
stream handshake p95 51 ms, AgentRun completion 4.47 s). The run started with
2,164,293,632 bytes free and stopped after this small envelope by policy; it is
protocol/regression evidence only and does not increase the distinct-session,
active-turn, or maximum-capacity claims below.

On 2026-08-28, a completed two-run Workflow root was exported as a v2 archive
(92 records, SHA-256
`ba294db2891b02453952e01a067194c7b4f57d098785eec644e708ae836a70d8`). The
archive was validated, restored transactionally into a separately migrated
PostgreSQL database, and opened by a temporary Eve process. The restored
session returned its durable tail index (38) and the expected session/turn/
message events. This proves the local archive restore/replay path; an external
deployment drill with the exact production image and credentials is still
required before any hot-history deletion policy is approved.

After the 2026-08-28 production-preview restart, the stream-recovery gate was
rerun against the rebuilt Eve gateway. It observed 49 canonical events, forced
two client disconnects at cursor 4, recovered the remaining 45 events with one
reconnect, matched the complete stable-event-id sequence, and retired the
synthetic sandbox. A same-build 100-session distinct-stream run then established
100/100 connections with p95 handshake 289 ms, zero seed failures, zero
unexpected disconnects, and zero cleanup failures; all 100 synthetic sessions
were retired. These are regression and conservative operating-point results,
not a maximum-capacity claim.

After the `906fab8` database-timeout hardening and production-preview restart,
the recovery gate was rerun on 2026-08-28. It observed 48 canonical events,
forced two disconnects at cursor 4, recovered the remaining 44 events with one
reconnect, matched the complete stable-event-id sequence, and retired its
temporary sandbox. A 20-follower pooled stream smoke on the same build
established all 20 connections with a 64 ms p95 handshake and zero unexpected
disconnects; the single seeded session was reset and removed. The full capacity
matrix was intentionally refused by its 2 GiB free-disk preflight (1.54 GiB
available), so no large load was started against the shared Workflow database.

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

Protected target metrics also expose aggregate sandbox admission activity once
the backend has served a sandbox request. These values are process-local
diagnostics, not a second admission controller; they distinguish queued
sandbox demand from database or Provider pressure during a capacity run.

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

Sandboxes are lazy, live handles are admitted through a bounded FIFO gate, and
idle compute is stopped after `AGENT_SANDBOX_IDLE_TIMEOUT_MS`; stopped Docker
containers retain `/workspace` and still consume disk/inodes. The real Docker
gate verified a one-session live limit, FIFO admission of the next session,
permit release after idle shutdown, same-session workspace restoration,
cross-session isolation, and deny-all egress. Long-lived sessions therefore do
not imply permanently running compute, but they still require an explicit
storage budget and user-authorized deletion lifecycle. Microsandbox or a remote microVM service is
the production recommendation for mutually untrusted tenants and elastic
compute; changing backends does not remove Provider, Workflow, database, or
object-store bottlenecks.

The deterministic Provider failure gate now includes two sequential sessions
that each execute a real Docker `bash` call while the sandbox admission limit is
one. Resetting the first session closes only its own process-wide tracked
handle, releases the permit, and lets the second session proceed. Same-session
reattachment reuses one live backend handle, including concurrent first access,
so an idle-timer handoff cannot leak an admission reference. The same gate also
keeps 429, 408, 500, interrupted-stream, and timeout recovery separate from
terminal retry exhaustion; HTTP 524 remains classified as a gateway timeout
rather than a generic server response.

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
mixed-workload capacity claim. The Workflow stream fan-out emitter now removes
listeners on EOF, errors, and cancellation and disables Node's generic
ten-listener warning only on that private emitter. Three repeated rounds of 20
same-stream followers returned the listener count to zero after cancellation.
Historical catch-up is keyset-paginated and uses a bounded exact-ID window plus
the exact buffered/history overlap instead of an ever-growing set of delivered
chunk IDs. It never rejects a distinct live chunk based on cross-worker ULID
ordering; a deliberately delayed duplicate outside the bounded window is safer
than losing a valid event and remains identifiable by Eve's stable event ID.

The AgentRun verifier retires every synthetic Eve session it creates after the
measurement (and records attempted, retired, and failed cleanup counts in the
evidence). This keeps capacity runs from leaving resumable Workflow roots that
would otherwise be re-enqueued on the next runtime restart. Historical user
sessions and Muses host sessions are never selected by that cleanup path.

Submission recovery is also session-addressed. If Eve accepts a session while
the database attach response is lost, the run keeps `submitting` admission
state and persists the exact Eve session id. The background reconciler mints a
short-lived host token for that recorded owner, resets that exact session, and
only then marks the reservation `submission-ambiguous`. If runtime credentials
are unavailable, the row remains active and is reported as deferred rather than
being released blindly. This prevents an accepted Eve turn from becoming an
untracked workload after a process restart.

The protected metrics route was checked after the 2026-08-28 rebuild and
reported `workflowRuns.running=83` (oldest active update
`2026-08-17T05:53:54.648Z`) while the product AgentRun table reported one active
run. The Workflow records are durable session roots and child/turn records;
their age alone is not evidence that they are abandoned. The metrics surface
exists to make this backlog visible for owner-scoped reconciliation, while the
retention audit continues to refuse active-root deletion.

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
until the archive is copied to the deployment's durable object store and the
external deployment replay drill has passed.

Publication bytes no longer add new PostgreSQL pressure. Migration `0016`
keeps artifact and website-preview metadata in PostgreSQL but writes their
bytes through the host-replaceable `AssetStore`; legacy inline rows remain
readable. A real PostgreSQL + MinIO + ClamAV gate verified direct transfer,
malware rejection, aggregate quota reservation, externalized publication
objects, ready-object expiry, and stale multipart abortion. This does not
reduce the existing Workflow event history described above.

At the same audit point the host had about 1.34 GiB free disk, below the
capacity runner's 2 GiB default safety margin. The v2 preflight correctly
refused to start a new matrix. Run the next capacity campaign on an isolated
database volume with enough headroom; lowering the margin on this host would
turn the load generator into a production-data availability risk.

## 2026-08-28 production-preview recheck

The rebuilt local production preview passed the following bounded gates without
changing the durable-history policy:

- Stream recovery forced two disconnects at cursor 4, recovered 39 events with
  one reconnect, matched the complete stable-event-id sequence, and retired its
  synthetic session and sandbox.
- One 100 MiB direct multipart upload completed at 34.44 MiB/s with one
  interrupted-part retry. Cross-tenant and cross-principal reads returned 403;
  the object was removed by the verifier.
- The AgentRun API completed a deterministic text result with a live Provider,
  preserved idempotent replay and event cursors, and accepted cancellation.
  Usage is checked as non-negative integer counters because live Provider token
  counts are not deterministic fixture values. Structured-output projection
  remains available as an explicit `AGENT_RUN_TEST_OUTPUT_SCHEMA=1` contract
  check; it is not used as the live-provider capacity smoke because a model may
  legitimately decline a requested schema and return a typed failure.
- The dedicated gateway established 1,000 pooled SSE followers over eight
  durable sessions with zero errors or unexpected disconnects; handshake p95 was
  209 ms and target Web RSS remained about 217 MiB. This is connection fan-out
  evidence, not 1,000-user or distinct-session capacity.

The full 1k/5k/10k stream, active-turn, and mixed capacity matrix remains
blocked by the host's 1.6 GiB free-disk level and is intentionally not run
against this shared Workflow volume. No maximum user count is claimed from the
recheck. The current conservative planning envelope remains 1,000 pooled
connections, 100 distinct sessions, and 12 active AgentRuns, each as a separate
dimension.

## 2026-08-28 post-cleanup verification

The non-destructive host preflight initially refused the capacity matrix with
1.57 GiB free disk. The only space reclaimed in this pass was the rebuildable
local npm cache (about 1.2 GiB); no Workflow rows, user assets, or sandbox
workspaces were removed. The resulting preflight reported 2.79 GiB free disk,
3.0 GiB available memory, four CPUs, no swap, and 975 stopped/zero running Eve
sandbox containers.

On the same `9fd6e6c` production preview, stream recovery observed 40 canonical
events. Two forced disconnects at cursor 4 recovered the remaining 36 events
with one reconnect and an exact stable-event-id sequence match; the synthetic
session and sandbox were reset and removed. The AgentRun API and pinned Docker
sandbox runtime gates also passed.

The real PostgreSQL + MinIO + ClamAV asset gate passed quota reservation,
externalized publication objects, malware rejection, expiry and stale multipart
cleanup. A 100 MiB direct multipart upload completed in 1.415 s (70.66 MiB/s),
with one interrupted-part retry, zero failures, and 403 isolation responses for
both a different tenant and a different principal in the same tenant. The
fixture was removed after verification.

These are regression measurements only. The large capacity matrix remains
intentionally unstarted unless an isolated Workflow database volume provides
adequate disk headroom; the separate planning levels above are unchanged.

The same post-cleanup build also passed a bounded mixed smoke with 20 pooled
SSE followers over four durable sessions and one concurrent AgentRun. All 20
connections established with zero errors or unexpected disconnects (handshake
p95 43 ms); the AgentRun completed without error in 21.9 s and the load
generator event-loop p95 was 20.5 ms. The stream fixtures and AgentRun session
were retired after the run. Provider completion latency is reported separately
and is not treated as a host-saturation measurement.

After the production rebuild, the full capacity runner performed its
filesystem preflight at 1.92 GiB free and correctly started zero load batches.
This fail-closed result is retained as evidence; the 2 GiB threshold was not
lowered and no shared Workflow history was touched.
