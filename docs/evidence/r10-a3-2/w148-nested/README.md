# W130/W137 inactive child review follow-up

At 771f97de CodeRabbit identified that a recorded inactive descendant could still be hidden by the parent-only chip list. Accepted: historical inactive children render independently in the chip list, with the projection-derived lock and present/absent state. They are excluded from the parent worksheet catalog to prevent a duplicate editable control. No ancestor is asserted or selected to expose a historical child.

Four parameterized cases cover absent/present child facts with the parent selected or unselected/inactive. Initial red: 0 pass / 4 fail. The focused set restores green at 19/19. Removing standalone visibility gives 15 pass / 4 fail; restoring gives 19/19. Restoring inactive descendants to the worksheet catalog gives 17 pass / 2 fail; restoring gives 19/19. Both mutations require exactly one anchor and restore source bytes in finally.

The unified assertion ledger versus 3222c6f2 records 57→99 assertion expressions across seven changed test groups. Existing baseline assertions are unchanged. Full checks, served (a)–(h), W148, Retry, SSE, CI and terminal review are resealed under `.odos/r10-a3-2-w148-final/` at the new clean head. Previous candidate evidence is historical.

NOT EVALUATED

Coded-by: Codex — GPT-6 Astra, high effort
