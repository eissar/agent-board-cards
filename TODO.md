# TODO

- [ ] **Crash liveness:** Prevent cards from staying stuck projecting `running` if `abcd` or a child agent process dies mid-run (e.g., PID/lock liveness check, and/or `abcd` appending `ConversationErrorEvent` on unexpected child exit).
