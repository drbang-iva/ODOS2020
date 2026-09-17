# W148 — staged All Normal replacement notice

Adopted operator ruling: a scoped positive replaces an unsaved negative act; accept the positive-only save. A saved negative act plus a contradicting positive retains the server W68/W69 refusal. No MCP source or server assertion changes in this round.

The affected eye displays “All Normal cleared for this eye because a finding was recorded” until its command completes. Remarks/grades/measurements/empty Other retain the staged act without that notice. Failed/unconfirmed saves retain the notice; an identical Retry clears it after success. Notice ids are scoped to structure and eye, cleared on visit change, and completion only clears the notice id observed by that save.

Focused tests: W148 OD/OS staged All Normal replacement is explained until positive-only save completes; W148 replacement notice survives an unconfirmed save and clears after identical Retry succeeds; four W133 compatible edits and three W133 contradictory edits. The existing W133 refused-response fixture continues to test response handling only; the new W148 success fixtures and final served probe establish the accepted positive-only path.

Initial red: 7 pass / 3 fail (missing notice). Green: 10/10. Exact notice-removal mutation: 7 pass / 3 fail; restored 10/10. All exits and TAP are retained. The runner requires exactly one anchor and restores original bytes in finally. The initial wrong-working-directory invocation produced React-is-not-defined errors and is retained as wrong-cwd.fixture-invalid, explicitly excluded from behavioral proof.

all-assertion-ledger.json contains exact before/after assertion expressions versus 3222c6f2, with W133/W148 mapping. Existing workspace assertions are unchanged. No assertion is removed or weakened. Three new tests add 12 assertions, and the existing compatible-edit parameterized test adds one per instance.

Final full-suite/build/browser/CI/bot evidence is sealed after commit under the gitignored .odos/r10-a3-2-w148 directory, preserving clean application identity. Independent Claude Opus evaluation remains required. HELD OPEN; never merge.

NOT EVALUATED

Coded-by: Codex — GPT-6 Astra, high effort
