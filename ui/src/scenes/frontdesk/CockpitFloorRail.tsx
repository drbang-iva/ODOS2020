// ui/src/scenes/frontdesk/CockpitFloorRail.tsx
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_FLOOR_BOARD_CONFIG, deriveFloorBoard } from "../../lib/floor-board";
import { useSchedulingStore } from "../../lib/scheduling-store";

// The floor rail (design doc §4): an at-a-glance count of patients on the floor + a
// red dot when any lane holds a red-timer patient, shown on the schedule view; click
// swaps center stage to the Floor board. Uses the same ui-side default config as the
// board (persisted floor-config read is a deferred fast-follow). `now` ticks so the
// red dot appears on its own when a wait crosses the red threshold.
export function CockpitFloorRail({ onOpenFloor }: { onOpenFloor: () => void }) {
  const appointments = useSchedulingStore((state) => state.appointments);
  const visitTypes = useSchedulingStore((state) => state.visitTypes);
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toISOString()), 30_000);
    return () => clearInterval(id);
  }, []);

  const board = useMemo(
    () => deriveFloorBoard(appointments, visitTypes, DEFAULT_FLOOR_BOARD_CONFIG, now),
    [appointments, visitTypes, now],
  );

  const cards = Object.values(board).flat();
  const totalOnFloor = cards.length;
  const hasRed = cards.some((card) => card.timer.level === "red");

  return (
    <button
      type="button"
      onClick={onOpenFloor}
      aria-label={`Floor: ${totalOnFloor} patient${totalOnFloor === 1 ? "" : "s"}${hasRed ? ", one or more overdue" : ""}`}
      className="flex items-center gap-1.5 rounded border border-white/15 bg-black/30 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
    >
      <span>Floor</span>
      <span className="rounded-full bg-white/10 px-1.5 py-0.5 font-bold text-white">{totalOnFloor}</span>
      {hasRed && <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />}
    </button>
  );
}
