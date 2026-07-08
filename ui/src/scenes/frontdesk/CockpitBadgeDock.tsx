import clsx from "clsx";
import { COCKPIT_DOCK_ITEMS, badgeDisplay, type CockpitPanelId } from "../../lib/cockpit-shell";

// The persistent right-edge icon rail (design doc §2). Badges are iOS-style red
// counts; counts arrive per-organ once the comms adapters land (Phase 3b+), so
// this takes an optional counts map and shows nothing when absent/zero.
export function CockpitBadgeDock({
  openPanel,
  onToggle,
  counts = {},
}: {
  openPanel: CockpitPanelId | null;
  onToggle: (id: CockpitPanelId) => void;
  counts?: Partial<Record<CockpitPanelId, number>>;
}) {
  return (
    <nav
      aria-label="Cockpit dock"
      className="flex w-12 flex-col items-center gap-2 border-l border-white/10 bg-black/40 py-2"
    >
      {COCKPIT_DOCK_ITEMS.map((item) => {
        const badge = badgeDisplay(counts[item.id] ?? 0);
        const active = openPanel === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={active}
            title={item.label}
            onClick={() => onToggle(item.id)}
            className={clsx(
              "relative grid h-9 w-9 place-items-center rounded-md text-lg",
              active ? "bg-white/20" : "bg-white/5 hover:bg-white/10",
            )}
          >
            <span aria-hidden>{item.glyph}</span>
            {badge && (
              <span className="absolute -right-1 -top-1 rounded-full bg-red-500 px-1 text-[9px] font-bold leading-4 text-white">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
