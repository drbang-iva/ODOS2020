# ODOS UI - Director and Clinical Encounter (v0.3)

Browser UI for ODOS. Built on **Vite + React + Three.js + R3F**.
Zero Medplum SDK runtime coupling: the UI talks plain FHIR REST through `src/lib/fhir.ts` and imports only `@medplum/fhirtypes` for FHIR typing.

## Current state

- Patient picker searches FHIR `Patient` resources by name and opens the selected patient in Director state.
- Director keeps the v0.2 patient universe view and now exposes a "Start comprehensive exam" CTA.
- Encounter charting scene supports the v0.3 thin slice: VA, IOP, and Refraction.
- Each section owns local form state and saves through a transaction Bundle with BodyStructure, Observation, and Provenance entries.
- Encounter header supports Sign & finish, which marks the Encounter `finished`, writes `period.end`, and records Provenance.
- No AI, no voice, no billing workflow, and no alternate charting skins in v0.3.

## Run

```bash
# From repo root, make sure Medplum is up
npm run up

# Install or update the v0.3 FHIR profiles
npm run install-profiles

# Then in ui/
cd ui
cp .env.example .env
# Add the local Medplum admin credentials to .env
npm install
npm run dev
```

Open http://localhost:5173. Vite proxies `/fhir`, `/auth`, and `/oauth2` to Medplum at localhost:8103.

## Build provenance

Production builds expose an unauthenticated static `/version.json` asset with the built checkout's full SHA, short SHA, branch, and ISO 8601 `builtAt` timestamp. The fixed corner stamp is injected outside React's root so the absolute build identity remains visible when application JavaScript fails; JavaScript adds relative age and status styling when it runs.

Iris ops may write this optional same-origin asset beside the bundle:

```json
{
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "shortSha": "0123456",
  "checkedAt": "2026-08-10T18:00:00.000Z"
}
```

`/deployed.json` identifies the deployed checkout's current `HEAD`; the build never writes it. A valid matching SHA is current regardless of age, and a valid mismatch is stale regardless of age. Missing, unfetchable, or malformed content falls back silently to the 12-hour build-age backstop. An unknown built SHA always displays an unknown-provenance warning.

The production build also fails if any final emitted JavaScript, CSS, JSON, or other text asset contains an absolute HTTP(S) loopback URL. Vite development is excluded because its local proxy targets are intentional.

## Golden Path

1. Pick a patient from Patient Picker.
2. Click "Start comprehensive exam" in Director.
3. Save VA.
4. Save IOP.
5. Save Refraction.
6. Click "Sign & finish" and confirm the UI returns to Director.

Profile-validation smoke: save an invalid IOP unit through a test or tool path and confirm Medplum returns an OperationOutcome expression and no partial section resources persist.

## Transaction Bundle Pattern

- UI writes use `create`, `patch`, and `executeTransaction` in `src/lib/fhir.ts`.
- Every UI write sends `X-ODOS-Source: ui/<sourceTag>`.
- Section saves use `src/lib/fhir-ophthalmology/save-section-bundle.ts`.
- The save composer is mirrored from `mcp/src/fhir/ophthalmology/save-section-bundle.ts`; `mcp/tests/builder-mirror-parity.test.ts` fails if UI and MCP drift.
- A section Bundle contains conditional `BodyStructure` create-by-location, one Observation per eye, and one Provenance sidecar per Observation.
- The UI transaction helper detects per-entry failures and compensates created resources so failed section saves do not leave partial clinical state.

## Architecture Notes

- **No Medplum React components.** `@medplum/fhirtypes` only.
- **No Medplum runtime SDK.** All server communication is `fetch()` against FHIR REST.
- **FHIR profiles live in repo root** under `data/profiles/`; install them with `npm run install-profiles`.
- **Ophthalmology builders are mirrored** under `src/lib/fhir-ophthalmology/` until the planned v0.5 monorepo refactor.

## Validation

```bash
cd ../mcp
npx tsc --noEmit
npm test

cd ../ui
npx tsc --noEmit
npm run build
```

Expected current result: 54 MCP tests passing, UI build clean, main JS bundle about 1.039 MB.
