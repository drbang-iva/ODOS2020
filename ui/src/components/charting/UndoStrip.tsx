import { useState } from "react";
import { undoButtonTitle, undoStripCopy, type UndoLedgerSlot } from "../../lib/encounter-undo";
import { SIGNED_ENCOUNTER_TOOLTIP } from "../../lib/encounter-void";

/**
 * The Undo strip (§4b.1): a row of text with one verb at the end. Same alert-colored ghost
 * token as every clear control; `role="status" aria-live="polite"` like every inline message
 * in the sheets. It reverses exactly one action — the one the slot records — and is not a
 * toast: it stays for the life of the unsigned encounter and renders disabled after sign with
 * the amendment tooltip, so the clinician still sees that the path existed and why it closed.
 *
 * `confirmed` is the strip's honesty switch. Only a slot this page saw come back from a
 * SUCCESSFUL void is known to be exact; a slot read from the server (on load, or after a
 * refused clear on this non-atomic stack) names every row the clear MEANT to void, so it
 * reads as an upper bound — "up to 3 values" — and the Undo title says the same. Default off:
 * a caller that forgets the flag hedges, it never over-claims.
 */
export function UndoStrip({
  slot,
  closed,
  onUndo,
  confirmed = false,
  scope = slot.scope === "encounter" ? "encounter" : "section",
}: {
  slot: UndoLedgerSlot;
  closed: boolean;
  onUndo: () => void | Promise<void>;
  /** True only for a slot returned by a successful void in this page's session. */
  confirmed?: boolean;
  /** Which placement this is — the section strip beneath a sheet heading, or the visit slot in the chart bar. */
  scope?: "section" | "encounter";
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  async function undo() {
    if (closed || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await onUndo();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="odos-undo-strip" role="status" aria-live="polite" data-undo-scope={scope}>
      <span className="odos-undo-strip-copy">{undoStripCopy(slot, { confirmed })}</span>
      {message && <span className="odos-undo-strip-message">{message}</span>}
      <button
        type="button"
        data-entry-sheet-pristine-action
        disabled={closed || busy || undefined}
        title={closed ? SIGNED_ENCOUNTER_TOOLTIP : undoButtonTitle(slot, confirmed)}
        onClick={undo}
      >
        Undo
      </button>
    </div>
  );
}
