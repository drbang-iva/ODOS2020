# Final-head review follow-up: in-flight editing

CodeRabbit at 95a8582f raised two findings. The inline encounter-navigation claim is rejected for the served route: ui/src/App.tsx:581 returns EncounterCharting keyed by encounterId. Changing visits unmounts the old chart/editor and its state; old callbacks retain the old chart closure. The editor's notice reset also covers definition identity changes within a visit. No general reset of live retry state is added from the incorrect assumption that the chart instance survives visit navigation.

The outside-diff in-flight editing finding is accepted. While the first save waits, later edits could enter the capture used by an identical Retry and then be incorrectly marked pristine. The common editingLocked guard now includes saving, blocks the actual eye fieldset and edit handlers, and also blocks All Normal while a request or unresolved retry is pending. The submitted request remains byte-identical on Retry and no unsent edit can enter that saved capture.

W131/W148 in-flight save locks edits so identical Retry cannot mark unsent edits saved: initial red 0 pass / 1 fail; restored focused set 11/11. Removing saving from editingLocked gives 10 pass / 1 fail; restored 11/11. Exact mutation restores source bytes and requires one anchor. all-assertion-ledger.json records the seven new assertion expressions versus 95a8582f; existing assertions unchanged. Full final-head checks and served proof are resealed under .odos/r10-a3-2-w148-final, preserving clean git identity.

NOT EVALUATED

Coded-by: Codex — GPT-6 Astra, high effort
