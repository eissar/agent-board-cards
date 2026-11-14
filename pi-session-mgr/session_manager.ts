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
import {
  type AgentSession,
  type AgentSessionEvent,
  type CompactionEntry,
  type ContextEditEntry,
  type ExtensionUIContext,
  type FileEntry,
  type NewSessionOptions,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
  SessionManager,
  type SessionProjection,
  type SessionTreeNode,
  type UsageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type EmittedOpenHandsEvent,
  type ExecutionStatus,
  type OpenHandsEvent,
  parseEventLog,
  projectExecutionStatus,
} from "../event_log.ts";
import {
  OpenHandsReducer,
  type ReducerAgentSessionEvent,
} from "../reducer.ts";

export interface AbcSessionManagerOpenOrCreateOptions {
  cwd: string;
  sessionDir: string;
  sessionId: string;
  eventLogPath?: string;
  parentSession?: string;
}

export class AbcSessionManager {
  private readonly inner: SessionManager;
  private readonly eventLogPath?: string;
  private readonly events: OpenHandsEvent[];
  private reducer: OpenHandsReducer;

  constructor(inner: SessionManager, eventLogPath?: string) {
    this.inner = inner;
    this.eventLogPath = eventLogPath;
    this.events = [];

    if (eventLogPath && existsSync(eventLogPath)) {
      const content = readFileSync(eventLogPath, "utf8");
      if (content.trim().length > 0) {
        this.events.push(...parseEventLog(content));
      }
    }

    this.reducer = new OpenHandsReducer({
      cardId: this.inner.getSessionId(),
      initialEvents: this.events,
    });
  }

  static openOrCreate(
    options: AbcSessionManagerOpenOrCreateOptions,
  ): AbcSessionManager {
    const existing = SessionManager.findById(
      options.cwd,
      options.sessionId,
      options.sessionDir,
    );
    const inner = existing
      ? SessionManager.open(existing, options.sessionDir, options.cwd)
      : SessionManager.create(options.cwd, options.sessionDir, {
        id: options.sessionId,
        parentSession: options.parentSession,
      });
    return new AbcSessionManager(inner, options.eventLogPath);
  }

  static create(
    cwd: string,
    sessionDir?: string,
    options?: NewSessionOptions & { eventLogPath?: string },
  ): AbcSessionManager {
    const inner = SessionManager.create(cwd, sessionDir, options);
    return new AbcSessionManager(inner, options?.eventLogPath);
  }

  static open(
    path: string,
    sessionDir?: string,
    cwdOverride?: string,
    eventLogPath?: string,
  ): AbcSessionManager {
    const inner = SessionManager.open(path, sessionDir, cwdOverride);
    return new AbcSessionManager(inner, eventLogPath);
  }

  static inMemory(
    cwd?: string,
    options?: NewSessionOptions & { eventLogPath?: string },
    entries?: FileEntry[],
  ): AbcSessionManager {
    const inner = SessionManager.inMemory(cwd, options, entries);
    return new AbcSessionManager(inner, options?.eventLogPath);
  }

  asSessionManager(): SessionManager {
    return this as unknown as SessionManager;
  }

  getEventLogPath(): string | undefined {
    return this.eventLogPath;
  }

  getOpenHandsEvents(): readonly OpenHandsEvent[] {
    return this.events;
  }

  getExecutionStatus(): ExecutionStatus {
    return projectExecutionStatus(this.events);
  }

  private persistEvents(emitted: readonly EmittedOpenHandsEvent[]): void {
    if (emitted.length === 0) {
      return;
    }
    for (const evt of emitted) {
      this.events.push(evt);
    }
    if (!this.eventLogPath) {
      return;
    }
    mkdirSync(dirname(this.eventLogPath), { recursive: true });
    const fd = openSync(this.eventLogPath, "a");
    try {
      const payload = emitted.map((evt) => `${JSON.stringify(evt)}\n`).join("");
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  handleAgentSessionEvent(event: AgentSessionEvent): EmittedOpenHandsEvent[] {
    const emitted = this.reducer.reduce(
      event as unknown as ReducerAgentSessionEvent,
    );
    this.persistEvents(emitted);
    return emitted;
  }

  emitWaitingForConfirmation(): EmittedOpenHandsEvent {
    const evt = this.reducer.emitWaitingForConfirmation();
    this.persistEvents([evt]);
    return evt;
  }

  emitResumedRunning(): EmittedOpenHandsEvent {
    const evt = this.reducer.emitResumedRunning();
    this.persistEvents([evt]);
    return evt;
  }

  wrapUIContext<T extends ExtensionUIContext>(uiContext: T): T {
    return this.reducer.wrapUIContext(uiContext, (evt) => {
      this.persistEvents([evt]);
    });
  }

  attachToSession(session: Pick<AgentSession, "subscribe">): () => void {
    return session.subscribe((event) => {
      this.handleAgentSessionEvent(event);
    });
  }

  // --- Delegated SessionManager methods ---

  setSessionFile(sessionFile: string): void {
    this.inner.setSessionFile(sessionFile);
  }

  newSession(options?: NewSessionOptions): string | undefined {
    const result = this.inner.newSession(options);
    this.reducer = new OpenHandsReducer({
      cardId: this.inner.getSessionId(),
      initialEvents: this.events,
    });
    return result;
  }

  isPersisted(): boolean {
    return this.inner.isPersisted();
  }

  getCwd(): string {
    return this.inner.getCwd();
  }

  getSessionDir(): string {
    return this.inner.getSessionDir();
  }

  usesDefaultSessionDir(): boolean {
    return this.inner.usesDefaultSessionDir();
  }

  getSessionId(): string {
    return this.inner.getSessionId();
  }

  getSessionFile(): string | undefined {
    return this.inner.getSessionFile();
  }

  _persist(entry: SessionEntry): void {
    this.inner._persist(entry);
  }

  appendMessage(
    message: Parameters<SessionManager["appendMessage"]>[0],
  ): string {
    return this.inner.appendMessage(message);
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    return this.inner.appendThinkingLevelChange(thinkingLevel);
  }

  appendModelChange(provider: string, modelId: string): string {
    return this.inner.appendModelChange(provider, modelId);
  }

  appendUsage(
    kind: string,
    provider: string,
    model: string,
    usage: Parameters<SessionManager["appendUsage"]>[3],
    note?: string,
  ): UsageEntry {
    return this.inner.appendUsage(kind, provider, model, usage, note);
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string | null,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: CompactionEntry["usage"],
  ): string {
    return this.inner.appendCompaction(
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
      usage,
    );
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.inner.appendCustomEntry(customType, data);
  }

  appendSessionInfo(name: string): string {
    return this.inner.appendSessionInfo(name);
  }

  getSessionName(): string | undefined {
    return this.inner.getSessionName();
  }

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: Parameters<SessionManager["appendCustomMessageEntry"]>[1],
    display: boolean,
    details?: T,
  ): string {
    return this.inner.appendCustomMessageEntry(
      customType,
      content,
      display,
      details,
    );
  }

  appendContextEdit(
    targetId: string,
    replacement: ContextEditEntry["replacement"],
  ): string {
    return this.inner.appendContextEdit(targetId, replacement);
  }

  getLeafId(): string | null {
    return this.inner.getLeafId();
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.inner.getLeafEntry();
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.inner.getEntry(id);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.inner.getChildren(parentId);
  }

  getLabel(id: string): string | undefined {
    return this.inner.getLabel(id);
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    return this.inner.appendLabelChange(targetId, label);
  }

  getBranch(fromId?: string): SessionEntry[] {
    return this.inner.getBranch(fromId);
  }

  buildContextEntries(): SessionEntry[] {
    return this.inner.buildContextEntries();
  }

  buildSessionProjection(): SessionProjection {
    return this.inner.buildSessionProjection();
  }

  buildSessionContext(): SessionContext {
    return this.inner.buildSessionContext();
  }

  getHeader(): SessionHeader | null {
    return this.inner.getHeader();
  }

  getEntryCount(): number {
    return this.inner.getEntryCount();
  }

  getEntries(): SessionEntry[] {
    return this.inner.getEntries();
  }

  getTree(): SessionTreeNode[] {
    return this.inner.getTree();
  }

  branch(branchFromId: string): void {
    this.inner.branch(branchFromId);
  }

  resetLeaf(): void {
    this.inner.resetLeaf();
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: CompactionEntry["usage"],
  ): string {
    return this.inner.branchWithSummary(
      branchFromId,
      summary,
      details,
      fromHook,
      usage,
    );
  }

  createBranchedSession(leafId: string): string | undefined {
    return this.inner.createBranchedSession(leafId);
  }
}
