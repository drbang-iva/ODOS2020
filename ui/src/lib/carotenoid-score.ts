export const CAROTENOID_LABEL_ANCHORS = [
  { anchor: 18_000, label: "Low" },
  { anchor: 25_000, label: "Below average" },
  { anchor: 32_000, label: "Lower-middle" },
  { anchor: 42_000, label: "Around average" },
  { anchor: 50_000, label: "Above average" },
  { anchor: 60_000, label: "High" },
  { anchor: 70_000, label: "Very high" },
  { anchor: 80_000, label: "Extremely high end of the scale" },
] as const;

export const CAROTENOID_COLOR_BANDS = [
  { min: 10_000, max: 19_999, color: "Red", hex: "#ef4444" },
  { min: 20_000, max: 29_999, color: "Orange", hex: "#f97316" },
  { min: 30_000, max: 39_999, color: "Yellow", hex: "#eab308" },
  { min: 40_000, max: 49_999, color: "Green", hex: "#22c55e" },
  { min: 50_000, max: 59_999, color: "Blue", hex: "#3b82f6" },
  { min: 60_000, max: 90_000, color: "Purple", hex: "#a855f7" },
] as const;

export function carotenoidPresentation(score: number): { score: number; label: string; color: string } {
  const label = [...CAROTENOID_LABEL_ANCHORS].reverse().find((row, reversedIndex) => {
    const index = CAROTENOID_LABEL_ANCHORS.length - reversedIndex - 1;
    return score >= (CAROTENOID_COLOR_BANDS[index]?.min ?? row.anchor);
  })?.label ?? CAROTENOID_LABEL_ANCHORS[0].label;
  const color = [...CAROTENOID_COLOR_BANDS].reverse().find((row) => score >= row.min)?.color ?? CAROTENOID_COLOR_BANDS[0].color;
  return { score, label, color };
}
