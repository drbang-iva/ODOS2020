# Inactive recorded-absent history — final review fix

CodeRabbit's outside-diff finding at cb69007a is accepted under the historical identity contract (§3.2) and Recorded absent rendering (§3.4, W130/W137). Inactive options with any live canonical fact remain visible. The existing projection-derived editable:false flag locks the row. A live absent row stays unchecked and outside both loaded and selected on a Remarks save, so it is never written by omission.

W130/W137 inactive recorded-absent fact stays visible, unchecked and locked: initial red 0 pass / 1 fail; restored focused set 14/14. Restoring the present-only inactive filter fails this test; restored 14/14. The mutation requires one anchor and restores source bytes. No server or existing assertion changed. all-assertion-ledger.json is the unified final ledger versus 3222c6f2, including all W148 and Retry fixes.

Full checks, served (a)-(h), W148, the actual in-flight Retry proof, screenshots, SSE and final CI/review are resealed at the final clean head under .odos/r10-a3-2-w148-complete. Prior candidates remain historical evidence only.

NOT EVALUATED

Coded-by: Codex — GPT-6 Astra, high effort
