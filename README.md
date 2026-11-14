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
- `repos/<host>/<owner>/<repo>/` — bare clone of the remote URL (shared object store)
- `repos/<host>/<owner>/<repo>/abc/<hash>.jsonl` — OpenHands `EventLog` (lives inside the bare repo, not inside the worktree)
- `worktrees/<hash>/` — `git worktree` branched from `repos/<host>/<owner>/<repo>/` (never based on a local repo)

Inside each worktree (`abc/` excluded via `git rev-parse --git-path info/exclude`):
- `abc/PLAN.md`
- `abc/hooks.json`

Default prompt:
`start by reading abc/PLAN.md and execute on the contents. note: abc/ is gitignored.`
