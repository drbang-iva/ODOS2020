import { useEffect, useState } from "react";
import { previewEncounterVoid, type EncounterVoidEntry } from "../../lib/encounter-void";

/**
 * What this visit already holds for a section, asked of the server once on open.
 *
 * Surfaces that keep no encounter history of their own (VA, IOP, Auto-refraction) only knew
 * about values saved in the current session, so their per-item × and Clear-section controls
 * vanished on reopen. §2 says "× on any recorded value": a value persisted before this session
 * is still a recorded value. The void preview already identifies every live candidate with its
 * finding key and laterality; this hook hands that to the sheet so it can offer the same controls
 * it offers right after a save.
 *
 * A signed encounter is previewed too: the preview is read-only and the server allows it after
 * sign, so the signed chart still shows its recorded values with their controls present-but-
 * disabled (§3, §4b.5) instead of pretending nothing was recorded.
 */
export function usePersistedVoidEntries(
  encounterReference: string,
  sectionKey: string | string[],
  fetchImpl?: typeof fetch,
): { entries: EncounterVoidEntry[]; loaded: boolean } {
  const [state, setState] = useState<{ entries: EncounterVoidEntry[]; loaded: boolean }>({ entries: [], loaded: false });
  const keys = Array.isArray(sectionKey) ? sectionKey : [sectionKey];
  const keyId = keys.join("|");

  useEffect(() => {
    let cancelled = false;
    setState({ entries: [], loaded: false });
    previewEncounterVoid(encounterReference, { scope: "section", sectionKey: keys.length === 1 ? keys[0]! : keys }, fetchImpl)
      .then((result) => { if (!cancelled) setState({ entries: result.entries, loaded: true }); })
      .catch(() => { if (!cancelled) setState({ entries: [], loaded: true }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounterReference, keyId, fetchImpl]);

  return state;
}

/** Group persisted references by eye; anything not OD/OS (binocular values) lands under "OU". */
export function referencesByEye(entries: readonly EncounterVoidEntry[]): Partial<Record<"OD" | "OS" | "OU", string[]>> {
  const grouped: Partial<Record<"OD" | "OS" | "OU", string[]>> = {};
  for (const entry of entries) {
    const eye = entry.laterality === "OD" || entry.laterality === "OS" ? entry.laterality : "OU";
    (grouped[eye] ??= []).push(entry.reference);
  }
  return grouped;
}
