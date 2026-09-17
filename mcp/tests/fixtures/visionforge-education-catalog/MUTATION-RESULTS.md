# Mandate 17: CI-shaped break → red → restore → green

Run from the ODOS O1 worktree. This uses CI’s `ODOS_POSTGRES_URL` name and deliberately unsets the obsolete catalog-only variable. The disposable test database was started with:

```sh
docker run -d --name odos-o1b-pg -e POSTGRES_DB=medplum -e POSTGRES_USER=medplum -e POSTGRES_PASSWORD=medplum -p 127.0.0.1:15433:5432 postgres:16-alpine
docker exec odos-o1b-pg pg_isready -U medplum -d medplum
```

Each command below runs the named mutation, its focused red check, restores the original source bytes in `finally`, and reruns the same focused check green. The exact mutation and focused test command are in [`mcp/tests/catalog_guard_probe.py`](../../catalog_guard_probe.py); `/tmp/odos-o1b-guards/G*-red.tap` and `G*-green.tap` retain the full local outputs. Only `ODOS_POSTGRES_URL` is set for the test; `ODOS_CATALOG_TEST_POSTGRES_URL` is explicitly unset. No Medplum/admin credential is used. There are **no skipped tests** in either phase.

| Guard | Exact command and environment (worktree root) | Red (`exit/pass/fail/skip`) | Restored green (`exit/pass/fail/skip`) |
|---|---|---|---|
| G1 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G1` | `1/0/1/0` | `0/1/0/0` |
| G2 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G2` | `1/0/1/0` | `0/1/0/0` |
| G2b | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G2b` | `1/0/1/0` | `0/1/0/0` |
| G3 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G3` | `1/0/1/0` | `0/1/0/0` |
| G4 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G4` | `1/0/1/0` | `0/1/0/0` |
| G5 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G5` | `1/0/1/0` | `0/1/0/0` |
| G6 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G6` | `1/0/1/0` | `0/1/0/0` |
| G7 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G7` | `1/0/1/0` | `0/1/0/0` |
| G8 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G8` | `1/0/1/0` | `0/1/0/0` |
| G9 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G9` | `1/0/1/0` | `0/1/0/0` |
| G10 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G10` | `1/0/1/0` | `0/1/0/0` |
| G11 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G11` | `1/0/1/0` | `0/1/0/0` |
| G11b | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G11b` | `1/0/1/0` | `0/1/0/0` |
| G12 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G12` | `1/0/1/0` | `0/1/0/0` |
| G13 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G13` | `1/0/1/0` | `0/1/0/0` |
| G14 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G14` | `1/0/1/0` | `0/1/0/0` |
| G15 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G15` | `1/0/1/0` | `0/1/0/0` |
| G16 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G16` | `1/0/1/0` | `0/1/0/0` |
| G17 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G17` | `1/0/1/0` | `0/1/0/0` |
| G18 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G18` | `1/0/1/0` | `0/1/0/0` |
| G19 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G19` | `1/0/1/0` | `0/1/0/0` |
| G20 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G20` | `1/0/1/0` | `0/1/0/0` |
| G21 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G21` | `1/n/a/n/a/n/a` | `0/n/a/n/a/n/a` |
| G22 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G22` | `1/0/1/0` | `0/1/0/0` |
| G23 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G23` | `1/0/1/0` | `0/1/0/0` |
| G24 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G24` | `1/0/1/0` | `0/1/0/0` |
| G25 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G25` | `1/0/1/0` | `0/1/0/0` |
| G26 | `env -u ODOS_CATALOG_TEST_POSTGRES_URL ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum python3 mcp/tests/catalog_guard_probe.py G26` | `1/0/1/0` | `0/1/0/0` |

G21 uses `node --import tsx scripts/fhir-read-grant-check.ts` inside the probe, so it emits no TAP counts. Its red was `Service-identity FHIR write exclusion entry no longer matches a real ungranted call site: mcp/src/index.ts:7895 fhir.patch AccessPolicy`; its restored green was `FHIR read grant check: PASS` (48 resource types, 922 operations). No census row was added or changed in this fixback.
G23 red forwarded `Bearer synthetic-o1-seam-secret` to the same-origin target; restored green never requested the target. `redirect: "error"` was already present at #622’s evaluated head.
G24 red accepted the regression envelope after two failed baseline reads; restored green refused `storage-unavailable` without a network request or store write, then refused `lifecycle-regressed` after the load recovered.
G25 red selected `C0 accepted through real HTTP` and `snapshot persistence keeps accepted evidence` as `# SKIP` under the obsolete variable. The `educationCatalogCiPresence.test.ts` watchdog failed; restored green executed both with no skips.
G18 temporarily moved the pinned schema lines; G19 temporarily edited `plan-sets/generator.ts`; both files were restored byte-for-byte. The C0 capture body, headers and fixture writer were never edited or recaptured.
