# agent-board-cards

we use openhands format vendored at v1.62.0

Vendored Python event envelope files in `vendor/openhands/v1.62.0/event/` are from `OpenHands/software-agent-sdk` at tag `v1.62.0` (`504a88cab0`).

## Principles

- No custom events — use the generalized OpenHands event stream as-is.
- Wherever possible, state is expressed by the filesystem; custom data structures are a code smell.
- `prefix` :: agents are prefixed by git remote URL (scanned from worktrees; worktrees are never based on local repos).
- `type` :: agents are organized by their deliverable (`patch file` | `working area changes` | `markdown`). Currently `working area changes` (worktree) only.

## Multiple cards

Card subcommands take any number of ids before the subcommand:

    abc 2d082 e6894 rm
    abc 2d082 e6894 stop
    abc 2d082 e6894 ls --json

`rm` resolves and liveness-checks all targets before deleting any of them.

## Layout

Worktree library (e.g. `~/.local/share/abc/default/`):
- `repos/<host>/<owner>/<repo>/` — bare clone of the remote URL (shared object store); the base commit ref is the merge head in this repo
- `repos/<host>/<owner>/<repo>/info/exclude` — excludes `abc/` across all worktrees of this repo
- `repos/<host>/<owner>/<repo>/abc/<id>.jsonl` — OpenHands `EventLog` (lives inside the bare repo, not inside the worktree); see: openhands sessionmanager
- `repos/<host>/<owner>/<repo>/abc/<id>.lock` — `flock` held by the agent process for its lifetime; lock not held (or file absent) means not running, whatever the log says. The kernel releases the lock on any exit, so there is no stale-pid / pid-reuse case
- `repos/<host>/<owner>/<repo>/abc/hooks.json` — lifecycle hooks, per repo
- `sessions/<timestamp>_<id>.jsonl` — Pi session, owns the agent's memory across rounds and the card's display title; status comes only from the `EventLog`
- `worktrees/<id>/` — `git worktree` branched from `repos/<host>/<owner>/<repo>/` (never based on a local repo)

`<id>` is the card id: the first 5 hex characters of a random UUID, retried while `<id>` exists in `sessions/` or `worktrees/`.

Inside each worktree:
- `abc/PLAN.md`

Runner & Launch:
- Card runner uses `@earendil-works/pi-coding-agent` SDK (`createAgentSession`) in Node/Bun with a custom `SessionManager` so the OpenHands reducer runs in-process against `abc/<id>.jsonl` (no `pi --mode rpc` subprocess).
- `flock -n <repo>/abc/<id>.lock <bun|node> <runner> --session-dir <library>/sessions --session-id <id>`

`flock` (no `-o`) passes the locked fd to the runner process, so the lock is held until it exits. `-n` refuses to start a second agent on a running card.

Liveness check: `flock -n <repo>/abc/<id>.lock true` succeeds ⇒ not running.

Default prompt:
`start by reading abc/PLAN.md and execute on the contents. note: abc/ is gitignored.`
