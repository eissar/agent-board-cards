import { expect, test } from "bun:test";
import {
  ExecutionStatus,
  parseEventLog,
  projectExecutionStatus,
  ROOT_PARENT_ID,
  validateEmittedEvent,
  validateEventEnvelope,
} from "./event_log.ts";

test("validateEventEnvelope rejects reserved ROOT_PARENT_ID as event id", () => {
  const invalid = {
    id: ROOT_PARENT_ID,
    timestamp: "2026-11-14T18:00:00.000Z",
    source: "agent",
    parent_id: null,
    kind: "MessageEvent",
  };
  expect(validateEventEnvelope(invalid)).toBe(false);
});

test("validateEventEnvelope rejects missing or empty kind", () => {
  const base = {
    id: "evt-1",
    timestamp: "2026-11-14T18:00:00.000Z",
    source: "agent",
    parent_id: null,
  };
  expect(validateEventEnvelope(base)).toBe(false);
  expect(validateEventEnvelope({ ...base, kind: "" })).toBe(false);
  expect(validateEventEnvelope({ ...base, kind: "FutureUnknownEvent" })).toBe(
    true,
  );
});

test("validateEmittedEvent enforces strict v1.62.0 schemas and rejects unknown kinds", () => {
  const base = {
    id: "evt-1",
    timestamp: "2026-11-14T18:00:00.000Z",
    parent_id: null,
  };

  expect(
    validateEmittedEvent({
      ...base,
      source: "agent",
      kind: "CustomUnknownEvent",
    }),
  ).toBe(false);

  expect(
    validateEmittedEvent({
      ...base,
      source: "environment",
      kind: "ConversationErrorEvent",
    }),
  ).toBe(false);

  expect(
    validateEmittedEvent({
      ...base,
      source: "environment",
      kind: "ConversationErrorEvent",
      code: "rate_limit",
      detail: "429 Too Many Requests",
    }),
  ).toBe(true);

  expect(
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
  ).toBe(true);

  expect(
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
  ).toBe(true);

  expect(
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
  ).toBe(true);
});

test("parseEventLog tolerates unknown event kinds on read but rejects invalid envelopes", () => {
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
  expect(parsed.length).toBe(1);
  expect(parsed[0].kind).toBe("SomeFutureEvent");

  expect(() =>
    parseEventLog(
      JSON.stringify({
        id: "evt-1",
        timestamp: "2026-11-14T18:00:00.000Z",
        source: "environment",
        parent_id: null,
      }),
    )
  ).toThrow();
});

test("projectExecutionStatus folds OpenHands-style events into ExecutionStatus", () => {
  const base = {
    timestamp: "2026-11-14T18:00:00.000Z",
    parent_id: null,
  };

  expect(projectExecutionStatus([])).toBe(ExecutionStatus.IDLE);

  expect(
    projectExecutionStatus([
      {
        ...base,
        id: "evt-1",
        source: "user",
        kind: "MessageEvent",
        llm_message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ]),
  ).toBe(ExecutionStatus.RUNNING);

  expect(
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
  ).toBe(ExecutionStatus.RUNNING);

  expect(
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
  ).toBe(ExecutionStatus.PAUSED);

  expect(
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
  ).toBe(ExecutionStatus.ERROR);

  expect(
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
  ).toBe(ExecutionStatus.WAITING_FOR_CONFIRMATION);
});

// Adapted from OpenHands/software-agent-sdk v1.62.0:
// tests/sdk/event/test_event_serialization.py
test("OpenHands v1.62.0 event serialization round-trip (MessageEvent, ActionEvent, ObservationEvent, AgentErrorEvent)", () => {
  const base = {
    id: "evt-1",
    timestamp: "2026-11-14T18:00:00.000Z",
    parent_id: null,
  };

  const events = [
    {
      ...base,
      source: "user" as const,
      kind: "MessageEvent" as const,
      llm_message: {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Hello There!" }],
      },
      activated_skills: [],
      extended_content: [],
    },
    {
      ...base,
      id: "evt-2",
      parent_id: "evt-1",
      source: "agent" as const,
      kind: "ActionEvent" as const,
      thought: [{ type: "text" as const, text: "I need to do something" }],
      action: { path: "README.md" },
      tool_name: "mock_tool",
      tool_call_id: "call_123",
      tool_call: {
        id: "call_123",
        name: "mock_tool",
        arguments: "{}",
      },
      llm_response_id: "response_456",
    },
    {
      ...base,
      id: "evt-3",
      parent_id: "evt-2",
      source: "environment" as const,
      kind: "ObservationEvent" as const,
      observation: {
        content: [{ type: "text" as const, text: "test result" }],
      },
      action_id: "evt-2",
      tool_name: "mock_tool",
      tool_call_id: "call_123",
    },
    {
      ...base,
      id: "evt-4",
      parent_id: "evt-3",
      source: "agent" as const,
      kind: "AgentErrorEvent" as const,
      error: "Something went wrong",
      tool_call_id: "call_001",
      tool_name: "test_tool",
    },
  ];

  for (const evt of events) {
    expect(validateEmittedEvent(evt)).toBe(true);
  }

  const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
  const parsed = parseEventLog(jsonl);
  expect(parsed).toEqual(events);
  for (const evt of parsed) {
    expect(validateEmittedEvent(evt)).toBe(true);
  }
});

// Adapted from OpenHands/software-agent-sdk v1.62.0:
// tests/sdk/event/test_event_serialization.py::test_extra_fields_forbidden
test("OpenHands v1.62.0 extra fields forbidden on emit, tolerated on read", () => {
  const withExtra = {
    id: "evt-1",
    timestamp: "2026-11-14T18:00:00.000Z",
    source: "user",
    parent_id: null,
    kind: "MessageEvent",
    llm_message: {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
    extra_field: "should_not_be_allowed",
  };

  expect(validateEmittedEvent(withExtra)).toBe(false);
  expect(parseEventLog(JSON.stringify(withExtra))).toEqual([withExtra]);
});

// Adapted from OpenHands/software-agent-sdk v1.62.0:
// tests/sdk/conversation/test_conversation_execution_status_enum.py
test("OpenHands v1.62.0 ExecutionStatus enum values and JSON round-trip", () => {
  expect(ExecutionStatus.IDLE).toBe("idle");
  expect(ExecutionStatus.RUNNING).toBe("running");
  expect(ExecutionStatus.PAUSED).toBe("paused");
  expect(ExecutionStatus.WAITING_FOR_CONFIRMATION).toBe(
    "waiting_for_confirmation",
  );
  expect(ExecutionStatus.FINISHED).toBe("finished");
  expect(ExecutionStatus.ERROR).toBe("error");
  expect(ExecutionStatus.STUCK).toBe("stuck");

  for (const status of [
    ExecutionStatus.FINISHED,
    ExecutionStatus.PAUSED,
    ExecutionStatus.WAITING_FOR_CONFIRMATION,
    ExecutionStatus.ERROR,
  ]) {
    const evt = {
      id: "evt-status",
      timestamp: "2026-11-14T18:00:00.000Z",
      source: "environment" as const,
      parent_id: null,
      kind: "ConversationStateUpdateEvent" as const,
      key: "execution_status",
      value: status,
    };
    const roundTripped = parseEventLog(JSON.stringify(evt));
    expect(projectExecutionStatus(roundTripped)).toBe(status);
  }
});
