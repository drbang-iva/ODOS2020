# Mandate 17 break/restore results

| Guard | Red | Restored green |
|---|---|---|
| G1 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G2 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G2b | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G3 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G4 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G5 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G6 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G7 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G8 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G9 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G10 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G11 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G11b | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G19 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G12 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G13 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G14 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G15 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G16 | exit 1, pass 3, fail 2 | exit 0, pass 5, fail 0 |
| G20 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G17 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G18 | exit 1, pass 0, fail 1 | exit 0, pass 1, fail 0 |
| G21 | Stale index.ts:7895: exact-location census failed, `ERR_TEST_FAILURE` | `FHIR read grant check: PASS` (48 resource types, 922 operations); only line 7895→7898 |

Additional withdrawal-race test: prepared scheduled dispatch after accepted withdrawal was red (`Missing expected rejection`, 0 passed/1 failed) and green after the execution check (178 passed/0 failed across affected comms suites). The original G1–G20 mutations were all restored before this focused fix; it does not change their target branches.
