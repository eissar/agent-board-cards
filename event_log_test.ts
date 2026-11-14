import { assertEquals } from "@std/assert";
import {
  type BaseEvent,
  ExecutionStatus,
  projectExecutionStatus,
  ROOT_PARENT_ID,
  validateEventEnvelope,
} from "./event_log.ts";

Deno.test("BaseEvent envelope rejects reserved ROOT_PARENT_ID as event id", () => {
  const invalid: BaseEvent = {
    id: ROOT_PARENT_ID,
    timestamp: "2026-11-14T18:00:00.000Z",
    source: "agent",
    parent_id: null,
  };
  assertEquals(validateEventEnvelope(invalid), false);
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
        tool_call_id: "call-1",
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
        tool_call_id: "call-1",
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
