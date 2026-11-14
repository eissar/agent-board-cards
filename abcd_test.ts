import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepoExclude, runCardCommand } from "./abc.ts";
import { startAbcd } from "./abcd.ts";
import { parseEventLog, projectExecutionStatus } from "./event_log.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFixtureCard(library: string, id = "b00b1") {
  const bareRepoPath = join(library, "repos", "github.com", "org", "repo");
  mkdirSync(bareRepoPath, { recursive: true });
  spawnSync("git", ["init", "--bare", bareRepoPath], { stdio: "ignore" });

  const seedDir = join(library, "_seed");
  spawnSync("git", ["clone", bareRepoPath, seedDir], { stdio: "ignore" });
  spawnSync("git", ["-C", seedDir, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", seedDir, "config", "user.name", "Test"]);
  writeFileSync(join(seedDir, "README.md"), "# test\n", "utf8");
  spawnSync("git", ["-C", seedDir, "add", "README.md"]);
  spawnSync("git", ["-C", seedDir, "commit", "-m", "init"], { stdio: "ignore" });
  spawnSync("git", ["-C", seedDir, "push", "origin", "HEAD:main"], {
    stdio: "ignore",
  });
  spawnSync("git", ["-C", bareRepoPath, "symbolic-ref", "HEAD", "refs/heads/main"]);
  rmSync(seedDir, { recursive: true, force: true });

  ensureRepoExclude(bareRepoPath);

  const worktreePath = join(library, "worktrees", id);
  mkdirSync(join(library, "worktrees"), { recursive: true });
  spawnSync(
    "git",
    ["-C", bareRepoPath, "worktree", "add", "-b", `abc/${id}`, worktreePath, "HEAD"],
    { stdio: "ignore" },
  );

  mkdirSync(join(bareRepoPath, "abc"), { recursive: true });
  const eventLogPath = join(bareRepoPath, "abc", `${id}.jsonl`);
  return { bareRepoPath, worktreePath, eventLogPath };
}

describe("abcd daemon", () => {
  test("reduces events over Unix socket, triggers hooks.json, and serves HTTP board API", async () => {
    const lib = makeTempDir("abcd-test-");
    const fixture = createFixtureCard(lib, "f1234");
    const hookTracePath = join(lib, "hooks.trace");

    writeFileSync(
      join(fixture.bareRepoPath, "abc", "hooks.json"),
      JSON.stringify({
        running: `echo "$ABC_CARD_ID:$ABC_STATUS" >> "${hookTracePath}"`,
        finished: `echo "$ABC_CARD_ID:$ABC_STATUS" >> "${hookTracePath}"`,
      }),
      "utf8",
    );

    const server = await startAbcd({ library: lib, port: 0 });
    try {
      expect(existsSync(server.socketPath)).toBe(true);
      expect(existsSync(server.logPath)).toBe(true);

      // Send Pi events over Unix socket
      await new Promise<void>((resolve, reject) => {
        const client = connect(server.socketPath, () => {
          client.write(
            JSON.stringify({
              cardId: "f1234",
              eventLogPath: fixture.eventLogPath,
              event: { type: "agent_start" },
            }) + "\n",
          );
          client.write(
            JSON.stringify({
              cardId: "f1234",
              eventLogPath: fixture.eventLogPath,
              event: {
                type: "message_end",
                message: { role: "user", content: "hi" },
              },
            }) + "\n",
          );
          client.write(
            JSON.stringify({
              cardId: "f1234",
              eventLogPath: fixture.eventLogPath,
              event: { type: "agent_settled", aborted: false },
            }) + "\n",
          );
          client.end(() => resolve());
        });
        client.on("error", reject);
      });

      // Wait briefly for socket data & hooks to finish
      for (let i = 0; i < 40; i++) {
        if (existsSync(hookTracePath)) {
          const trace = readFileSync(hookTracePath, "utf8");
          if (trace.includes("f1234:finished")) break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      const events = parseEventLog(readFileSync(fixture.eventLogPath, "utf8"));
      expect(projectExecutionStatus(events)).toBe("finished");
      expect(readFileSync(hookTracePath, "utf8")).toContain("f1234:running");
      expect(readFileSync(hookTracePath, "utf8")).toContain("f1234:finished");

      // Check HTTP endpoints
      const htmlRes = await fetch(`${server.url}/`);
      expect(htmlRes.status).toBe(200);
      const html = await htmlRes.text();
      expect(html).toContain("<h1>abc</h1>");
      expect(html).toContain('id="new-btn"');
      expect(html).toContain('id="remote-select"');

      const reposRes = await fetch(`${server.url}/api/repos`);
      expect(reposRes.status).toBe(200);
      expect(await reposRes.json()).toEqual(["github.com/org/repo"]);

      const listRes = await fetch(`${server.url}/api/cards`);
      expect(listRes.status).toBe(200);
      const cards = (await listRes.json()) as Array<{ id: string; status: string }>;
      expect(cards.find((c) => c.id === "f1234")?.status).toBe("finished");

      const detailRes = await fetch(`${server.url}/api/cards/f1234`);
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as { events: unknown[] };
      expect(detail.events.length).toBe(3);
    } finally {
      await server.close();
      rmSync(lib, { recursive: true, force: true });
    }
  });

  test("triggers crashed hook when socket disconnects while running", async () => {
    const lib = makeTempDir("abcd-crash-");
    const fixture = createFixtureCard(lib, "c4a5e");
    const hookTracePath = join(lib, "crash.trace");

    writeFileSync(
      join(fixture.bareRepoPath, "abc", "hooks.json"),
      JSON.stringify({
        crashed: `echo "$ABC_CARD_ID:$ABC_STATUS" >> "${hookTracePath}"`,
      }),
      "utf8",
    );

    const server = await startAbcd({ library: lib, port: 0 });
    try {
      await new Promise<void>((resolve, reject) => {
        const client = connect(server.socketPath, () => {
          client.write(
            JSON.stringify({
              cardId: "c4a5e",
              eventLogPath: fixture.eventLogPath,
              event: { type: "agent_start" },
            }) + "\n",
          );
          // Abruptly close without agent_settled
          client.end(() => resolve());
        });
        client.on("error", reject);
      });

      for (let i = 0; i < 40; i++) {
        if (existsSync(hookTracePath)) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(readFileSync(hookTracePath, "utf8")).toContain("c4a5e:crashed");
    } finally {
      await server.close();
      rmSync(lib, { recursive: true, force: true });
    }
  });

  test("runCardCommand fails fast if abcd is not running", () => {
    const lib = makeTempDir("abcd-missing-");
    createFixtureCard(lib, "a9999");
    try {
      expect(() => runCardCommand(lib, "a9999")).toThrow(/abcd is not running/);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });
});
