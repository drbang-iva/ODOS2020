// ui/src/scenes/frontdesk/CockpitFloorBoard.tsx
import { useEffect, useMemo, useState } from "react";
import { deriveFloorBoard } from "../../lib/floor-board";
import { parseFloorState } from "../../lib/floor-state";
import { useSchedulingStore } from "../../lib/scheduling-store";
import { PatientQuickCard } from "../scheduler/PatientQuickCard";
import { FloorCard } from "./FloorCard";
import { useFloorBoardConfig } from "./useFloorBoardConfig";

// The floor board center stage (design doc §5): stations as horizontal swim-rows,
// checked-in patients as draggable cards, honest-manual movement (drag rewrites the
// osod-floor-state extension via updateAppointment). Renders its own PatientQuickCard
// on card click, mirroring how SchedulerDayGrid owns its quick card. Config source is
// the persisted floor-config singleton (read via useFloorBoardConfig), falling back to
// the ui-side DEFAULT_FLOOR_BOARD_CONFIG until a practice configures its own.
export function CockpitFloorBoard() {
  const appointments = useSchedulingStore((state) => state.appointments);
  const visitTypes = useSchedulingStore((state) => state.visitTypes);
  const date = useSchedulingStore((state) => state.date);
  const updateAppointment = useSchedulingStore((state) => state.updateAppointment);
  const floorConfig = useFloorBoardConfig();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [dragError, setDragError] = useState<string | null>(null);
  // Ticking `now` so time-in-lane timers advance on their own, not just when the
  // store changes. 30s cadence matches the amber/red minute granularity.
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toISOString()), 30_000);
    return () => clearInterval(id);
  }, []);

  const board = useMemo(
    () => deriveFloorBoard(appointments, visitTypes, floorConfig, now),
    [appointments, visitTypes, floorConfig, now],
  );

  // Resolve the selected appointment against live store data so the quick card
  // reflects moves/edits after selection (mirrors SchedulerDayGrid's live lookup).
  const selected = useMemo(
    () => appointments.find((candidate) => candidate.id === selectedId) ?? null,
    [appointments, selectedId],
  );

  async function handleDrop(stationId: string, appointmentId: string) {
    const appointment = appointments.find((candidate) => candidate.id === appointmentId);
    if (!appointment) {
      return;
    }
    // No-op when dropped back on the current lane: updateAppointment always rewrites
    // `since` to now, which would zero a still-accurate wait timer (and cost a
    // pointless network write + reload). Guard the identity drop.
    if (parseFloorState(appointment)?.station === stationId) {
      return;
    }
    try {
      await updateAppointment(appointment, { floorStation: stationId });
      setDragError(null);
    } catch (err) {
      setDragError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex min-h-[60vh] flex-col gap-2 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-bold uppercase tracking-wide text-white/55">Floor board</h1>
        <a
          href="/settings/floor-config"
          aria-label="Floor settings"
          className="rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white/60 hover:bg-white/10 hover:text-white"
        >
          ⚙
        </a>
      </div>
      {dragError && (
        <div className="rounded border border-red-400/40 bg-red-950/50 px-3 py-2 text-xs text-red-100">
          Could not move patient: {dragError}
        </div>
      )}
      {floorConfig.stations.filter((station) => station.active !== false).map((station) => (
        <div
          key={station.id}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/25 p-2"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const appointmentId = event.dataTransfer.getData("text/plain");
            if (appointmentId) {
              void handleDrop(station.id, appointmentId);
            }
          }}
        >
          <div className="w-20 shrink-0 text-xs font-bold uppercase text-white/45">{station.label}</div>
          <div className="flex flex-1 flex-wrap gap-2">
            {(board[station.id] ?? []).map((card) => (
              <div
                key={card.appointment.id}
                draggable
                onDragStart={(event) => event.dataTransfer.setData("text/plain", card.appointment.id ?? "")}
                className="w-56"
              >
                <FloorCard card={card} onClick={() => setSelectedId(card.appointment.id ?? null)} />
              </div>
            ))}
          </div>
        </div>
      ))}
      <PatientQuickCard
        appointment={selected}
        pinned={pinned}
        onPinnedChange={setPinned}
        onClose={() => {
          setPinned(false);
          setSelectedId(null);
        }}
        onDetails={() => {
          /* MVP: deep-edit modal deferred; the floor board only needs the quick card. */
        }}
        date={date}
      />
    </div>
  );
}
