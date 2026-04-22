# OSOD UI — Director view (v0.2)

Browser UI for OSOD. Built on **Vite + React + Three.js + R3F** (WebGPU-capable, WebGL 2 fallback).
Zero Medplum SDK runtime coupling — talks plain FHIR REST via `src/lib/fhir.ts`.

## Current state (v0.2 scaffold)

- Variant A — Patient Director only (central orb + 6 orbital systems)
- Placeholder detail panel: fetches all observations for the patient
- Future: anatomical-location filtering once v0.1 POC tags Observations
- Future: Variants B (practice galaxy), C (encounter director), D (war table)

## Run

```bash
# From repo root first, make sure Medplum is up
cd .. && docker-compose up -d

# Then in ui/
cp .env.example .env
# paste your Medplum admin password into .env
npm install
npm run dev
```

Opens on http://localhost:5173. Vite dev server proxies `/fhir`, `/auth`, `/oauth2` to Medplum at localhost:8103.

## Architecture notes

- **No Medplum React components.** `@medplum/fhirtypes` only (pure TypeScript types).
- **FHIR client mirrors node-side** — same PKCE login flow, same method signatures.
- **Orbital layout is spatial + semantic** — positions are stable across patients (spatial memory).
- **Observation tagging is a v0.1 task** — this UI reads from FHIR; the data must be written with proper anatomical-location codes to drive orbital filters.

## Next commits

1. Wire anatomical-location filtering once v0.1 POC includes the tag
2. Status pulses on orbitals (problem → red pulse, etc.)
3. Zoom-to-orbital animated camera move
4. Variant C — Encounter director sub-scene
