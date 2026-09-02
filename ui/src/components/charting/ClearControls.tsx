import { useEffect, useState, type ReactNode } from "react";
import type { Encounter } from "@medplum/fhirtypes";
import {
  SIGNED_ENCOUNTER_TOOLTIP,
  clearEncounterConfirmMessage,
  clearSectionConfirmMessage,
  confirmDestructive,
  isClosedEncounterStatus,
  previewEncounterVoid,
  voidEncounterEntries,
  type EncounterVoidResult,
} from "../../lib/encounter-void";
import { useEncounterEdit, type EncounterClearFailedDetail, type EncounterEditContextValue } from "./encounter-edit-context";

/**
 * The three tiers of the pre-finalization delete, one visual token.
 *
 * The token is Assessment's Discard button — ghost, alert-colored border and text. It already
 * reads as "this takes something away" everywhere it appears, so there is nothing new to learn.
 *
 *   tier 1  RemoveValueButton    × trailing a recorded value; confirms only when typed detail is lost
 *   tier 2  ClearSectionButton   "Clear <Section>" in the section header; always confirms with a count
 *   tier 3  ClearEncounterButton "Clear everything charted this visit…" in the entry-sheet chrome
 *
 * After sign every tier renders present-but-disabled with one tooltip. The server's 409 is the guard;
 * the disabled state only tells the clinician why the path is closed.
 */

export const CLEAR_TOKEN_CLASS =
  "rounded border border-[color:var(--odos-alert)] bg-[color:var(--odos-surface-2)] font-semibold text-[color:var(--odos-alert)] transition hover:bg-[color:var(--odos-surface)] disabled:cursor-not-allowed disabled:opacity-45";

export function RemoveValueButton({
  label,
  onRemove,
  confirmMessage,
  className,
}: {
  /** What is being removed, e.g. "Reactivity OD" — becomes `aria-label="Remove Reactivity OD"`. */
  label: string;
  onRemove: () => void | Promise<void>;
  /** Supply only when the value carries recorded detail (a note, qualifiers, a nested value). */
  confirmMessage?: string;
  className?: string;
}) {
  const closed = isClosedEncounterStatus(useEncounterEdit().encounterStatus);
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      title={closed ? SIGNED_ENCOUNTER_TOOLTIP : `Remove ${label}`}
      disabled={closed || undefined}
      data-entry-sheet-pristine-action
      onClick={async () => {
        if (closed) return;
        if (confirmMessage && !confirmDestructive(confirmMessage)) return;
        await onRemove();
      }}
      className={`${CLEAR_TOKEN_CLASS} px-1.5 py-0.5 text-xs leading-none ${className ?? ""}`}
    >
      ×
    </button>
  );
}

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
      if (!confirmDestructive(clearSectionConfirmMessage(label, preview.count))) return;
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
        data-entry-sheet-pristine-action
        disabled={closed || busy || undefined}
        title={closed ? SIGNED_ENCOUNTER_TOOLTIP : `Void every ${label} value recorded this visit`}
        onClick={clear}
        className={`${CLEAR_TOKEN_CLASS} px-3 py-1.5 text-xs ${className ?? ""}`}
      >
        Clear {label}
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
  children,
}: {
  encounterReference: string;
  encounterStatus: Encounter["status"] | undefined;
  onCleared: (result: EncounterVoidResult) => void;
  fetchImpl?: typeof fetch;
  children?: ReactNode;
}) {
  const closed = isClosedEncounterStatus(encounterStatus);
  const { onClearFailed } = useEncounterEdit();
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
      if (!confirmDestructive(clearEncounterConfirmMessage(preview.sections, preview.count))) return;
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
        title={closed ? SIGNED_ENCOUNTER_TOOLTIP : "Void every value recorded this visit, every section"}
        onClick={clearAll}
      >
        {children ?? "Clear everything charted this visit…"}
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
