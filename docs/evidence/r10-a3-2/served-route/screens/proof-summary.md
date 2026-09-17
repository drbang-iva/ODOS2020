# Supplemental served screens

Author proof at `aefb6dbfc4cc1b5a0df70e75ba1dd25d4b82e2e2`. `node --import tsx scripts/r10-served-route/screens-proof.mjs` exited 0. `result.json` records six successful scenarios and seven screenshots, the served asset/MCP identity, canonical IDs and versions, requests, and server responses. All seven final screenshots were visually inspected; actual Assessment origin text and all carry completion steps are visible.

- Recorded absent: real provider canonical finding PUT seeds an absent fact, then the actual Lens UI displays Recorded absent.
- Deferred: actual shipped Lens OS control saves and reloads; history confirms panel.deferred=true with canonical panel identity.
- Proposal: actual Lens diagnosis rail proposes the supported diagnosis and links the fact.
- Origin: both diagnosis workspace and actual AssessmentSection show the canonical finding origin. The Assessment capture waits for that visible text before taking the screenshot.
- Carry recovery: actual Assessment Confirm makes the source eligible for carry. A real carry first completes on a separate destination. With parent authorization, operator fixture setup removes only that carry's completion-witness Provenance, preserving its complete bytes under gitignored `.odos/r10-a3-2-served/screens-removed-witness-<id>.json`. This is explicitly injected missing-lineage state, not a naturally occurring partial failure. No HTTP response is mocked.
- The server then returns carry-incomplete409. The UI displays the reload/replan action, performs GET strictly between its two POSTs, and sends a new commandId with replan=true. The server returns200 with all steps complete. The Condition ID and canonical finding references remain unchanged; result.json records both versions/outcomes.

Use only screenshots named in result.json for the final proof. assessment-before-fix-97fe4799 files are historical failure evidence. Other old failure/assessment-origin images are development artifacts, not final proof. The final Assessment screenshot is assessment-section-origin.png. validation.json records the final script hash and visual/identity checks. Local credential-value scan found zero matches.

No production code was edited by this harness. This is author verification, not independent evaluation.
