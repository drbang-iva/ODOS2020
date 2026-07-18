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

test("all 12 Surface × Accent combinations resolve the approved variable values", () => {
  const combinations: AppearanceConfig[] = [];
  for (const surface of APPEARANCE_SURFACES) {
    for (const accent of APPEARANCE_ACCENTS) combinations.push({ surface, accent });
  }
  assert.equal(combinations.length, 12);

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

test("the stylesheet carries every approved selector value and keeps Midnight × Gold as the default", () => {
  const css = readFileSync(new URL("../src/styles/appearance.css", import.meta.url), "utf8");
  assert.match(css, /:root\s*\{/);
  assert.match(css, /:root\[data-surface="space-black"\]/);
  assert.match(css, /:root\[data-surface="light"\]/);
  for (const accent of ["sapphire", "emerald", "amethyst"]) {
    assert.match(css, new RegExp(`:root\\[data-accent="${accent}"\\]`));
  }
  for (const value of new Set([
    ...Object.values(SURFACE_VARIABLES.midnight),
    ...Object.values(SURFACE_VARIABLES.light),
    ...Object.values(SURFACE_VARIABLES["space-black"]),
    ...Object.values(ACCENT_VARIABLES.gold),
    ...Object.values(ACCENT_VARIABLES.sapphire),
    ...Object.values(ACCENT_VARIABLES.emerald),
    ...Object.values(ACCENT_VARIABLES.amethyst),
  ])) {
    assert.ok(css.includes(value), value);
  }

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
    const light = radios.find((input) => input.props.value === "light")!;
    const amethyst = radios.find((input) => input.props.value === "amethyst")!;
    await act(async () => {
      light.props.onChange();
      amethyst.props.onChange();
    });
    await act(async () => {
      await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });

    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0]?.sourceTag, "appearance-config");
    assert.deepEqual(parseAppearanceConfig(fixture.writes[0]!.resource), {
      surface: "light",
      accent: "amethyst",
    });
    const reloaded = await loadAppearanceConfigSingleton(fixture.client);
    assert.deepEqual(reloaded.config, { surface: "light", accent: "amethyst" });
    assert.deepEqual(dataset, { surface: "light", accent: "amethyst" });
  } finally {
    if (renderer) act(() => renderer.unmount());
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

test("Appearance is a closed scheme picker with no custom color input", () => {
  const fixture = clientFixture();
  const renderer = create(
    <AppearanceSettingsReady config={DEFAULT_APPEARANCE} canWrite client={fixture.client} />,
  );
  const inputs = renderer.root.findAllByType("input");
  assert.equal(inputs.length, 7);
  assert.ok(inputs.every((input) => input.props.type === "radio"));
  assert.deepEqual(inputs.map((input) => input.props.value), [
    "light", "midnight", "space-black", "gold", "sapphire", "emerald", "amethyst",
  ]);
  act(() => renderer.unmount());
});
