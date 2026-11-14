#!/usr/bin/env bun
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import {
  createCard,
  listCard,
  resolveCard,
  resolveLibraryRoot,
  runCardCommand,
  stopCard,
} from "./abc.ts";
import {
  type EmittedOpenHandsEvent,
  ExecutionStatus,
  type OpenHandsEvent,
  parseEventLog,
  projectExecutionStatus,
} from "./event_log.ts";
import {
  OpenHandsReducer,
  type ReducerAgentSessionEvent,
} from "./reducer.ts";

export interface IncomingEventMessage {
  cardId: string;
  eventLogPath: string;
  event: ReducerAgentSessionEvent;
}

export interface AbcdServer {
  library: string;
  socketPath: string;
  logPath: string;
  httpPort: number;
  url: string;
  close: () => Promise<void>;
}

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

function listAllCards(library: string) {
  const worktreesDir = join(library, "worktrees");
  if (!existsSync(worktreesDir)) {
    return [];
  }
  const cards = [];
  for (const id of readdirSync(worktreesDir).sort()) {
    if (!/^[0-9a-f]{5}$/.test(id)) {
      continue;
    }
    try {
      cards.push(listCard(library, id));
    } catch {
      // skip incomplete worktree entries
    }
  }
  return cards;
}

function runHooks(
  library: string,
  cardId: string,
  status: string,
  log: (msg: string) => void,
): void {
  let bareRepoPath: string;
  let worktreePath: string;
  let eventLogPath: string;
  try {
    const card = resolveCard(library, cardId);
    bareRepoPath = card.bareRepoPath;
    worktreePath = card.worktreePath;
    eventLogPath = card.eventLogPath;
  } catch {
    return;
  }

  const hooksPath = join(bareRepoPath, "abc", "hooks.json");
  if (!existsSync(hooksPath)) {
    return;
  }

  let hooks: Record<string, string>;
  try {
    hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, string>;
  } catch (err) {
    log(`[hook] failed to parse ${hooksPath}: ${String(err)}`);
    return;
  }

  const cmd = hooks[status];
  if (typeof cmd !== "string" || !cmd.trim()) {
    return;
  }

  log(`[hook] ${cardId} (${status}): ${cmd}`);
  const child = spawn("sh", ["-c", cmd], {
    cwd: worktreePath,
    env: {
      ...process.env,
      ABC_CARD_ID: cardId,
      ABC_STATUS: status,
      ABC_WORKTREE: worktreePath,
      ABC_REPO: bareRepoPath,
      ABC_EVENT_LOG: eventLogPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) log(`[hook:${cardId}] ${text}`);
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) log(`[hook:${cardId}:err] ${text}`);
  });
  child.on("exit", (code) => {
    if (code !== 0) {
      log(`[hook:${cardId}] exited with code ${code}`);
    }
  });
}

function readCardEvents(eventLogPath: string): OpenHandsEvent[] {
  if (!existsSync(eventLogPath)) {
    return [];
  }
  const content = readFileSync(eventLogPath, "utf8");
  if (!content.trim()) {
    return [];
  }
  return parseEventLog(content);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>abc</title>
  <style>
    :root { color-scheme: dark; --bg: #0d1117; --card: #161b22; --border: #30363d; --fg: #e6edf3; --muted: #8b949e; }
    body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); color: var(--fg); padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    h1 { font-size: 16px; margin: 0; }
    .stats { color: var(--muted); font-size: 13px; }
    table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
    th { color: var(--muted); font-weight: 600; }
    .status { padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .running { background: #1f6feb33; color: #58a6ff; }
    .finished { background: #23863633; color: #3fb950; }
    .error, .crashed { background: #da363333; color: #f85149; }
    .paused, .idle { background: #6e768133; color: #8b949e; }
    button { background: #21262d; color: var(--fg); border: 1px solid var(--border); padding: 4px 8px; cursor: pointer; font-family: inherit; font-size: 12px; }
    button:hover { border-color: #8b949e; }
    .fab { position: fixed; right: 24px; bottom: 24px; width: 48px; height: 48px; border-radius: 50%; background: #238636; border: 1px solid #2ea043; color: #fff; font-size: 24px; line-height: 1; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
    .fab:hover { background: #2ea043; border-color: #3fb950; }
    dialog { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 16px; width: 380px; max-width: 90vw; font-family: inherit; }
    dialog::backdrop { background: rgba(0,0,0,0.6); }
    dialog label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
    dialog input, dialog textarea { width: 100%; box-sizing: border-box; background: var(--bg); color: var(--fg); border: 1px solid var(--border); padding: 6px 8px; font-family: inherit; font-size: 13px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  </style>
</head>
<body>
  <header>
    <h1>abc</h1>
    <div class="stats" id="stats">loading...</div>
  </header>
  <table>
    <thead>
      <tr><th>id</th><th>status</th><th>alive</th><th>repo</th><th>worktree</th><th></th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <button class="fab" id="new-btn" title="New card">+</button>
  <dialog id="new-dialog">
    <form id="new-form">
      <div style="font-weight:600;font-size:14px;">New card</div>
      <label for="remote">remote</label>
      <input id="remote" name="remote" placeholder="eissar/booru" required />
      <label for="prompt">prompt (optional)</label>
      <textarea id="prompt" name="prompt" rows="3" placeholder="defaults to abc/PLAN.md"></textarea>
      <div class="dialog-actions">
        <button type="button" id="cancel-btn">cancel</button>
        <button type="submit" style="background:#238636;border-color:#2ea043;">run</button>
      </div>
    </form>
  </dialog>
  <script>
    const dlg = document.getElementById("new-dialog");
    const form = document.getElementById("new-form");
    document.getElementById("new-btn").onclick = () => { dlg.showModal(); document.getElementById("remote").focus(); };
    document.getElementById("cancel-btn").onclick = () => dlg.close();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const remote = document.getElementById("remote").value.trim();
      const prompt = document.getElementById("prompt").value.trim();
      if (!remote) return;
      const res = await fetch("/api/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remote, prompt: prompt || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Failed to start card");
        return;
      }
      form.reset();
      dlg.close();
      refresh();
    };
    async function refresh() {
      const res = await fetch("/api/cards");
      const cards = await res.json();
      const counts = cards.reduce((acc, c) => ((acc[c.status] = (acc[c.status] || 0) + 1), acc), {});
      document.getElementById("stats").textContent =
        cards.length + " cards · " + Object.entries(counts).map(([k, v]) => v + " " + k).join(", ");
      const tbody = document.getElementById("rows");
      tbody.innerHTML = "";
      for (const c of cards) {
        const tr = document.createElement("tr");
        const repoShort = c.bareRepoPath.split("/repos/")[1] || c.bareRepoPath;
        tr.innerHTML =
          "<td>" + c.id + "</td>" +
          "<td><span class='status " + c.status + "'>" + c.status + "</span></td>" +
          "<td>" + c.alive + "</td>" +
          "<td>" + repoShort + "</td>" +
          "<td>" + c.worktreePath + "</td>" +
          "<td>" + (c.alive
            ? "<button data-stop='" + c.id + "'>stop</button>"
            : "<button data-run='" + c.id + "'>run</button>") + "</td>";
        tbody.appendChild(tr);
      }
      tbody.querySelectorAll("button[data-stop]").forEach((btn) => {
        btn.onclick = async () => { await fetch("/api/cards/" + btn.dataset.stop + "/stop", { method: "POST" }); refresh(); };
      });
      tbody.querySelectorAll("button[data-run]").forEach((btn) => {
        btn.onclick = async () => { await fetch("/api/cards/" + btn.dataset.run + "/run", { method: "POST" }); refresh(); };
      });
    }
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;

export async function startAbcd(options?: {
  library?: string;
  port?: number;
  host?: string;
}): Promise<AbcdServer> {
  const library = resolveLibraryRoot(options?.library);
  mkdirSync(library, { recursive: true });

  const socketPath = join(library, "abcd.sock");
  const logPath = join(library, "abcd.log");
  const host = options?.host ?? process.env.ABC_HOST ?? "127.0.0.1";
  const requestedPort = options?.port ?? Number(process.env.ABC_PORT ?? 3456);

  if (existsSync(socketPath)) {
    rmSync(socketPath, { force: true });
  }

  const log = (line: string) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    appendFileSync(logPath, entry, "utf8");
  };

  // Active reducers per cardId (derived from abc/<id>.jsonl on first event; evicted on socket close)
  const activeReducers = new Map<
    string,
    { reducer: OpenHandsReducer; eventLogPath: string; lastStatus: ExecutionStatus }
  >();

  const netServer: NetServer = createNetServer((socket: Socket) => {
    let buffer = "";
    const socketCards = new Set<string>();

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const raw = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!raw) continue;

        let msg: IncomingEventMessage;
        try {
          msg = JSON.parse(raw) as IncomingEventMessage;
        } catch (err) {
          log(`[socket] invalid JSON: ${String(err)}`);
          continue;
        }

        const { cardId, eventLogPath, event } = msg;
        if (!cardId || !eventLogPath || !event) {
          log(`[socket] malformed message: ${raw}`);
          continue;
        }

        socketCards.add(cardId);
        let entry = activeReducers.get(cardId);
        if (!entry) {
          const initialEvents = readCardEvents(eventLogPath);
          entry = {
            reducer: new OpenHandsReducer({ cardId, initialEvents }),
            eventLogPath,
            lastStatus:
              initialEvents.length > 0
                ? projectExecutionStatus(initialEvents)
                : ExecutionStatus.IDLE,
          };
          activeReducers.set(cardId, entry);
        }

        try {
          const emitted = entry.reducer.reduce(event);
          if (emitted.length > 0) {
            appendEvents(entry.eventLogPath, emitted);
            for (const evt of emitted) {
              if (
                evt.kind === "ConversationStateUpdateEvent" &&
                evt.key === "execution_status" &&
                typeof evt.value === "string"
              ) {
                const nextStatus = evt.value as ExecutionStatus;
                if (nextStatus !== entry.lastStatus) {
                  entry.lastStatus = nextStatus;
                  runHooks(library, cardId, nextStatus, log);
                }
              } else if (evt.kind === "InterruptEvent") {
                if (entry.lastStatus !== ExecutionStatus.PAUSED) {
                  entry.lastStatus = ExecutionStatus.PAUSED;
                  runHooks(library, cardId, ExecutionStatus.PAUSED, log);
                }
              }
            }
          }
        } catch (err) {
          log(`[reducer:${cardId}] error: ${String(err)}`);
        }
      }
    });

    socket.on("close", () => {
      for (const cardId of socketCards) {
        const entry = activeReducers.get(cardId);
        activeReducers.delete(cardId);
        if (entry) {
          const events = readCardEvents(entry.eventLogPath);
          const status =
            events.length > 0
              ? projectExecutionStatus(events)
              : ExecutionStatus.IDLE;
          if (status === ExecutionStatus.RUNNING) {
            log(`[crash] ${cardId} disconnected while running`);
            runHooks(library, cardId, "crashed", log);
          }
        }
      }
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    netServer.once("error", rejectPromise);
    netServer.listen(socketPath, () => {
      netServer.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const httpServer: HttpServer = createHttpServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    if (method === "GET" && urlPath === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (method === "GET" && urlPath === "/api/cards") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(listAllCards(library)));
      return;
    }

    if (method === "POST" && urlPath === "/api/cards") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}") as {
            remote?: string;
            prompt?: string;
          };
          if (!parsed.remote || typeof parsed.remote !== "string") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "remote is required" }));
            return;
          }
          const card = createCard(library, parsed.remote);
          runCardCommand(library, card.id, parsed.prompt);
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: card.id }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
      return;
    }

    const cardMatch = /^\/api\/cards\/([0-9a-f]{5})(?:\/(run|stop))?$/.exec(
      urlPath,
    );
    if (cardMatch) {
      const id = cardMatch[1];
      const action = cardMatch[2];
      try {
        if (!action && method === "GET") {
          const info = listCard(library, id);
          const events = readCardEvents(info.eventLogPath);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...info, events }));
          return;
        }
        if (action === "stop" && method === "POST") {
          const result = stopCard(library, id);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }
        if (action === "run" && method === "POST") {
          runCardCommand(library, id);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id, started: true }));
          return;
        }
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const httpPort = await new Promise<number>((resolvePromise, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(requestedPort, host, () => {
      httpServer.off("error", rejectPromise);
      const addr = httpServer.address();
      resolvePromise(typeof addr === "object" && addr ? addr.port : requestedPort);
    });
  });

  const url = `http://${host}:${httpPort}`;
  log(`abcd running on ${url} (socket: ${socketPath})`);

  const close = async () => {
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => netServer.close(() => r()));
    rmSync(socketPath, { force: true });
  };

  return { library, socketPath, logPath, httpPort, url, close };
}

if (
  import.meta.main ||
  (typeof process !== "undefined" &&
    process.argv[1] &&
    resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname))
) {
  const args = process.argv.slice(2);
  let library: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--library" && args[i + 1]) {
      library = args[++i];
    } else if (args[i] === "--port" && args[i + 1]) {
      port = Number.parseInt(args[++i], 10);
    } else if (args[i] === "--host" && args[i + 1]) {
      host = args[++i];
    }
  }

  const server = await startAbcd({ library, port, host });
  console.log(`abcd running on ${server.url}, view log at ${server.logPath}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
