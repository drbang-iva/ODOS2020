import type { CardDensity, RoleId } from "./roles";

export type ChartCardId =
  | "allergies"
  | "tobacco-use"
  | "care-team"
  | "problem-list"
  | "programs"
  | "product-timeline"
  | "longitudinal-imaging";

export interface ChartCardRegistration {
  id: ChartCardId;
  label: string;
  densityByRole: Record<RoleId, CardDensity>;
}

export const CHART_CARD_REGISTRY: ChartCardRegistration[] = [
  {
    id: "programs",
    label: "Programs",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact", "practice-admin": "compact" },
  },
  {
    id: "allergies",
    label: "Allergies",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact", "practice-admin": "compact" },
  },
  {
    id: "tobacco-use",
    label: "Tobacco Use",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact", "practice-admin": "compact" },
  },
  {
    id: "product-timeline",
    label: "Product Timeline",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact", "practice-admin": "compact" },
  },
  {
    id: "care-team",
    label: "Care Team",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact", "practice-admin": "compact" },
  },
  {
    id: "problem-list",
    label: "Problem List",
    densityByRole: { doctor: "full", tech: "compact", "front-desk": "compact", "practice-admin": "compact" },
  },
  {
    id: "longitudinal-imaging",
    label: "Longitudinal Imaging",
    densityByRole: { doctor: "full", tech: "full", "front-desk": "compact", "practice-admin": "compact" },
  },
];

export function cardDensity(cardId: ChartCardId, role: RoleId): CardDensity {
  return CHART_CARD_REGISTRY.find((card) => card.id === cardId)?.densityByRole[role] ?? "hidden";
}

export type OverviewPanelId =
  | "billing-weather"
  | "patient-snapshot"
  | "problem-list"
  | "active-programs"
  | "visit-ledger"
  | "medications"
  | "consult-drafts"
  | "longitudinal-imaging"
  | "optical-order"
  | "product-timeline"
  | "demographic-detail"
  | "document-history"
  | "sale-sheet"
  | "credit-bank-deposit-sheet"
  | "balance-chips";

export interface OverviewPanelRegistration {
  id: OverviewPanelId;
  tier: 1 | 2 | 3;
  densityByRole: Record<RoleId, CardDensity>;
}

export const OVERVIEW_PANEL_REGISTRY: OverviewPanelRegistration[] = [
  { id: "billing-weather", tier: 1, densityByRole: { doctor: "full", tech: "hidden", "front-desk": "hidden", "practice-admin": "hidden" } },
  { id: "patient-snapshot", tier: 1, densityByRole: { doctor: "full", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "problem-list", tier: 1, densityByRole: { doctor: "full", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "active-programs", tier: 1, densityByRole: { doctor: "full", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "visit-ledger", tier: 1, densityByRole: { doctor: "full", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "medications", tier: 2, densityByRole: { doctor: "full", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "consult-drafts", tier: 2, densityByRole: { doctor: "full", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "longitudinal-imaging", tier: 2, densityByRole: { doctor: "full", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "optical-order", tier: 2, densityByRole: { doctor: "full", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "product-timeline", tier: 3, densityByRole: { doctor: "compact", tech: "compact", "front-desk": "full", "practice-admin": "full" } },
  { id: "demographic-detail", tier: 3, densityByRole: { doctor: "compact", tech: "compact", "front-desk": "full", "practice-admin": "full" } },
  { id: "document-history", tier: 3, densityByRole: { doctor: "compact", tech: "compact", "front-desk": "full", "practice-admin": "full" } },
  { id: "sale-sheet", tier: 3, densityByRole: { doctor: "hidden", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "credit-bank-deposit-sheet", tier: 3, densityByRole: { doctor: "hidden", tech: "full", "front-desk": "full", "practice-admin": "full" } },
  { id: "balance-chips", tier: 3, densityByRole: { doctor: "hidden", tech: "full", "front-desk": "full", "practice-admin": "full" } },
];

export function overviewPanelDensity(panelId: OverviewPanelId, role: RoleId): CardDensity {
  return OVERVIEW_PANEL_REGISTRY.find((panel) => panel.id === panelId)?.densityByRole[role] ?? "hidden";
}
