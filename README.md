# agent-board-cards

we use openhands format vendored at v1.62.0

Vendored Python event envelope files in `vendor/openhands/v1.62.0/event/` are from `OpenHands/software-agent-sdk` at tag `v1.62.0` (`504a88cab0`).

## Principles

- No custom events — use the generalized OpenHands event stream as-is.
- Wherever possible, state is expressed by the filesystem; custom data structures are a code smell.
- `prefix` :: agents are prefixed by git remote URL (scanned from worktrees; worktrees are never based on local repos).
- `type` :: agents are organized by their deliverable (`patch file` | `working area changes` | `markdown`). Currently `working area changes` (worktree) only.

## Layout

Worktree library (e.g. `~/.local/share/abc/default/`):
- `repos/<host>/<owner>/<repo>/` — bare clone of the remote URL (shared object store); the base commit ref is the merge head in this repo
- `repos/<host>/<owner>/<repo>/abc/<id>.jsonl` — OpenHands `EventLog` (lives inside the bare repo, not inside the worktree)
- `repos/<host>/<owner>/<repo>/abc/<id>.pid` — pidfile of the agent process running the card; absent or dead pid means not running, whatever the log says
- `repos/<host>/<owner>/<repo>/abc/hooks.json` — lifecycle hooks, per repo (outside the worktree so a sandbox such as nono can protect them independently of writable worktree contents; placement enables, rather than enforces, that boundary)
- `sessions/<timestamp>_<id>.jsonl` — Pi session, owns the agent's memory across rounds and the card's display title; status comes only from the `EventLog`
- `worktrees/<id>/` — `git worktree` branched from `repos/<host>/<owner>/<repo>/` (never based on a local repo)

`<id>` is the card id: the first 5 hex characters of a random UUID. Scan retained Pi session logs first and retry until the id is unused. Then panic if `worktrees/<id>/` already exists: a worktree conflict is an invariant violation, not another retry condition. No atomic ID reservation machinery is needed.

Inside each worktree (`abc/` excluded via `git rev-parse --git-path info/exclude`):
- `abc/PLAN.md`

Launch:
`pi --mode rpc --session-dir <library>/sessions --session-id <id>`

Default prompt:
`start by reading abc/PLAN.md and execute on the contents. note: abc/ is gitignored.`
