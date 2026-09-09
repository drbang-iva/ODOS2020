import type { Basic } from "@medplum/fhirtypes";
import { fhir } from "./fhir";
import { searchAll } from "./fhir-search";

export const APPEARANCE_SURFACES = ["light", "midnight", "space-black"] as const;
export const APPEARANCE_ACCENTS = [
  "teal",
  "gold",
  "emerald",
  "sapphire",
  "amethyst",
  "deep-sapphire",
  "deep-amethyst",
] as const;

export type AppearanceSurface = (typeof APPEARANCE_SURFACES)[number];
export type AppearanceAccent = (typeof APPEARANCE_ACCENTS)[number];

// Light stays valid but is withheld until the legacy hardcoded-utility migration lands.
export const SELECTABLE_APPEARANCE_SURFACES = ["midnight", "space-black"] as const satisfies readonly AppearanceSurface[];

export interface AppearanceConfig {
  surface: AppearanceSurface;
  accent: AppearanceAccent;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  surface: "midnight",
  accent: "teal",
};

export const SEMANTIC_VARIABLES = {
  "--odos-teal": "#73d6c7",
  "--odos-gold": "#e0bc7e",
  "--odos-emerald": "#2fbf8f",
  "--odos-amethyst": "#9d71f0",
  "--odos-sapphire": "#4c7fe8",
  "--odos-amber": "#e7a94c",
  "--odos-alert": "#e25c6a",
} as const;

export const APPEARANCE_CONFIG_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/appearance-config";
export const APPEARANCE_CONFIG_CODE = "odos-appearance-config";
export const APPEARANCE_CONFIG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-appearance-config";
export const APPEARANCE_CONFIG_RESOURCE_ID = "appearance-config";

export const SURFACE_VARIABLES: Record<AppearanceSurface, Readonly<Record<string, string>>> = {
  midnight: {
    "--odos-ground": "#0a0e1a",
    "--odos-page-ground": "#0a0b14",
    "--odos-surface": "#121a2e",
    "--odos-surface-2": "#17203a",
    "--odos-line": "rgba(154, 178, 224, 0.13)",
    "--odos-line-2": "rgba(154, 178, 224, 0.22)",
    "--odos-text": "#e9edf6",
    "--odos-muted": "#97a1b8",
    "--odos-faint": "#5e6880",
    "--odos-card-gradient": "linear-gradient(180deg, rgba(23, 32, 58, 0.78), rgba(18, 26, 46, 0.86))",
    "--odos-chip-gradient": "linear-gradient(180deg, rgba(23, 32, 58, 0.62), rgba(18, 26, 46, 0.72))",
    "--odos-field-gradient": "linear-gradient(180deg, rgba(23, 32, 58, 0.9), rgba(18, 26, 46, 0.9))",
    "--odos-popover": "rgba(16, 22, 40, 0.98)",
    "--odos-shadow-card": "0 10px 30px rgba(0, 0, 0, 0.25)",
    "--odos-shadow-deep": "0 18px 50px rgba(0, 0, 0, 0.35)",
    "--odos-shadow-pop": "0 20px 60px rgba(0, 0, 0, 0.55)",
    "--odos-deep-surface": "#0e1425",
    "--odos-panel-top": "#131b31",
    "--odos-clinic-panel-top": "#131c33",
    "--odos-clinic-panel-bottom": "#0e1526",
    "--odos-context-surface": "#11192c",
    "--odos-iris-surface": "#1b2440",
    "--odos-overlay-line": "rgb(255 255 255 / .1)",
    "--odos-overlay-line-2": "rgb(255 255 255 / .16)",
    "--odos-chart-toggle": "rgb(17 25 44 / .97)",
    "--odos-chart-toggle-text": "rgb(255 255 255 / .72)",
    "--odos-chart-scrim": "rgb(3 6 14 / .42)",
  },
  "space-black": {
    "--odos-ground": "#06080e",
    "--odos-page-ground": "#06080e",
    "--odos-surface": "#0b1020",
    "--odos-surface-2": "#101728",
    "--odos-card-gradient": "linear-gradient(180deg, rgba(16, 23, 40, 0.85), rgba(11, 16, 32, 0.92))",
    "--odos-chip-gradient": "linear-gradient(180deg, rgba(16, 23, 40, 0.7), rgba(11, 16, 32, 0.8))",
    "--odos-field-gradient": "linear-gradient(180deg, rgba(16, 23, 40, 0.9), rgba(11, 16, 32, 0.9))",
    "--odos-popover": "rgba(8, 12, 22, 0.98)",
    "--odos-deep-surface": "#080c16",
    "--odos-panel-top": "#0d1322",
    "--odos-clinic-panel-top": "#101728",
    "--odos-clinic-panel-bottom": "#0b1020",
    "--odos-context-surface": "#0d1322",
    "--odos-iris-surface": "#101728",
    "--odos-chart-toggle": "rgb(11 16 32 / .97)",
  },
  light: {
    "--odos-ground": "#eef0f5",
    "--odos-page-ground": "#eef0f5",
    "--odos-surface": "#ffffff",
    "--odos-surface-2": "#f7f8fb",
    "--odos-line": "rgba(26, 34, 51, 0.12)",
    "--odos-line-2": "rgba(26, 34, 51, 0.22)",
    "--odos-text": "#1a2233",
    "--odos-muted": "#5b667f",
    "--odos-faint": "#8b94a8",
    "--odos-card-gradient": "linear-gradient(180deg, #ffffff, #f7f8fb)",
    "--odos-chip-gradient": "linear-gradient(180deg, #ffffff, #f2f4f8)",
    "--odos-field-gradient": "linear-gradient(180deg, #ffffff, #f2f4f8)",
    "--odos-popover": "rgba(255, 255, 255, 0.98)",
    "--odos-shadow-card": "0 10px 30px rgba(26, 34, 51, 0.10)",
    "--odos-shadow-deep": "0 18px 50px rgba(26, 34, 51, 0.12)",
    "--odos-shadow-pop": "0 20px 60px rgba(26, 34, 51, 0.22)",
    "--odos-deep-surface": "#f2f4f8",
    "--odos-panel-top": "#ffffff",
    "--odos-clinic-panel-top": "#ffffff",
    "--odos-clinic-panel-bottom": "#f2f4f8",
    "--odos-context-surface": "#ffffff",
    "--odos-iris-surface": "#e5e8ef",
    "--odos-overlay-line": "rgba(26, 34, 51, 0.12)",
    "--odos-overlay-line-2": "rgba(26, 34, 51, 0.22)",
    "--odos-chart-toggle": "rgba(255, 255, 255, 0.97)",
    "--odos-chart-toggle-text": "rgba(26, 34, 51, 0.72)",
    "--odos-chart-scrim": "rgba(26, 34, 51, 0.22)",
  },
};

export const ACCENT_VARIABLES: Record<AppearanceAccent, Readonly<Record<string, string>>> = {
  teal: {
    "--odos-accent": "#73d6c7",
    "--odos-accent-hi": "#a0e3d9",
    "--odos-accent-lo": "#40bfac",
    "--odos-accent-ink": "#04231f",
    "--odos-accent-border": "rgba(115, 214, 199, 0.55)",
    "--odos-accent-ring": "rgba(115, 214, 199, 0.10)",
    "--odos-accent-glow": "0 8px 28px rgba(115, 214, 199, 0.24)",
    "--odos-accent-glow-hover": "0 12px 34px rgba(115, 214, 199, 0.32)",
    "--odos-accent-hairline": "rgba(115, 214, 199, 0.4)",
    "--odos-accent-tint-hi": "rgba(115, 214, 199, 0.13)",
    "--odos-accent-tint-lo": "rgba(115, 214, 199, 0.05)",
  },
  gold: {
    "--odos-accent": "#e0bc7e",
    "--odos-accent-hi": "#f0d6a4",
    "--odos-accent-lo": "#c79e5c",
    "--odos-accent-ink": "#0b0e18",
    "--odos-accent-border": "rgba(224, 188, 126, 0.55)",
    "--odos-accent-ring": "rgba(224, 188, 126, 0.08)",
    "--odos-accent-glow": "0 8px 28px rgba(224, 188, 126, 0.22)",
    "--odos-accent-glow-hover": "0 12px 34px rgba(224, 188, 126, 0.3)",
    "--odos-accent-hairline": "rgba(224, 188, 126, 0.35)",
    "--odos-accent-tint-hi": "rgba(224, 188, 126, 0.12)",
    "--odos-accent-tint-lo": "rgba(224, 188, 126, 0.05)",
  },
  emerald: {
    "--odos-accent": "#3ccb9b",
    "--odos-accent-hi": "#6fdfbb",
    "--odos-accent-lo": "#28a87e",
    "--odos-accent-ink": "#04231a",
    "--odos-accent-border": "rgba(60, 203, 155, 0.55)",
    "--odos-accent-ring": "rgba(60, 203, 155, 0.10)",
    "--odos-accent-glow": "0 8px 28px rgba(60, 203, 155, 0.24)",
    "--odos-accent-glow-hover": "0 12px 34px rgba(60, 203, 155, 0.32)",
    "--odos-accent-hairline": "rgba(60, 203, 155, 0.4)",
    "--odos-accent-tint-hi": "rgba(60, 203, 155, 0.13)",
    "--odos-accent-tint-lo": "rgba(60, 203, 155, 0.05)",
  },
  sapphire: {
    "--odos-accent": "#6d97f0",
    "--odos-accent-hi": "#8fb0f4",
    "--odos-accent-lo": "#4c7fe8",
    "--odos-accent-ink": "#0b0e18",
    "--odos-accent-border": "rgba(109, 151, 240, 0.55)",
    "--odos-accent-ring": "rgba(109, 151, 240, 0.10)",
    "--odos-accent-glow": "0 8px 28px rgba(109, 151, 240, 0.26)",
    "--odos-accent-glow-hover": "0 12px 34px rgba(109, 151, 240, 0.34)",
    "--odos-accent-hairline": "rgba(109, 151, 240, 0.4)",
    "--odos-accent-tint-hi": "rgba(109, 151, 240, 0.14)",
    "--odos-accent-tint-lo": "rgba(109, 151, 240, 0.06)",
  },
  amethyst: {
    "--odos-accent": "#ae87f4",
    "--odos-accent-hi": "#c2a4f8",
    "--odos-accent-lo": "#9d71f0",
    "--odos-accent-ink": "#0b0e18",
    "--odos-accent-border": "rgba(174, 135, 244, 0.55)",
    "--odos-accent-ring": "rgba(174, 135, 244, 0.10)",
    "--odos-accent-glow": "0 8px 28px rgba(174, 135, 244, 0.26)",
    "--odos-accent-glow-hover": "0 12px 34px rgba(174, 135, 244, 0.34)",
    "--odos-accent-hairline": "rgba(174, 135, 244, 0.4)",
    "--odos-accent-tint-hi": "rgba(174, 135, 244, 0.14)",
    "--odos-accent-tint-lo": "rgba(174, 135, 244, 0.06)",
  },
  "deep-sapphire": {
    "--odos-accent": "#3057bd",
    "--odos-accent-hi": "#3f6ad2",
    "--odos-accent-lo": "#22417f",
    "--odos-accent-ink": "#f4f8ff",
    "--odos-accent-border": "rgba(48, 87, 189, 0.55)",
    "--odos-accent-ring": "rgba(48, 87, 189, 0.10)",
    "--odos-accent-glow": "0 8px 28px rgba(48, 87, 189, 0.26)",
    "--odos-accent-glow-hover": "0 12px 34px rgba(48, 87, 189, 0.34)",
    "--odos-accent-hairline": "rgba(48, 87, 189, 0.4)",
    "--odos-accent-tint-hi": "rgba(48, 87, 189, 0.14)",
    "--odos-accent-tint-lo": "rgba(48, 87, 189, 0.06)",
  },
  "deep-amethyst": {
    "--odos-accent": "#7443cc",
    "--odos-accent-hi": "#7f4ed6",
    "--odos-accent-lo": "#5a3099",
    "--odos-accent-ink": "#f6f2ff",
    "--odos-accent-border": "rgba(116, 67, 204, 0.55)",
    "--odos-accent-ring": "rgba(116, 67, 204, 0.10)",
    "--odos-accent-glow": "0 8px 28px rgba(116, 67, 204, 0.26)",
    "--odos-accent-glow-hover": "0 12px 34px rgba(116, 67, 204, 0.34)",
    "--odos-accent-hairline": "rgba(116, 67, 204, 0.4)",
    "--odos-accent-tint-hi": "rgba(116, 67, 204, 0.14)",
    "--odos-accent-tint-lo": "rgba(116, 67, 204, 0.06)",
  },
};

export type AppearanceSettingsClient = Pick<
  typeof fhir,
  "search" | "searchUrl" | "create" | "update"
>;

export function appearanceVariables(config: AppearanceConfig): Readonly<Record<string, string>> {
  validateAppearanceConfig(config);
  return {
    ...SURFACE_VARIABLES.midnight,
    ...SURFACE_VARIABLES[config.surface],
    ...SEMANTIC_VARIABLES,
    ...ACCENT_VARIABLES.teal,
    ...ACCENT_VARIABLES[config.accent],
  };
}

export function buildAppearanceConfigResource(
  config: AppearanceConfig,
  existing?: Basic,
): Basic {
  validateAppearanceConfig(config);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [{
        system: APPEARANCE_CONFIG_SYSTEM,
        code: APPEARANCE_CONFIG_CODE,
        display: "ODOS Appearance Config",
      }],
      text: "ODOS Appearance Config",
    },
    extension: [{
      url: APPEARANCE_CONFIG_EXTENSION_URL,
      valueString: JSON.stringify(config),
    }],
  };
}

export function parseAppearanceConfig(resource: Basic): AppearanceConfig {
  const coding = resource.code?.coding?.find(
    (candidate) => candidate.system === APPEARANCE_CONFIG_SYSTEM
      && candidate.code === APPEARANCE_CONFIG_CODE,
  );
  if (!coding) throw new Error("Basic resource is not the odos appearance-config singleton.");
  const raw = resource.extension?.find(
    (extension) => extension.url === APPEARANCE_CONFIG_EXTENSION_URL,
  )?.valueString;
  if (!raw) throw new Error("Appearance-config singleton is missing its config extension.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Appearance-config JSON is malformed and cannot be parsed.");
  }
  validateAppearanceConfig(parsed);
  return parsed;
}

export async function loadAppearanceConfigSingleton(
  client: Pick<typeof fhir, "search" | "searchUrl">,
): Promise<{ config: AppearanceConfig; resource?: Basic }> {
  const resources = await searchAll<Basic>(client, "Basic", {
    code: `${APPEARANCE_CONFIG_SYSTEM}|${APPEARANCE_CONFIG_CODE}`,
    _count: "10",
  });
  const resource = [...resources].sort((a, b) => lastUpdatedMs(b) - lastUpdatedMs(a))[0];
  return {
    config: resource ? parseAppearanceConfig(resource) : DEFAULT_APPEARANCE,
    ...(resource ? { resource } : {}),
  };
}

export function applyAppearance(
  config: AppearanceConfig,
  target = document.documentElement,
): void {
  validateAppearanceConfig(config);
  target.dataset.surface = config.surface;
  target.dataset.accent = config.accent;
}

export async function loadAndApplyAppearance(
  client: Pick<typeof fhir, "search" | "searchUrl"> = fhir,
  target = document.documentElement,
): Promise<AppearanceConfig> {
  const { config } = await loadAppearanceConfigSingleton(client);
  applyAppearance(config, target);
  return config;
}

function validateAppearanceConfig(value: unknown): asserts value is AppearanceConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Appearance config must be an object.");
  }
  const config = value as Record<string, unknown>;
  if (!APPEARANCE_SURFACES.includes(config.surface as AppearanceSurface)) {
    throw new Error("Appearance surface must be light, midnight, or space-black.");
  }
  if (!APPEARANCE_ACCENTS.includes(config.accent as AppearanceAccent)) {
    throw new Error("Appearance accent must be teal, gold, emerald, sapphire, amethyst, deep-sapphire, or deep-amethyst.");
  }
}

function lastUpdatedMs(resource: Basic): number {
  return resource.meta?.lastUpdated ? Date.parse(resource.meta.lastUpdated) || 0 : 0;
}
