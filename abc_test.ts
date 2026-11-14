import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRepoExclude,
  generateCardId,
  isLockHeld,
  listCard,
  listRepoCards,
  parseRemoteSpecifier,
  resolveCard,
  resolveLibraryRoot,
  rmCard,
  runCli,
  stopCard,
} from "./abc.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFixtureCard(library: string, id = "a1b2c"): {
  bareRepoPath: string;
  worktreePath: string;
  sessionPath: string;
  eventLogPath: string;
  lockPath: string;
} {
  const bareRepoPath = join(library, "repos", "github.com", "org", "repo");
  mkdirSync(bareRepoPath, { recursive: true });
  spawnSync("git", ["init", "--bare", bareRepoPath], { stdio: "ignore" });

  // Seed an initial commit via a temporary clone/worktree so worktree add works
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
  const wtRes = spawnSync(
    "git",
    ["-C", bareRepoPath, "worktree", "add", "-b", `abc/${id}`, worktreePath, "HEAD"],
    { encoding: "utf8" },
  );
  if (wtRes.status !== 0) {
    throw new Error(`git worktree add failed: ${wtRes.stderr}`);
  }

  mkdirSync(join(worktreePath, "abc"), { recursive: true });
  writeFileSync(join(worktreePath, "abc", "PLAN.md"), "# plan\n", "utf8");

  mkdirSync(join(library, "sessions"), { recursive: true });
  const sessionPath = join(library, "sessions", `2026-01-01T00-00-00_${id}.jsonl`);
  writeFileSync(sessionPath, '{"type":"session","id":"' + id + '"}\n', "utf8");

  mkdirSync(join(bareRepoPath, "abc"), { recursive: true });
  const eventLogPath = join(bareRepoPath, "abc", `${id}.jsonl`);
  const lockPath = join(bareRepoPath, "abc", `${id}.lock`);

  return { bareRepoPath, worktreePath, sessionPath, eventLogPath, lockPath };
}

describe("abc CLI", () => {
  test("parseRemoteSpecifier parses https, ssh, and #ref; rejects local paths", () => {
    expect(parseRemoteSpecifier("https://github.com/org/repo.git#main")).toEqual({
      cloneUrl: "https://github.com/org/repo.git",
      host: "github.com",
      repoPath: "org/repo",
      ref: "main",
    });

    expect(parseRemoteSpecifier("git@github.com:org/repo.git#feat/x")).toEqual({
      cloneUrl: "git@github.com:org/repo.git",
      host: "github.com",
      repoPath: "org/repo",
      ref: "feat/x",
    });

    expect(parseRemoteSpecifier("github.com/eissar/booru")).toEqual({
      cloneUrl: "https://github.com/eissar/booru",
      host: "github.com",
      repoPath: "eissar/booru",
      ref: undefined,
    });

    expect(parseRemoteSpecifier("eissar/booru#main")).toEqual({
      cloneUrl: "https://github.com/eissar/booru",
      host: "github.com",
      repoPath: "eissar/booru",
      ref: "main",
    });

    const prevHost = process.env.ABC_DEFAULT_HOST;
    try {
      process.env.ABC_DEFAULT_HOST = "https://gitlab.example.com";
      expect(parseRemoteSpecifier("eissar/booru")).toEqual({
        cloneUrl: "https://gitlab.example.com/eissar/booru",
        host: "gitlab.example.com",
        repoPath: "eissar/booru",
        ref: undefined,
      });
    } finally {
      if (prevHost === undefined) {
        delete process.env.ABC_DEFAULT_HOST;
      } else {
        process.env.ABC_DEFAULT_HOST = prevHost;
      }
    }

    expect(() => parseRemoteSpecifier("/tmp/local/repo")).toThrow();
    expect(() => parseRemoteSpecifier("./local")).toThrow();
    expect(() => parseRemoteSpecifier("file:///tmp/repo")).toThrow();
  });

  test("resolveLibraryRoot respects explicit arg and ABC_LIBRARY", () => {
    const prev = process.env.ABC_LIBRARY;
    try {
      process.env.ABC_LIBRARY = "/tmp/abc-env-lib";
      expect(resolveLibraryRoot()).toBe("/tmp/abc-env-lib");
      expect(resolveLibraryRoot("/tmp/abc-flag-lib")).toBe("/tmp/abc-flag-lib");
    } finally {
      if (prev === undefined) {
        delete process.env.ABC_LIBRARY;
      } else {
        process.env.ABC_LIBRARY = prev;
      }
    }
  });

  test("ensureRepoExclude adds abc/ idempotently", () => {
    const dir = makeTempDir("abc-excl-");
    try {
      ensureRepoExclude(dir);
      ensureRepoExclude(dir);
      const content = readFileSync(join(dir, "info", "exclude"), "utf8");
      expect(content.match(/^abc\/$/gm)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("generateCardId returns 5-hex id not colliding with existing worktrees/sessions", () => {
    const lib = makeTempDir("abc-id-");
    try {
      const id = generateCardId(lib);
      expect(id).toMatch(/^[0-9a-f]{5}$/);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });

  test("resolveCard, listCard (idle & crashed), and root CLI commands", () => {
    const lib = makeTempDir("abc-card-");
    try {
      const fixture = createFixtureCard(lib, "dead0");
      const resolved = resolveCard(lib, "dead0");
      expect(resolved.bareRepoPath).toBe(fixture.bareRepoPath);
      expect(resolved.worktreePath).toBe(fixture.worktreePath);
      expect(resolved.sessionPath).toBe(fixture.sessionPath);

      expect(listCard(lib, "dead0").status).toBe("idle");

      // Simulate SIGKILL crash: event log says running, lock is not held
      writeFileSync(
        fixture.eventLogPath,
        JSON.stringify({
          id: "dead0-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          source: "environment",
          parent_id: null,
          kind: "ConversationStateUpdateEvent",
          key: "execution_status",
          value: "running",
        }) + "\n",
        "utf8",
      );

      const crashedInfo = listCard(lib, "dead0");
      expect(crashedInfo.projectedStatus).toBe("running");
      expect(crashedInfo.alive).toBe(false);
      expect(crashedInfo.status).toBe("crashed");

      expect(runCli(["--library", lib, "root"])).toBe(0);
      expect(runCli(["--library", lib, "dead0", "root"])).toBe(0);
      expect(runCli(["--library", lib, "dead0", "ls", "--json"])).toBe(0);
      expect(listRepoCards(lib, "github.com/org/repo").map((c) => c.id)).toEqual([
        "dead0",
      ]);
      expect(runCli(["--library", lib, "github.com/org/repo", "ls"])).toBe(0);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });

  test("stopCard & rmCard respect flock liveness", async () => {
    const lib = makeTempDir("abc-lock-");
    try {
      const fixture = createFixtureCard(lib, "cafe1");

      const child = spawn("flock", ["-n", fixture.lockPath, "sleep", "30"], {
        stdio: "ignore",
      });

      // Wait briefly for flock to acquire the lock
      let held = false;
      for (let i = 0; i < 40; i++) {
        if (isLockHeld(fixture.lockPath)) {
          held = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(held).toBe(true);

      // rmCard without --force must refuse while lock is held
      expect(() => rmCard(lib, "cafe1")).toThrow(/currently running/);

      // stopCard sends SIGTERM and releases lock
      const stopRes = stopCard(lib, "cafe1");
      expect(stopRes.stopped).toBe(true);
      expect(stopRes.pids.length).toBeGreaterThan(0);

      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
        } else {
          child.once("exit", () => resolve());
        }
      });

      let released = false;
      for (let i = 0; i < 40; i++) {
        if (!isLockHeld(fixture.lockPath)) {
          released = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(released).toBe(true);

      // Now rmCard cleans up worktree, session, eventLog, and lock
      rmCard(lib, "cafe1");
      expect(existsSync(fixture.worktreePath)).toBe(false);
      expect(existsSync(fixture.sessionPath)).toBe(false);
      expect(existsSync(fixture.eventLogPath)).toBe(false);
      expect(existsSync(fixture.lockPath)).toBe(false);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });
});
