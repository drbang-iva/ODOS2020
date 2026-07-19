import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  ACCENT_VARIABLES,
  APPEARANCE_ACCENTS,
  APPEARANCE_SURFACES,
  DEFAULT_APPEARANCE,
  SELECTABLE_APPEARANCE_SURFACES,
  SEMANTIC_VARIABLES,
  SURFACE_VARIABLES,
  appearanceVariables,
  buildAppearanceConfigResource,
  loadAppearanceConfigSingleton,
  parseAppearanceConfig,
  type AppearanceConfig,
  type AppearanceSettingsClient,
} from "../src/lib/appearance";
import { AppearanceSettingsReady } from "../src/scenes/settings/AppearanceSettings";

function clientFixture(initial?: Basic) {
  let stored = initial;
  const writes: Array<{ resource: Basic; sourceTag: string }> = [];
  const client = {
    async search<T extends Basic>(): Promise<Bundle<T>> {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: stored ? [{ resource: stored as T }] : [],
      };
    },
    async searchUrl<T extends Basic>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    },
    async update<T extends Basic>(resource: T, sourceTag: string): Promise<T> {
      stored = resource;
      writes.push({ resource, sourceTag });
      return resource;
    },
  };
  return { client: client as AppearanceSettingsClient, writes };
}

const appearanceCss = readFileSync(new URL("../src/styles/appearance.css", import.meta.url), "utf8");

function cssAccentVariables(accent: (typeof APPEARANCE_ACCENTS)[number]): Record<string, string> {
  const selector = accent === "gold" ? ":root" : `:root[data-accent="${accent}"]`;
  const blockStart = appearanceCss.indexOf(`${selector} {`);
  assert.notEqual(blockStart, -1, `${selector} must exist`);
  const blockEnd = appearanceCss.indexOf("}", blockStart);
  assert.notEqual(blockEnd, -1, `${selector} must close`);
  return Object.fromEntries(
    [...appearanceCss.slice(blockStart, blockEnd).matchAll(/(--odos-accent(?:-[a-z-]+)?):\s*([^;]+);/g)]
      .map((match) => [match[1]!, match[2]!.trim()]),
  );
}

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi);
  assert.equal(channels?.length, 3, `${hex} must be a six-digit hex color`);
  const [red, green, blue] = channels.map((channel) => {
    const srgb = Number.parseInt(channel, 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

test("all 18 Surface × Accent combinations resolve the approved variable values", () => {
  const combinations: AppearanceConfig[] = [];
  for (const surface of APPEARANCE_SURFACES) {
    for (const accent of APPEARANCE_ACCENTS) combinations.push({ surface, accent });
  }
  assert.equal(combinations.length, 18);

  for (const config of combinations) {
    const variables = appearanceVariables(config);
    for (const [name, value] of Object.entries({
      ...SURFACE_VARIABLES.midnight,
      ...SURFACE_VARIABLES[config.surface],
      ...ACCENT_VARIABLES.gold,
      ...ACCENT_VARIABLES[config.accent],
    })) {
      assert.equal(variables[name], value, `${config.surface} × ${config.accent} ${name}`);
    }
  }
});

test("the stylesheet and JS-applied accent tokens stay identical", () => {
  for (const accent of APPEARANCE_ACCENTS) {
    assert.deepEqual(cssAccentVariables(accent), ACCENT_VARIABLES[accent], accent);
  }
});

test("every accent ink clears WCAG AA across all three gradient stops", () => {
  for (const accent of APPEARANCE_ACCENTS) {
    const variables = ACCENT_VARIABLES[accent];
    const ink = variables["--odos-accent-ink"]!;
    for (const stop of ["--odos-accent-hi", "--odos-accent", "--odos-accent-lo"]) {
      const ratio = contrastRatio(variables[stop]!, ink);
      assert.ok(ratio >= 4.5, `${accent} ${stop} contrast ${ratio.toFixed(2)} must be at least 4.5:1`);
    }
  }
});

test("Midnight × Gold remains the default appearance", () => {
  assert.match(appearanceCss, /:root\s*\{/);
  assert.match(appearanceCss, /:root\[data-surface="space-black"\]/);
  assert.match(appearanceCss, /:root\[data-surface="light"\]/);

  const defaults = appearanceVariables(DEFAULT_APPEARANCE);
  assert.equal(defaults["--odos-ground"], "#0a0e1a");
  assert.equal(defaults["--odos-surface"], "#121a2e");
  assert.equal(defaults["--odos-surface-2"], "#17203a");
  assert.equal(defaults["--odos-text"], "#e9edf6");
  assert.equal(defaults["--odos-accent"], "#e0bc7e");
  assert.equal(defaults["--odos-accent-hi"], "#f0d6a4");
  assert.equal(defaults["--odos-accent-lo"], "#c79e5c");
});

test("semantic colors stay fixed when the Accent scheme changes", () => {
  for (const accent of APPEARANCE_ACCENTS) {
    const variables = appearanceVariables({ surface: "midnight", accent });
    for (const [name, value] of Object.entries(SEMANTIC_VARIABLES)) {
      assert.equal(variables[name], value, `${accent} must not change ${name}`);
    }
  }
});

test("saving Appearance persists the singleton and a reload restores and applies it", async () => {
  const fixture = clientFixture(buildAppearanceConfigResource(DEFAULT_APPEARANCE));
  const previousDocument = globalThis.document;
  const dataset: Record<string, string> = {};
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { dataset } },
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <AppearanceSettingsReady
          config={DEFAULT_APPEARANCE}
          canWrite
          client={fixture.client}
        />,
      );
    });
    const radios = renderer.root.findAllByType("input");
    const spaceBlack = radios.find((input) => input.props.value === "space-black")!;
    const amethyst = radios.find((input) => input.props.value === "amethyst")!;
    await act(async () => {
      spaceBlack.props.onChange();
      amethyst.props.onChange();
    });
    await act(async () => {
      await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });

    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0]?.sourceTag, "appearance-config");
    assert.deepEqual(parseAppearanceConfig(fixture.writes[0]!.resource), {
      surface: "space-black",
      accent: "amethyst",
    });
    const reloaded = await loadAppearanceConfigSingleton(fixture.client);
    assert.deepEqual(reloaded.config, { surface: "space-black", accent: "amethyst" });
    assert.deepEqual(dataset, { surface: "space-black", accent: "amethyst" });
  } finally {
    if (renderer) act(() => renderer.unmount());
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

test("Appearance offers only the two ready surfaces and no custom color input", () => {
  const fixture = clientFixture();
  const renderer = create(
    <AppearanceSettingsReady config={DEFAULT_APPEARANCE} canWrite client={fixture.client} />,
  );
  const inputs = renderer.root.findAllByType("input");
  assert.equal(inputs.length, 8);
  assert.ok(inputs.every((input) => input.props.type === "radio"));
  assert.deepEqual(inputs.map((input) => input.props.value), [
    "midnight", "space-black", "gold", "emerald", "sapphire", "amethyst", "deep-sapphire", "deep-amethyst",
  ]);
  assert.deepEqual(
    renderer.root.findAllByType("label").map((label) => label.findAllByType("span").at(-1)?.children.join("")),
    ["Midnight", "Space Black", "Gold", "Emerald", "Sapphire", "Amethyst", "Deep Sapphire", "Deep Amethyst"],
  );
  assert.deepEqual(SELECTABLE_APPEARANCE_SURFACES, ["midnight", "space-black"]);
  assert.equal(inputs.some((input) => input.props.value === "light"), false);
  act(() => renderer.unmount());
});

test("a persisted Light configuration remains valid and resolves its variables", async () => {
  const persisted = buildAppearanceConfigResource({ surface: "light", accent: "gold" });
  const fixture = clientFixture(persisted);
  const loaded = await loadAppearanceConfigSingleton(fixture.client);

  assert.deepEqual(loaded.config, { surface: "light", accent: "gold" });
  assert.equal(appearanceVariables(loaded.config)["--odos-ground"], SURFACE_VARIABLES.light["--odos-ground"]);
});

test("a persisted Sapphire configuration remains valid and resolves the bright ramp", async () => {
  const persisted = buildAppearanceConfigResource({ surface: "midnight", accent: "sapphire" });
  const fixture = clientFixture(persisted);
  const loaded = await loadAppearanceConfigSingleton(fixture.client);

  assert.deepEqual(loaded.config, { surface: "midnight", accent: "sapphire" });
  assert.equal(appearanceVariables(loaded.config)["--odos-accent"], "#6d97f0");
});
