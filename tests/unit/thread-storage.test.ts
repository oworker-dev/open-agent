import assert from "node:assert/strict";
import test from "node:test";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { position } from "eve/events";
import { serializeAssetPrompt } from "../../packages/agent-contracts/src/asset.ts";
import { appendThreadEvent, appendThreadEventIndexed, compactThreadEvents, createAgentThread, dedupeThreadEvents, editOperationId, eventIdentity, inputResponseSubmissionFailure, inputResponseSubmissionProjectsAnswer, latestEditableTurnId, mergeThreadEventSnapshots, mergeThreadCollectionsForConflict, parseThreadCollection, reconcileHydratedPendingTurn, reconcilePendingTurnWithEvents, threadEventCursor } from "../../packages/agent-ui/dist/agent-workspace/thread-storage.js";
import { line, reply, startTurn } from "../helpers/session-events.ts";

const prompt = (id: string, text = "same prompt") => serializeAssetPrompt(text, [], id);
const pending = { id: "pending-message", text: "same prompt", state: "submitting" as const, submittedAt: 100 };
const source = () => [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "first", "d1", prompt("original")), ...reply(4, "first", "d1", "Done")];

test("an incompatible history cache preserves its session for authoritative repair", () => {
  const thread = createAgentThread(100, "Preserved conversation");
  const collection = parseThreadCollection({ version: 2, threads: [{ ...thread,
    events: [{ type: "session.started", data: {}, meta: { id: "old-event", timestamp: 100 } }],
    session: { sessionId: "old-session", streamIndex: 434 },
    transcriptCoverage: { version: 1, complete: true, authoritative: true,
      projection: "logical-edits-v1", startIndex: 0, endIndex: 434 },
  }] });
  assert.equal(collection.threads.length, 1);
  assert.equal(collection.threads[0]?.title, "Preserved conversation");
  assert.deepEqual(collection.threads[0]?.session, { sessionId: "old-session", streamIndex: 434 });
  assert.deepEqual(collection.threads[0]?.events, []);
  assert.equal(collection.threads[0]?.transcriptCoverage, undefined);
});

test("edit operation identities are deterministic and include session, target and content", () => {
  const id = editOperationId("session", "turn", "message");
  assert.equal(id, editOperationId("session", "turn", "message"));
  assert.notEqual(id, editOperationId("other", "turn", "message"));
  assert.notEqual(id, editOperationId("session", "other", "message"));
  assert.notEqual(id, editOperationId("session", "turn", "other"));
  assert.match(id, /^edit-[0-9a-f]{16}$/);
});

test("recovery merges by durable position despite reversed timestamps and reset turn ids", () => {
  const events = source();
  const middle = Math.floor(events.length / 2);
  const merged = mergeThreadEventSnapshots(events.slice(middle), events.slice(0, middle).map((event) => ({ ...event, meta: { ...event.meta, at: "2099-01-01T00:00:00Z" } })));
  assert.deepEqual(merged.map(eventIdentity), events.map(eventIdentity));
  assert.equal(mergeThreadEventSnapshots(events, []).length, events.length);
  assert.deepEqual(mergeThreadEventSnapshots(events, events.slice(0, 2)), events);
});

test("facts sharing a source line remain distinct and exact replay is idempotent", () => {
  const atomic = line(0, { type: "session.started", data: {} }, { type: "turn.started", data: { turnId: "first", cause: { deliveryId: "first-delivery" }, follows: null } });
  assert.notEqual(eventIdentity(atomic[0]!), eventIdentity(atomic[1]!));
  assert.equal(dedupeThreadEvents([...atomic, ...atomic]).length, 2);
  assert.equal(threadEventCursor(atomic[0]!), undefined);
  assert.equal(threadEventCursor(atomic[1]!), 1);
});

test("readonly append preserves the published snapshot and inserts in source order", () => {
  const [first] = line(0, { type: "session.started", data: {} });
  const [last] = line(2, { type: "delivery.admitted", data: { deliveryId: "later", source: { channel: "eve" } } });
  const [middle] = line(1, { type: "delivery.admitted", data: { deliveryId: "first", source: { channel: "eve" } } });
  const original = Object.freeze([first!, last!]);
  const next = appendThreadEvent(original, middle!);
  assert.deepEqual(original, [first, last]);
  assert.deepEqual(next, [first, middle, last]);
  assert.equal(appendThreadEvent(next, middle!), next);
});

test("indexed replay keeps every delta and does not collapse a commit", () => {
  const sourceEvents = source();
  const events: SessionStreamEvent[] = [];
  const ids = new Set<string>();
  for (const event of sourceEvents.toReversed()) assert.equal(appendThreadEventIndexed(events, ids, event), true);
  for (const event of sourceEvents) assert.equal(appendThreadEventIndexed(events, ids, event), false);
  assert.deepEqual(events, sourceEvents);
  assert.equal(position(conversationOf(events).view), 5);
});

test("large tool input recovery preserves source coverage and linear serialized size", () => {
  const events: SessionStreamEvent[] = []; const ids = new Set<string>();
  const count = 16_384;
  for (let index = 0; index < count; index++) {
    appendThreadEventIndexed(events, ids, line(index, { type: "call.input", scope: { turnId: "first", runId: "run" }, data: { callId: "patch", ...(index === 0 ? { name: "apply_patch", kind: "tool" as const } : {}), delta: "x" } })[0]!);
  }
  const compacted = compactThreadEvents([...events, ...events]);
  assert.equal(compacted.length, count);
  assert.equal(threadEventCursor(compacted.at(-1)!), count);
  assert.ok(JSON.stringify(compacted).length < count * 300);
});

test("a pending message is acknowledged only by its own envelope", () => {
  assert.equal(reconcilePendingTurnWithEvents(pending, startTurn(1, "first", "d1", prompt("pending-message"))), undefined);
  assert.equal(reconcilePendingTurnWithEvents(pending, startTurn(1, "first", "d1", prompt("other-message"))), pending);
  const events = [...startTurn(1, "first", "d1", prompt("pending-message")), ...startTurn(5, "second", "d2", prompt("other-message"), "first")];
  assert.equal(reconcilePendingTurnWithEvents(pending, events), undefined);
});

test("hydration never resubmits unacknowledged browser work", () => {
  assert.equal(reconcileHydratedPendingTurn({ ...pending, state: "submitting" }, [])?.state, "delivery-failed");
  const obsolete = parseThreadCollection({ version: 2, threads: [{
    ...createAgentThread(1, "Obsolete edit state"),
    pendingTurn: { ...pending, state: "resubmitting" },
  }] });
  assert.equal(obsolete.threads[0]?.pendingTurn, undefined);
  const edit = { ...pending, beforeTurnId: "first", operation: "edit" as const, delivery: "server" as const, mailboxItemId: "mail-1" };
  assert.equal(reconcileHydratedPendingTurn(edit, []), edit);
});

test("edit eligibility follows the selected branch and excludes consumed steering", () => {
  const events = source();
  assert.equal(latestEditableTurnId(events), "first");
  events.push(...line(5, { type: "delivery.consumed", scope: { turnId: "first" }, data: { turnId: "first", deliveryId: "steer", parts: [{ kind: "text", text: "Follow-up" }] } }));
  assert.equal(latestEditableTurnId(events), undefined);
});

test("a context clear is retained as facts and changes edit selection", () => {
  const events = source();
  events.push(...line(5, { type: "context.started", data: { changeId: "clear", kind: "clear" } }, { type: "context.settled", data: { changeId: "clear", kind: "clear", outcome: "completed", selects: null } }));
  assert.equal(latestEditableTurnId(events), undefined);
  assert.deepEqual(compactThreadEvents(events), events);
  events.push(...startTurn(6, "edited", "d2", prompt("edit")), ...reply(9, "edited", "d2", "Edited reply"));
  assert.equal(latestEditableTurnId(events), "edited");
});

test("conflict resolution retains complete remote facts and the highest line cursor", () => {
  const events = source(); const thread = { ...createAgentThread(1), id: "thread", events, session: { sessionId: "session", streamIndex: 5 } };
  const local = { ...thread, events: events.slice(0, 2), updatedAt: 3, session: { sessionId: "session", streamIndex: 1 } };
  const merged = mergeThreadCollectionsForConflict({ threads: [local], version: 2 }, { threads: [thread], version: 2 });
  assert.deepEqual(merged.threads[0]?.events, events);
  assert.equal(merged.threads[0]?.session.streamIndex, 5);
});

test("hydrates queued follow-ups from the v2 collection without accepting malformed entries", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-queued",
      preferences: { modelId: "model", reasoning: "medium" },
      queuedTurns: [
        { id: "queued-1", state: "queued", submittedAt: 2, text: "Continue" },
        { id: "invalid", state: "delivering", submittedAt: 3, text: "Do not send" },
        { delivery: "server", expectedTurnId: "turn-1", id: "committed-1", intent: "active-turn", mailboxItemId: "mail-1", state: "committed", submittedAt: 4, text: "Durably admitted" },
      ],
      session: { streamIndex: 0 },
      status: "ready",
      title: "Queued",
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.queuedTurns, [
    { id: "queued-1", state: "queued", submittedAt: 2, text: "Continue" },
    { delivery: "server", expectedTurnId: "turn-1", id: "committed-1", intent: "active-turn", mailboxItemId: "mail-1", state: "committed", submittedAt: 4, text: "Durably admitted" },
  ]);
});

test("hydrates only a valid one-shot composer draft restoration", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      draftRestore: { id: "draft-restore-1", text: "Continue with the blue variant" },
      events: [],
      id: "thread-draft-restore",
      preferences: { modelId: "model", reasoning: "medium" },
      queuedTurns: [],
      session: { streamIndex: 0 },
      status: "ready",
      title: "Thread",
      updatedAt: 2,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.draftRestore, {
    id: "draft-restore-1",
    text: "Continue with the blue variant",
  });
});

test("hydrates only bounded valid interrupted-turn markers", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-interrupted-turns",
      interruptedTurns: [
        { eventCount: 12, streamIndex: 120, turnId: "turn-valid" },
        { eventCount: -1, streamIndex: 121, turnId: "turn-negative" },
        { eventCount: 14.5, streamIndex: 122, turnId: "turn-fractional" },
        { eventCount: 15, streamIndex: 123, turnId: "" },
        { eventCount: 16, streamIndex: -1, turnId: "turn-stream-negative" },
        { eventCount: 18, streamIndex: 128, turnId: "turn-valid", settled: false, pendingClientMessageId: "stopped-send",
          pendingMessage: { id: "stopped-send", operation: "send", state: "interrupted", submittedAt: 5, text: "keep this row" } },
        { eventCount: 19, streamIndex: 129, turnId: "turn-invalid-pending", settled: false, pendingClientMessageId: "expected-id",
          pendingMessage: { id: "other-id", operation: "send", state: "interrupted", submittedAt: 5, text: "reject mismatched row" } },
      ],
      preferences: { modelId: "model", reasoning: "medium" },
      queuedTurns: [],
      session: { streamIndex: 0 },
      status: "cancelling",
      title: "Interrupted",
      updatedAt: 2,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.interruptedTurns, [
    { eventCount: 18, streamIndex: 128, turnId: "turn-valid", settled: false, pendingClientMessageId: "stopped-send",
      pendingMessage: { id: "stopped-send", operation: "send", state: "interrupted", submittedAt: 5, text: "keep this row" } },
    { eventCount: 19, streamIndex: 129, turnId: "turn-invalid-pending", settled: false, pendingClientMessageId: "expected-id" },
  ]);
});

test("hydrates bounded retained context used after an edited turn", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-context",
      preferences: { modelId: "model", reasoning: "medium" },
      retainedContext: ["User: Keep the original architecture", "Assistant: The architecture is retained."],
      session: { streamIndex: 0 },
      status: "ready",
      title: "Context",
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.retainedContext, [
    "User: Keep the original architecture",
    "Assistant: The architecture is retained.",
  ]);
});

test("hydrates transcript coverage only when its absolute cursor is valid", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-coverage",
      preferences: { modelId: "model", reasoning: "medium" },
      session: { sessionId: "session-coverage", streamIndex: 12803 },
      status: "ready",
      title: "Coverage",
      transcriptCoverage: { complete: true, endIndex: 12803, startIndex: 0, version: 1 },
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.transcriptCoverage, {
    complete: true,
    endIndex: 12803,
    startIndex: 0,
    version: 1,
  });

  const invalid = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-invalid-coverage",
      preferences: { modelId: "model", reasoning: "medium" },
      session: { streamIndex: 10 },
      status: "ready",
      title: "Invalid coverage",
      transcriptCoverage: { complete: true, endIndex: 9, startIndex: 10, version: 1 },
      updatedAt: 1,
    }],
    version: 2,
  });
  assert.equal(invalid.threads[0]?.transcriptCoverage, undefined);
});

test("preserves validated attachments for a durable edited-turn retry", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-edit-attachment",
      pendingTurn: {
        files: [
          { filename: "reference.png", mediaType: "image/png", url: "data:image/png;base64,AA==" },
          { filename: "invalid.png", mediaType: "image/png" },
        ],
        id: "pending-edit",
        state: "submitting",
        submittedAt: 2,
        text: "",
      },
      preferences: { modelId: "model", reasoning: "medium" },
      session: { sessionId: "session-edit", streamIndex: 0 },
      status: "submitted",
      title: "Attachment edit",
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.pendingTurn, {
    files: [{ filename: "reference.png", mediaType: "image/png", url: "data:image/png;base64,AA==" }],
    id: "pending-edit",
    state: "submitting",
    submittedAt: 2,
    text: "",
  });
});

test("hydrates durable input responses and rejects malformed response snapshots", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-input-response",
      inputResponseSubmissions: [{
        id: "response-1",
        mailboxItemId: "mail-response-1",
        responses: [
          { optionId: "approve", interactionId: "request-1" },
          { interactionId: "request-2" },
        ],
        state: "committed",
        streamIndexAtSubmission: 12,
        submittedAt: 2,
      }, {
        id: "response-2",
        responses: [{ interactionId: "request-3", text: "Confirmed" }],
        settledAtStreamIndex: 24,
        state: "committed",
        streamIndexAtSubmission: 12,
        submittedAt: 3,
      }],
      preferences: { modelId: "model", reasoning: "medium" },
      session: { sessionId: "session-response", streamIndex: 24 },
      status: "ready",
      title: "Responses",
      updatedAt: 3,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.inputResponseSubmissions, [{
    id: "response-2",
    responses: [{ interactionId: "request-3", text: "Confirmed" }],
    settledAtStreamIndex: 24,
    state: "committed",
    streamIndexAtSubmission: 12,
    submittedAt: 3,
  }]);
});

test("a refused approval restores its controls despite a committed mailbox receipt", () => {
  const submission = {
    id: "answer-1", state: "committed" as const, streamIndexAtSubmission: 10,
    submittedAt: 100, responses: [{ interactionId: "approval-1", optionId: "approve" }],
  };
  const events = [
    ...line(10, { type: "response.submitted", data: { deliveryId: "answer-delivery", interactionId: "approval-1", responseId: "response-1", value: { optionId: "approve" } } }),
    ...line(11, { type: "response.settled", data: { responseId: "response-1", outcome: "refused", reason: "Only the requester can approve." } }),
  ];
  assert.equal(inputResponseSubmissionProjectsAnswer(submission, events.slice(0, 1)), true);
  assert.equal(inputResponseSubmissionProjectsAnswer(submission, events), false);
  assert.equal(inputResponseSubmissionFailure(submission, events), "Only the requester can approve.");
  const retry = { ...submission, id: "answer-2", streamIndexAtSubmission: 12, submittedAt: 200 };
  assert.equal(inputResponseSubmissionProjectsAnswer(retry, events), true, "old refusal must not hide a new attempt");
  const applied = [...events,
    ...line(12, { type: "response.submitted", data: { deliveryId: "retry-delivery", interactionId: "approval-1", responseId: "response-2", value: { optionId: "approve" } } }),
    ...line(13, { type: "response.settled", data: { responseId: "response-2", outcome: "applied" } }),
  ];
  assert.equal(inputResponseSubmissionProjectsAnswer(retry, applied), true);
  assert.equal(inputResponseSubmissionFailure(retry, applied), undefined);
  assert.equal(inputResponseSubmissionProjectsAnswer(submission, applied), false);
});

test("unrelated approval failures do not change an answer's projection", () => {
  const submission = {
    id: "answer-1", state: "committed" as const, streamIndexAtSubmission: 10,
    submittedAt: 100, responses: [{ interactionId: "approval-1", optionId: "approve" }],
  };
  const events = [
    ...line(10, { type: "response.submitted", data: { deliveryId: "other-delivery", interactionId: "approval-2", responseId: "response-2", value: { optionId: "approve" } } }),
    ...line(11, { type: "response.settled", data: { responseId: "response-2", outcome: "failed" } }),
  ];
  assert.equal(inputResponseSubmissionProjectsAnswer(submission, events), true);
});
