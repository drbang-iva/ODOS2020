# W144 / V36 void and undo evidence

Author-side proof only; NOT EVALUATED. No commits created.

Production: retained top-level voidActionId; retained ledger action IDs; UndoStrip supplies exact displayed ID through ExamEntrySheet and EncounterHeader callbacks into EncounterCharting requests. The client maps undo-superseded to required copy; the strip removes retry. Old slots lacking action identity offer no blind Undo. EncounterCharting changes are callback prop plumbing only. ClearControls needed no change.

Existing assertions:
- ui/tests/encounterVoid.test.tsx:444 and :503: unchanged deep-equality assertions. Before: client silently dropped top-level voidActionId, 40/42 pass. After: full returned result retains ID, 42/42 pass. W144 / V36.
- ui/tests/encounterUndo.test.tsx:91: expected request before `{scope: section, sectionKey: entrance:pupils}`; after adds exact fixture voidActionId. W144 / V36.
- ui/tests/encounterUndo.test.tsx:94: rejection assertion still requires signed/closed error; request fixture now supplies action ID. W144 / V36.
- Shared slot fixture :28 and request setup :86/:377 gain ID. Existing capability, count, copy, scope, closed-state and restore assertions unchanged. W144 / V36.
- New five W144 tests cover both section and encounter strips, from void-response or reloaded ledger, exact HTTP request ID, superseded copy and absent retry; legacy missing-ID slot cannot invoke Undo.

Checks run from ui/:
- `node --import tsx --test tests/encounterVoid.test.tsx` baseline: 40 pass / 2 fail.
- `node --import tsx --test tests/encounterVoid.test.tsx tests/encounterUndo.test.tsx` restored: 74 pass / 0 fail.
- `npx tsc --noEmit --skipLibCheck`: exit 0 (empty output).

Mutation guards, restored in finally before continuing:
- Omit top-level returned voidActionId: 70 pass / 4 fail (74 tests); both original count-honesty assertions and new W144 response identity guards fail.
- UndoStrip passes undefined instead of displayed ID: 28 pass / 4 fail (32 tests), W144 exact request assertions.
- Remove undo-superseded classification: 28 pass / 4 fail (32 tests), W144 required copy assertions.
- Restore all three: 74 pass / 0 fail. Raw output included beside this ledger.
