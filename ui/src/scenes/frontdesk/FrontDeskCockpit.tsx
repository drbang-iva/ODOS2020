import { useEffect, useState } from "react";
import clsx from "clsx";
import { SCHEDULER_PALETTE } from "../../lib/scheduling";
import { togglePanel, type CockpitCenterView, type CockpitPanelId } from "../../lib/cockpit-shell";
import { SchedulerDayGrid } from "../SchedulerDayGrid";
import { CockpitBadgeDock } from "./CockpitBadgeDock";
import { CockpitGuestPanel } from "./CockpitGuestPanel";
import { CockpitFloorBoard } from "./CockpitFloorBoard";
import { CockpitFloorRail } from "./CockpitFloorRail";
import {
  canStartAppointmentChart,
  type PracticeRoleId,
} from "../../lib/practice-roles";
import { useSchedulingStore } from "../../lib/scheduling-store";
import {
  loadFrontDeskWatchers,
  updateWatcherTask,
  type WatcherFrontDeskProjection,
  type WatcherTaskAction,
} from "../../lib/watchers";

// The front-desk cockpit shell (design doc §2). Root is a <div> (not <main>) so
// the embedded SchedulerDayGrid's own <main> stays the single landmark.
export function FrontDeskCockpit({
  roles = [],
  initialWatcherProjection,
  loadWatcherProjection = loadFrontDeskWatchers,
}: {
  roles?: readonly PracticeRoleId[];
  initialWatcherProjection?: WatcherFrontDeskProjection;
  loadWatcherProjection?: (date: string) => Promise<WatcherFrontDeskProjection>;
} = {}) {
  const [centerView, setCenterView] = useState<CockpitCenterView>("schedule");
  const [openPanel, setOpenPanel] = useState<CockpitPanelId | null>(null);
  const [watcherProjection, setWatcherProjection] = useState<WatcherFrontDeskProjection | undefined>(initialWatcherProjection);
  const [watcherLoadError, setWatcherLoadError] = useState<string>();
  const date = useSchedulingStore((state) => state.date);
  const canStartChart = canStartAppointmentChart(roles);
  const initialAppointmentId = typeof window === "undefined"
    ? undefined
    : new URLSearchParams(window.location.search).get("appointmentId") ?? undefined;

  useEffect(() => {
    if (initialWatcherProjection) return;
    let active = true;
    loadWatcherProjection(date)
      .then((projection) => {
        if (active) {
          setWatcherProjection(projection);
          setWatcherLoadError(undefined);
        }
      })
      .catch((error) => {
        if (active) setWatcherLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, [date, initialWatcherProjection, loadWatcherProjection]);

  async function handleWatcherAction(taskId: string, action: WatcherTaskAction) {
    await updateWatcherTask(taskId, action);
    setWatcherProjection(await loadWatcherProjection(date));
  }

  return (
    <div className="relative flex min-h-screen text-white" style={{ backgroundColor: SCHEDULER_PALETTE.surfaceBase }}>
      <section className="min-w-0 flex-1">
        <CockpitTopBar centerView={centerView} onCenterViewChange={setCenterView} />
        {watcherProjection?.status === "degraded" && (
          <div role="alert" className="border-b border-amber-300/40 bg-amber-950/50 px-4 py-2 text-sm text-amber-100">
            <strong>Balance watch degraded.</strong>{" "}
            {watcherProjection.lastSuccessfulAt
              ? <>It last succeeded at <time dateTime={watcherProjection.lastSuccessfulAt}>{watcherProjection.lastSuccessfulAt}</time>.</>
              : "It has not completed successfully yet."}
          </div>
        )}
        {watcherLoadError && (
          <div role="alert" className="border-b border-red-400/40 bg-red-950/50 px-4 py-2 text-sm text-red-100">
            Balance watch could not be loaded: {watcherLoadError}
          </div>
        )}
        {centerView === "schedule"
          ? <SchedulerDayGrid
              roles={roles}
              watcherAlerts={watcherProjection?.status === "healthy" ? watcherProjection.alerts : []}
              initialAppointmentId={initialAppointmentId}
              onWatcherAction={handleWatcherAction}
            />
          : <CockpitFloorBoard canStartChart={canStartChart} />}
      </section>
      <CockpitBadgeDock openPanel={openPanel} onToggle={(id) => setOpenPanel((prev) => togglePanel(prev, id))} />
      {openPanel && <CockpitGuestPanel panel={openPanel} onClose={() => setOpenPanel(null)} />}
    </div>
  );
}

function CockpitTopBar({
  centerView,
  onCenterViewChange,
}: {
  centerView: CockpitCenterView;
  onCenterViewChange: (view: CockpitCenterView) => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-white/10 bg-black/35 px-4 py-2">
      <span className="text-sm font-extrabold tracking-wide text-white">ODOS</span>
      <span className="text-xs text-white/45">Front desk</span>
      <div className="ml-2 flex overflow-hidden rounded border border-white/15 bg-black/30">
        {(["schedule", "floor"] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={centerView === view}
            onClick={() => onCenterViewChange(view)}
            className={clsx(
              "px-3 py-1 text-xs font-semibold capitalize",
              centerView === view ? "bg-white/20 text-white" : "text-white/55 hover:text-white",
            )}
          >
            {view}
          </button>
        ))}
      </div>
      {centerView === "schedule" && (
        <CockpitFloorRail onOpenFloor={() => onCenterViewChange("floor")} />
      )}
    </header>
  );
}
