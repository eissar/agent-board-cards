import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type EmittedOpenHandsEvent,
  type OpenHandsEvent,
  parseEventLog,
} from "../event_log.ts";
import {
  OpenHandsReducer,
  type ReducerAgentSessionEvent,
} from "../reducer.ts";

function appendEvents(
  eventLogPath: string,
  emitted: readonly EmittedOpenHandsEvent[],
): void {
  if (emitted.length === 0) {
    return;
  }
  mkdirSync(dirname(eventLogPath), { recursive: true });
  const fd = openSync(eventLogPath, "a");
  try {
    const payload = emitted.map((evt) => `${JSON.stringify(evt)}\n`).join("");
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export default function abcSessionExtension(pi: ExtensionAPI): void {
  pi.registerFlag("event-log", {
    description: "Path to OpenHands EventLog JSONL (abc/<id>.jsonl)",
    type: "string",
  });
  pi.registerFlag("card-id", {
    description: "Card ID for deterministic OpenHands event IDs",
    type: "string",
  });

  let eventLogPath: string | undefined;
  let reducer: OpenHandsReducer | undefined;

  function ensureInitialized(ctx: ExtensionContext): boolean {
    if (reducer && eventLogPath) {
      return true;
    }

    const flagLog = pi.getFlag("event-log");
    const resolvedLog =
      typeof flagLog === "string" && flagLog.length > 0
        ? flagLog
        : process.env.ABC_EVENT_LOG;

    if (!resolvedLog) {
      return false;
    }

    const flagCardId = pi.getFlag("card-id");
    const cardId =
      (typeof flagCardId === "string" && flagCardId.length > 0
        ? flagCardId
        : undefined) ??
      process.env.ABC_CARD_ID ??
      ctx.sessionManager.getSessionId();

    const initialEvents: OpenHandsEvent[] = [];
    if (existsSync(resolvedLog)) {
      const content = readFileSync(resolvedLog, "utf8");
      if (content.trim().length > 0) {
        initialEvents.push(...parseEventLog(content));
      }
    }

    eventLogPath = resolvedLog;
    reducer = new OpenHandsReducer({ cardId, initialEvents });
    return true;
  }

  function handle(
    event: ReducerAgentSessionEvent,
    ctx: ExtensionContext,
  ): void {
    if (!ensureInitialized(ctx) || !reducer || !eventLogPath) {
      return;
    }
    const emitted = reducer.reduce(event);
    appendEvents(eventLogPath, emitted);
  }

  pi.on("session_start", (_event, ctx) => {
    reducer = undefined;
    eventLogPath = undefined;
    ensureInitialized(ctx);
  });

  pi.on("agent_start", (event, ctx) => {
    handle(event as unknown as ReducerAgentSessionEvent, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    handle(event as unknown as ReducerAgentSessionEvent, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    handle(event as unknown as ReducerAgentSessionEvent, ctx);
  });

  pi.on("agent_settled", (event, ctx) => {
    handle(event as unknown as ReducerAgentSessionEvent, ctx);
  });
}
