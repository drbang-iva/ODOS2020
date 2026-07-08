import type { AppointmentBlockContent } from "../../lib/scheduling";
import { HOVER_CARD_WIDTH, hoverCardPosition, type HoverAnchor } from "../../lib/scheduler-block-density";

// Rung 2 of the disclosure ladder: the read-only reveal of everything a short
// block clips (both status axes, insurance line, badges). Fixed-position so it
// escapes the grid's overflow clipping; pointer-events-none so it can never
// steal the click that opens the quick card (rung 3).
export function AppointmentHoverCard({
  content,
  anchor,
}: {
  content: AppointmentBlockContent;
  anchor: HoverAnchor;
}) {
  const { left, top } = hoverCardPosition(anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-md border border-white/25 bg-[#0d0d1a] px-3 py-2 shadow-2xl"
      style={{ left, top, width: HOVER_CARD_WIDTH }}
    >
      <div className="truncate text-[12px] font-bold leading-tight text-white">{content.patientDisplay}</div>
      <div className="truncate text-[11px] font-semibold leading-tight text-white/85">{content.visitTypeDisplay}</div>
      <div className="truncate text-[10px] leading-snug text-white/70">
        {content.statusDisplay} · {content.confirmationDisplay}
      </div>
      <div className="truncate text-[10px] leading-snug text-white/65">{content.insuranceLine}</div>
      {content.badges.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {content.badges.map((badge) => (
            <span key={badge.code} className="rounded-sm bg-white/10 px-1 py-0.5 text-[9px] font-bold uppercase text-white/80">
              {badge.display}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
