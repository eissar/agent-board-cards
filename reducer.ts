import {
  type ActionEvent,
  type AgentErrorEvent,
  type ConversationErrorEvent,
  type ConversationStateUpdateEvent,
  type EmittedOpenHandsEvent,
  ExecutionStatus,
  type InterruptEvent,
  type MessageEvent,
  type ObservationEvent,
  type OpenHandsContent,
  type OpenHandsEvent,
  type OpenHandsObservation,
  type OpenHandsTextContent,
  type SourceType,
  validateEmittedEvent,
} from "./event_log.ts";

export interface ReducerTextContent {
  type: "text";
  text: string;
}

export interface ReducerImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ReducerThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ReducerToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ReducerMessage =
  | {
    role: "user";
    content: string | readonly (ReducerTextContent | ReducerImageContent)[];
    timestamp?: number;
  }
  | {
    role: "assistant";
    content: readonly (
      | ReducerTextContent
      | ReducerThinkingContent
      | ReducerToolCallContent
    )[];
    stopReason?: string;
    errorMessage?: string;
    rawStopReason?: string;
    responseId?: string;
    timestamp?: number;
  }
  | {
    role: string;
    [key: string]: unknown;
  };

export type ReducerAgentSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: readonly unknown[]; willRetry?: boolean }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "message_start"; message: ReducerMessage }
  | { type: "message_update"; message: ReducerMessage; assistantMessageEvent?: unknown }
  | { type: "message_end"; message: ReducerMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | {
    type: "tool_execution_update";
    toolCallId: string;
    toolName: string;
    args?: unknown;
    partialResult?: unknown;
  }
  | {
    type: "tool_execution_end";
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
  }
  | {
    type: "auto_retry_end";
    success: boolean;
    attempt: number;
    finalError?: string;
  }
  | { type: string; [key: string]: unknown };

export interface UIContextLike {
  confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  select(
    title: string,
    options: string[],
    opts?: unknown,
  ): Promise<string | undefined>;
}

export interface OpenHandsReducerOptions {
  cardId: string;
  initialEvents?: readonly OpenHandsEvent[];
  now?: () => number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toOpenHandsContent(
  content: string | readonly (ReducerTextContent | ReducerImageContent)[],
): OpenHandsContent[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const out: OpenHandsContent[] = [];
  for (const part of content) {
    if (part.type === "text") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      out.push({
        type: "image",
        image_urls: [`data:${part.mimeType};base64,${part.data}`],
      });
    }
  }
  return out;
}

function extractErrorText(result: unknown): string {
  if (typeof result === "string" && result.length > 0) {
    return result;
  }
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const texts: string[] = [];
      for (const item of record.content) {
        if (
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          texts.push((item as { text: string }).text);
        }
      }
      const joined = texts.join("\n").trim();
      if (joined.length > 0) {
        return joined;
      }
    }
    if (typeof record.error === "string" && record.error.length > 0) {
      return record.error;
    }
    if (typeof record.message === "string" && record.message.length > 0) {
      return record.message;
    }
    try {
      const serialized = JSON.stringify(result);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // fall through
    }
  }
  return "Tool execution failed";
}

function toObservation(result: unknown): OpenHandsObservation {
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const content: OpenHandsContent[] = [];
      for (const item of record.content) {
        if (typeof item !== "object" || item === null) {
          continue;
        }
        const block = item as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        } else if (
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        ) {
          content.push({
            type: "image",
            image_urls: [`data:${block.mimeType};base64,${block.data}`],
          });
        }
      }
      return { content, is_error: false };
    }
  }
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }], is_error: false };
  }
  if (result === undefined) {
    return { content: [{ type: "text", text: "" }], is_error: false };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    is_error: false,
  };
}

export class OpenHandsReducer {
  private readonly cardId: string;
  private readonly now: () => number;
  private seq = 0;
  private lastEventId: string | null = null;
  private lastTimestampMs = 0;
  private responseCounter = 0;
  private readonly toolCallToActionId = new Map<string, string>();
  private rememberedError: { code: string; detail: string } | null = null;

  constructor(options: OpenHandsReducerOptions) {
    if (!options.cardId) {
      throw new Error("cardId must be non-empty");
    }
    this.cardId = options.cardId;
    this.now = options.now ?? Date.now;

    if (options.initialEvents && options.initialEvents.length > 0) {
      const idPattern = new RegExp(`^${escapeRegExp(this.cardId)}-(\\d+)$`);
      let maxSeq = options.initialEvents.length;

      for (const evt of options.initialEvents) {
        const match = idPattern.exec(evt.id);
        if (match) {
          const parsed = Number.parseInt(match[1], 10);
          if (Number.isFinite(parsed) && parsed > maxSeq) {
            maxSeq = parsed;
          }
        }
        if (evt.kind === "ActionEvent") {
          const actionEvt = evt as ActionEvent;
          if (actionEvt.tool_call_id && actionEvt.id) {
            this.toolCallToActionId.set(actionEvt.tool_call_id, actionEvt.id);
          }
        }
        const parsedTs = Date.parse(evt.timestamp);
        if (Number.isFinite(parsedTs) && parsedTs > this.lastTimestampMs) {
          this.lastTimestampMs = parsedTs;
        }
        this.lastEventId = evt.id;
      }
      this.seq = maxSeq;
    }
  }

  getSeq(): number {
    return this.seq;
  }

  getLastEventId(): string | null {
    return this.lastEventId;
  }

  getToolCallActionId(toolCallId: string): string | undefined {
    return this.toolCallToActionId.get(toolCallId);
  }

  private nextEvent<T extends EmittedOpenHandsEvent>(
    eventFields: Omit<T, "id" | "timestamp" | "parent_id"> & { source: SourceType },
  ): T {
    this.seq += 1;
    const id = `${this.cardId}-${this.seq}`;
    const parentId = this.lastEventId;
    const rawNow = this.now();
    const tsMs = rawNow > this.lastTimestampMs ? rawNow : this.lastTimestampMs + 1;
    const timestamp = new Date(tsMs).toISOString();

    const event = {
      ...eventFields,
      id,
      timestamp,
      parent_id: parentId,
    } as unknown as T;

    if (!validateEmittedEvent(event)) {
      throw new Error(
        `Emitted event failed strict v1.62.0 validation: ${JSON.stringify(event)}`,
      );
    }

    this.lastEventId = id;
    this.lastTimestampMs = tsMs;
    return event;
  }

  emitWaitingForConfirmation(): ConversationStateUpdateEvent {
    return this.nextEvent<ConversationStateUpdateEvent>({
      kind: "ConversationStateUpdateEvent",
      source: "environment",
      key: "execution_status",
      value: ExecutionStatus.WAITING_FOR_CONFIRMATION,
    });
  }

  emitResumedRunning(): ConversationStateUpdateEvent {
    return this.nextEvent<ConversationStateUpdateEvent>({
      kind: "ConversationStateUpdateEvent",
      source: "environment",
      key: "execution_status",
      value: ExecutionStatus.RUNNING,
    });
  }

  wrapUIContext<T extends UIContextLike>(
    uiContext: T,
    onEmit?: (event: EmittedOpenHandsEvent) => void,
  ): T {
    const emit = (evt: EmittedOpenHandsEvent) => {
      onEmit?.(evt);
    };

    return {
      ...uiContext,
      confirm: async (title: string, message: string, opts?: unknown) => {
        emit(this.emitWaitingForConfirmation());
        try {
          return await uiContext.confirm(title, message, opts);
        } finally {
          emit(this.emitResumedRunning());
        }
      },
      select: async (title: string, options: string[], opts?: unknown) => {
        emit(this.emitWaitingForConfirmation());
        try {
          return await uiContext.select(title, options, opts);
        } finally {
          emit(this.emitResumedRunning());
        }
      },
    };
  }

  reduce(event: ReducerAgentSessionEvent): EmittedOpenHandsEvent[] {
    switch (event.type) {
      case "message_update":
      case "tool_execution_update":
      case "tool_execution_start":
      case "agent_end":
        return [];

      case "agent_start": {
        this.rememberedError = null;
        return [
          this.nextEvent<ConversationStateUpdateEvent>({
            kind: "ConversationStateUpdateEvent",
            source: "environment",
            key: "execution_status",
            value: ExecutionStatus.RUNNING,
          }),
        ];
      }

      case "message_end": {
        const msg = event.message as ReducerMessage;
        if (!msg) {
          return [];
        }

        if (msg.role === "user") {
          const userMsg = msg as Extract<ReducerMessage, { role: "user" }>;
          return [
            this.nextEvent<MessageEvent>({
              kind: "MessageEvent",
              source: "user",
              llm_message: {
                role: "user",
                content: toOpenHandsContent(userMsg.content),
              },
              llm_response_id: null,
            }),
          ];
        }

        if (msg.role === "assistant") {
          const assistantMsg = msg as Extract<
            ReducerMessage,
            { role: "assistant" }
          >;

          if (assistantMsg.stopReason === "error") {
            this.rememberedError = {
              code:
                typeof assistantMsg.rawStopReason === "string" &&
                  assistantMsg.rawStopReason.length > 0
                  ? assistantMsg.rawStopReason
                  : "llm_error",
              detail:
                typeof assistantMsg.errorMessage === "string" &&
                  assistantMsg.errorMessage.length > 0
                  ? assistantMsg.errorMessage
                  : "Assistant turn failed with stopReason=error",
            };
            return [];
          }

          if (assistantMsg.stopReason === "aborted") {
            return [];
          }

          // Successful assistant turn clears any remembered error from a prior failed attempt.
          this.rememberedError = null;

          const blocks = Array.isArray(assistantMsg.content)
            ? assistantMsg.content
            : [];
          const toolCalls: ReducerToolCallContent[] = [];
          const thought: OpenHandsTextContent[] = [];
          const thinkingTexts: string[] = [];
          const thinkingBlocks: ReducerThinkingContent[] = [];

          for (const block of blocks) {
            if (block.type === "toolCall") {
              toolCalls.push(block);
            } else if (block.type === "text") {
              if (block.text.length > 0) {
                thought.push({ type: "text", text: block.text });
              }
            } else if (block.type === "thinking") {
              thinkingBlocks.push(block);
              if (block.thinking.length > 0) {
                thinkingTexts.push(block.thinking);
              }
            }
          }

          if (toolCalls.length > 0) {
            this.responseCounter += 1;
            const llmResponseId =
              typeof assistantMsg.responseId === "string" &&
                assistantMsg.responseId.length > 0
                ? assistantMsg.responseId
                : `${this.cardId}-resp-${this.responseCounter}`;
            const reasoningContent =
              thinkingTexts.length > 0 ? thinkingTexts.join("\n") : null;

            const emitted: ActionEvent[] = [];
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i];
              const actionEvent = this.nextEvent<ActionEvent>({
                kind: "ActionEvent",
                source: "agent",
                thought: i === 0 ? thought : [],
                reasoning_content: i === 0 ? reasoningContent : null,
                thinking_blocks: i === 0 ? thinkingBlocks : [],
                action: null,
                tool_name: tc.name,
                tool_call_id: tc.id,
                tool_call: {
                  id: tc.id,
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments ?? {}),
                },
                llm_response_id: llmResponseId,
              });
              this.toolCallToActionId.set(tc.id, actionEvent.id);
              emitted.push(actionEvent);
            }
            return emitted;
          }

          const messageContent: OpenHandsContent[] = thought.length > 0
            ? thought
            : [{ type: "text", text: "" }];

          return [
            this.nextEvent<MessageEvent>({
              kind: "MessageEvent",
              source: "agent",
              llm_message: {
                role: "assistant",
                content: messageContent,
              },
              llm_response_id:
                typeof assistantMsg.responseId === "string" &&
                  assistantMsg.responseId.length > 0
                  ? assistantMsg.responseId
                  : null,
            }),
          ];
        }

        return [];
      }

      case "tool_execution_end": {
        const toolEvent = event as Extract<
          ReducerAgentSessionEvent,
          { type: "tool_execution_end" }
        >;
        if (toolEvent.isError) {
          return [
            this.nextEvent<AgentErrorEvent>({
              kind: "AgentErrorEvent",
              source: "agent",
              tool_name: toolEvent.toolName,
              tool_call_id: toolEvent.toolCallId,
              error: extractErrorText(toolEvent.result),
            }),
          ];
        }

        const actionId =
          this.toolCallToActionId.get(toolEvent.toolCallId) ??
          toolEvent.toolCallId;
        return [
          this.nextEvent<ObservationEvent>({
            kind: "ObservationEvent",
            source: "environment",
            tool_name: toolEvent.toolName,
            tool_call_id: toolEvent.toolCallId,
            action_id: actionId,
            observation: toObservation(toolEvent.result),
          }),
        ];
      }

      case "auto_retry_end": {
        const retryEvent = event as Extract<
          ReducerAgentSessionEvent,
          { type: "auto_retry_end" }
        >;
        if (retryEvent.success) {
          this.rememberedError = null;
        } else if (!this.rememberedError && retryEvent.finalError) {
          this.rememberedError = {
            code: "auto_retry_exhausted",
            detail: retryEvent.finalError,
          };
        }
        return [];
      }

      case "agent_settled": {
        const settled = event as Extract<
          ReducerAgentSessionEvent,
          { type: "agent_settled" }
        >;
        if (settled.aborted) {
          this.rememberedError = null;
          return [
            this.nextEvent<InterruptEvent>({
              kind: "InterruptEvent",
              source: "user",
            }),
          ];
        }

        if (this.rememberedError) {
          const err = this.rememberedError;
          this.rememberedError = null;
          return [
            this.nextEvent<ConversationErrorEvent>({
              kind: "ConversationErrorEvent",
              source: "environment",
              code: err.code,
              detail: err.detail,
            }),
            this.nextEvent<ConversationStateUpdateEvent>({
              kind: "ConversationStateUpdateEvent",
              source: "environment",
              key: "execution_status",
              value: ExecutionStatus.ERROR,
            }),
          ];
        }

        return [
          this.nextEvent<ConversationStateUpdateEvent>({
            kind: "ConversationStateUpdateEvent",
            source: "environment",
            key: "execution_status",
            value: ExecutionStatus.FINISHED,
          }),
        ];
      }

      default:
        return [];
    }
  }
}
