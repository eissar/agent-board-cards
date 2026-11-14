import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type ExtensionUIContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AbcSessionManager } from "./pi-session-mgr/session_manager.ts";

export const DEFAULT_CARD_PROMPT =
  "start by reading abc/PLAN.md and execute on the contents. note: abc/ is gitignored.";

export interface RunCardOptions {
  cwd: string;
  sessionDir: string;
  sessionId: string;
  eventLogPath: string;
  prompt?: string;
  uiContext?: ExtensionUIContext;
  sessionOptions?: Omit<CreateAgentSessionOptions, "cwd" | "sessionManager">;
}

function createHeadlessUIContext(): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingIndicator: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    setEditorComponent: () => {},
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    theme: {} as ExtensionUIContext["theme"],
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Headless runner" }),
  };
}

export async function runCard(options: RunCardOptions): Promise<{
  sessionManager: AbcSessionManager;
}> {
  const sessionManager = AbcSessionManager.openOrCreate({
    cwd: options.cwd,
    sessionDir: options.sessionDir,
    sessionId: options.sessionId,
    eventLogPath: options.eventLogPath,
  });

  const { session } = await createAgentSession({
    ...options.sessionOptions,
    cwd: options.cwd,
    sessionManager: sessionManager as unknown as SessionManager,
  });

  const unsubscribe = sessionManager.attachToSession(session);

  try {
    const baseUiContext = options.uiContext ?? createHeadlessUIContext();
    await session.bindExtensions({
      uiContext: sessionManager.wrapUIContext(baseUiContext),
      onError: (err) => {
        console.error(
          `[abc-runner] extension error (${err.extensionPath}): ${err.error}`,
        );
      },
    });

    const prompt = options.prompt ?? DEFAULT_CARD_PROMPT;
    await session.prompt(prompt);
  } finally {
    unsubscribe();
    session.dispose();
  }

  return { sessionManager };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "session-dir": { type: "string" },
      "session-id": { type: "string" },
      "event-log": { type: "string" },
      cwd: { type: "string" },
      prompt: { type: "string" },
    },
    strict: true,
  });

  const sessionDir = values["session-dir"];
  const sessionId = values["session-id"];
  const eventLogPath = values["event-log"];

  if (!sessionDir || !sessionId || !eventLogPath) {
    console.error(
      "Usage: runner.ts --session-dir <dir> --session-id <id> --event-log <path> [--cwd <dir>] [--prompt <text>]",
    );
    process.exitCode = 2;
    return;
  }

  await runCard({
    cwd: resolve(values.cwd ?? process.cwd()),
    sessionDir: resolve(sessionDir),
    sessionId,
    eventLogPath: resolve(eventLogPath),
    prompt: values.prompt,
  });
}

if (
  import.meta.main ||
  (typeof process !== "undefined" &&
    process.argv[1] &&
    resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname))
) {
  await main();
}
