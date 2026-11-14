import { expect, test } from "bun:test";
import {
  type ActionEvent,
  type EmittedOpenHandsEvent,
  ExecutionStatus,
  projectExecutionStatus,
  ROOT_PARENT_ID,
  validateEmittedEvent,
} from "./event_log.ts";
import { OpenHandsReducer, type ReducerAgentSessionEvent } from "./reducer.ts";

function runSequence(
  reducer: OpenHandsReducer,
  events: readonly ReducerAgentSessionEvent[],
): EmittedOpenHandsEvent[] {
  const out: EmittedOpenHandsEvent[] = [];
  for (const evt of events) {
    out.push(...reducer.reduce(evt));
  }
  return out;
}

function assertMonotonicChain(
  events: readonly EmittedOpenHandsEvent[],
  cardId: string,
): void {
  let prevId: string | null = null;
  let prevTs = 0;

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    expect(validateEmittedEvent(evt)).toBe(true);
    expect(evt.id === ROOT_PARENT_ID).toBe(false);
    expect(evt.id.startsWith(`${cardId}-`)).toBe(true);
    expect(evt.parent_id).toBe(prevId);

    const ts = Date.parse(evt.timestamp);
    expect(ts > prevTs).toBe(true);

    prevId = evt.id;
    prevTs = ts;
  }
}

test("reducer: agent_start -> running, agent_end(willRetry) stays running, agent_settled -> finished", () => {
  const clock = 1_700_000_000_000;
  const reducer = new OpenHandsReducer({
    cardId: "a1b2c",
    now: () => clock,
  });

  const startEvents = runSequence(reducer, [
    { type: "agent_start" },
    {
      type: "message_end",
      message: { role: "user", content: "read abc/PLAN.md" },
    },
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    },
    {
      type: "agent_end",
      messages: [],
      willRetry: true,
    },
  ]);

  expect(projectExecutionStatus(startEvents)).toBe(ExecutionStatus.RUNNING);
  expect(startEvents.length).toBe(2);
  expect(startEvents[0].kind).toBe("ConversationStateUpdateEvent");
  expect(startEvents[1].kind).toBe("MessageEvent");
  expect(startEvents[1].source).toBe("user");

  const endEvents = runSequence(reducer, [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done!" }],
        stopReason: "stop",
        responseId: "resp-1",
      },
    },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled", aborted: false },
  ]);

  const all = [...startEvents, ...endEvents];
  assertMonotonicChain(all, "a1b2c");
  expect(projectExecutionStatus(all)).toBe(ExecutionStatus.FINISHED);
  expect(endEvents.map((e) => e.kind)).toEqual([
    "MessageEvent",
    "ConversationStateUpdateEvent",
  ]);
  expect(endEvents[0].source).toBe("agent");
});

test("reducer: aborted agent_settled -> paused (InterruptEvent)", () => {
  const reducer = new OpenHandsReducer({
    cardId: "dead1",
    now: () => 1_700_000_000_000,
  });

  const events = runSequence(reducer, [
    { type: "agent_start" },
    {
      type: "message_end",
      message: { role: "user", content: "work" },
    },
    { type: "agent_settled", aborted: true },
  ]);

  assertMonotonicChain(events, "dead1");
  expect(events[events.length - 1].kind).toBe("InterruptEvent");
  expect(events[events.length - 1].source).toBe("user");
  expect(projectExecutionStatus(events)).toBe(ExecutionStatus.PAUSED);
});

test("reducer: error then successful retry -> finished (never error)", () => {
  const reducer = new OpenHandsReducer({
    cardId: "ret01",
    now: () => 1_700_000_000_000,
  });

  const events = runSequence(reducer, [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: "hello" } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        rawStopReason: "rate_limit",
        errorMessage: "429 Too Many Requests",
      },
    },
    { type: "agent_end", messages: [], willRetry: true },
    { type: "auto_retry_end", success: true, attempt: 1 },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Recovered!" }],
        stopReason: "stop",
      },
    },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled", aborted: false },
  ]);

  assertMonotonicChain(events, "ret01");
  expect(events.some((e) => e.kind === "ConversationErrorEvent")).toBe(false);
  expect(projectExecutionStatus(events)).toBe(ExecutionStatus.FINISHED);
});

test("reducer: retries exhausted -> ConversationErrorEvent + error status", () => {
  const reducer = new OpenHandsReducer({
    cardId: "err01",
    now: () => 1_700_000_000_000,
  });

  const events = runSequence(reducer, [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: "hello" } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        rawStopReason: "overloaded",
        errorMessage: "529 Overloaded",
      },
    },
    { type: "agent_end", messages: [], willRetry: true },
    {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "529 Overloaded",
    },
    { type: "agent_settled", aborted: false },
  ]);

  assertMonotonicChain(events, "err01");
  const errorEvt = events.find((e) => e.kind === "ConversationErrorEvent");
  expect(errorEvt?.kind).toBe("ConversationErrorEvent");
  if (errorEvt?.kind === "ConversationErrorEvent") {
    expect(errorEvt.code).toBe("overloaded");
    expect(errorEvt.detail).toBe("529 Overloaded");
  }
  expect(projectExecutionStatus(events)).toBe(ExecutionStatus.ERROR);
});

test("reducer: tool-calling reply emits ActionEvents (no MessageEvent), links ObservationEvent & AgentErrorEvent", () => {
  const reducer = new OpenHandsReducer({
    cardId: "tool1",
    now: () => 1_700_000_000_000,
  });

  const events = runSequence(reducer, [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: "inspect" } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read both files." },
          {
            type: "toolCall",
            id: "tc-1",
            name: "read",
            arguments: { path: "a.txt" },
          },
          {
            type: "toolCall",
            id: "tc-2",
            name: "read",
            arguments: { path: "missing.txt" },
          },
        ],
        stopReason: "toolUse",
        responseId: "resp-tools",
      },
    },
    { type: "tool_execution_start", toolCallId: "tc-1", toolName: "read" },
    {
      type: "tool_execution_update",
      toolCallId: "tc-1",
      toolName: "read",
      partialResult: "...",
    },
    {
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "hello world" }] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "tc-2",
      toolName: "read",
      isError: true,
      result: { content: [{ type: "text", text: "ENOENT: no such file" }] },
    },
    { type: "agent_settled", aborted: false },
  ]);

  assertMonotonicChain(events, "tool1");

  const assistantMessages = events.filter(
    (e) => e.kind === "MessageEvent" && e.source === "agent",
  );
  expect(assistantMessages.length).toBe(0);

  const actions = events.filter((e) => e.kind === "ActionEvent") as ActionEvent[];
  expect(actions.length).toBe(2);
  expect(actions[0].thought).toEqual([
    { type: "text", text: "Let me read both files." },
  ]);
  expect(actions[1].thought).toEqual([]);
  expect(actions[0].llm_response_id).toBe("resp-tools");
  expect(actions[1].llm_response_id).toBe("resp-tools");

  const obs = events.find((e) => e.kind === "ObservationEvent");
  expect(obs?.kind).toBe("ObservationEvent");
  if (obs?.kind === "ObservationEvent") {
    expect(obs.action_id).toBe(actions[0].id);
    expect(obs.tool_call_id).toBe("tc-1");
    expect(obs.observation.content).toEqual([
      { type: "text", text: "hello world" },
    ]);
  }

  const toolErr = events.find((e) => e.kind === "AgentErrorEvent");
  expect(toolErr?.kind).toBe("AgentErrorEvent");
  if (toolErr?.kind === "AgentErrorEvent") {
    expect(toolErr.tool_call_id).toBe("tc-2");
    expect(toolErr.error).toBe("ENOENT: no such file");
  }

  expect(projectExecutionStatus(events)).toBe(ExecutionStatus.FINISHED);
});

test("reducer: continues seq, parent_id, and timestamp across rounds", () => {
  const round1 = new OpenHandsReducer({
    cardId: "rnd01",
    now: () => 1_700_000_000_000,
  });
  const firstEvents = runSequence(round1, [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: "round 1" } },
    { type: "agent_settled", aborted: false },
  ]);

  const round2 = new OpenHandsReducer({
    cardId: "rnd01",
    initialEvents: firstEvents,
    now: () => 1_700_000_000_000,
  });
  const secondEvents = runSequence(round2, [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: "round 2" } },
    { type: "agent_settled", aborted: false },
  ]);

  const combined = [...firstEvents, ...secondEvents];
  assertMonotonicChain(combined, "rnd01");
  expect(secondEvents[0].id).toBe("rnd01-4");
  expect(secondEvents[0].parent_id).toBe(
    firstEvents[firstEvents.length - 1].id,
  );
});

test("reducer: wrapUIContext emits waiting_for_confirmation then running", async () => {
  const reducer = new OpenHandsReducer({
    cardId: "ui001",
    now: () => 1_700_000_000_000,
  });
  const emitted: EmittedOpenHandsEvent[] = [];

  const wrapped = reducer.wrapUIContext(
    {
      confirm: async (_title: string, _message: string) => true,
      select: async (_title: string, options: string[]) => options[0],
    },
    (evt) => emitted.push(evt),
  );

  const confirmed = await wrapped.confirm("Proceed?", "Confirm action");
  expect(confirmed).toBe(true);
  const selected = await wrapped.select("Pick one", ["a", "b"]);
  expect(selected).toBe("a");

  assertMonotonicChain(emitted, "ui001");
  expect(emitted.length).toBe(4);
  expect(
    emitted.map((e) =>
      e.kind === "ConversationStateUpdateEvent" ? e.value : e.kind
    ),
  ).toEqual([
    ExecutionStatus.WAITING_FOR_CONFIRMATION,
    ExecutionStatus.RUNNING,
    ExecutionStatus.WAITING_FOR_CONFIRMATION,
    ExecutionStatus.RUNNING,
  ]);
});
