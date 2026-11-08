import assert from "node:assert/strict";
import test from "node:test";
import { planMailboxEdit, observeEditClear, prepareMailboxEditTransaction, MailboxEditPendingError } from "../../agent/lib/mailbox-edit-transaction.ts";
import { line, reply, startTurn } from "../helpers/session-events.ts";
import type { SessionStreamEvent } from "eve/client";
import type { AgentMailboxItem } from "../../server/data/agent-mailbox-store.ts";

function branch() {
  return [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "a", "da", "First"), ...reply(4, "a", "da", "First reply"),
    ...startTurn(5, "b", "db", "Original", "a"), ...reply(8, "b", "db", "Superseded reply")];
}
function cleared(itemId = "item", deliveryId = "clear") {
  return line(9,
    { type: "delivery.admitted", data: { deliveryId, source: { control: "clear" }, principal: { id: `mailbox-edit-clear:${itemId}`, type: "service" } } },
    { type: "context.started", data: { changeId: "change", kind: "clear", cause: { deliveryId } } },
    { type: "context.settled", data: { changeId: "change", kind: "clear", outcome: "completed", selects: null } },
    { type: "delivery.settled", data: { deliveryId, outcome: "applied" } },
  );
}

test("edit plan selects only messages preceding the target", () => {
  const plan = planMailboxEdit(branch(), "b");
  assert.deepEqual(plan.history, [{ id: "da:user", role: "user", text: "First" }, { id: "a:assistant", role: "assistant", text: "First reply" }]);
  assert.equal(plan.startIndex, 9);
  assert.throws(() => planMailboxEdit(branch(), "missing"), /no longer/);
});

test("repeated edits preserve imported prefix ids without copying obsolete audit rows", () => {
  const events = branch();
  const plan = planMailboxEdit(events, "b");
  const replacement = startTurn(10, "c", "dc", "Edited");
  const imported = replacement.map((event) => event.type === "delivery.consumed" ? { ...event, data: { ...event.data, history: plan.history } } : event);
  const after = [...events, ...cleared(), ...imported, ...reply(13, "c", "dc", "Edited reply")];
  const nextPlan = planMailboxEdit(after, "c");
  assert.deepEqual(nextPlan.history, plan.history);
  assert.equal(nextPlan.history.length, 2);
  assert.throws(() => planMailboxEdit(after, "b"), /no longer/);
});

test("clear reconciliation recovers a lost receipt only for its named operation", () => {
  assert.equal(observeEditClear(cleared(), "item"), "completed");
  assert.equal(observeEditClear(cleared(), "other"), "pending");
  assert.equal(observeEditClear(cleared(), "other", "clear"), "completed");
  const failed = cleared().map((event) => event.type === "context.settled" ? { ...event, data: { ...event.data, outcome: "failed" as const } } : event);
  assert.equal(observeEditClear(failed, "item"), "failed");
});

function setup() {
  let events = branch();
  let item = { itemId: "item", status: "delivering", sessionId: "session", payload: { operation: { beforeTurnId: "b" } } } as AgentMailboxItem;
  let clears = 0;
  const store = {
    async findOwned() { return item; },
    async prepareEdit(_id: string, editPlan: NonNullable<AgentMailboxItem["editPlan"]>) { item = { ...item, editPlan }; return item; },
    async claimEditClear() {
      if (item.editPlan?.phase !== "prepared") return false;
      item = { ...item, editPlan: { ...item.editPlan, phase: "clearing" } }; return true;
    },
    async recordEditClear(_id: string, clearDeliveryId: string) { item = { ...item, editPlan: { ...item.editPlan!, clearDeliveryId } }; },
    async completeEditClear() { item = { ...item, editPlan: { ...item.editPlan!, phase: "cleared" } }; },
  };
  const session = { id: "session", async *stream({ startIndex }: { startIndex: number }) { yield* events.filter((event) => event.meta.position.line >= startIndex); },
    async clear() {
      clears++; events = [...events, ...cleared()];
      return { deliveryId: "clear", async result() {} };
    },
  };
  const options = { auth: { principalId: "user", principalType: "user", attributes: {}, authenticator: "test" },
    beforeTurnId: "b", itemId: "item", owner: { principalId: "user", principalType: "user", tenantId: "tenant" }, session, store } as unknown as Parameters<typeof prepareMailboxEditTransaction>[0];
  return { options, get item() { return item; }, get clears() { return clears; }, get events() { return events; }, set events(value: SessionStreamEvent[]) { events = value; } };
}

test("edit transaction persists its prefix and clears exactly once across repeated calls", async () => {
  const state = setup();
  const plan = await prepareMailboxEditTransaction(state.options);
  assert.equal(plan.phase, "cleared"); assert.equal(state.clears, 1);
  assert.deepEqual(await prepareMailboxEditTransaction(state.options), plan);
  assert.equal(state.clears, 1);
});

test("a lost clear acknowledgement is reconciled without issuing another clear", async () => {
  const state = setup();
  state.options.store.recordEditClear = async () => { throw new Error("database unavailable after clear acceptance"); };
  await assert.rejects(prepareMailboxEditTransaction(state.options), /database unavailable/);
  assert.equal(state.item.editPlan?.phase, "clearing");
  assert.equal((await prepareMailboxEditTransaction(state.options)).phase, "cleared");
  assert.equal(state.clears, 1);
});

test("an unconfirmed clear remains fenced and never clears a later turn on retry", async () => {
  const state = setup();
  state.options.session.clear = async () => { throw new Error("admission outcome unknown"); };
  await assert.rejects(prepareMailboxEditTransaction(state.options), /outcome unknown/);
  await assert.rejects(prepareMailboxEditTransaction(state.options), MailboxEditPendingError);
  assert.equal(state.item.editPlan?.phase, "clearing");
});
