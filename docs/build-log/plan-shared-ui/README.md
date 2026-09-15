# UI author verification

Synthetic React interaction checks: `cd ui && node --import tsx --test tests/protocolScope.test.tsx tests/protocolAuthoring.test.tsx`: 12 passed, 0 failed. AssessmentSection itself mounts with mocked HTTP/FHIR and verifies confirm and edit URLs, request bodies, refresh, and clearing the visible flag with no matching offers. The scope component checks distinct whole/item badges and undo targets, including legacy item scope.

`cd ui && npx tsc --noEmit --skipLibCheck`: exit 0, no diagnostics.

Mutation evidence: replacing whole-only selection with first active application gives 1 failure (wrong undo target), 2 passes. Discarding fetched actions in AssessmentSection gives 1 failure (actual confirmation row missing), 2 passes. Restored checks passed. Initial attempted pre-implementation red had a syntax error and wrong test working directory; it is not valid behavior evidence. The recorded mutation controls are the valid red/green evidence.

`components-after.png` is a synthetic browser component fixture, not a full app or real-backend proof. Captured with Chromium against task-owned Vite at 127.0.0.1:5197; verified listening process, stopped Vite and browser after capture. Snapshot predates final control spacing styling. Temporary fixture files removed.

At pinned head 02cdf89e, `rg 'add-item|followup' ui/src` and inspection of protocol-authoring.ts and AssessmentSection found no per-item API client or item tap surface. This change displays persisted item applications; no new item tap surface added. Listing refreshes after whole apply, individual/whole undo, and follow-up confirm/edit. Live backend persistence is covered separately by backend tests; independent evaluation remains outstanding.
