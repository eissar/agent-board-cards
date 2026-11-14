# Reducer & Custom SessionManager Plan

## Goal

Run an in-process OpenHands `v1.62.0` event reducer inside a Node/Bun card runner (`@earendil-works/pi-coding-agent` SDK `createAgentSession`) with a custom `SessionManager`, persisting:
- Pi session state (agent memory + display title) to `<library>/sessions/<timestamp>_<id>.jsonl` (`--session-dir <library>/sessions --session-id <id>`)
- OpenHands `EventLog` (sole source of card status) to `repos/<host>/<owner>/<repo>/abc/<id>.jsonl`

No `pi --mode rpc` subprocess or raw RPC sink file is needed because the reducer subscribes to `AgentSession` events in-process.

## 1. Envelope Generation (Deterministic & Monotonic)

Every emitted `OpenHandsEvent` must pass strict `v1.62.0` envelope validation:
- `id`: deterministically and monotonically generated per card run (e.g., `<card-id>-<seq>` or monotonic sequence/UUIDv7-style ID; never `ROOT_PARENT_ID`).
- `parent_id`: `null` for the first event in `abc/<id>.jsonl`, then the `id` of the immediately preceding emitted event.
- Across rounds, `seq` / `parent_id` / `timestamp` continue from the last event loaded into the custom `SessionManager`'s in-memory state; ids are never reused.
- `timestamp`: monotonic ISO 8601 string.
- `source`: `"user" | "agent" | "environment" | "hook"`.

## 2. Event Mapping (`AgentSession` → OpenHands `v1.62.0`)

Drop high-frequency streaming deltas (`message_update`, `tool_execution_update`) so `abc/<id>.jsonl` only records durable state transitions:

| Pi `AgentSession` Event | Condition | Emitted OpenHands Event |
|---|---|---|
| `agent_start` | — | `ConversationStateUpdateEvent` (`key: "execution_status"`, `value: "running"`, `source: "environment"`) |
| `message_end` | `message.role === "user"` | `MessageEvent` (`source: "user"`) |
| `message_end` | `message.role === "assistant"`, no tool calls, `stopReason !== "error"` | `MessageEvent` (`source: "agent"`) |
| `message_end` | `message.role === "assistant"`, has tool calls | one `ActionEvent` per tool call (`source: "agent"`, `thought` on first only, `tool_call`, `llm_response_id`); record `tool_call_id → id` |
| `message_end` | `stopReason === "error"` | *(nothing yet; remember `code`/`detail` — a retry may follow)* |
| `tool_execution_start` | — | *(ignored; `ActionEvent` built at `message_end`)* |
| `tool_execution_end` | `isError: false` | `ObservationEvent` (`source: "environment"`, `tool_call_id`, `tool_name`, `action_id`) |
| `tool_execution_end` | `isError: true` | `AgentErrorEvent` (`source: "agent"`, `tool_call_id`, `tool_name`, `error`) |
| `agent_end` | — | *(ignored for terminal status; retries/compaction/queued turns may follow)* |
| `agent_settled` | `aborted: false`, error remembered | `ConversationErrorEvent` (`source: "environment"`, `code`, `detail`) + `ConversationStateUpdateEvent` (`value: "error"`) |
| `agent_settled` | `aborted: false`, no error | `ConversationStateUpdateEvent` (`key: "execution_status"`, `value: "finished"`, `source: "environment"`) |
| `agent_settled` | `aborted: true` | `InterruptEvent` (`source: "user"`) |
| wrapped `uiContext.confirm` / `select` (via `bindExtensions`) | before / after answer | `ConversationStateUpdateEvent` (`value: "waiting_for_confirmation"`), then `value: "running"` |

## 3. Strict Schema Validation (`vendor/openhands/v1.62.0/event/`)

Tighten `/srv/code/abc/event_log.ts` so emitted events are strictly validated against the vendored Python models:
- Reject missing/empty `kind` on validation.
- Require `code` and `detail` on `ConversationErrorEvent` (`vendor/openhands/v1.62.0/event/conversation_error.py`).
- Populate required `ActionEvent` / `MessageEvent` / `ObservationEvent` fields per `v1.62.0` rather than relying on minimal stub shapes.
- Keep unknown-event tolerance only when *reading* logs, never when *emitting* events.

## 4. Durability & Crash Liveness

- Append each reduced OpenHands event immediately (line-buffered JSONL write + flush) to `repos/<host>/<owner>/<repo>/abc/<id>.jsonl`.
- Keep `flock -n <repo>/abc/<id>.lock` wrapping the Node/Bun runner process.
- If the runner is killed (`SIGKILL`/OOM) before emitting a terminal event, `abc/<id>.jsonl` will project `running` while `flock -n <repo>/abc/<id>.lock true` succeeds (not running); status consumers combine both signals.

## 5. Testing

1. **Pure reducer tests (Deno):**
   - Feed recorded/synthetic `AgentSession` event sequences through the reducer and assert exact `OpenHandsEvent[]` output, deterministic/monotonic `id`/`parent_id`/`timestamp`, strict `v1.62.0` validation, and `projectExecutionStatus()` results (`agent_start` → `running`, `agent_end` with `willRetry` stays `running`, `agent_settled` → `finished`, `aborted: true` → `paused`, error then successful retry → `finished` (never `error`), retries exhausted → `error`, tool-calling reply → `ActionEvent`s and no `MessageEvent`).
2. **Custom `SessionManager` tests (Node/Bun):**
   - Adapt the test cases from `earendil-works/pi` `packages/coding-agent/test/session-manager/` (`build-context`, `custom-session-id`, `file-operations`, `load-entries`, `save-entry`, `tree-traversal`) to verify session persistence under `--session-dir` alongside `abc/<id>.jsonl` emission.
