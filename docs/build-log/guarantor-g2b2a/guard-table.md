# Per-guard mutation evidence

Revision 3 adds enforced K6 and K15 green/red/restored evidence in [revision3/README.md](revision3/README.md). It supersedes the historical K6 route-only limitation below.

Each row lists command exit codes. Green/restored 0 means success; red 1 means the named test failed. These tests use persistent in-memory transport fixtures; separate real Medplum HTTP and Chromium runs are linked in README.md.

| Control | Green | Red | Restored | Failing test |
| --- | --- | --- | --- | --- |
| K1-unfiltered | 0 | 1 | 0 | K1 search refuses a prefix-only family<br>K2 phone compares digits and rejects a different digit<br>K4 inactive excluded<br>K4 zero-link excluded<br>K4 non-RelatedPerson excluded |
| K2-raw-phone | 0 | 1 | 0 | K2 phone compares digits and rejects a different digit |
| K3-resource | 0 | 1 | 0 | K3 search card exposes exactly six keys |
| K4-inactive | 0 | 1 | 0 | K4 inactive excluded |
| K4-zero-link | 0 | 1 | 0 | K4 zero-link excluded |
| K4-other-link | 0 | 1 | 0 | K4 non-RelatedPerson excluded |
| K5-cap | 0 | 1 | 0 | K5 21 matches return 422 |
| K5-error-mapping | 0 | 1 | 0 | K5 201 matches return 422 |
| K7-extra-patient | 0 | 1 | 0 | K7 create writes exactly one active unlinked Person; missing surname writes nothing |
| K7-name-check | 0 | 1 | 0 | K7 create writes exactly one active unlinked Person; missing surname writes nothing |
| K8-draft-record | 0 | 1 | 0 | K8 draft includes every source link, writes nothing, refuses consolidate subset<br>K9 draft versions reject changed child at create |
| K8-subset | 0 | 1 | 0 | K8 draft includes every source link, writes nothing, refuses consolidate subset |
| K8-empty | 0 | 1 | 0 | K8 empty consolidation draft refuses with zero writes |
| K9-auto-retry | 0 | 1 | 0 | K9 stale confirmation makes one create and requires Review again<br>K10 new Move creates Person before draft and Review again reuses it |
| K10-draft-before-person | 0 | 1 | 0 | K10 new Move creates Person before draft and Review again reuses it |
| K10-second-person | 0 | 1 | 0 | K10 new Move creates Person before draft and Review again reuses it |
| K11-swapped | 0 | 1 | 0 | K11 Join keeps Loaded Ann and moves loser full set<br>K11 Join keeps Found Ann and moves loser full set |
| K12-pending | 0 | 1 | 0 | K12 pending offers no Move Join or history Undo |
| K13-correct-undo | 0 | 1 | 0 | K13 Undo only on completed non-correct and requires a reason |
| K14-enabled | 0 | 1 | 0 | K14 create-new starts disabled before any keyed search<br>K14 matching cards require None of these before new guarantor |
| K9/K13 retry id | 0 | 1 | 0 | K9 uncertain confirmation retry reuses the submitted operation id; K13 uncertain Undo retry reuses the submitted correction id |
| K10 skip draft | 0 | 1 | 0 | K10 existing Move drafts before create; K10 new Move creates Person before draft and Review again reuses it |
| Registry delete A2 entry | 0 | 1 | 0 | preflight refuses unregistered service-identity transaction write |

## K6 — decorative route-only control

The prescribed route-only substitution cannot turn authorization green-to-red: `authenticateStaffRouteForAction` in index.ts selects actorRole; it does not remove the effective business-action check. Both new search/create handlers and the shipped Operation constructor check `guarantor.link`. The live proof authenticates through the prescribed generic authenticateStaffRoute with an actually revoked membership: all four new routes return 403 and produce zero operation writes. k6-control-result.json separately proves the constructor refuses before any operation I/O. No constructor or role-policy mutation was performed to manufacture a red. Therefore K6 authorization is live-proven, but its specified route-only mutation is DECORATIVE, not demonstrated green/red/restore. This limitation requires evaluator attention.

K10 no-draft and registry logs are adjacent to results.json. No new audit event type was added.
