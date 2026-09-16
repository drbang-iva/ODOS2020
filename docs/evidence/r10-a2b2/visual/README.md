# Synthetic before/after component captures

Twelve 1440 × 1000 Chrome screenshots: OU grouping, read-only conflict, pre-rebuild banner, unavailable overlay, partial pick with Finish linking, and audit notice with Repair. Every pair uses the same fixture data, viewport and component interaction. Before is an isolated `git archive 6025d836` snapshot; after is an isolated copy of the task's changed source. Source SHA-256 hashes are in `source-manifest.json`.

These are real React components served through Vite with synthetic in-browser transport. They prove rendering and the illustrated component interaction; they do not prove the actual application route, real FHIR persistence, authorization, or deployed state. No patient data, credentials, authentication, Docker containers, or external services were used. Legacy compatibility fields on fixture rows allow the identical fixture to render the base and changed components. The partial scenario selects the actual suggested-diagnosis control and waits for the saved diagnosis; the changed version then receives a synthetic 502 unconfirmed link result and exposes Finish linking.

The capture asserts one OU row, disabled conflict controls, all controls disabled for pre-rebuild data, each unavailable/recovery message, visible Repair, and zero uncaught browser page errors. All twelve images were visually inspected. During inspection, notices initially displaced the diagnosis grid; the parent agent corrected their placement and the final images were recaptured. The final partial capture includes the parent's visible button styling.

`capture.txt` lists all twelve completed captures. `capture-observations.json` records visible text. `block.md` was generated with the vendored before-and-after formatter; its local references must be replaced with verified commit-pinned URLs after the parent commits and pushes the evidence.

Reproduce from repository root:

1. Run `node docs/evidence/r10-a2b2/visual/prepare.mjs` to create isolated snapshots. It prints the temporary directory and saves its path in `/tmp/r10-a2b2-visual-path`.
2. In each snapshot's `ui` directory, run `./node_modules/.bin/vite --config visual.config.mjs --host 127.0.0.1 --port PORT --strictPort`, using 15371 for before and 15372 for after. Verify those ports belong to these processes. Each server has its own dependency cache.
3. Run `node docs/evidence/r10-a2b2/visual/capture.mjs` from the repository root.
4. Stop only those two Vite processes when finished.

Original capture process ownership: before PID 91349 on 127.0.0.1:15371; after PID 91389 on 127.0.0.1:15372. Both were stopped after final capture; no Docker containers were started.
