#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExecutionStatus,
  parseEventLog,
  projectExecutionStatus,
} from "./event_log.ts";

export interface ParsedRemote {
  cloneUrl: string;
  host: string;
  repoPath: string;
  ref?: string;
}

export interface CardPaths {
  id: string;
  library: string;
  bareRepoPath: string;
  worktreePath: string;
  sessionPath: string | null;
  eventLogPath: string;
  lockPath: string;
}

export interface CardInfo extends CardPaths {
  alive: boolean;
  projectedStatus: ExecutionStatus;
  status: ExecutionStatus | "crashed";
}

export function resolveLibraryRoot(explicitLibrary?: string): string {
  const raw =
    explicitLibrary ??
    process.env.ABC_LIBRARY ??
    join(homedir(), ".local/share/abc/default");
  return resolve(raw);
}

export function resolveDefaultHost(): string {
  const raw = (process.env.ABC_DEFAULT_HOST ?? "https://github.com").trim();
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
    ? raw
    : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

export function parseRemoteSpecifier(remote: string): ParsedRemote {
  const trimmed = remote.trim();
  if (!trimmed) {
    throw new Error("Remote specifier cannot be empty");
  }

  const hashIdx = trimmed.indexOf("#");
  const cloneUrl = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  const ref = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1) || undefined;

  if (!cloneUrl) {
    throw new Error(`Invalid remote specifier: ${remote}`);
  }

  if (
    cloneUrl.startsWith("/") ||
    cloneUrl.startsWith("./") ||
    cloneUrl.startsWith("../") ||
    cloneUrl.startsWith("file://")
  ) {
    throw new Error(
      `Local repository paths are not allowed (remote URLs only): ${remote}`,
    );
  }

  let host: string;
  let rawPath: string;
  let resolvedCloneUrl = cloneUrl;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cloneUrl)) {
    const parsed = new URL(cloneUrl);
    host = parsed.hostname;
    rawPath = parsed.pathname;
  } else {
    const scpMatch = /^([^@/:]+)@([^/:]+):(.+)$/.exec(cloneUrl);
    if (scpMatch) {
      host = scpMatch[2];
      rawPath = scpMatch[3];
    } else {
      const bareHostMatch = /^([a-zA-Z0-9.-]+\.[a-zA-Z0-9-]+)\/(.+)$/.exec(cloneUrl);
      if (bareHostMatch) {
        host = bareHostMatch[1];
        rawPath = bareHostMatch[2];
        resolvedCloneUrl = `https://${cloneUrl}`;
      } else if (/^[^/]+\/[^/]+/.test(cloneUrl)) {
        const base = new URL(resolveDefaultHost());
        host = base.hostname;
        rawPath = `${base.pathname.replace(/\/+$/, "")}/${cloneUrl}`;
        resolvedCloneUrl = `${resolveDefaultHost()}/${cloneUrl}`;
      } else {
        throw new Error(`Unsupported remote specifier: ${remote}`);
      }
    }
  }

  const repoPath = rawPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");

  if (!host || !repoPath || repoPath.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`Invalid remote host or repo path: ${remote}`);
  }

  return { cloneUrl: resolvedCloneUrl, host, repoPath, ref };
}

function sessionExistsForId(sessionsDir: string, id: string): boolean {
  if (!existsSync(sessionsDir)) {
    return false;
  }
  const suffix = `_${id}.jsonl`;
  for (const entry of readdirSync(sessionsDir)) {
    if (entry.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

export function findSessionFilesForId(sessionsDir: string, id: string): string[] {
  if (!existsSync(sessionsDir)) {
    return [];
  }
  const suffix = `_${id}.jsonl`;
  return readdirSync(sessionsDir)
    .filter((entry) => entry.endsWith(suffix))
    .sort()
    .map((entry) => join(sessionsDir, entry));
}

export function generateCardId(library: string): string {
  const worktreesDir = join(library, "worktrees");
  const sessionsDir = join(library, "sessions");
  for (let i = 0; i < 1000; i++) {
    const id = randomUUID().replace(/-/g, "").slice(0, 5);
    if (
      !existsSync(join(worktreesDir, id)) &&
      !sessionExistsForId(sessionsDir, id)
    ) {
      return id;
    }
  }
  throw new Error("Failed to generate unique 5-hex card id");
}

export function ensureRepoExclude(bareRepoPath: string): void {
  const infoDir = join(bareRepoPath, "info");
  mkdirSync(infoDir, { recursive: true });
  const excludePath = join(infoDir, "exclude");
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes("abc/") && !lines.includes("abc")) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, `${existing}${prefix}abc/\n`, "utf8");
  }
}

function runGit(args: string[], cwd?: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${msg}`);
  }
  return (res.stdout || "").trim();
}

export function resolveCard(library: string, id: string): CardPaths {
  if (!/^[0-9a-f]{5}$/.test(id)) {
    throw new Error(`Invalid card id "${id}" (expected 5 hex characters)`);
  }
  const worktreePath = join(library, "worktrees", id);
  if (!existsSync(worktreePath)) {
    throw new Error(`Card "${id}" not found (missing ${worktreePath})`);
  }

  const dotGitPath = join(worktreePath, ".git");
  if (!existsSync(dotGitPath)) {
    throw new Error(`Card "${id}" is missing .git metadata at ${dotGitPath}`);
  }

  const dotGitContent = readFileSync(dotGitPath, "utf8");
  const match = /^gitdir:\s*(.+)$/m.exec(dotGitContent);
  if (!match) {
    throw new Error(`Invalid .git file in ${worktreePath}`);
  }

  const worktreeGitDir = resolve(worktreePath, match[1].trim());
  // <bareRepoPath>/worktrees/<id> -> <bareRepoPath>
  const bareRepoPath = resolve(worktreeGitDir, "../..");
  const sessions = findSessionFilesForId(join(library, "sessions"), id);

  return {
    id,
    library,
    bareRepoPath,
    worktreePath,
    sessionPath: sessions.length > 0 ? sessions[sessions.length - 1] : null,
    eventLogPath: join(bareRepoPath, "abc", `${id}.jsonl`),
    lockPath: join(bareRepoPath, "abc", `${id}.lock`),
  };
}

export function isLockHeld(lockPath: string): boolean {
  if (!existsSync(lockPath)) {
    return false;
  }
  const res = spawnSync("flock", ["-n", lockPath, "true"], {
    stdio: "ignore",
  });
  return res.status !== 0;
}

export function findLockPids(lockPath: string): number[] {
  const resolved = resolve(lockPath);
  const pids = new Set<number>();

  const lslocks = spawnSync("lslocks", ["--json", "--output", "PID,PATH"], {
    encoding: "utf8",
  });
  if (lslocks.status === 0 && lslocks.stdout) {
    try {
      const parsed = JSON.parse(lslocks.stdout) as {
        locks?: Array<{ pid?: number | string; path?: string }>;
      };
      for (const lock of parsed.locks ?? []) {
        if (lock.path && resolve(lock.path) === resolved) {
          const pid = Number(lock.pid);
          if (Number.isInteger(pid) && pid > 0) {
            pids.add(pid);
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  const fuser = spawnSync("fuser", [resolved], { encoding: "utf8" });
  const combined = `${fuser.stdout ?? ""} ${fuser.stderr ?? ""}`;
  for (const token of combined.trim().split(/\s+/)) {
    const pid = Number.parseInt(token, 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  return [...pids];
}

export function addRepo(
  library: string,
  remote: string,
): { bareRepoPath: string; host: string; repoPath: string; ref?: string } {
  const { cloneUrl, host, repoPath, ref } = parseRemoteSpecifier(remote);
  const bareRepoPath = join(library, "repos", host, repoPath);

  if (!existsSync(bareRepoPath)) {
    mkdirSync(dirname(bareRepoPath), { recursive: true });
    runGit(["clone", "--bare", cloneUrl, bareRepoPath]);
  } else {
    runGit(["-C", bareRepoPath, "fetch", "origin", "--prune"]);
  }

  ensureRepoExclude(bareRepoPath);
  return { bareRepoPath, host, repoPath, ref };
}

export function createCard(
  library: string,
  remote: string,
  prompt?: string,
): CardPaths {
  const { bareRepoPath, ref } = addRepo(library, remote);

  let startPoint = "HEAD";
  if (ref) {
    const verify = spawnSync(
      "git",
      ["-C", bareRepoPath, "rev-parse", "--verify", "--quiet", ref],
      { encoding: "utf8" },
    );
    if (verify.status !== 0) {
      runGit(["-C", bareRepoPath, "fetch", "origin", ref]);
      startPoint = "FETCH_HEAD";
    } else {
      startPoint = ref;
    }
  }

  const id = generateCardId(library);
  const worktreePath = join(library, "worktrees", id);
  mkdirSync(dirname(worktreePath), { recursive: true });

  runGit([
    "-C",
    bareRepoPath,
    "worktree",
    "add",
    "-b",
    `abc/${id}`,
    worktreePath,
    startPoint,
  ]);

  const planDir = join(worktreePath, "abc");
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, "PLAN.md");
  writeFileSync(planPath, prompt ? `${prompt}\n` : "", "utf8");

  return resolveCard(library, id);
}

export function listCard(library: string, id: string): CardInfo {
  const paths = resolveCard(library, id);
  let projectedStatus: ExecutionStatus = ExecutionStatus.IDLE;

  if (existsSync(paths.eventLogPath)) {
    const content = readFileSync(paths.eventLogPath, "utf8");
    if (content.trim().length > 0) {
      const events = parseEventLog(content);
      projectedStatus = projectExecutionStatus(events);
    }
  }

  const alive = isLockHeld(paths.lockPath);
  const status: ExecutionStatus | "crashed" =
    projectedStatus === ExecutionStatus.RUNNING && !alive
      ? "crashed"
      : projectedStatus;

  return {
    ...paths,
    alive,
    projectedStatus,
    status,
  };
}

export function listRepoCards(library: string, repoTarget: string): CardInfo[] {
  let bareRepoPath = join(library, "repos", repoTarget.replace(/\.git$/i, ""));
  if (!existsSync(bareRepoPath)) {
    const { host, repoPath } = parseRemoteSpecifier(repoTarget);
    bareRepoPath = join(library, "repos", host, repoPath);
  }
  if (!existsSync(bareRepoPath)) {
    throw new Error(`Repo not found: ${repoTarget}`);
  }

  const worktreesDir = join(library, "worktrees");
  if (!existsSync(worktreesDir)) {
    return [];
  }

  const cards: CardInfo[] = [];
  for (const id of readdirSync(worktreesDir).sort()) {
    if (!/^[0-9a-f]{5}$/.test(id)) {
      continue;
    }
    const info = listCard(library, id);
    if (resolve(info.bareRepoPath) === resolve(bareRepoPath)) {
      cards.push(info);
    }
  }
  return cards;
}

export function stopCard(library: string, id: string): {
  stopped: boolean;
  pids: number[];
} {
  const paths = resolveCard(library, id);
  if (!isLockHeld(paths.lockPath)) {
    return { stopped: false, pids: [] };
  }
  const pids = findLockPids(paths.lockPath);
  if (pids.length === 0) {
    throw new Error(`Lock is held at ${paths.lockPath}, but no PID was found`);
  }
  for (const pid of pids) {
    process.kill(pid, "SIGTERM");
  }
  return { stopped: true, pids };
}

export function rmCard(
  library: string,
  id: string,
  options?: { force?: boolean },
): void {
  const paths = resolveCard(library, id);
  if (isLockHeld(paths.lockPath) && !options?.force) {
    throw new Error(`Card "${id}" is currently running (use --force to remove)`);
  }

  if (existsSync(paths.worktreePath)) {
    const removeRes = spawnSync(
      "git",
      ["-C", paths.bareRepoPath, "worktree", "remove", "--force", paths.worktreePath],
      { encoding: "utf8" },
    );
    if (removeRes.status !== 0) {
      rmSync(paths.worktreePath, { recursive: true, force: true });
      spawnSync("git", ["-C", paths.bareRepoPath, "worktree", "prune"], {
        encoding: "utf8",
      });
    }
  }

  spawnSync("git", ["-C", paths.bareRepoPath, "branch", "-D", `abc/${id}`], {
    encoding: "utf8",
  });

  for (const sessionFile of findSessionFilesForId(join(library, "sessions"), id)) {
    rmSync(sessionFile, { force: true });
  }
  rmSync(paths.eventLogPath, { force: true });
  rmSync(paths.lockPath, { force: true });
}

export const DEFAULT_CARD_PROMPT =
  "start by reading abc/PLAN.md and execute on the contents. note: abc/ is gitignored.";

function requireAbcdSocket(library: string): string {
  const socketPath = join(library, "abcd.sock");
  if (!existsSync(socketPath)) {
    throw new Error(`abcd is not running (missing ${socketPath})`);
  }
  return socketPath;
}

function requirePiBin(): string {
  const piBin = process.env.ABC_PI_BIN ?? "pi";
  if (!Bun.which(piBin)) {
    throw new Error(`Fatal precondition: "${piBin}" not found in PATH`);
  }
  return piBin;
}

export function runCardCommand(
  library: string,
  id: string,
  prompt?: string,
  model?: string,
): void {
  if (prompt !== undefined) {
    throw new Error("Unimplemented: follow-up prompt on existing card");
  }
  const paths = resolveCard(library, id);
  if (isLockHeld(paths.lockPath)) {
    throw new Error(`Card "${id}" is already running`);
  }
  const socketPath = requireAbcdSocket(library);
  const piBin = requirePiBin();
  mkdirSync(dirname(paths.lockPath), { recursive: true });
  mkdirSync(join(library, "sessions"), { recursive: true });

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const extensionDir = resolve(selfDir, "pi-session-mgr");

  const runnerArgs = [
    "-n",
    paths.lockPath,
    piBin,
    "-e",
    extensionDir,
    "--session-dir",
    join(library, "sessions"),
    "--session-id",
    id,
    "--abcd-socket",
    socketPath,
    "--event-log",
    paths.eventLogPath,
    "--card-id",
    id,
    ...(model ? ["--model", model] : []),
    "-p",
    DEFAULT_CARD_PROMPT,
  ];

  const child = spawn("flock", runnerArgs, {
    cwd: paths.worktreePath,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function openPiCommand(
  library: string,
  id: string,
  extraArgs: string[] = [],
): number {
  const paths = resolveCard(library, id);
  if (isLockHeld(paths.lockPath)) {
    throw new Error(`Card "${id}" is already running`);
  }
  const socketPath = requireAbcdSocket(library);
  const piBin = requirePiBin();
  mkdirSync(dirname(paths.lockPath), { recursive: true });
  mkdirSync(join(library, "sessions"), { recursive: true });

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const extensionDir = resolve(selfDir, "pi-session-mgr");

  const args = [
    "-n",
    paths.lockPath,
    piBin,
    "-e",
    extensionDir,
    "--session-dir",
    join(library, "sessions"),
    "--session-id",
    id,
    "--abcd-socket",
    socketPath,
    "--event-log",
    paths.eventLogPath,
    "--card-id",
    id,
    ...extraArgs,
  ];

  const res = spawnSync("flock", args, {
    cwd: paths.worktreePath,
    stdio: "inherit",
  });
  if (res.error) {
    throw res.error;
  }
  return res.status ?? 1;
}

function extractRunArgs(args: string[]): {
  model?: string;
  prompt?: string;
} {
  let model: string | undefined;
  const promptParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model") {
      const next = args[i + 1];
      if (!next) {
        throw new Error("--model requires a value");
      }
      model = next;
      i += 1;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else {
      promptParts.push(arg);
    }
  }
  return {
    model,
    prompt: promptParts.length > 0 ? promptParts.join(" ") : undefined,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  abc root",
    "  abc pi [args...]",
    "  abc <remote> add",
    "  abc <remote> run [--model <m>] [prompt]",
    "  abc <id|repo> ls [--json]",
    "  abc <id> root",
    "  abc <id> run [--model <m>] [prompt]",
    "  abc <id> pi [args...]",
    "  abc <id> stop",
    "  abc <id> rm [--force]",
  ].join("\n");
}

function extractGlobalFlags(argv: string[]): {
  library?: string;
  rest: string[];
} {
  let library: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--library") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--library requires a directory path");
      }
      library = next;
      i += 1;
    } else if (arg.startsWith("--library=")) {
      library = arg.slice("--library=".length);
    } else {
      rest.push(arg);
    }
  }
  return { library, rest };
}

export function runCli(argv: string[]): number {
  const { library: explicitLibrary, rest } = extractGlobalFlags(argv);
  const library = resolveLibraryRoot(explicitLibrary);

  if (rest.length === 0 || rest[0] === "-h" || rest[0] === "--help") {
    console.log(usage());
    return 0;
  }

  const first = rest[0];
  if (first === "root") {
    console.log(library);
    return 0;
  }

  if (first === "pi") {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    const extensionDir = resolve(selfDir, "pi-session-mgr");
    const piBin = requirePiBin();
    const extra = rest[1] === "--" ? rest.slice(2) : rest.slice(1);
    const res = spawnSync(
      piBin,
      ["-e", extensionDir, "--session-dir", join(library, "sessions"), ...extra],
      { stdio: "inherit" },
    );
    if (res.error) {
      throw res.error;
    }
    return res.status ?? 1;
  }

  const target = first;
  const sub = rest[1];
  if (!sub) {
    console.error(usage());
    return 2;
  }

  switch (sub) {
    case "add": {
      const repo = addRepo(library, target);
      console.log(repo.bareRepoPath);
      return 0;
    }
    case "root": {
      const card = resolveCard(library, target);
      console.log(card.bareRepoPath);
      return 0;
    }
    case "ls": {
      const json = rest.includes("--json");
      if (target.includes("/")) {
        const cards = listRepoCards(library, target);
        if (json) {
          console.log(JSON.stringify(cards, null, 2));
        } else {
          for (const card of cards) {
            console.log(`${card.id}\t${card.status}\t${card.worktreePath}`);
          }
        }
        return 0;
      }
      const info = listCard(library, target);
      if (json) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        console.log(`id: ${info.id}`);
        console.log(`status: ${info.status}`);
        console.log(`alive: ${info.alive}`);
        console.log(`worktree: ${info.worktreePath}`);
        console.log(`repo: ${info.bareRepoPath}`);
        console.log(`session: ${info.sessionPath ?? "-"}`);
        console.log(`event_log: ${info.eventLogPath}`);
        console.log(`lock: ${info.lockPath}`);
      }
      return 0;
    }
    case "run": {
      const { model, prompt } = extractRunArgs(rest.slice(2));
      if (target.includes("/") || target.includes(":")) {
        const card = createCard(library, target, prompt);
        runCardCommand(library, card.id, undefined, model);
        console.log(card.id);
      } else {
        runCardCommand(library, target, prompt, model);
        console.log(target);
      }
      return 0;
    }
    case "pi": {
      return openPiCommand(library, target, rest.slice(2));
    }
    case "stop": {
      const result = stopCard(library, target);
      if (!result.stopped) {
        console.error(`Card ${target} is not running`);
        return 1;
      }
      return 0;
    }
    case "rm": {
      const force = rest.includes("--force");
      rmCard(library, target, { force });
      return 0;
    }
    default: {
      console.error(`Unknown subcommand "${sub}"\n${usage()}`);
      return 2;
    }
  }
}

if (
  import.meta.main ||
  (typeof process !== "undefined" &&
    process.argv[1] &&
    resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname))
) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
