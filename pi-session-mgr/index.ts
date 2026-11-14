import { connect, type Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ReducerAgentSessionEvent } from "../reducer.ts";

export default function abcSessionExtension(pi: ExtensionAPI): void {
  pi.registerFlag("abcd-socket", {
    description: "Path to abcd Unix domain socket",
    type: "string",
  });
  pi.registerFlag("event-log", {
    description: "Path to OpenHands EventLog JSONL (abc/<id>.jsonl)",
    type: "string",
  });
  pi.registerFlag("card-id", {
    description: "Card ID for deterministic OpenHands event IDs",
    type: "string",
  });

  let socket: Socket | undefined;
  let eventLogPath: string | undefined;
  let cardId: string | undefined;

  async function ensureConnected(ctx: ExtensionContext): Promise<void> {
    const flagLog = pi.getFlag("event-log");
    const resolvedLog =
      typeof flagLog === "string" && flagLog.length > 0
        ? flagLog
        : process.env.ABC_EVENT_LOG;

    if (!resolvedLog) {
      return;
    }

    if (socket && !socket.destroyed) {
      return;
    }

    const flagSock = pi.getFlag("abcd-socket");
    const socketPath =
      (typeof flagSock === "string" && flagSock.length > 0
        ? flagSock
        : undefined) ?? process.env.ABC_SOCKET;

    if (!socketPath) {
      throw new Error("Fatal precondition: abcd socket not configured (--abcd-socket or ABC_SOCKET)");
    }

    const flagCardId = pi.getFlag("card-id");
    cardId =
      (typeof flagCardId === "string" && flagCardId.length > 0
        ? flagCardId
        : undefined) ??
      process.env.ABC_CARD_ID ??
      ctx.sessionManager.getSessionId();
    eventLogPath = resolvedLog;

    await new Promise<void>((resolve, reject) => {
      const client = connect(socketPath);
      const onError = (err: Error) => {
        client.destroy();
        reject(new Error(`Fatal precondition: abcd unavailable at ${socketPath}: ${err.message}`));
      };
      client.once("error", onError);
      client.once("connect", () => {
        client.off("error", onError);
        client.on("error", (err) => {
          console.error(`[pi-session-mgr] abcd socket error: ${err.message}`);
          process.exit(1);
        });
        socket = client;
        resolve();
      });
    });
  }

  function forward(event: ReducerAgentSessionEvent): void {
    if (!eventLogPath || !cardId) {
      return;
    }
    if (!socket || socket.destroyed) {
      throw new Error("Fatal precondition: lost connection to abcd");
    }
    socket.write(`${JSON.stringify({ cardId, eventLogPath, event })}\n`);
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureConnected(ctx);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

  pi.on("agent_start", (event) => {
    forward(event as unknown as ReducerAgentSessionEvent);
  });

  pi.on("message_end", (event) => {
    forward(event as unknown as ReducerAgentSessionEvent);
  });

  pi.on("tool_execution_end", (event) => {
    forward(event as unknown as ReducerAgentSessionEvent);
  });

  pi.on("agent_settled", (event) => {
    forward(event as unknown as ReducerAgentSessionEvent);
  });
}
