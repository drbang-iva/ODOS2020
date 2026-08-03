export type RoleId = "doctor" | "tech" | "front-desk" | "practice-admin";
export type CardDensity = "compact" | "full" | "hidden";

export interface RoleConfig {
  id: RoleId;
  label: string;
  defaultView: "encounter-charting" | "chart-sidebar" | "admin-cards";
  encounterDensity: CardDensity;
}

// Presentation only: this role config is never authorization, MCP tool gating,
// or clinical-write permission logic. Real security belongs to v0.5 RBAC and
// Medplum AccessPolicy; every user can switch to every role here.
export const ROLE_CONFIG: Record<RoleId, RoleConfig> = {
  doctor: {
    id: "doctor",
    label: "Doctor",
    defaultView: "encounter-charting",
    encounterDensity: "full",
  },
  tech: {
    id: "tech",
    label: "Tech",
    defaultView: "chart-sidebar",
    encounterDensity: "full",
  },
  "front-desk": {
    id: "front-desk",
    label: "Front desk",
    defaultView: "admin-cards",
    encounterDensity: "compact",
  },
  "practice-admin": {
    id: "practice-admin",
    label: "Practice admin",
    defaultView: "admin-cards",
    encounterDensity: "compact",
  },
};

export const ROLE_IDS = Object.keys(ROLE_CONFIG) as RoleId[];
export const DEFAULT_ROLE: RoleId = "doctor";
