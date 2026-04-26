export type RoleId = "doctor" | "tech" | "front-desk";
export type CardDensity = "compact" | "full" | "hidden";

export interface RoleConfig {
  id: RoleId;
  label: string;
  defaultView: "encounter-charting" | "chart-sidebar" | "admin-cards";
  encounterDensity: CardDensity;
  directorOrbitalFilters: string[];
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
    directorOrbitalFilters: [
      "anterior-segment",
      "refractive",
      "systemic",
      "posterior-segment",
      "retina",
      "lids-adnexa",
    ],
  },
  tech: {
    id: "tech",
    label: "Tech",
    defaultView: "chart-sidebar",
    encounterDensity: "full",
    directorOrbitalFilters: ["refractive", "anterior-segment", "posterior-segment", "systemic"],
  },
  "front-desk": {
    id: "front-desk",
    label: "Front desk",
    defaultView: "admin-cards",
    encounterDensity: "compact",
    directorOrbitalFilters: ["systemic", "refractive"],
  },
};

export const ROLE_IDS = Object.keys(ROLE_CONFIG) as RoleId[];
export const DEFAULT_ROLE: RoleId = "doctor";
