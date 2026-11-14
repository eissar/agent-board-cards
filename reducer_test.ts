import { assertEquals } from "@std/assert";
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

function assertMonotonicChain(events: readonly EmittedOpenHandsEvent[], cardId: string): void {
  let prevId: string | null = null;
  let prevTs = 0;

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    assertEquals(validateEmittedEvent(evt), true);
    assertEquals(evt.id === ROOT_PARENT_ID, false);
    assertEquals(evt.id.startsWith(`${cardId}-`), true);
    assertEquals(evt.parent_id, prevId);

    const ts = Date.parse(evt.timestamp);
    assertEquals(ts > prevTs, true);

    prevId = evt.id;
    prevTs = ts;
  }
}

Deno.test("reducer: agent_start -> running, agent_end(willRetry) stays running, agent_settled -> finished", () => {
  let clock = 1_700_000_000_000;
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

  assertEquals(projectExecutionStatus(startEvents), ExecutionStatus.RUNNING);
  assertEquals(startEvents.length, 2);
  assertEquals(startEvents[0].kind, "ConversationStateUpdateEvent");
  assertEquals(startEvents[1].kind, "MessageEvent");
  assertEquals(startEvents[1].source, "user");

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
  assertEquals(projectExecutionStatus(all), ExecutionStatus.FINISHED);
  assertEquals(endEvents.map((e) => e.kind), [
    "MessageEvent",
    "ConversationStateUpdateEvent",
  ]);
  assertEquals(endEvents[0].source, "agent");
});

Deno.test("reducer: aborted agent_settled -> paused (InterruptEvent)", () => {
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
  assertEquals(events[events.length - 1].kind, "InterruptEvent");
  assertEquals(events[events.length - 1].source, "user");
  assertEquals(projectExecutionStatus(events), ExecutionStatus.PAUSED);
});

Deno.test("reducer: error then successful retry -> finished (never error)", () => {
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
  assertEquals(
    events.some((e) => e.kind === "ConversationErrorEvent"),
    false,
  );
  assertEquals(projectExecutionStatus(events), ExecutionStatus.FINISHED);
});

Deno.test("reducer: retries exhausted -> ConversationErrorEvent + error status", () => {
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
  assertEquals(errorEvt?.kind, "ConversationErrorEvent");
  if (errorEvt?.kind === "ConversationErrorEvent") {
    assertEquals(errorEvt.code, "overloaded");
    assertEquals(errorEvt.detail, "529 Overloaded");
  }
  assertEquals(projectExecutionStatus(events), ExecutionStatus.ERROR);
});

Deno.test("reducer: tool-calling reply emits ActionEvents (no MessageEvent), links ObservationEvent & AgentErrorEvent", () => {
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
  assertEquals(assistantMessages.length, 0);

  const actions = events.filter((e) => e.kind === "ActionEvent") as ActionEvent[];
  assertEquals(actions.length, 2);
  assertEquals(actions[0].thought, [{ type: "text", text: "Let me read both files." }]);
  assertEquals(actions[1].thought, []);
  assertEquals(actions[0].llm_response_id, "resp-tools");
  assertEquals(actions[1].llm_response_id, "resp-tools");

  const obs = events.find((e) => e.kind === "ObservationEvent");
  assertEquals(obs?.kind, "ObservationEvent");
  if (obs?.kind === "ObservationEvent") {
    assertEquals(obs.action_id, actions[0].id);
    assertEquals(obs.tool_call_id, "tc-1");
    assertEquals(obs.observation.content, [{ type: "text", text: "hello world" }]);
  }

  const toolErr = events.find((e) => e.kind === "AgentErrorEvent");
  assertEquals(toolErr?.kind, "AgentErrorEvent");
  if (toolErr?.kind === "AgentErrorEvent") {
    assertEquals(toolErr.tool_call_id, "tc-2");
    assertEquals(toolErr.error, "ENOENT: no such file");
  }

  assertEquals(projectExecutionStatus(events), ExecutionStatus.FINISHED);
});

Deno.test("reducer: continues seq, parent_id, and timestamp across rounds", () => {
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
    now: () => 1_700_000_000_000, // even if clock hasn't advanced, timestamps stay monotonic
  });
  const secondEvents = runSequence(round2, [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: "round 2" } },
    { type: "agent_settled", aborted: false },
  ]);

  const combined = [...firstEvents, ...secondEvents];
  assertMonotonicChain(combined, "rnd01");
  assertEquals(secondEvents[0].id, "rnd01-4");
  assertEquals(secondEvents[0].parent_id, firstEvents[firstEvents.length - 1].id);
});

Deno.test("reducer: wrapUIContext emits waiting_for_confirmation then running", async () => {
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
  assertEquals(confirmed, true);
  const selected = await wrapped.select("Pick one", ["a", "b"]);
  assertEquals(selected, "a");

  assertMonotonicChain(emitted, "ui001");
  assertEquals(emitted.length, 4);
  assertEquals(
    emitted.map((e) =>
      e.kind === "ConversationStateUpdateEvent" ? e.value : e.kind
    ),
    [
      ExecutionStatus.WAITING_FOR_CONFIRMATION,
      ExecutionStatus.RUNNING,
      ExecutionStatus.WAITING_FOR_CONFIRMATION,
      ExecutionStatus.RUNNING,
    ],
  );
});
