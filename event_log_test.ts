import { assertEquals, assertThrows } from "@std/assert";
import {
  ExecutionStatus,
  parseEventLog,
  projectExecutionStatus,
  ROOT_PARENT_ID,
  validateEmittedEvent,
  validateEventEnvelope,
} from "./event_log.ts";

Deno.test("validateEventEnvelope rejects reserved ROOT_PARENT_ID as event id", () => {
  const invalid = {
    id: ROOT_PARENT_ID,
    timestamp: "2026-11-14T18:00:00.000Z",
    source: "agent",
    parent_id: null,
    kind: "MessageEvent",
  };
  assertEquals(validateEventEnvelope(invalid), false);
});

Deno.test("validateEventEnvelope rejects missing or empty kind", () => {
  const base = {
    id: "evt-1",
    timestamp: "2026-11-14T18:00:00.000Z",
    source: "agent",
    parent_id: null,
  };
  assertEquals(validateEventEnvelope(base), false);
  assertEquals(validateEventEnvelope({ ...base, kind: "" }), false);
  assertEquals(
    validateEventEnvelope({ ...base, kind: "FutureUnknownEvent" }),
    true,
  );
});

Deno.test("validateEmittedEvent enforces strict v1.62.0 schemas and rejects unknown kinds", () => {
  const base = {
    id: "evt-1",
    timestamp: "2026-11-14T18:00:00.000Z",
    parent_id: null,
  };

  assertEquals(
    validateEmittedEvent({
      ...base,
      source: "agent",
      kind: "CustomUnknownEvent",
    }),
    false,
  );

  assertEquals(
    validateEmittedEvent({
      ...base,
      source: "environment",
      kind: "ConversationErrorEvent",
    }),
    false,
  );

  assertEquals(
    validateEmittedEvent({
      ...base,
      source: "environment",
      kind: "ConversationErrorEvent",
      code: "rate_limit",
      detail: "429 Too Many Requests",
    }),
    true,
  );

  assertEquals(
    validateEmittedEvent({
      ...base,
      source: "user",
      kind: "MessageEvent",
      llm_message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      llm_response_id: null,
    }),
    true,
  );

  assertEquals(
    validateEmittedEvent({
      ...base,
      source: "agent",
      kind: "ActionEvent",
      thought: [{ type: "text", text: "checking files" }],
      tool_name: "read",
      tool_call_id: "call-1",
      tool_call: {
        id: "call-1",
        name: "read",
        arguments: '{"path":"README.md"}',
      },
      llm_response_id: "resp-1",
    }),
    true,
  );

  assertEquals(
    validateEmittedEvent({
      ...base,
      source: "environment",
      kind: "ObservationEvent",
      tool_name: "read",
      tool_call_id: "call-1",
      action_id: "evt-0",
      observation: {
        content: [{ type: "text", text: "file contents" }],
      },
    }),
    true,
  );
});

Deno.test("parseEventLog tolerates unknown event kinds on read but rejects invalid envelopes", () => {
  const validLog = [
    JSON.stringify({
      id: "evt-1",
      timestamp: "2026-11-14T18:00:00.000Z",
      source: "environment",
      parent_id: null,
      kind: "SomeFutureEvent",
      payload: 42,
    }),
  ].join("\n");

  const parsed = parseEventLog(validLog);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].kind, "SomeFutureEvent");

  assertThrows(() =>
    parseEventLog(
      JSON.stringify({
        id: "evt-1",
        timestamp: "2026-11-14T18:00:00.000Z",
        source: "environment",
        parent_id: null,
      }),
    )
  );
});

Deno.test("projectExecutionStatus folds OpenHands-style events into ExecutionStatus", () => {
  const base = {
    timestamp: "2026-11-14T18:00:00.000Z",
    parent_id: null,
  };

  assertEquals(projectExecutionStatus([]), ExecutionStatus.IDLE);

  assertEquals(
    projectExecutionStatus([
      {
        ...base,
        id: "evt-1",
        source: "user",
        kind: "MessageEvent",
        llm_message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ]),
    ExecutionStatus.RUNNING,
  );

  assertEquals(
    projectExecutionStatus([
      {
        ...base,
        id: "evt-1",
        source: "agent",
        kind: "ActionEvent",
        thought: [],
        tool_name: "bash",
        tool_call_id: "call-1",
        tool_call: { id: "call-1", name: "bash", arguments: "{}" },
        llm_response_id: "resp-1",
      },
    ]),
    ExecutionStatus.RUNNING,
  );

  assertEquals(
    projectExecutionStatus([
      {
        ...base,
        id: "evt-1",
        source: "agent",
        kind: "ActionEvent",
        thought: [],
        tool_name: "bash",
        tool_call_id: "call-1",
        tool_call: { id: "call-1", name: "bash", arguments: "{}" },
        llm_response_id: "resp-1",
      },
      {
        ...base,
        id: "evt-2",
        source: "user",
        kind: "PauseEvent",
      },
    ]),
    ExecutionStatus.PAUSED,
  );

  assertEquals(
    projectExecutionStatus([
      {
        ...base,
        id: "evt-1",
        source: "environment",
        kind: "ConversationErrorEvent",
        code: "llm_error",
        detail: "boom",
      },
    ]),
    ExecutionStatus.ERROR,
  );

  assertEquals(
    projectExecutionStatus([
      {
        ...base,
        id: "evt-1",
        source: "environment",
        kind: "ConversationStateUpdateEvent",
        key: "execution_status",
        value: ExecutionStatus.WAITING_FOR_CONFIRMATION,
      },
    ]),
    ExecutionStatus.WAITING_FOR_CONFIRMATION,
  );
});
