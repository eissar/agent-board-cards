import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionStatus, parseEventLog } from "./event_log.ts";
import { AbcSessionManager } from "./pi-session-mgr/session_manager.ts";

function makeAssistantMessage(text: string, timestamp = Date.now()) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic-messages" as const,
    provider: "anthropic" as const,
    model: "claude-sonnet-4-5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

function makeUserMessage(text: string, timestamp = Date.now()) {
  return {
    role: "user" as const,
    content: text,
    timestamp,
  };
}

describe("AbcSessionManager", () => {
  let tempRoot: string;
  let cwd: string;
  let sessionDir: string;
  let eventLogPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "abc-sm-test-"));
    cwd = join(tempRoot, "worktree");
    sessionDir = join(tempRoot, "sessions");
    eventLogPath = join(tempRoot, "repos", "abc", "a1b2c.jsonl");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("custom-session-id: creates <timestamp>_<id>.jsonl and resumes same session + continues EventLog across rounds", () => {
    const sm1 = AbcSessionManager.openOrCreate({
      cwd,
      sessionDir,
      sessionId: "a1b2c",
      eventLogPath,
    });

    expect(sm1.getSessionId()).toBe("a1b2c");
    expect(sm1.getSessionFile()?.endsWith("_a1b2c.jsonl")).toBe(true);

    sm1.appendMessage(makeUserMessage("round 1 prompt"));
    sm1.appendMessage(makeAssistantMessage("round 1 reply"));
    sm1.appendSessionInfo("Fix login bug");

    sm1.handleAgentSessionEvent({ type: "agent_start" });
    sm1.handleAgentSessionEvent({
      type: "message_end",
      message: makeUserMessage("round 1 prompt"),
    });
    sm1.handleAgentSessionEvent({
      type: "agent_settled",
      aborted: false,
    });

    const files = readdirSync(sessionDir);
    expect(files.length).toBe(1);
    expect(files[0].endsWith("_a1b2c.jsonl")).toBe(true);

    // Round 2: reopen by sessionId
    const sm2 = AbcSessionManager.openOrCreate({
      cwd,
      sessionDir,
      sessionId: "a1b2c",
      eventLogPath,
    });

    expect(sm2.getSessionId()).toBe("a1b2c");
    expect(sm2.getSessionFile()).toBe(sm1.getSessionFile());
    expect(sm2.getSessionName()).toBe("Fix login bug");
    expect(sm2.getOpenHandsEvents().length).toBe(3);

    const emittedRound2 = sm2.handleAgentSessionEvent({ type: "agent_start" });
    expect(emittedRound2.length).toBe(1);
    expect(emittedRound2[0].id).toBe("a1b2c-4");
    expect(emittedRound2[0].parent_id).toBe("a1b2c-3");
    expect(sm2.getExecutionStatus()).toBe(ExecutionStatus.RUNNING);
  });

  test("save-entry & load-entries: persists messages, model/thinking changes, and session_info", () => {
    const sm = AbcSessionManager.create(cwd, sessionDir, {
      id: "save1",
      eventLogPath,
    });

    const thinkingId = sm.appendThinkingLevelChange("high");
    const modelId = sm.appendModelChange("anthropic", "claude-sonnet-4-5");
    // Before first user/assistant message, file is not yet flushed to disk
    expect(existsSync(sm.getSessionFile()!)).toBe(false);

    const userId = sm.appendMessage(makeUserMessage("hello"));
    const assistantId = sm.appendMessage(makeAssistantMessage("hi there"));
    sm.appendSessionInfo("Card Title");

    expect(existsSync(sm.getSessionFile()!)).toBe(true);

    const reopened = AbcSessionManager.open(
      sm.getSessionFile()!,
      sessionDir,
      cwd,
      eventLogPath,
    );
    expect(reopened.getEntry(thinkingId)?.type).toBe("thinking_level_change");
    expect(reopened.getEntry(modelId)?.type).toBe("model_change");
    expect(reopened.getEntry(userId)?.type).toBe("message");
    expect(reopened.getEntry(assistantId)?.type).toBe("message");
    expect(reopened.getSessionName()).toBe("Card Title");
    expect(reopened.getEntryCount()).toBe(5);
  });

  test("file-operations: writes line-buffered JSONL to abc/<id>.jsonl and supports createBranchedSession", () => {
    const sm = AbcSessionManager.openOrCreate({
      cwd,
      sessionDir,
      sessionId: "file1",
      eventLogPath,
    });

    expect(sm.isPersisted()).toBe(true);
    expect(sm.getCwd()).toContain("worktree");
    expect(sm.getSessionDir()).toBe(sessionDir);

    const u1 = sm.appendMessage(makeUserMessage("msg 1"));
    const a1 = sm.appendMessage(makeAssistantMessage("reply 1"));
    sm.appendMessage(makeUserMessage("msg 2"));

    const branchedPath = sm.createBranchedSession(a1);
    expect(branchedPath).toBeDefined();
    expect(existsSync(branchedPath!)).toBe(true);
    const branched = AbcSessionManager.open(branchedPath!, sessionDir, cwd);
    expect(branched.getEntries().length).toBe(2);
    expect(branched.getLeafId()).toBe(a1);
    expect(u1).toBeDefined();

    // Verify immediate line-buffered JSONL persistence on abc/<id>.jsonl
    sm.handleAgentSessionEvent({ type: "agent_start" });
    expect(existsSync(eventLogPath)).toBe(true);
    const parsed = parseEventLog(readFileSync(eventLogPath, "utf8"));
    expect(parsed.length).toBe(1);
    expect(parsed[0].kind).toBe("ConversationStateUpdateEvent");
  });

  test("tree-traversal: branch, resetLeaf, getBranch, getTree, getChildren, labels", () => {
    const sm = AbcSessionManager.inMemory(cwd, { id: "tree1" });

    const u1 = sm.appendMessage(makeUserMessage("root user"));
    const a1 = sm.appendMessage(makeAssistantMessage("branch A"));
    sm.appendLabelChange(a1, "branch-a-label");

    sm.branch(u1);
    const a2 = sm.appendMessage(makeAssistantMessage("branch B"));

    expect(sm.getChildren(u1).map((e) => e.id)).toEqual([a1, a2]);
    expect(sm.getLabel(a1)).toBe("branch-a-label");
    expect(sm.getBranch().map((e) => e.id)).toEqual([u1, a2]);

    const tree = sm.getTree();
    expect(tree.length).toBe(1);
    expect(tree[0].entry.id).toBe(u1);
    expect(tree[0].children.length).toBe(2);

    sm.resetLeaf();
    const root2 = sm.appendMessage(makeUserMessage("new root"));
    expect(sm.getEntry(root2)?.parentId).toBeNull();
  });

  test("build-context: resolves model, thinkingLevel, and compaction-aware messages", () => {
    const sm = AbcSessionManager.inMemory(cwd, { id: "ctx01" });

    sm.appendModelChange("anthropic", "claude-sonnet-4-5");
    sm.appendThinkingLevelChange("medium");
    sm.appendMessage(makeUserMessage("old turn 1"));
    sm.appendMessage(makeAssistantMessage("old reply 1"));
    const keptUser = sm.appendMessage(makeUserMessage("recent turn 2"));
    sm.appendCompaction("Summary of turn 1", keptUser, 500);
    sm.appendMessage(makeAssistantMessage("recent reply 2"));

    const ctx = sm.buildSessionContext();
    expect(ctx.model).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(ctx.thinkingLevel).toBe("medium");
    // Compaction summary + keptUser + recent reply 2
    expect(ctx.messages.length).toBe(3);
    expect(ctx.messages[0].role).toBe("compactionSummary");
    expect(ctx.messages[1].role).toBe("user");
    expect(ctx.messages[2].role).toBe("assistant");
  });
});
