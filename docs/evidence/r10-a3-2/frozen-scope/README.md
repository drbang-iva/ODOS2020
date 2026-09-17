# V21 / V22 / W-k frozen negative-scope guard demonstration

No committed assertions changed. Mutations were limited to OcularHealthSection.tsx after the final build completed, restored in finally, and verified byte-identical to the original. No dist or running app was changed. Both replacement anchors require exactly one match and fail loudly otherwise; a surviving mutant or failing restored test also aborts.

Run: `python3 docs/evidence/r10-a3-2/frozen-scope/mutate.py` from repo root. Exact node commands, head and source hash are in results.json. Tests run from ui/.

1. `V21 V22 a saved negative scope stays frozen after the live normal template changes`: temporarily render current definition normalTemplate in the recorded negative-act timestamp position. Changing live template prose then corrupts the recorded evidence. Mutant: 1 test, 0 pass, 1 fail, 0 skipped, exit 1. Restored: 1 test, 1 pass, 0 fail, 0 skipped, exit 0.
2. `V21 V22 posterior re-save stays pristine, round-trips selections, and preserves the saved negative scope`: temporarily replace hydrated negative optionCodes with an empty list on a refresh after save. An unrelated vitreous save then changes the recorded fundus scope. Mutant: 1 test, 0 pass, 1 fail, 0 skipped, exit 1. Restored: 1 test, 1 pass, 0 fail, 0 skipped, exit 0.

Both failures occurred at the intended frozen recorded-evidence equality assertion. Source restored SHA256: `583071e0867e613991a039b4bdcecdc47e47e23c8c0795ee1cde65faeb3f39f7`. Git diff for the production file was empty after restoration. This closes the targeted mutation evidence gap reported during the assertion-ledger audit; author-side proof only, NOT EVALUATED.
