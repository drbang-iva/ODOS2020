// The front-desk cockpit shell (design doc §2, §6): a wide host with a swappable
// center stage, plus comms "organs" reachable as phone-width slide-over panels
// from a right-edge badge dock. Pure model + logic here; React renders it.

export type CockpitCenterView = "schedule" | "floor";

export type CockpitPanelId =
  | "launcher"
  | "messages"
  | "calls"
  | "requests"
  | "team-chat"
  | "notifications"
  | "fax";

export type CockpitBadgeKind = "unread" | "missed" | "requests" | "none";

export interface CockpitDockItem {
  id: CockpitPanelId;
  label: string;
  glyph: string; // text/emoji placeholder until an icon set lands
  badge: CockpitBadgeKind;
}

// Dock order, top→bottom (design doc §6).
export const COCKPIT_DOCK_ITEMS: CockpitDockItem[] = [
  { id: "launcher", label: "New…", glyph: "+", badge: "none" },
  { id: "messages", label: "Messages", glyph: "💬", badge: "unread" },
  { id: "calls", label: "Calls", glyph: "📞", badge: "missed" },
  { id: "requests", label: "Requests", glyph: "📅", badge: "requests" },
  { id: "team-chat", label: "Team Chat", glyph: "👥", badge: "none" },
  { id: "notifications", label: "Notifications", glyph: "🔔", badge: "none" },
  { id: "fax", label: "Fax", glyph: "📠", badge: "none" },
];

export function dockItem(id: CockpitPanelId): CockpitDockItem {
  const found = COCKPIT_DOCK_ITEMS.find((item) => item.id === id);
  if (!found) {
    throw new Error(`unknown cockpit panel: ${id}`);
  }
  return found;
}

// One panel at a time (design doc §2): clicking the open panel closes it;
// clicking another switches to it.
export function togglePanel(
  current: CockpitPanelId | null,
  id: CockpitPanelId,
): CockpitPanelId | null {
  return current === id ? null : id;
}

// iOS-style badge: nothing at 0, integer, capped at 99+.
export function badgeDisplay(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }
  return count > 99 ? "99+" : String(Math.floor(count));
}
