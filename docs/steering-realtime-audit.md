# Steering And Realtime Audit (2026-09-11)

## Scope

Fix delayed active-turn follow-ups and disappearing/reordered assistant groups.
Do not cancel a running tool to consume a follow-up. Do not rewrite durable
conversation history to repair a display issue.

## Edit Admission Follow-Up

Keep the existing Thinking placeholder while an edit awaits a definite result.
Do not add an ambiguity banner, automatically resend an uncertain operation,
or change scrolling, message spacing, steering, or the whole-turn checkpoint.

A dispatcher can stop after recording `admission_started_at` but before Eve
receives the request. Its expired lease previously became permanently
`submission-ambiguous`, blocking later mailbox work with no receipt to resolve
it. Blindly failing that row is unsafe: a delayed delivery could still rewind
context after the UI permits another request.

The bounded fix reuses the mailbox row as a consumption guard:

- Only edits admitted by a runtime advertising `editAdmissionGuard: true`
  receive the internal `edit-v1` capability. Client payload fingerprints remain
  unchanged, preserving idempotent replay after this internal annotation.
- Eve's durable inbound adapter checks and commits that row before passing the
  revert to the harness. For guarded edits, this commit means the durable
  consumer owns the input, not that the model has already answered. The UI
  still reconciles the actual user receipt and reply from the event stream.
- The existing mailbox worker cancels unconsumed guarded edits after 120 s.
  Expiration and consumption serialize on the same database row. A cancelled
  delivery returns no input to the harness, so it cannot clear context, emit a
  user receipt, or call the model. Consumed edits remain valid during slow model
  output and durable-step replay. This is not a two-minute model timeout.
- Failure restores the original visible branch and uses the existing failure
  UI. An explicit retry has a new operation id; refresh reuses the persisted id.
  An expired id is never reopened. No table, worker, or frontend timer was added.

Eve 0.31.1 does not publicly support an inbound guard on its reserved HTTP
adapter. The existing pinned patch now permits only a delivery-only adapter
from the canonical `eve` channel, rejecting other behavior and conflicting
guards. It re-exports Eve's own default input projector rather than duplicating
its parsing. Serialized `http` identity is unchanged, so existing sessions
rehydrate through the same guard without history migration. Registry restoration
and normal message/HITL pass-through have regression tests. This is an explicit
Open Agent compatibility patch, not an unmodified upstream Eve feature.

Two browser issues were reproduced and corrected during validation:

- The mounted Eve client's initial `ready` could overwrite an unconsumed edit
  or a partially recovered reply. Check the existing pending receipt and open
  turn before persisting that status, instead of creating another state machine.
- A persisted failed edit could lose its error UI on hydration. Derive the
  existing failure from the persisted admission, not only transient React state.

The obsolete clear-then-resend fixture now uses one addressed revert command,
the exact replaced turn id, and durable mailbox identity. It still checks prior
history, replacement-only display after refresh, and no duplicate dispatch.
The local-stop fixture no longer expects an edit button without a durable
session/checkpoint; its message-preservation assertion remains.

Validation: 628 unit tests passed; the isolated PostgreSQL suite passed all
12 subcases (13 including the parent test); 21 distinct browser regressions
passed. One existing ordinary-send recovery test still fails its persisted
pending-metadata cleanup assertion, as it did before this follow-up. It is
retained, not deleted or relabeled as obsolete. The edited-reply-after-refresh
failure previously listed below is resolved by this follow-up.

Live-runtime probe `wrun_01M26VMX7RDKZN2KNDNKQ2A0WQ` was created before restart.
An expired delivery produced no context clear or user receipt; a subsequent
FIFO message completed; a valid edit committed before its single context clear
and returned `EDIT_GUARD_REPLACEMENT`. The opt-in verifier is
`tests/integration/mailbox-edit-runtime-probe.ts` and refuses sessions not owned
by the verifier principal. A second pass used the ordinary mailbox worker for
the valid edit, confirming capability negotiation and consumption before
revert through the deployed dispatch path. It does not edit user-owned sessions.

Both production artifacts were rebuilt: Eve at 07:48:07 +0800 and Next at
07:55:32 +0800 on 2026-09-11. The restarted gateway serves
`http://43.110.40.25:3100/` (HTTP 200). TypeScript and `git diff --check` passed.
Legacy ambiguous entries without the guard capability are intentionally not
force-expired: their already-delivered commands cannot be fenced retroactively.
They still accept a late authoritative receipt. No historical records were
deleted or automatically rewritten. Disk headroom remains below 1 GB and is a
separate deployment risk, not resolved by this editing fix.

## Follow-Up Safety: Do Not Edit Consumed Steering

The user chose to disable unsupported mid-turn edits, not to add message-level
checkpoints. This follow-up changes edit eligibility and admission only; it does
not change Eve's steering consumption, tool cancellation, or checkpoint format.

Affected thread `thread-1789079789688-5hkv2h6twtm`, session
`wrun_01M26QEAYGHARHTHHXMVRJ820B`, has both the initial prompt and consumed steer
in `turn_0`. Editing the steer submitted a whole-turn edit targeting `turn_0`.
Eve emitted `context.cleared` at 2026-09-10 22:48:36.137 UTC before `turn_1`.
This was a real context rewind, not only a rendering issue. Existing audit
events remain; this fix does not automatically restore or rewrite that history.

Codex reference: `codex-rs/tui/src/app_backtrack.rs`,
`backtrack_fork_before_turn_id`, explicitly rejects a selected mid-turn steer
because it cannot be branched independently. Its regression test is
`backtrack_fork_before_turn_id_rejects_mid_turn_steers`. Open Agent retains its
existing latest-message-only editor, rather than adding Codex's broader
historical prompt selection.

- Edit eligibility requires an identifiable turn start and exactly one user
  receipt in the selected turn. A partial window cannot promote a steer to a
  root prompt. A later independent ordinary turn is still editable.
- The submit handler rechecks authoritative events and the selected visible
  message before staging an edit. The display-id fallback that could resolve
  a steer to its parent turn was removed.
- Pending unsafe edits no longer hide the containing turn optimistically.
- The mailbox rejects new whole-turn edits with HTTP 409 when that turn has
  a pending/admitted/committed steer. It uses existing per-session admission
  records under the session lock, not a full transcript scan or a new table.
  Cancelled/rejected steers do not block the turn. An already stored operation
  still follows the existing idempotent replay contract.
- Rejection happens before inserting a mailbox row, so no failed command is
  left to block subsequent FIFO work. Existing user sessions are not modified.

Validation includes the unit projection/HTTP cases, isolated PostgreSQL tests
covering enqueue rejection, next-request dispatch, replay, and owner isolation,
and browser regressions covering steering before/after reload and ordinary
changed/unchanged edits, including an ordinary turn after a steered turn.

Final results for this safety change: 620 unit tests passed, 8 isolated
PostgreSQL subcases passed, and all 9 focused browser tests passed. TypeScript,
Next production build, and `git diff --check` passed. The multi-turn browser
fixture uses unique durable event ids so its separate waiting boundaries are
not mistaken for exact replays. Desktop/mobile screenshots were inspected.
The 2026-09-11 07:07:59 +0800 frontend/server build is running behind the
restarted public gateway at `http://43.110.40.25:3100/` (HTTP 200). Eve keeps
the existing 05:45 artifact because no Eve runtime changes were needed here.
These scoped checks do not resolve the older unrelated failures listed below.

## Follow-Up Regression: Recovery-Owned Streams

The previous validation did not cover steering while the workspace recovery
reader owns the live stream and the mounted Eve store still has its old seed.
The earlier successful fresh-turn probes therefore did not establish that
steering was fixed across recovery.

Latest reported session: `thread-1789078048740-vcyghhdl5js`,
`wrun_01M26NSFBM93AAB52W4FD339NK`. Its first turn started at
22:07:40.581 UTC. The follow-up client id records submission at 22:07:53.435,
but the mailbox row was created only at 22:11:51.135, after `turn_0` ended at
22:11:50.264. Its operation is `send`, and it started `turn_1`. This was a
real admission delay, not merely delayed rendering of a committed steer.

Three frontend defects are now covered:

- Submission and target resolution inspected `agent.events` even when recovery
  was updating `thread.events`. The Eve store's `initialEvents` are read only
  once. Use the existing authoritative event selection for both settled-state
  checks and steering targets; do not invent another active-turn state store.
- Recovery batching checked the 75 ms threshold only on the next event. A
  short burst followed by provider silence could remain unpublished until
  another event or stream boundary. One trailing flush now publishes the last
  batch; it is cleared on flush and teardown and checks worker ownership.
- Recovery retained pre-admission queue objects even after the composer had
  supplied an `expectedTurnId` or mailbox receipt. Merge current composer-owned
  admissions before publishing; once admitted, server receipts retain control.
  The early-queue browser regression caught three enqueues before this fix.

These changes do not alter Eve's tool execution, cancellation, durable history,
or steering boundary protocol. Codex's `steer_input` and post-sampling pending
input checks remain the reference: admission during the active turn, consumption
after the current step has safely finished, before the next model request.

The new browser cases cover an empty seed, a previous-turn seed, and a prompt
queued before the recovery stream exposes `turn.started`. They hold the stream
open with no terminal event, assert prompt admission as `steer`, preserve the
original assistant segment, verify a single enqueue, and reload the result.

Real-provider refresh/file probe: session `wrun_01M26PVF9F97FHH3AJ1Z1RVMFN`.
Mailbox admission began at 22:26:19.583 UTC; acceptance was 22:26:20.302.
The current file-edit step completed at 22:26:42.627; steering was consumed in
the same `turn_0` at 22:26:42.739 (112 ms later), before step 1 began and before
turn completion at 22:26:45.844. Evidence:
`.tmp/live-steering-recovery-file-evidence.json`. This includes reload catch-up
latency and is not a WAN/rendering latency guarantee.

Final-build terminal/refresh probe: `wrun_01M26Q0SN3QVFYJ1ZEVDAYCSG8`.
The tool step completed at 22:29:19.765 UTC and the same-turn receipt arrived
at 22:29:19.972 (207 ms later); `turn_0` completed at 22:29:21.818.
Evidence: `.tmp/live-steering-recovery-evidence.json`.

Final validation: 617 unit tests passed; 15 focused browser tests passed,
including all three recovery-steering cases, preserved assistant segments,
queue withdrawal, half-open stream recovery, and cancellation boundaries.
Next production build and TypeScript validation passed. The frontend build
is dated 2026-09-11 06:28:22 +0800; the production supervisor was restarted
and `http://43.110.40.25:3100/` returned HTTP 200. Eve was restarted with the
existing 05:45 artifact because this follow-up fix changes only frontend
admission and recovery publication, not backend workflow code.

## Source Comparison

Codex reference: `openai/codex`, local checkout `../codex-reference`, commit
`c494130`. Inspected implementation, not just documentation:

- `codex-rs/core/src/session/turn_input.rs`: `steer_input` validates the active
  turn and appends user input to its pending queue; cancellation is separate.
- `codex-rs/core/src/session/turn.rs`: pending input is consumed before the
  next model request; `drain_in_flight` first settles the current tool results.
- `codex-rs/tui/src/chatwidget/input_submission.rs` and `user_messages.rs`:
  pending steering is reconciled with the committed user item.

Eve reference: installed `eve@0.31.1`, bundled sessions/streaming, frontend,
and execution-model guides; `session-command-inbox`, `turn-control-receiver`,
`turn-workflow`, and default message reducer implementations. Active-turn
steering here includes Open Agent's existing Eve patch; it is not claimed to
be an unmodified upstream Eve feature. Preserve Eve's ordered stream and
durable step/checkpoint boundaries.

## Confirmed Causes And Changes

1. **Assistant id collisions.** The display projection ran identity mapping
   more than once. An already-stabilized id lost its assistant segment suffix,
   so multiple replies acquired the same id. Preserve already-mapped ids and
   skip no-op turn-coordinate rewrites. Segment lookup now works with either
   the durable root or its optimistic display alias.
2. **Acceptance confused with consumption.** Mailbox `accepted` means the
   runtime inbox owns the command. Only `committed` / `message.received` means
   the model has consumed it. Keep server-accepted steering in the queue until
   that receipt; never use its optimistic id to rebind the existing turn.
3. **Missed safe boundary during workflow replay.** The boundary receiver could
   win its promise race before the already-ready command had moved from the
   multiplexed inbox into the delivery buffer. The steering poll now consumes
   only already-ready commands before declaring the buffer empty. No timers,
   waits for future commands, retargeting, or tool cancellation were added.
4. **Replay compatibility.** New `dispatchTurnStep` results durably record the
   ready-steering capability. Historical dispatch results without that field
   keep their recorded protocol. This avoids changing an existing workflow's
   already-recorded delivery/acknowledgement path. The next newly dispatched
   task in an existing session gets the fix without discarding its context.
5. **Unsupported sorting removed.** Removed the preceding revision's
   first-encounter turn-order map. It did not fix same-turn steering and could
   place newly loaded earlier history after the currently visible turn.

## Original Session Evidence

Screenshots `034313`, `034419`, and `035851` map to
`thread-1789069276540-paxl06gezg`, session
`wrun_01M26DDEXF92B6XFT8TSSKCWA6`.

- Follow-up stored at 19:41:41.239 UTC; runtime accepted it at 19:41:42.118.
- Step 2 completed at 19:41:45.655. Its delivery step nevertheless recorded
  `driver-delivery-empty`, confirmed by decoding the persisted step input.
- Step 3 ran until 19:43:53.158; follow-up receipt was 19:43:53.329.
- The session contained 238 durable UI events, about 0.75 MB serialized in
  the Workflow store. The delay was not evidence of a multi-GB transcript.
- Browser checkpoint writes lagged emission by up to 19 seconds. Checkpoint
  time is not browser-render time, so it cannot independently locate network
  or rendering latency.

## Validation

- New browser regression failed before the fix at the assertion that the
  original assistant text remains visible after steering; it now passes
  throughout live streaming, completion, and refresh.
- New inbox/receiver regression failed before the fix with
  `driver-delivery-empty` for a ready command; it now passes. Additional cases
  cover empty polls, stale targets, next-turn messages, FIFO, and old replay.
- Full unit suite: 617 passed. A pre-existing `assert.rejects` callback typing
  error in `host-auth.test.ts` was reproduced on the baseline and corrected
  with an async test callback only; production authentication was not changed.
- Key browser checks: live steering, active-turn session reuse, and hot file
  input passed. Broader 19-test selection: 16 passed, 3 failed identically on
  baseline `9749f2f` and the changed version. These remain unresolved:
  stale pending metadata after settled recovery; edited reply after refresh;
  historical cancellation context backfill. No blanket regression-free claim.

Two real-provider tests used Chromium through the production gateway on the
same server, with no mocked runtime or transport. These measure event emission
to browser receipt, not WAN latency or paint duration:

| Scenario | Events | Median | P95 | Max | Receipt After Safe Boundary |
| --- | ---: | ---: | ---: | ---: | ---: |
| `bash` with a five-second command | 25 | 4 ms | 40 ms | 49 ms | 115 ms |
| streamed 128-line HTML file edit | 73 | 4 ms | 44 ms | 53 ms | 158 ms |

Both follow-ups entered the same durable turn at its first safe boundary and
the final reply included the requested follow-up marker. Inbox acceptance was
0.84 s and 0.78 s respectively. The file case waited 25.1 s for consumption,
because the current streamed edit still had to finish; that wait is intentional.
Local evidence: `.tmp/live-steering-evidence.json` and
`.tmp/live-steering-file-evidence.json`.

## Deployment And Limits

Both Next and Eve production artifacts were rebuilt. The previous Eve artifact
dated September 6 while the frontend artifact dated September 11.
During restart the 40 GB host disk filled; only disposable npm download cache
was removed (about 1.7 GB). No conversation, database, uploaded asset, or sandbox
data was deleted. Approximately 1.5 GB remained free afterwards: disk headroom
is still an operational risk, not something this steering fix resolves.

Long model calls and tool execution still defer steering until a safe boundary.
Old already-dispatched tasks keep their historical protocol until they settle.
The measurements above are specific successful trials, not a latency SLA or
proof that every historical frontend/network issue has been eliminated.
