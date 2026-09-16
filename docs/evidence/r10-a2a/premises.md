# R10 A2a premise verification

ODOS origin/main and task base: `b761a8a27df29bf954c9b53ed126000f01f449dd`.
PerformanceOD origin/main: `05d83563b34c8e213a959cac7c6e15ee387bfd74`.
Both remotes fetched 2026-09-16. Contract and both adjudications read through git show origin/main. Shared checkouts were not switched or pulled.

All twelve section 2 premises hold at this exact base:

1. Production import search finds only reader-to-identity library usage; no handler calls A1.
2. Reader lines 23-24 and 110 return the untyped incomplete/reason shape.
3. Reader lines 193-200 and 313-333 select canonical contributors, union their evidence/extensions, and infer only for legacy with no explicit home.
4. Reader lines 138-160 keep negative acts in panels and select only live positive section snapshots. Existing test assertions at lines 86, 87 and 172 still retain the older positive.
5. Reader lines 149-150 put UNKNOWN in unresolved before status selection.
6. Findings endpoint lines 639-685 select the newest whole section; lines 803-805 use effectiveDateTime, issued, lastUpdated in that order.
7. OcularHealthSection lines 1228-1242 use active options, empty exclusions, and skip touched eyes.
8. Identity lines 16-41 enforce a strict key envelope; lines 54 onward restrict qualifier parsing to the addressed catalog field.
9. FHIR client lines 801-907 support headers for create/createWithOutcome/update; created is exactly HTTP 201.
10. Findings endpoint lines 992-1037 emit mutation and reassertion Provenance. Carry reader lines 113-128 and 319-339 relies on Provenance presence/activity.
11. A1 preflight-results.json lines 269-306 explicitly describe P7 as a diagnostic retry, not an A2 protocol.
12. Installed @medplum/fhirtypes is 4.5.2; its Provenance.d.ts and the HL7 R4 structure both omit identifier (sources in mandate-14.md).

Scope check: open PR #612 have no overlap with A2a allowed code files. Root ODOS checkout was clean and behind origin/main; it was left unchanged. Worktree: `.worktrees/r10-a2a`; branch: `drbang-iva/r10-a2a`.

Rev 3.1 re-verification: every cited premise source is byte-identical between 6a3ad04a and b761a8a2. The reader draft was imported only after rebasing. Role policies were recompiled from b761a8a2 and G-a..G-d rerun under each synthetic role; see principals.json and gate-results.json. The age-of-majority Basic rule changed outside this slice.

Final rebase verification: origin/main 87ca9f1d10c63a4796068c0a8d8cbda88fdf968c (#612) has no changes to any §2 finding or role-policy source. Handler import search still finds only the reader/identity/writer library imports. The final affected suites and live writer proofs were rerun on the rebased tree.
