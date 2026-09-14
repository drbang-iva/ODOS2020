# G-2b-1 live operation capture

Author development evidence: **115 assertions passed, 0 failed** across 13 real HTTP schedules. The capture contains **2025 HTTP exchanges**, 297 application transaction calls, and 833 persisted audit rows, including 39 guarantor-operation rows. It is not an independent evaluation or a final-head release verdict.

The source checkout HEAD was `5e7c2aef7f6b59432deb6046fda8e65056796b10`, with the operation implementation still uncommitted at capture time. Its SHA-256 was `7319e313f64978137142e36462b5feb501ee3bcf843153456f1a61956100ee37`. All six recorded implementation digests match before and after the capture.

| Schedule | Scenario assertions | HTTP exchanges | Operation audit rows |
|---|---:|---:|---:|
| L1 | 6 | 152 | 4 |
| L3 | 17 | 216 | 3 |
| L4 | 7 | 139 | 2 |
| L11-Destination | 2 | 27 | 0 |
| L11-Patient | 2 | 31 | 0 |
| L13 | 7 | 91 | 4 |
| L14-landed | 9 | 171 | 4 |
| L14-unsent | 9 | 168 | 3 |
| L15-paused | 9 | 259 | 4 |
| L15-takeover-fail | 10 | 248 | 5 |
| L15-partial-correction | 9 | 268 | 4 |
| L16-claim | 7 | 148 | 4 |
| L16-demographics | 6 | 107 | 2 |

The total assertion count also includes fourteen audit checks and one source-digest check. L3 includes the actual pending editor and sibling G-2a save, then real Complete; service-authored foreign `lab-order-transmission` Tasks in both in-progress and completed states are ignored by step 0. No lab submit path is invoked. L15 includes both contract schedules and the stronger schedule where C pauses before attaching to S and A must yield takeover-in-progress after its fenced D write receives 412. L16's claim competitor is a genuine service-authored Task recorded through the actual route; its setup claim is unsent, and the competing current-version claim lands through staff FHIR after A's verification. The evidence does not assert that a stale original B claim request could land.

`live-operation-proof.mjs` mounts the actual `registerGuarantorRoutes` on owned loopback port 28765, with the actual staff authenticator, service FHIR client and PostgreSQL audit runtime. The injected functions only schedule competitors, pause a prepared write, or discard a real response. Each service write remains a single-entry conditional transaction Bundle. The raw trace retains the HTTP response and the entry-level status and If-Match value; the assertions inspect those entry-level 200/412 responses.

`live-operation-http.json` retains requests and responses. Authentication responses retain identity, membership and Person/Task policy rules plus a digest of the full response; session details are omitted. `live-operation-proof.json` contains fresh resource snapshots, Task journals, transaction metadata, checks and audit rows. `live-operation-runtime.json` confirms Medplum 5.1.30-9b1bd92, two synthetic practice Projects plus its isolated bootstrap Project, transaction-bundles absent, real non-admin staff/composite memberships and a final repository sync dry run with four matching policies and zero membership drift.

The first instrument assumed direct PUTs and missed Bundle entry writes; its guards failed and the transport inspection was corrected. `live-operation-harness-check.json` records that repair. The audit seal then found a real implementation defect: C cancelled A before A could checkpoint its late definite 412, leaving A's intent unresolved. `live-operation-journal-before.json` preserves the red assertion and exact synthetic Task/intent evidence. The rerun verifies that A stays cancelled and that intent is recorded as rejected/412.

The membership seal found ordering drift in fixture grants. The repository's actual composite compiler proved the before/after grant sets identical, and its actual sync normalized the ordering. The fixture helper now uses that compiler. `live-operation-membership-normalization.json` records the equivalence and the zero-drift result.

Run from the live worktree with its existing private disposable fixture:

```sh
G2B1_SOURCE_ROOT=<implementation-worktree> node --import tsx docs/build-log/guarantor-g2b1/live-operation-proof.mjs
```

The runner closes its own application server and audit connection. It leaves the disposable Medplum/Postgres/Redis fixture running. The browser proof and L17/L18 policy captures are separate evidence. The unchanged pre-existing audit-schema test expectation failure is recorded in `live-audit-schema-tests.json`; no existing tests or application files were edited in this evidence branch.
