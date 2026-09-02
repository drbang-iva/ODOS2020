import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SIGNED_ENCOUNTER_TOOLTIP, type DestructiveConfirmSpec } from "../../lib/encounter-void";
import { QUIET_ACTION_CLASS } from "./ClearControls";
import { useConfirmDestructive } from "./ConfirmDestructive";
import { useEncounterClosed } from "./encounter-edit-context";

/**
 * Tier 1 leaves the resting state (§1). A section's per-value Removes are not in the DOM until
 * the clinician activates the section's one **Edit** word; the word then reads **Done**. Edit
 * state adds controls — it never disables entry, Save, Normal OU, or Clear — and it ends on Done,
 * on unmount (the provider's state dies with the section), or when the section's last recorded
 * value goes, so reopening always opens at rest.
 *
 * The state lives in the section, not the sheet: Auto-refraction is full-page and has no sheet.
 */

interface SectionEditingValue {
  editing: boolean;
  setEditing: (editing: boolean) => void;
  hasRecorded: boolean;
}

const SectionEditingContext = createContext<SectionEditingValue>({
  editing: false,
  setEditing: () => undefined,
  hasRecorded: false,
});

export function SectionEditingProvider({ hasRecorded, children }: { hasRecorded: boolean; children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const closed = useEncounterClosed();
  // Edit state ends when the section's last recorded value goes, and when the encounter signs
  // underneath an open edit state — a signed chart never shows Done or a Remove.
  useEffect(() => {
    if (!hasRecorded || closed) setEditing(false);
  }, [hasRecorded, closed]);
  return (
    <SectionEditingContext.Provider value={{ editing, setEditing, hasRecorded }}>
      {children}
    </SectionEditingContext.Provider>
  );
}

export function useSectionEditing(): SectionEditingValue {
  return useContext(SectionEditingContext);
}

/**
 * The door. Same visibility rule as Clear: hidden while an open encounter has nothing recorded
 * here; present-but-disabled with the amendment tooltip once signed, whatever was recorded.
 */
export function EditEntriesToggle() {
  const { editing, setEditing, hasRecorded } = useSectionEditing();
  const closed = useEncounterClosed();
  if (!closed && !hasRecorded) return null;
  return (
    <button
      type="button"
      aria-pressed={editing}
      data-entry-sheet-pristine-action
      disabled={closed || undefined}
      title={closed ? SIGNED_ENCOUNTER_TOOLTIP : editing ? "Done removing entries" : "Remove individual entries"}
      onClick={() => { if (!closed) setEditing(!editing); }}
      className={QUIET_ACTION_CLASS}
    >
      {editing ? "Done" : "Edit"}
    </button>
  );
}

/**
 * Tier 1: a small neutral **Remove** beside one recorded value, rendered only in edit state.
 * Behaviour is the delete slice's: confirm only when `confirm` is supplied (typed detail would be
 * lost); otherwise void on tap and let the Undo strip appear. A closed encounter never renders
 * it — one disabled Edit says the path is closed; nine disabled Removes would be the density
 * failure in grey (§5).
 */
export function RemoveValueButton({
  label,
  onRemove,
  confirm,
}: {
  /** What is being removed, e.g. "Reactivity OD" — becomes `aria-label="Remove Reactivity OD"`. */
  label: string;
  onRemove: () => void | Promise<void>;
  /** Supply only when the value carries recorded detail (a note, qualifiers, a nested value). */
  confirm?: DestructiveConfirmSpec;
}) {
  const { editing } = useSectionEditing();
  const closed = useEncounterClosed();
  const confirmDestructive = useConfirmDestructive();
  if (!editing || closed) return null;
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      title={`Remove ${label}`}
      data-entry-sheet-pristine-action
      onClick={async () => {
        if (confirm && !(await confirmDestructive(confirm))) return;
        await onRemove();
      }}
      className={QUIET_ACTION_CLASS}
    >
      Remove
    </button>
  );
}
