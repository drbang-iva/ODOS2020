# Synthetic browser and HTTP proof

Server health reported `5.1.30-9b1bd92`; the disposable project had no feature flags. Server: loopback `127.0.0.1:19513`; browser front door: `127.0.0.1:19510`. No practice server or real patient data was used.

The browser fixture renders the production `PatientRoute`, which renders `PatientOverview` and opens the production demographics editor. It supplies the existing browser session mechanism with a disposable staff token. The fixture does not replace the editor, writer, FHIR responses, or policy engine. The surrounding app shell and unrelated MCP-backed communication controls are outside this proof. The HTTP interceptor forwards each request to the real server and records its response; it inserts only the named competing writes.

The staff policy is generated from the unchanged staff declaration. The synthetic membership has two existing patient-compartment grants, one for each linked patient. Both RelatedPerson update interactions were separately confirmed HTTP 200 before the scenarios. No new AccessPolicy interaction or scope was introduced.

| Guard | Interleaving | Observed result |
|---|---|---|
| Q5b | Pause the editor's Person PUT after preflight; competitor reads and conditionally edits Person; then forward editor PUT | Editor Person 412; no child PUT; competitor Person retained; both children unchanged |
| Q6b | Forward Person PUT and receive 200; before releasing that response to the editor, competitor reads and conditionally edits Leo's RelatedPerson | Editor statuses 200 / 200 / 412; Person and Sam updated; Leo competitor retained; UI labels Leo mismatched |
| Q9b | Click Repair on the partial result | Only Leo's RelatedPerson gets a PUT and new version; Person and Sam versions unchanged; projections converge |
| Q9b repeat | Invoke the same exported repair operation after fresh indexed load of the converged set | Unchanged result; zero writes |

The evidence includes serialized request bodies, If-Match versions, statuses, patient-specific rendered results, and fresh persisted reads. Authentication headers are deliberately absent. Each scenario starts with new synthetic resources; there are no compensating writes. Patient content and the same-name unlinked decoy remain unchanged; editor write sets contain no Patient interaction. All role/legal fields, periods, and unrelated extensions are compared after saving. The fixtures include an existing Address.text; the successful structured-address correction is asserted to clear that stale display string.

`Q5b.json`, `Q6b-Q9b.json`, and `Q9b.json` contain the traces. `partial.png` and `repaired.png` show the live control before and after repair. These are author-side proofs, not independent evaluation.

## Reproduce

Install the root, MCP, and UI locked dependencies. Restore the four source snapshots from `reproduction/` into the ignored `.odos/guarantor-g2a/` directory, removing only the final `.txt` suffix. Use an isolated local Medplum 5.1.30 server at port 19513 with transaction bundles absent. Supply a mode-0600 `runtime.json` with `baseUrl`, `email`, and `password` for its synthetic local administrator; the credentials and server configuration are intentionally not committed.

From the repository root:

```sh
./mcp/node_modules/.bin/tsx .odos/guarantor-g2a/setup.ts
node .odos/guarantor-g2a/serve.mjs
# In a second terminal:
node .odos/guarantor-g2a/live-proof.mjs
```

Chrome must be installed. `setup.ts` writes only ignored session/runtime state. `fixtures.ts` creates throwaway patients, responsible parties, staff principal, and the existing staff policy; `live-proof.mjs` invokes it per scenario. Capture files are written to this evidence directory. Never substitute a practice endpoint. The script asserts its exact loopback target.
