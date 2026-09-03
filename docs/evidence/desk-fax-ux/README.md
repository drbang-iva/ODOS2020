# Desk fax UX author evidence

Base: `d805c51e72d3abf9c340188490ce45d86f7ad1fd` (`origin/main` at task creation).
Branch: `drbang-iva/desk-fax-ux`.

This is author verification, not an independent evaluation. No deployment was performed.

## Staff behavior

The sender number remains first. A supplied, nonblank, distinct sender identifier appears alongside it. Clicking **View PDF** fetches the document through the existing same-origin transport and displays its blob in a second `CockpitGuestPanel` instance. Default dimensions are 720 x 820 CSS pixels, capped to the viewport. The existing header drag mechanism moves it; no resize control is added. Fax position persists separately from the communications rail. X closes the preview and revokes its object URL. Escape closes it while page/panel controls have keyboard focus. Focus returns to the originating View PDF button, or to Desk Home when that button has been removed. Replacement, navigation/unmount, and a late response after navigation also release the URL. The original 60-second fallback remains.

## Verification

- Canonical `ui/package.json` test script: `node --import tsx --test tests/**/*.test.tsx`.
- `npm --prefix ui test`: **1231 passed, 0 failed, 0 skipped** (1226 top-level entries, including nested tests).
- `cd ui && npm run build`: exit 0; TypeScript plus Vite succeeded. Existing >500 kB chunk warning remains.
- `cd ui && node --import tsx --test tests/loginDeskHome.test.tsx`: **32 passed, 0 failed**.
- Original focused baseline: 26 passed. New guards before implementation: 26 passed, 4 failed.
- The initial full-suite attempt failed to load four unrelated files because this fresh worktree did not resolve `zod`. Read-only links to the existing installed UI/MCP dependency trees fixed the test environment; no package or lockfile changes were needed.

### Mandate 17

Each mutation was applied and confirmed by `rg` before its test. Each exact source file was restored byte-for-byte afterward.

| Guard | Deliberate break | Mutation check | RED | Restored GREEN |
| --- | --- | --- | --- | --- |
| Sender identity | Remove identifier expression from header | `rg senderIdentifier` in DeskHome: exit 1 | 0 pass / 1 fail | 1 pass / 0 fail |
| In-page preview | Insert anchor with `target = "_blank"` and `click()` | `rg link.target`: exact new-tab line present | 0 pass / 1 fail | 1 pass / 0 fail |
| Close cleanup | Remove effect cleanup revoke | `rg 'revokeObjectURL\(faxPreview.objectUrl\)'`: exit 1 | 0 pass / 1 fail | 1 pass / 0 fail |

Run each guard with `node --import tsx --test --test-name-pattern='<name>' tests/loginDeskHome.test.tsx` from `ui`; names are `inbound fax sender header`, `inbound fax PDF click`, and `inbound fax PDF close and Escape`. The close test covers both X and page Escape. Full assertion output and command summaries are preserved in [checks.txt](checks.txt).

### Browser evidence and limits

Chrome/Playwright rendered the actual `RouteSwitch` `/desk` branch in a temporary local harness, using synthetic Desk/Office responses and a generated synthetic PDF. Before and after used distinct verified Vite ports (15140 and 15141), separate worktrees/cache directories, identical data and 1440 x 1000 viewports. This is route/component and browser evidence with synthetic transport, **not** a credentialed Docker backend run, WestFax proof, or real-practice proof.

Verified: baseline opens a second tab; modified code keeps one tab; PDF contents visibly render; panel measures 720 x 820; dragging moves the panel and persists its position without changing rail storage; X and page Escape remove the embed/revoke its URL/restore focus; reopening retains position; an 800 x 700 viewport re-clamps the panel. Screenshots contain only synthetic content.

- [Before](before.png): original number-only row.
- [After](after.png): PDF visible in the in-page panel.
- [Dragged](dragged.png): PDF moved left to expose the correspondence worklist.

## Outstanding limitations / scope blockers

1. **Sender backend projection is missing at this base.** `mcp/src/fax/inbound-fax.ts` stores the WestFax identifier, but `mcp/src/desk/correspondence-block.ts:132-152` projects only senderNumber/pageCount/etc. into the Desk response. The UI summary type also lacked senderIdentifier; this PR adds that optional UI field. Live sender-name display still requires a separately authorized backend projection change. No `mcp/` file is modified.
2. **Native PDF focus consumes Escape in Chrome.** After a click inside the embedded PDF, Escape does not reach the page handler. X remains available. A temporary native-modal-dialog probe reproduced the same limitation; it was not retained. The current implementation therefore does not prove Escape-to-close from inside the native viewer itself.
3. The 60-second URL fallback is retained exactly as requested. No long-document/browser-specific behavior beyond the Chrome walkthrough is claimed.
4. Independent **Opus, high** evaluation is required before merge. The author posts no evaluation marker and does not merge.

No new clinical terminology, FHIR artifact URL, regulatory claim, or architectural decision was introduced. Mandate 14 ledger rows and PerformanceOD `decisions/INDEX.md` changes are not applicable. No cross-repo files were changed.
