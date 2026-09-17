# Rev 2.5 live authorization results

Author evidence — NOT EVALUATED. [Raw TAP](rev25-live-first.txt): **4 tests, 4 pass, 0 fail, 0 skipped, 0 TODO**. [Parsed evidence](rev25-live-results.json) preserves all **38 diagnostic rows**: staff 16, provider 16, MCP service 6. These operation rows are not additional tests. Every row includes role, target project, resource, before/after, policy reference(s), `test:live-authz` and `blocking: true`.

Target project: `14e0ec2a-cc7f-4ce6-be82-49d9417f3e95`. Staff policy: `AccessPolicy/2a64dbb9-ffea-4cbe-9647-b0713f422913`; provider policy: `AccessPolicy/95fa2233-96b0-49df-850b-f34981c88326`. The project admin MCP actor is `Practitioner/3bd8ef2d-cf96-463b-baa7-bbb3e24e7c23`, password fallback, no AccessPolicy references, explicit admin membership; authenticated active project equals the target and super-admin status is false. The bound synthetic clinician is `Practitioner/3293c640-ea23-47cb-b8b7-18664b93e0d0`. Actor references, policy versions and resource versions are retained per row in JSON.

| Rev 2.5 §7 obligation | Observed proof |
|---|---|
| Staff/provider assert, clear, revive | preliminary → entered-in-error → preliminary, same canonical owner with successive versions |
| Panel create/update with measurement; negative act | Panel TBUT 6 → 9, updated version; negative Observation created |
| Provider pull and identical resend | Condition plus one carried fact and two plan/findings Provenances; replay leaves fact states unchanged and retains one Condition/two Provenances |
| Canonical void/undo with action identity | entered-in-error → preliminary using recorded `voidActionId`; stale action refused 409 with zero writes |
| Closed door PUT/save/pull | PUT/save 409 both roles; provider pull 409, zero writes. Staff pull is denied 403 before closed-encounter handling, consistent with provider-only carry; it is not counted as evidence of the 409 guard |
| Pre-rebuild save; signed void; mismatched audit | 409 / 422 zero writes; forged audit surfaced as `auditPending: true` |
| Closed canonical amendment via real MCP dispatch | Observation PATCH **200**, final → amended, version advanced, identifier/components/extensions byte-identical |
| Lifecycle Provenance outcome | Entry **404**, GET 404 recorded. This is the known separate lifecycle defect; success is not claimed, and 404 is not required by the test |
| Generic MCP shared create | Public-schema refusal, zero FHIR writes; canonical append also refuses with shared-finding guard reason |
| Mismatching practitioner; pre-rebuild canonical amendment | Real dispatch refuses with corresponding reason; zero attempted writes, unchanged Observation and Provenance readback |

No missing §7 operation was found in the current test and recorded run. The staff closed-pull 403 is explicitly distinguished from the provider 409 proof. The generic-create row proves refusal at the public schema, not execution of a downstream guard. The three new live W115 mutation pairs independently kill removal of pre-rebuild refusal, session binding and identity preservation; each restores to 4/4. Broader package/live-lane checks and final-head independent evaluation remain separate evidence.
