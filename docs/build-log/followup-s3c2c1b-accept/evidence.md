# S3c-2c-1b author proof

Base and current `origin/main`: `80c365fe6fecbf890d860977db68277aac19e936` after `git fetch origin` on 2026-09-21. The tracked-file grant is §4 of the kickoff; ignored check outputs in `.odos/` are permitted by R1. No tracked file outside §4 changed. `git diff 80c365fe..HEAD -- mcp/src/clinical-graph/follow-up-decision-store.ts` is empty after G15 restoration.

## Checks

| Command | Base | Head |
| --- | --- | --- |
| `npm --prefix ui test` | 1,840 pass, 0 fail, 0 skip, exit 0 | 1,843 pass, 0 fail, 0 skip, exit 0 |
| `ODOS_POSTGRES_URL=... npm --prefix mcp test` | 6,193 pass, 0 fail, 55 skip, wrapper exit 1 | 6,210 pass, 0 fail, 55 skip, wrapper exit 1 |
| `npm run typecheck:scripts` | exit 0 | exit 0 |
| `cd mcp && npx tsc --noEmit` | exit 0 | exit 0 |
| `cd ui && npx tsc --noEmit --skipLibCheck` | exit 0 | exit 0 |
| `npm run preflight` | 0 warnings, 0 hard blocks | 0 warnings, 0 hard blocks |

Each MCP run used its own dedicated `odos-s3c2c1b-*` PostgreSQL container and `ODOS_POSTGRES_URL`. The MCP wrapper's exit 1 reflects its live-stack authorization skip gate; the executed assertions had zero failures. Head is +3 UI tests and +17 MCP tests. G1–G16 break/red/restore/green counts are in `mutations.tsv`. Every mutation exited 1 while broken and 0 after restoration; the file names the failing assertions and the pass/fail counts.

## Live synthetic money seam

Disposable Docker Compose project `odos-s3c2c1b-money` ran Medplum 5.1.8, Postgres 16 and Redis 7 with fresh prefixed volumes. The existing contract bootstrap smoke test passed 12/12. The proof called the real Accept, charge PATCH, queue GET, and sign-cleanup handlers using an authenticated FHIR client backed by this stack; it did not drive the odos-core HTTP route. All visits and identities were synthetic. Existing procedure concepts were priced in that disposable practice at visual field $100, OCT optic nerve $80, fundus photography $60 with a synthetic billing code. Each accepted proposal had `units: 1`.

1. Accept visual field, OCT optic nerve, optic-nerve photos and retina photos: queue shows all four `already-ordered`/`billed`; four live order actions and four ServiceRequests; three accepted charges. The two photo rows share one charge.
2. Remove OCT then sign: sign cleanup reports `materialized: 2, finalized: 2`; the visit has two ChargeItems totaling **$160**. The OCT order remains live.
3. On a second identical visit, remove and restore OCT, switch visual field to the macular diagnosis, then sign: `materialized: 3, finalized: 3`; three ChargeItems total **$240**. The visual field ChargeItem's `supportingInformation` reference equals the macular Condition reference.
4. With an active uncoded gonioscopy fee, Accept creates one order, zero charges, `charge.status: "uncoded"`; the row sentence is “No charge — Gonioscopy has no billing code in the fee schedule”.
5. Headless Chrome rendered the real `FollowUpQueue` component through a dedicated Vite server with synthetic queue responses. `for-review.png`, `billed.png` and `removed.png` show the three requested control states. These screenshots verify browser rendering and button presence; the live Medplum proof above verifies writes and money.

The current slice does not complete orders, promote staged protocol charges to accepted, edit Visit charges, support units other than 1, or add laterality.
