import { useEffect, useState } from "react";
import type { Encounter } from "@medplum/fhirtypes";
import {
  SIGNED_ENCOUNTER_TOOLTIP,
  clearEncounterConfirmSpec,
  clearSectionConfirmSpec,
  isClosedEncounterStatus,
  previewEncounterVoid,
  voidEncounterEntries,
  type EncounterVoidResult,
} from "../../lib/encounter-void";
import { useConfirmDestructive } from "./ConfirmDestructive";
import { useEncounterEdit, type EncounterClearFailedDetail, type EncounterEditContextValue } from "./encounter-edit-context";

/**
 * Tiers 2 and 3 of the pre-finalization delete, after the 2026-09-02 restraint pass.
 *
 * Nothing here is red at rest. The delete controls are plumbing; the recorded values are the
 * content. Alert colour appears once, on the confirm button of the in-app dialog
 * (`ConfirmDestructive.tsx`), at the moment of consequence.
 *
 *   tier 1  RemoveValueButton    lives in `section-editing.tsx`; absent until the section's Edit
 *   tier 2  ClearSectionButton   "Clear", text-only and muted, last in the section header's action row
 *   tier 3  ClearEncounterButton "Clear chart" in the entry-sheet chrome, wearing exactly Cancel's token
 *
 * After sign every tier renders present-but-disabled with one tooltip. The server's 409 is the guard;
 * the disabled state only tells the clinician why the path is closed.
 */

/** Token C — quiet: a muted word with a 44 px hit box; underline on hover/focus, nothing else. */
export const QUIET_ACTION_CLASS =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded px-2 text-xs font-semibold text-[color:var(--odos-muted)] underline-offset-4 transition hover:text-[color:var(--odos-text)] hover:underline focus-visible:text-[color:var(--odos-text)] focus-visible:underline disabled:cursor-not-allowed disabled:opacity-45 disabled:no-underline";

export function ClearSectionButton({
  encounterReference,
  sectionKey,
  label,
  hasRecorded = false,
  probeOnMount = false,
  onCleared,
  fetchImpl,
  className,
}: {
  encounterReference: string;
  /** The section key(s) the sheet owns; matched exactly or as a `key:` prefix on the server. */
  sectionKey: string | string[];
  /** Names the section in the tooltip and the dialog; the button itself reads "Clear". */
  label: string;
  /** The surface's own knowledge of whether this visit recorded anything here. */
  hasRecorded?: boolean;
  /**
   * For surfaces that keep no encounter history of their own (VA, IOP, auto-refraction): ask the
   * server once on open whether this visit recorded anything, so reopening a chart still offers
   * the control for values persisted before this session.
   */
  probeOnMount?: boolean;
  onCleared: (result: EncounterVoidResult) => void;
  fetchImpl?: typeof fetch;
  className?: string;
}) {
  const { encounterStatus, onClearFailed } = useEncounterEdit();
  const confirmDestructive = useConfirmDestructive();
  const closed = isClosedEncounterStatus(encounterStatus);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [probedCount, setProbedCount] = useState(0);
  const keys = Array.isArray(sectionKey) ? sectionKey : [sectionKey];
  const request = { scope: "section" as const, sectionKey: keys.length === 1 ? keys[0]! : keys };
  const keyId = keys.join("|");

  useEffect(() => {
    if (!probeOnMount || closed) return;
    let cancelled = false;
    previewEncounterVoid(encounterReference, request, fetchImpl)
      .then((result) => { if (!cancelled) setProbedCount(result.count); })
      .catch(() => { if (!cancelled) setProbedCount(0); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeOnMount, closed, encounterReference, keyId, fetchImpl]);

  if (!closed && !hasRecorded && probedCount === 0) return null;

  async function clear() {
    if (closed || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      // The count in the confirm is the server's, not the sheet's guess.
      const preview = await previewEncounterVoid(encounterReference, request, fetchImpl);
      if (preview.count === 0) {
        setMessage(`Nothing recorded for ${label} this visit.`);
        return;
      }
      if (!(await confirmDestructive(clearSectionConfirmSpec(label, preview.count)))) return;
      const result = await voidOrReport(() => voidEncounterEntries(encounterReference, request, { fetchImpl }), "section", onClearFailed);
      setProbedCount(0);
      onCleared(result);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={`Clear ${label}`}
        data-entry-sheet-pristine-action
        disabled={closed || busy || undefined}
        title={closed ? SIGNED_ENCOUNTER_TOOLTIP : `Clear ${label} — everything recorded this visit`}
        onClick={clear}
        className={`${QUIET_ACTION_CLASS} ${className ?? ""}`}
      >
        Clear
      </button>
      {message && <span role="status" aria-live="polite" className="text-xs text-[color:var(--odos-muted)]">{message}</span>}
    </span>
  );
}

export function ClearEncounterButton({
  encounterReference,
  encounterStatus,
  onCleared,
  fetchImpl,
}: {
  encounterReference: string;
  encounterStatus: Encounter["status"] | undefined;
  onCleared: (result: EncounterVoidResult) => void;
  fetchImpl?: typeof fetch;
}) {
  const closed = isClosedEncounterStatus(encounterStatus);
  const { onClearFailed } = useEncounterEdit();
  const confirmDestructive = useConfirmDestructive();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  async function clearAll() {
    if (closed || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const preview = await previewEncounterVoid(encounterReference, { scope: "encounter" }, fetchImpl);
      if (preview.count === 0) {
        setMessage("Nothing charted this visit yet.");
        return;
      }
      if (!(await confirmDestructive(clearEncounterConfirmSpec(preview.sections, preview.count)))) return;
      const result = await voidOrReport(() => voidEncounterEntries(encounterReference, { scope: "encounter" }, { fetchImpl }), "encounter", onClearFailed);
      onCleared(result);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="odos-exam-entry-sheet-clear-all">
      {message && <span role="status" aria-live="polite">{message}</span>}
      <button
        type="button"
        data-entry-sheet-chrome
        disabled={closed || busy || undefined}
        title={closed ? SIGNED_ENCOUNTER_TOOLTIP : "Clear everything charted this visit"}
        onClick={clearAll}
      >
        Clear chart
      </button>
    </span>
  );
}

/**
 * Run the void itself. If the server refuses it, tell the encounter BEFORE the caller renders
 * the error, so the chart is re-read alongside the message — refresh AND report, never one
 * without the other. Preview failures and declined confirms never reach here: nothing was
 * attempted, so there is nothing the screen could be stale about.
 */
async function voidOrReport(
  run: () => Promise<EncounterVoidResult>,
  scope: EncounterClearFailedDetail["scope"],
  onClearFailed: EncounterEditContextValue["onClearFailed"],
): Promise<EncounterVoidResult> {
  try {
    return await run();
  } catch (error) {
    onClearFailed?.({ scope, error });
    throw error;
  }
}
