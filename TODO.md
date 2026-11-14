# TODO

- [ ] **Pi → OpenHands event translation:** Map `pi --mode rpc --no-session` lifecycle events onto standard OpenHands events so `projectExecutionStatus(events)` reflects accurate terminal states—including emitting `ConversationStateUpdateEvent` (`execution_status: "finished"` / `"idle"`) on `agent_settled` and `ConversationErrorEvent` on abort or unexpected child/daemon exit (crash liveness).
