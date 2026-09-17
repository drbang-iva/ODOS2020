# §3.7 author implementation checkpoint

Implemented in allowed overview/completeness sources. Pure shared evidence selection lives in exam-overview-projection.ts. Shared FHIR reader/carry loading is exported from existing exam-overview-endpoint.ts for both endpoints, avoiding duplicated plan/witness interpretation or a new production file. No matcher cycle, schema/seed/policy change, commit, or live test.

Behavior: canonical facts and explicit negative acts credit; panel values including TBUT=0 credit; deferred/Other/Remarks alone, retired/cleared/inactive records and unchanged carried clinical content do not. Reader homes supply overview links. PreRebuild legacy views display without current-fact credit. Stored local-practice option is exercised through real store loading in both endpoints. Original carry ownership comes from shared validated plan/witness APIs; homes/version-only edits do not create credit. Valid later reassertion or changed presence/qualifiers supplies current evidence. Nonshared evidence retains its original path, including unrelated HPI legacy carry fallback explicitly limited to unrelated bound observations.

Checks: initial focused red 8 pass/11 fail; legacy-view added red 25 pass/1 fail. Final focused26/26 plus existing overview projection/endpoint and diagnosisLinkL3 41/41 =67/67. Release T7/T8/T9 3/3. npm --prefix mcp run build exit0.

Mutations:9/9 red then restored26/26 each: W80 homes, W81 inactive/context/carry, W118 values, W114 stored definitions, V27 clinical-change/reassert/legacy-view. Exact recipes overview-mutations.py; results overview-mutation-results.json; individual red/restored TAP in this directory. All production bytes restored after mutation.

Existing assertion mapping: T7 todo removed, expected Observation/fact unchanged (V27); T8 switched to real stored-definition fixture and todo removed, status200/link assertion unchanged (W80); T9 private predicate replaced with real stored catalog handler path, true live/false cleared unchanged, todo removed (W81). examOverviewProjection old 6/6 fixture's invented shared normal definition/resource replaced with real lens seed + canonical explicit absent fact; all expected counts/status remain6/6 complete (V27/W81). Other legacy rendering and nonshared assertions preserved unchanged.

Remaining: §3.8 protocol implementation begins next. No independent evaluation claim.
