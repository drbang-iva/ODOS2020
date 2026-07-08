import { useState } from "react";
import clsx from "clsx";
import { SCHEDULER_PALETTE } from "../../lib/scheduling";
import { togglePanel, type CockpitCenterView, type CockpitPanelId } from "../../lib/cockpit-shell";
import { SchedulerDayGrid } from "../SchedulerDayGrid";
import { CockpitBadgeDock } from "./CockpitBadgeDock";
import { CockpitGuestPanel } from "./CockpitGuestPanel";
import { CockpitFloorBoard } from "./CockpitFloorBoard";

// The front-desk cockpit shell (design doc §2). Root is a <div> (not <main>) so
// the embedded SchedulerDayGrid's own <main> stays the single landmark.
export function FrontDeskCockpit() {
  const [centerView, setCenterView] = useState<CockpitCenterView>("schedule");
  const [openPanel, setOpenPanel] = useState<CockpitPanelId | null>(null);

  return (
    <div className="relative flex min-h-screen text-white" style={{ backgroundColor: SCHEDULER_PALETTE.surfaceBase }}>
      <section className="min-w-0 flex-1">
        <CockpitTopBar centerView={centerView} onCenterViewChange={setCenterView} />
        {centerView === "schedule" ? <SchedulerDayGrid /> : <CockpitFloorBoard />}
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
    </header>
  );
}
