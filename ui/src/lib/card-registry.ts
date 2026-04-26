import type { CardDensity, RoleId } from "./roles";

export type ChartCardId = "allergies" | "tobacco-use" | "care-team" | "problem-list" | "programs";

export interface ChartCardRegistration {
  id: ChartCardId;
  label: string;
  densityByRole: Record<RoleId, CardDensity>;
}

export const CHART_CARD_REGISTRY: ChartCardRegistration[] = [
  {
    id: "programs",
    label: "Programs",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact" },
  },
  {
    id: "allergies",
    label: "Allergies",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact" },
  },
  {
    id: "tobacco-use",
    label: "Tobacco Use",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact" },
  },
  {
    id: "care-team",
    label: "Care Team",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact" },
  },
  {
    id: "problem-list",
    label: "Problem List",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact" },
  },
];

export function cardDensity(cardId: ChartCardId, role: RoleId): CardDensity {
  return CHART_CARD_REGISTRY.find((card) => card.id === cardId)?.densityByRole[role] ?? "hidden";
}
