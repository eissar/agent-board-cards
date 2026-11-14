# agent-board-cards

we use openhands format vendored at v1.62.0

Vendored Python event envelope files in `vendor/openhands/v1.62.0/event/` are from `OpenHands/software-agent-sdk` at tag `v1.62.0` (`504a88cab0`).

## Principles

- No custom events — use the generalized OpenHands event stream as-is.
- Wherever possible, state is expressed by the filesystem; custom data structures are a code smell.
- `prefix` :: agents are prefixed by filepath (e.g., a worktree).
- `type` :: agents are organized by their deliverable (`patch file` | `working area changes` | `markdown`).
