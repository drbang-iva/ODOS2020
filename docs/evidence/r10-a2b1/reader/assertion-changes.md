# Reader amendment assertion ledger

Baseline: 4b3f6d7c25fb40268e216dcd22ad03a866d03643. NOT EVALUATED.

All existing changed assertions are in `mcp/tests/currentFindingReader.test.ts`. Line references below name the baseline.

| Line | Before | After | Contract |
|---|---|---|---|
| 234 | Missing resource id gives `missing` | `upstream` | W-g |
| 236 | Next link without URL gives `refused` | `upstream` | W-g |
| 251 | Invalid operation marker during audit load gives `refused` | `upstream` | W-g |
| 277 | HTTP matrix covers 403, 404 | Also covers 410 → `missing` | W-g |
| 304 | Audit lookup exception gives `refused` | `upstream`; same sanitized reason | W-g |

Added assertions: `preRebuild` true for legacy atomic (including retired), legacy snapshot, unresolved UNKNOWN, invalid canonical; false for empty, canonical-only, and negative-act-only projections. W-i / V3.

TDD reader red: 34 tests, 29 pass, 5 fail. Reader+writer+parity green: 239 tests, 239 pass, 0 fail. No captures or divergence fixtures changed.
