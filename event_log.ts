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

export enum ExecutionStatus {
  IDLE = "idle",
  RUNNING = "running",
  PAUSED = "paused",
  WAITING_FOR_CONFIRMATION = "waiting_for_confirmation",
  FINISHED = "finished",
  ERROR = "error",
  STUCK = "stuck",
}

export interface MessageEvent extends BaseEvent {
  kind: "MessageEvent";
}

export interface ActionEvent extends BaseEvent {
  kind: "ActionEvent";
  tool_call_id: ToolCallID;
}

export interface PauseEvent extends BaseEvent {
  kind: "PauseEvent";
}

export interface InterruptEvent extends BaseEvent {
  kind: "InterruptEvent";
}

export interface ConversationErrorEvent extends BaseEvent {
  kind: "ConversationErrorEvent";
  code?: string;
  detail?: string;
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

export type OpenHandsEvent =
  | MessageEvent
  | ActionEvent
  | PauseEvent
  | InterruptEvent
  | ConversationErrorEvent
  | ConversationStateUpdateEvent
  | GenericEvent;

const VALID_SOURCES: ReadonlySet<string> = new Set<SourceType>([
  "agent",
  "user",
  "environment",
  "hook",
]);

const VALID_STATUSES: ReadonlySet<string> = new Set<string>(
  Object.values(ExecutionStatus),
);

export function validateEventEnvelope(event: BaseEvent): boolean {
  if (typeof event.id !== "string" || event.id.length === 0) {
    return false;
  }
  if (event.id === ROOT_PARENT_ID) {
    return false;
  }
  if (typeof event.timestamp !== "string" || event.timestamp.length === 0) {
    return false;
  }
  if (!VALID_SOURCES.has(event.source)) {
    return false;
  }
  if (
    event.parent_id !== null &&
    (typeof event.parent_id !== "string" || event.parent_id.length === 0)
  ) {
    return false;
  }
  return true;
}

function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return typeof value === "string" && VALID_STATUSES.has(value);
}

export function projectExecutionStatus(
  events: readonly OpenHandsEvent[],
): ExecutionStatus {
  let status = ExecutionStatus.IDLE;

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
