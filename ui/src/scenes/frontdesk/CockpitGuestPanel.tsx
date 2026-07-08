import { dockItem, type CockpitPanelId } from "../../lib/cockpit-shell";

// Phone-width slide-over (design doc §2). Phase 2a ships the panel chrome with a
// stub body naming the phase that fills it; drag-to-float + per-workstation
// persistence come in Phase 2b, real content per organ in Phases 3b–5b.
const PANEL_STUB: Record<CockpitPanelId, string> = {
  launcher: "Quick actions — New Message · New Call · Pay Request · New Fax (Phase 3b).",
  messages: "Two-way messaging with inline TEXT BACK · BOOK · PAY REQ (Phase 3b, GHL adapter).",
  calls: "Call history, one-click callback, voicemail + recording playback (Phase 3b).",
  requests: "Screened appointment requests, badge-counted for immediate review (Phase 4b).",
  "team-chat": "Internal staff channels, DMs, mentions, threads (Phase 5b).",
  notifications: "Cross-cutting payment + schedule event stream (later).",
  fax: "Fax inbox with sent/failed status + New Fax (later; fax provider TBD).",
};

export function CockpitGuestPanel({
  panel,
  onClose,
}: {
  panel: CockpitPanelId;
  onClose: () => void;
}) {
  const item = dockItem(panel);
  return (
    <aside
      role="dialog"
      aria-label={item.label}
      className="fixed inset-y-0 right-12 z-40 flex w-[320px] flex-col border-l border-white/15 bg-[#0c0c18] shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm font-bold text-white">{item.label}</span>
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="text-white/60 hover:text-white"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3 text-sm leading-relaxed text-white/55">
        {PANEL_STUB[panel]}
      </div>
    </aside>
  );
}
