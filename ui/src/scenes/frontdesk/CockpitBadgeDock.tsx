import clsx from "clsx";
import { COCKPIT_DOCK_ITEMS, badgeDisplay, type CockpitPanelId } from "../../lib/cockpit-shell";

// The persistent right-edge icon rail (design doc §2). Badges are iOS-style red
// counts; counts arrive per-organ once the comms adapters land (Phase 3b+), so
// this takes an optional counts map and shows nothing when absent/zero.
export function CockpitBadgeDock({
  openPanel,
  pinnedPanel = openPanel,
  onToggle,
  onHover,
  onHoverLeave,
  counts = {},
  tones = {},
  titles = {},
}: {
  openPanel: CockpitPanelId | null;
  pinnedPanel?: CockpitPanelId | null;
  onToggle: (id: CockpitPanelId) => void;
  onHover?: (id: CockpitPanelId) => void;
  onHoverLeave?: () => void;
  counts?: Partial<Record<CockpitPanelId, number>>;
  tones?: Partial<Record<CockpitPanelId, "alarm" | "plain">>;
  titles?: Partial<Record<CockpitPanelId, string>>;
}) {
  return (
    <nav
      aria-label="Cockpit dock"
      onPointerLeave={(event) => event.pointerType !== "touch" && onHoverLeave?.()}
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
            aria-expanded={active}
            aria-pressed={pinnedPanel === item.id}
            title={titles[item.id] ?? item.label}
            onClick={() => onToggle(item.id)}
            onPointerEnter={(event) => event.pointerType !== "touch" && onHover?.(item.id)}
            className={clsx(
              "relative grid h-9 w-9 place-items-center rounded-md text-lg",
              active ? "bg-white/20" : "bg-white/5 hover:bg-white/10",
            )}
          >
            <span aria-hidden>{item.glyph}</span>
            {badge && (
              <span className={clsx("absolute -right-1 -top-1 rounded-full px-1 text-[9px] font-bold leading-4 text-white", tones[item.id] === "plain" ? "odos-cockpit-badge-plain" : "bg-red-500")}>
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
