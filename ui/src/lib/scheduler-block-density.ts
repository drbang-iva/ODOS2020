// Rungs 1-2 of the front-desk disclosure ladder (cockpit design doc §4):
// below COMPACT_BLOCK_HEIGHT a block cannot fit its four text lines + badge
// row, so it renders a compact cue strip; the full content moves to the
// hover card. Pure logic only — no React in this module.
import { SCHEDULER_PALETTE, type AppointmentBlockContent } from "./scheduling";

// Minimum block height (px) that fits the full four-line content + badges.
export const COMPACT_BLOCK_HEIGHT = 64;

export function isCompactBlock(blockHeightPx: number): boolean {
  return blockHeightPx < COMPACT_BLOCK_HEIGHT;
}

export interface CompactCue {
  key: string;
  label: string;
  glyph: string;
  color: string;
}

function statusCue(content: AppointmentBlockContent): CompactCue {
  const label = content.statusDisplay;
  switch (content.status) {
    case "checked-in":
    case "walk-in":
      return { key: "status", label, glyph: "●", color: SCHEDULER_PALETTE.establishedTeal };
    case "checked-out":
      return { key: "status", label, glyph: "●", color: SCHEDULER_PALETTE.mutedLineLight };
    case "no-show":
      return { key: "status", label, glyph: "✕", color: SCHEDULER_PALETTE.urgentRed };
    case "cancelled":
      return { key: "status", label, glyph: "✕", color: SCHEDULER_PALETTE.mutedLineLight };
    default:
      // scheduled (or unknown): the short-block question is "confirmed yet?"
      return content.confirmation === "confirmed"
        ? { key: "status", label: content.confirmationDisplay, glyph: "✓", color: SCHEDULER_PALETTE.establishedTeal }
        : { key: "status", label: content.confirmationDisplay, glyph: "◌", color: SCHEDULER_PALETTE.nonPatientGold };
  }
}

function needsBillingAttention(content: AppointmentBlockContent): boolean {
  return !content.isNonPatient && content.insuranceLine.includes("none");
}

export function buildCompactCues(content: AppointmentBlockContent): CompactCue[] {
  const cues: CompactCue[] = [statusCue(content)];
  if (content.badges.some((badge) => badge.code === "urgent")) {
    cues.push({ key: "urgent", label: "Urgent", glyph: "!", color: SCHEDULER_PALETTE.urgentRed });
  }
  if (needsBillingAttention(content)) {
    cues.push({
      key: "insurance",
      label: `Coverage gap — ${content.insuranceLine}`,
      glyph: "$",
      color: SCHEDULER_PALETTE.nonPatientGold,
    });
  }
  return cues.slice(0, 3);
}

export const HOVER_CARD_WIDTH = 240;
const HOVER_CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;

export interface HoverAnchor {
  top: number;
  left: number;
  right: number;
}

export function hoverCardPosition(
  anchor: HoverAnchor,
  viewport: { width: number; height: number },
  estimatedHeight = 120,
): { left: number; top: number } {
  const fitsRight = anchor.right + HOVER_CARD_GAP + HOVER_CARD_WIDTH + VIEWPORT_MARGIN <= viewport.width;
  const left = fitsRight
    ? anchor.right + HOVER_CARD_GAP
    : anchor.left - HOVER_CARD_WIDTH - HOVER_CARD_GAP;
  const maxTop = viewport.height - estimatedHeight - VIEWPORT_MARGIN;
  const top = Math.min(Math.max(anchor.top, VIEWPORT_MARGIN), maxTop);
  return { left, top };
}
