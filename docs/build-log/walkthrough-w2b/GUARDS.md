# W2b guard evidence

## Initial handler baseline

```text
not ok 62 - W2b G1 eye code prefers medical
not ok 63 - W2b G2 E/M prefers medical
not ok 64 - W2b G3 G6 eye code falls back to the lowest-ranked refractive diagnosis
not ok 65 - W2b G4a vision plan prefers refractive
not ok 66 - W2b G4b vision plan with only medical has no default
not ok 67 - W2b G5 irregular astigmatism and aniseikonia are medical
not ok 68 - W2b G5 other and unspecified refraction are refractive
not ok 69 - W2b G7 unclassified text and unreadable Conditions preserve rank one
# tests 80
# pass 72
# fail 8
# skipped 0
```

Only the eight newly added guards failed; 72 existing tests passed. The restored implementation passed 80/80.

## G1–G7 mutation evidence

```text
g1-red: exit=1
not ok 1 - W2b G1 eye code prefers medical
not ok 2 - W2b G2 E/M prefers medical
not ok 3 - W2b G3 G6 eye code falls back to the lowest-ranked refractive diagnosis
not ok 4 - W2b G4a vision plan prefers refractive
not ok 5 - W2b G4b vision plan with only medical has no default
not ok 6 - W2b G5 irregular astigmatism and aniseikonia are medical
not ok 7 - W2b G5 other and unspecified refraction are refractive
not ok 8 - W2b G7 unclassified text and unreadable Conditions preserve rank one
# tests 8
# suites 0
# pass 0
# fail 8
# cancelled 0
# skipped 0
# todo 0

g1-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

g2-red: exit=1
not ok 2 - W2b G2 E/M prefers medical
# tests 8
# suites 0
# pass 7
# fail 1
# cancelled 0
# skipped 0
# todo 0

g2-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

g3-red: exit=1
not ok 3 - W2b G3 G6 eye code falls back to the lowest-ranked refractive diagnosis
not ok 4 - W2b G4a vision plan prefers refractive
not ok 7 - W2b G5 other and unspecified refraction are refractive
not ok 8 - W2b G7 unclassified text and unreadable Conditions preserve rank one
# tests 8
# suites 0
# pass 4
# fail 4
# cancelled 0
# skipped 0
# todo 0

g3-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

g4a-red: exit=1
not ok 4 - W2b G4a vision plan prefers refractive
not ok 5 - W2b G4b vision plan with only medical has no default
not ok 6 - W2b G5 irregular astigmatism and aniseikonia are medical
not ok 7 - W2b G5 other and unspecified refraction are refractive
not ok 8 - W2b G7 unclassified text and unreadable Conditions preserve rank one
# tests 8
# suites 0
# pass 3
# fail 5
# cancelled 0
# skipped 0
# todo 0

g4a-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

g4b-red: exit=1
not ok 5 - W2b G4b vision plan with only medical has no default
not ok 6 - W2b G5 irregular astigmatism and aniseikonia are medical
# tests 8
# suites 0
# pass 6
# fail 2
# cancelled 0
# skipped 0
# todo 0

g4b-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

g5-astigmatism-red: exit=1
not ok 6 - W2b G5 irregular astigmatism and aniseikonia are medical
# tests 8
# suites 0
# pass 7
# fail 1
# cancelled 0
# skipped 0
# todo 0

g5-astigmatism-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

g5-aniseikonia-red: exit=1
not ok 6 - W2b G5 irregular astigmatism and aniseikonia are medical
# tests 8
# suites 0
# pass 7
# fail 1
# cancelled 0
# skipped 0
# todo 0

g5-aniseikonia-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

g6-red: exit=1
not ok 3 - W2b G3 G6 eye code falls back to the lowest-ranked refractive diagnosis
# tests 8
# suites 0
# pass 7
# fail 1
# cancelled 0
# skipped 0
# todo 0

g6-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

g7-red: exit=1
not ok 8 - W2b G7 unclassified text and unreadable Conditions preserve rank one
# tests 8
# suites 0
# pass 7
# fail 1
# cancelled 0
# skipped 0
# todo 0

g7-green: exit=0
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0

```

## G8 baseline

`npm --prefix ui test`: 1912 tests, 1912 passed, 0 failed, 0 skipped. Both new dry-eye guards were green before UI product edits; no such edits were made.

## G9 fresh-stack proof

```text
cleanup-guard: exit=0
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
stack-up: exit=0
healthcheck: PASS attempt=12/90 interval=2s baseUrl-byte-identical=true
live-integration: exit=0
# tests 12
# suites 0
# pass 12
# fail 0
# cancelled 0
# skipped 0
# todo 0
# tests 218
# suites 0
# pass 218
# fail 0
# cancelled 0
# skipped 0
# todo 0
operator-identity: exit=0
role-repair: exit=0
live-authz: exit=0
# tests 78
# suites 0
# pass 78
# fail 0
# cancelled 0
# skipped 0
# todo 0
runtime-service: exit=0
g9-baseline: MCP ready attempt=3
g9-baseline: exit=0
provider: invite=200 User=1 ProjectMembership=1 profile=present binding=200 admin=false provider-access=true
provider: comprehensive-exam-new create=200 readback=200 pointer=glaucoma expected=glaucoma
provider: routine-vision-exam-new create=200 readback=200 pointer=myopia expected=myopia
provider: G9 2/2 persisted visit defaults PASS
g9-red: MCP ready attempt=2
g9-red: exit=1
provider: invite=200 User=1 ProjectMembership=1 profile=present binding=200 admin=false provider-access=true
provider: comprehensive-exam-new create=200 readback=200 pointer=myopia expected=glaucoma
provider: routine-vision-exam-new create=200 readback=200 pointer=myopia expected=myopia
g9-restored: MCP ready attempt=2
g9-restored: exit=0
provider: invite=200 User=1 ProjectMembership=1 profile=present binding=200 admin=false provider-access=true
provider: comprehensive-exam-new create=200 readback=200 pointer=glaucoma expected=glaucoma
provider: routine-vision-exam-new create=200 readback=200 pointer=myopia expected=myopia
provider: G9 2/2 persisted visit defaults PASS
stack-down: exit=0
NAMES               STATUS
vf-prac1b-walk-db   Up 7 days

```

## G8 served-order mutation

Reversed KCS and dry-eye syndrome in the real seed order, then restored the seed source byte-for-byte.

```text
g8-red: exit=1
not ok 1885 - W2b G8 Find dx serves KCS first for dry eye
not ok 1886 - W2b G8 DiagnosisPicker serves KCS first for dry eye
# tests 1912
# suites 0
# pass 1910
# fail 2
# cancelled 0
# skipped 0
# todo 0

g8-green: exit=0
# tests 1912
# suites 0
# pass 1912
# fail 0
# cancelled 0
# skipped 0
# todo 0

related-final: exit=0
# tests 80
# suites 0
# pass 80
# fail 0
# cancelled 0
# skipped 0
# todo 0


```

## First full MCP run

```text
full-mcp-ci-unit: exit=1
not ok 4208 - W87a W87b W129 exact finding write registry covers every call site including Binary patches
not ok 4226 - T22 every registered finding write path uses real handlers and emits permitted Observations
# tests 6175
# suites 0
# pass 6114
# fail 2
# cancelled 0
# skipped 59
# todo 0
```

Both failures reported the unused `createWithOutcome` wrapper copied into the new test helper as an unregistered resource write. Removed that unused helper method from the new test file; no registry or existing assertion changed.

## Final MCP verification after helper repair

G1–G7 repeated the same red/green counts above after removing the unused test helper method. The related suite again passed 80/80.

```text
full-mcp-ci-unit: exit=0
# tests 6175
# suites 0
# pass 6116
# fail 0
# cancelled 0
# skipped 59
# todo 0
dedicated Postgres cleanup: exit=0
NAMES               STATUS
vf-prac1b-walk-db   Up 7 days

```

The full MCP command matches the CI unit file selection and ran with dedicated Postgres and no operator files. Its 59 skips include credentialed, destructive-fixture, and other opt-in lanes. They are not counted as passed; the separate credentialed live lanes above cover their stated file sets only.

Build checks: `npm --prefix mcp run build`, `npm --prefix ui run build`, and `npm run typecheck:scripts` each exited 0. `git diff --check` passed.
