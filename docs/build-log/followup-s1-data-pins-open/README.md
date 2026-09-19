# Follow-up S1 — data pins open

Saved encounter findings now keep their section group visible, including inactive groups.
Removal checks saved content freshly and refuses with the requested 409 response.
The chart displays “Has findings this visit” and refreshes after a save or a removal race.
Previously removed groups with saved data reappear on the next load without manual re-adding.
Empty-group removal and the existing no-resurrection behavior remain covered.
All 12 deliberate mutations failed and all restored focused runs passed.
Full MCP: zero test failures, but runner exit 1 because live lanes remain unconfigured (same at baseline).
NOT EVALUATED — separate Claude Opus 5 evaluation is required; do not merge.

Base: `1bd7a57d8a5ef8d40581c9adcd613df154f63994` (freshly fetched origin/main before edits).
Branch: `drbang-iva/followup-s1-data-pins-open`.
Proof-to-code binding: [source and served asset hashes](proof/code-identity.json).

## Files touched

- `mcp/src/clinical-graph/finding-section-content.ts`: shared paged, encounter/patient-scoped saved-content reader.
- `mcp/src/clinical-graph/finding-section-group-endpoint.ts`: catalog pins and fresh remove refusal.
- `ui/src/lib/finding-section-groups.ts`: pinned groups bypass active/effective exclusion.
- `ui/src/scenes/EncounterCharting.tsx`: pin text, save refresh, 409 message/refetch, local union preservation.
- `mcp/tests/findingSectionGroup.test.ts` and `ui/tests/findingSectionGroups.test.tsx`: guards, with existing tests retained.
- This build-log directory: evidence, screenshots, isolated synthetic proof harness and mutation runner.

## Premise re-verification


All checked from `git show origin/main:<path>` before any production edits:

- P1 green: `mcp/src/clinical-graph/finding-section-group-endpoint.ts:203`, remove filters at 241 and persists at 242 without a content check.
- P2 green: same endpoint 96–115, effective is defaults plus active overrides; `finding-section-group-store.ts:31` seed and 193 resolver.
- P3 green: `ui/src/lib/finding-section-groups.ts:29`, 46: inactive group prefixes stay hidden, no content input.
- P4 green: `ui/src/scenes/EncounterCharting.tsx:618`, 645, 669, 947: remove request, local recompute, filter, remove controls.
- P5 green: `mcp/src/clinical-graph/custom-section-endpoint.ts:111`, 314, 521 captures Observations; history 324; `diagnosis-findings-endpoint.ts:178`, 184 maps projected facts to sections.
- P6 green: both named test files exist; `docs/build-log/section-group-visibility/README.md:21` records empty-group no-resurrection proof.


## Writer census (base file:line)

The census searched writes, then followed producers into their saved resource shapes. Raw searches: [all writer matches](proof/writer-search.txt), [selected call sites](proof/writer-call-sites.txt).
All paths below are relative to `mcp/src/` at the base SHA; unchanged producer lines remain valid at this head.

| Producer | Write call sites | Saved content read by this change |
|---|---|---|
| Custom sections / Ocular Health | `clinical-graph/custom-section-endpoint.ts:521`, `:724`, `:748` | Definition-coded Observations; delegated canonical facts and negative acts |
| Canonical atomic/current-finding writer | `clinical-graph/current-finding-writer.ts:242`, `:244`, `:343`, `:610`, `:611` | Shared current projection, including explicit absent and live conflicts; legacy observation classification |
| Diagnosis door / carry-forward | `clinical-graph/diagnosis-findings-endpoint.ts:513`; `clinical-graph/diagnosis-carry-forward-endpoint.ts:463`, `:471` | Delegated atomic facts and definition-coded captured Observations |
| Protocol findings | `clinical-graph/protocol-endpoint.ts:936` | Definition-coded Observation |
| Meibography HTTP | `clinical-graph/dry-eye-meibography-endpoint.ts:131`, `:136` | Image DocumentReference and score Observation independently pin gland structure |
| Questionnaire MCP | `index.ts:3939`, `:3944` | QuestionnaireResponse and summary Observation independently pin symptoms |
| Meibography MCP | `index.ts:3990`, `:4010` | Same image/score builders as HTTP |
| Native observation producers | `clinical-graph/contact-lens-endpoint.ts:877`; `dilation-endpoint.ts:153`; `cup-disc-endpoint.ts:190`; `cover-test-endpoint.ts:81`; `eom-endpoint.ts:108`; `eye-growth-endpoint.ts:757`; `gonioscopy-endpoint.ts:84`, `:95`, `:98`; `iop-endpoint.ts:191`, `:206`; `pretest-endpoint.ts:870`; `refraction-endpoint.ts:151` (all under `clinical-graph/`) | Existing definition/alias classification maps native Observation codes to section keys when associated with a grouped definition |
| Generic/native MCP writes | `index.ts:2915`, `:2989`, `:4317`, `:4516`, `:4533` | Same saved Observation classification; unknown, unassociated codes do not invent section ownership |

The two non-definition-coded families are explicitly mapped using existing questionnaire concepts/references and the existing meibography profile/image type. Both resources of each multi-write operation count independently, so a failed second write does not hide the first.
Pretest vitals (`clinical-graph/pretest-vitals-endpoint.ts:340`) and smoking status (`index.ts:3674`) do not write the grouped finding definitions. Legacy dry-eye medication/procedure/adverse-event records, unrelated correspondence/import documents, and observations with no matching definition do not belong to the grouped finding-definition surface. The tear-film source remains in Ocular Health; its workup shortcut does not alter source ownership.

**G8 limitation: this list is not enforced.** There is no registry binding every producer call site to the reader. The shared reader families are mutation-tested, including independently dropping questionnaire response, questionnaire score, meibography image and meibography score. That is not a guarantee that a future writer will update this list.

## Guards: deliberately broken, then restored

Commands are recorded in [results.json](proof/guards/results.json). Server: `npm --prefix mcp test -- tests/findingSectionGroup.test.ts`. Client: `node --import tsx --test ui/tests/findingSectionGroups.test.tsx`.
Every red command exited 1; every restored green command exited 0. The following quotes are extracted from the actual full linked outputs.

### G1

[red output](proof/guards/G1-red.txt):

```text
# tests 23
# pass 17
# fail 6
# skipped 0
exit 1
```

[green output](proof/guards/G1-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G2

[red output](proof/guards/G2-red.txt):

```text
# tests 23
# pass 21
# fail 2
# skipped 0
exit 1
```

[green output](proof/guards/G2-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G3

[red output](proof/guards/G3-red.txt):

```text
# tests 23
# pass 21
# fail 2
# skipped 0
exit 1
```

[green output](proof/guards/G3-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G4-server

[red output](proof/guards/G4-server-red.txt):

```text
# tests 23
# pass 22
# fail 1
# skipped 0
exit 1
```

[green output](proof/guards/G4-server-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G4-client

[red output](proof/guards/G4-client-red.txt):

```text
# tests 9
# pass 8
# fail 1
# skipped 0
exit 1
```

[green output](proof/guards/G4-client-green.txt):

```text
# tests 9
# pass 9
# fail 0
# skipped 0
exit 0
```

### G5

[red output](proof/guards/G5-red.txt):

```text
# tests 23
# pass 22
# fail 1
# skipped 0
exit 1
```

[green output](proof/guards/G5-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G6

[red output](proof/guards/G6-red.txt):

```text
# tests 23
# pass 19
# fail 4
# skipped 0
exit 1
```

[green output](proof/guards/G6-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G7

[red output](proof/guards/G7-red.txt):

```text
# tests 9
# pass 8
# fail 1
# skipped 0
exit 1
```

[green output](proof/guards/G7-green.txt):

```text
# tests 9
# pass 9
# fail 0
# skipped 0
exit 0
```

### G8-questionnaire-score

[red output](proof/guards/G8-questionnaire-score-red.txt):

```text
# tests 23
# pass 22
# fail 1
# skipped 0
exit 1
```

[green output](proof/guards/G8-questionnaire-score-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G8-questionnaire-response

[red output](proof/guards/G8-questionnaire-response-red.txt):

```text
# tests 23
# pass 22
# fail 1
# skipped 0
exit 1
```

[green output](proof/guards/G8-questionnaire-response-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G8-image

[red output](proof/guards/G8-image-red.txt):

```text
# tests 23
# pass 22
# fail 1
# skipped 0
exit 1
```

[green output](proof/guards/G8-image-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

### G8-score

[red output](proof/guards/G8-score-red.txt):

```text
# tests 23
# pass 22
# fail 1
# skipped 0
exit 1
```

[green output](proof/guards/G8-score-green.txt):

```text
# tests 23
# pass 23
# fail 0
# skipped 0
exit 0
```

G1 removes the server content check. G2 drops atomic facts (present and absent). G3 omits pins from effective keys. G4 restores active-only filtering on server/client. G5 removes entered-in-error exclusion. G6 refuses all removes. G7 drops pins from the local recompute (the selector must not offer the pinned group again). G8 removes each supplemental producer-family reader independently.

## Proof steps 1–5

All patients, identities and findings are synthetic. All screenshots are 1440 pixels wide. Browser proof used the actual served app and provider identity in an isolated Docker stack, not component fixtures.

1. **Unchanged base before production edits:** comprehensive encounter, pull in Dry Eye Workup, save symptoms, remove returns 200, section disappears. [Before](01-base-saved.png), [after removal](02-base-removed.png). Direct [FHIR read](proof/base-fhir-read.json) returned HTTP 200 and two saved preliminary symptoms Observations (the first capture retry had saved before its UI wait timed out):

   ```json
   {"status":200,"storedObservations":2,"code":"dry-eye:symptoms","statusOfObservations":"preliminary","valueString":"S1 synthetic dry-eye symptom finding"}
   ```

2. **Fresh branch encounter:** pull in workup and save a new synthetic symptom. [Pinned immediately after save](05-fresh-save-pinned.png). No remove control; requested pin text visible; direct remove returns 409. [HTTP evidence](proof/fresh-http.json), [browser result](proof/fresh-browser-result.txt).
3. **Repair:** reopen the exact base encounter with empty overrides. Group and saved history return automatically. [Repair screenshot](03-repair.png), [refusal screenshot](04-remove-refused.png), [catalog and HTTP evidence](proof/branch-http.json), [browser result](proof/branch-browser-result.txt):

   ```json
   {"repair":true,"refusal":409,"sectionKeys":["dry-eye:symptoms"],"pinVisible":true}
   ```

4. **Empty:** [added empty group](06-empty-before-remove.png) → remove 200 → [hidden again](07-empty-removed.png). [Browser result](proof/empty-browser-result.txt).
5. **Full suites, before and after:** actual command summaries linked below. Root, MCP and UI dependencies installed before the configured baseline. An earlier environment setup run failed before root dependencies/database were supplied; it is not the configured baseline.

| Command | Before | After | Runner exit |
|---|---|---|---|
| `ODOS_POSTGRES_URL=<isolated synthetic database> npm --prefix mcp test` | 6073 total; 6018 pass; 0 fail; 55 skipped | 6083 total; 6028 pass; 0 fail; 55 skipped | 1 both times: required live lanes unconfigured |
| `npm --prefix ui test` | 1757 total/pass; 0 fail; 0 skipped | 1760 total/pass; 0 fail; 0 skipped | 0 both times |

Actual output: [MCP before](proof/mcp-before.txt), [MCP after](proof/mcp-after.txt), [UI before](proof/ui-before.txt), [UI after](proof/ui-after.txt). The MCP runner specifically reports 47 unconfigured registered live tests within 55 total skips. No ungated-run bypass was used. This does not prove the complete live authorization matrix; the scoped provider browser proof above did run against real Medplum.

`npm --prefix mcp run build` and `npm --prefix ui run build` exited 0 (existing Vite large-chunk advisory). `npm run preflight`: [0 warnings, 0 hard blocks](proof/preflight.txt). [Proxy census](proof/proxy-coverage.txt): 25 backend families, 28 proxy entries, all registered families covered. `git diff --check` exited 0.

## Docker shutdown

The owned stack was stopped with `node docs/build-log/followup-s1-data-pins-open/proof/stack.mjs stop`. It reported “Stopped containers belonging to odos-s1-proof; retained containers and volumes.”
`docker ps --filter name=odos-s1- --format '{{.Names}}'` returned no rows. Other ODOS/VisionForge containers were untouched.

Final `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`:

```text
vf-prac1b-walk-db	Up 13 hours	127.0.0.1:55481->5432/tcp
odos-matrix-proof-medplum-server-1	Up 4 days	5000/tcp, 127.0.0.1:19104->8103/tcp
odos-matrix-proof-postgres-1	Up 4 days (healthy)	127.0.0.1:16433->5432/tcp
odos-matrix-proof-redis-1	Up 4 days (healthy)	127.0.0.1:17380->6379/tcp
odos-matrix-1-medplum-server-1	Up 4 days	5000/tcp, 127.0.0.1:19103->8103/tcp
odos-matrix-1-postgres-1	Up 4 days (healthy)	127.0.0.1:16432->5432/tcp
odos-matrix-1-redis-1	Up 4 days (healthy)	127.0.0.1:17379->6379/tcp
odos-consent-safety-redis-1	Up 4 days (healthy)	127.0.0.1:16379->6379/tcp
odos-consent-safety-postgres-1	Up 4 days (healthy)	127.0.0.1:15432->5432/tcp
odos-history-1d5-postgres-1	Up 4 days (healthy)	127.0.0.1:15832->5432/tcp
odos-history-1d5-redis-1	Up 4 days (healthy)	127.0.0.1:16779->6379/tcp
```

## Decisions, risks and follow-ups

- The explicit group-level union in §3.2/3.5 controls rendering: a pinned inactive group exposes all its active definitions, not just the populated section. Empty, unpinned groups retain existing behavior. This interpretation was stated while implementation proceeded; no user answer changed it.
- No new architecture decision: `decisions/INDEX.md` unchanged. No new medical codes or FHIR artifact URLs: existing verified constants/builders reused; no Mandate 14 ledger rows added.
- Additional paged reads occur on catalog/remove requests. Incomplete or out-of-scope reads fail closed. No save/delete behavior changed.
- Writer call-site census is not automatically enforced; full MCP live lanes remain unconfigured, as above.
- Cross-repo follow-up: separately invoked Claude Opus 5 independently evaluates the final PR head. Bot findings are a first pass only. No evaluation marker or operator override is supplied by the author.
- **Not done:** shelf and search; follow-up profiles; category-default removal (S1b); built-in section collapsing; changes to how data is saved or deleted.

NOT EVALUATED

needs-review
