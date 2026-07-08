// Rungs 1-2 of the front-desk disclosure ladder (cockpit design doc §4):
// below COMPACT_BLOCK_HEIGHT a block cannot fit its four text lines + badge
// row, so it renders a compact cue strip; the full content moves to the
// hover card. Pure logic only — no React in this module.

// Minimum block height (px) that fits the full four-line content + badges.
export const COMPACT_BLOCK_HEIGHT = 64;

export function isCompactBlock(blockHeightPx: number): boolean {
  return blockHeightPx < COMPACT_BLOCK_HEIGHT;
}
