export type SourceType = "agent" | "user" | "environment" | "hook";

export type EventID = string;
export type ToolCallID = string;

export const ROOT_PARENT_ID = "__root__" as const;

export interface BaseEvent {
  id: EventID;
  timestamp: string;
  source: SourceType;
  parent_id: EventID | null;
}

export const ExecutionStatus = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  WAITING_FOR_CONFIRMATION: "waiting_for_confirmation",
  FINISHED: "finished",
  ERROR: "error",
  STUCK: "stuck",
} as const;

export type ExecutionStatus =
  (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

export interface OpenHandsTextContent {
  type: "text";
  text: string;
}

export interface OpenHandsImageContent {
  type: "image";
  image_urls: string[];
}

export type OpenHandsContent = OpenHandsTextContent | OpenHandsImageContent;

export interface OpenHandsMessageToolCall {
  id: ToolCallID;
  name: string;
  arguments: string;
}

export interface OpenHandsMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: OpenHandsContent[];
  tool_calls?: OpenHandsMessageToolCall[] | null;
  tool_call_id?: ToolCallID | null;
  name?: string | null;
  reasoning_content?: string | null;
  thinking_blocks?: unknown[];
}

export interface OpenHandsObservation {
  content: OpenHandsContent[];
  is_error?: boolean;
  [key: string]: unknown;
}

export interface MessageEvent extends BaseEvent {
  kind: "MessageEvent";
  llm_message: OpenHandsMessage;
  llm_response_id?: EventID | null;
  activated_skills?: string[];
  extended_content?: OpenHandsTextContent[];
  sender?: string | null;
}

export interface ActionEvent extends BaseEvent {
  kind: "ActionEvent";
  source: "agent";
  thought: OpenHandsTextContent[];
  reasoning_content?: string | null;
  thinking_blocks?: unknown[];
  action?: Record<string, unknown> | null;
  tool_name: string;
  tool_call_id: ToolCallID;
  tool_call: OpenHandsMessageToolCall;
  llm_response_id: EventID;
}

export interface ObservationEvent extends BaseEvent {
  kind: "ObservationEvent";
  source: "environment";
  tool_name: string;
  tool_call_id: ToolCallID;
  observation: OpenHandsObservation;
  action_id: EventID;
  extended_content?: OpenHandsTextContent[];
}

export interface AgentErrorEvent extends BaseEvent {
  kind: "AgentErrorEvent";
  source: "agent";
  tool_name: string;
  tool_call_id: ToolCallID;
  error: string;
}

export interface PauseEvent extends BaseEvent {
  kind: "PauseEvent";
  source: "user";
}

export interface InterruptEvent extends BaseEvent {
  kind: "InterruptEvent";
  source: "user";
}

export interface ConversationErrorEvent extends BaseEvent {
  kind: "ConversationErrorEvent";
  code: string;
  detail: string;
}

export interface ConversationStateUpdateEvent extends BaseEvent {
  kind: "ConversationStateUpdateEvent";
  key: string;
  value: unknown;
}

export interface GenericEvent extends BaseEvent {
  kind: string;
  [key: string]: unknown;
}

export type EmittedOpenHandsEvent =
  | MessageEvent
  | ActionEvent
  | ObservationEvent
  | AgentErrorEvent
  | PauseEvent
  | InterruptEvent
  | ConversationErrorEvent
  | ConversationStateUpdateEvent;

export type OpenHandsEvent = EmittedOpenHandsEvent | GenericEvent;

const VALID_SOURCES: ReadonlySet<string> = new Set<SourceType>([
  "agent",
  "user",
  "environment",
  "hook",
]);

const VALID_STATUSES: ReadonlySet<string> = new Set<string>(
  Object.values(ExecutionStatus),
);

const VALID_MESSAGE_ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "system",
  "tool",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the common v1.62.0 event envelope (id, timestamp, source, parent_id, kind).
 * Used for both reading logs (where unknown `kind`s are tolerated) and emitting events.
 */
export function validateEventEnvelope(
  event: unknown,
): event is BaseEvent & { kind: string } {
  if (!isPlainObject(event)) {
    return false;
  }
  if (!isNonEmptyString(event.id) || event.id === ROOT_PARENT_ID) {
    return false;
  }
  if (!isNonEmptyString(event.timestamp)) {
    return false;
  }
  if (typeof event.source !== "string" || !VALID_SOURCES.has(event.source)) {
    return false;
  }
  if (event.parent_id !== null && !isNonEmptyString(event.parent_id)) {
    return false;
  }
  if (!isNonEmptyString(event.kind)) {
    return false;
  }
  return true;
}

function isValidContentItem(item: unknown): boolean {
  if (!isPlainObject(item)) {
    return false;
  }
  if (item.type === "text") {
    return typeof item.text === "string";
  }
  if (item.type === "image") {
    return Array.isArray(item.image_urls);
  }
  return false;
}

function isValidTextContentArray(value: unknown): value is OpenHandsTextContent[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isPlainObject(item) && item.type === "text" && typeof item.text === "string")
  );
}

/**
 * Strictly validates an event being emitted against v1.62.0 OpenHands schemas.
 * Unknown event kinds are rejected on emit.
 */
export function validateEmittedEvent(
  event: unknown,
): event is EmittedOpenHandsEvent {
  if (!validateEventEnvelope(event)) {
    return false;
  }

  const record = event as unknown as Record<string, unknown>;

  switch (event.kind) {
    case "MessageEvent": {
      if (!isPlainObject(record.llm_message)) {
        return false;
      }
      const msg = record.llm_message;
      if (typeof msg.role !== "string" || !VALID_MESSAGE_ROLES.has(msg.role)) {
        return false;
      }
      if (!Array.isArray(msg.content) || !msg.content.every(isValidContentItem)) {
        return false;
      }
      if (
        record.llm_response_id !== undefined &&
        record.llm_response_id !== null &&
        !isNonEmptyString(record.llm_response_id)
      ) {
        return false;
      }
      return true;
    }

    case "ActionEvent": {
      if (event.source !== "agent") {
        return false;
      }
      if (!isValidTextContentArray(record.thought)) {
        return false;
      }
      if (!isNonEmptyString(record.tool_name)) {
        return false;
      }
      if (!isNonEmptyString(record.tool_call_id)) {
        return false;
      }
      if (!isPlainObject(record.tool_call)) {
        return false;
      }
      const tc = record.tool_call;
      if (
        !isNonEmptyString(tc.id) ||
        !isNonEmptyString(tc.name) ||
        typeof tc.arguments !== "string"
      ) {
        return false;
      }
      if (!isNonEmptyString(record.llm_response_id)) {
        return false;
      }
      return true;
    }

    case "ObservationEvent": {
      if (event.source !== "environment") {
        return false;
      }
      if (!isNonEmptyString(record.tool_name)) {
        return false;
      }
      if (!isNonEmptyString(record.tool_call_id)) {
        return false;
      }
      if (!isNonEmptyString(record.action_id)) {
        return false;
      }
      if (!isPlainObject(record.observation)) {
        return false;
      }
      if (
        !Array.isArray(record.observation.content) ||
        !record.observation.content.every(isValidContentItem)
      ) {
        return false;
      }
      return true;
    }

    case "AgentErrorEvent": {
      if (event.source !== "agent") {
        return false;
      }
      if (!isNonEmptyString(record.tool_name)) {
        return false;
      }
      if (!isNonEmptyString(record.tool_call_id)) {
        return false;
      }
      if (!isNonEmptyString(record.error)) {
        return false;
      }
      return true;
    }

    case "ConversationErrorEvent": {
      if (!isNonEmptyString(record.code)) {
        return false;
      }
      if (!isNonEmptyString(record.detail)) {
        return false;
      }
      return true;
    }

    case "ConversationStateUpdateEvent": {
      if (!isNonEmptyString(record.key)) {
        return false;
      }
      if (!("value" in record)) {
        return false;
      }
      return true;
    }

    case "PauseEvent":
    case "InterruptEvent": {
      return event.source === "user";
    }

    default:
      return false;
  }
}

/**
 * Parses JSONL content into OpenHands events.
 * Tolerates unknown event kinds on read, while rejecting invalid envelopes.
 */
export function parseEventLog(jsonl: string): OpenHandsEvent[] {
  const events: OpenHandsEvent[] = [];
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    if (!validateEventEnvelope(parsed)) {
      throw new Error(`Invalid OpenHands event envelope in log: ${line}`);
    }
    events.push(parsed as OpenHandsEvent);
  }
  return events;
}

function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return typeof value === "string" && VALID_STATUSES.has(value);
}

export function projectExecutionStatus(
  events: readonly OpenHandsEvent[],
): ExecutionStatus {
  let status: ExecutionStatus = ExecutionStatus.IDLE;

  for (const event of events) {
    switch (event.kind) {
      case "MessageEvent":
      case "ActionEvent":
        status = ExecutionStatus.RUNNING;
        break;
      case "PauseEvent":
      case "InterruptEvent":
        status = ExecutionStatus.PAUSED;
        break;
      case "ConversationErrorEvent":
        status = ExecutionStatus.ERROR;
        break;
      case "ConversationStateUpdateEvent": {
        if (event.key === "execution_status" && isExecutionStatus(event.value)) {
          status = event.value;
        } else if (
          event.key === "full_state" &&
          typeof event.value === "object" &&
          event.value !== null &&
          "execution_status" in event.value &&
          isExecutionStatus(
            (event.value as { execution_status: unknown }).execution_status,
          )
        ) {
          status = (event.value as { execution_status: ExecutionStatus })
            .execution_status;
        }
        break;
      }
      default:
        break;
    }
  }

  return status;
}
