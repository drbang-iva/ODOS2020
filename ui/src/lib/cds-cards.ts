export type CdsIndicator = "info" | "warning" | "critical";
export type CdsDsiType = "predictive" | "evidence-based" | "rules-based";

export interface CdsCardViewModel {
  uuid: string;
  summary: string;
  detail?: string;
  indicator: CdsIndicator;
  source: {
    label: string;
    url?: string;
  };
  dsi_type: CdsDsiType;
  intervention_risk_management: {
    risk_identification: string;
    risk_mitigation: string;
    continual_monitoring: string;
  };
  source_attributes: {
    developer_identity: string;
    funding_source: string;
    evidence_basis_citation: string;
  };
  card_ttl_minutes?: number;
  generatedAt?: string;
}

export function isFreshCdsCard(card: CdsCardViewModel, now = new Date()): boolean {
  if (!card.generatedAt) {
    return true;
  }
  const ttl = Math.max(card.card_ttl_minutes ?? 60, 1);
  return Date.parse(card.generatedAt) + ttl * 60_000 > now.getTime();
}
