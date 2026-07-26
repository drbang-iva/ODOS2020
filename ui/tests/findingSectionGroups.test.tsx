import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SpineNav } from "../src/components/charting/SpineNav";
import { FindingSectionGroupsSettings } from "../src/components/settings/FindingSectionGroupsSettings";
import {
  filterDefinitionsForSectionGroups,
  type FindingSectionGroup,
} from "../src/lib/finding-section-groups";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";
import { EncounterCharting } from "../src/scenes/EncounterCharting";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const GROUP: FindingSectionGroup = {
  id: "group-1",
  groupKey: "dry-eye-workup",
  label: "Dry eye workup",
  sectionKeyPrefixes: ["custom:zz-test-"],
  defaultForVisitTypeCategories: ["dry-eye"],
  active: true,
};

test("ungrouped definitions remain visible for every category while grouped definitions require an effective group", () => {
  const definitions = [
    { stableKey: "entrance:pupils", sectionKey: "entrance:pupils", active: true },
    { stableKey: "custom:ordinary", sectionKey: "custom:ordinary", active: true },
    { stableKey: "custom:zz-test-marker", sectionKey: "custom:zz-test-marker", active: true },
  ];

  for (const effectiveGroupKeys of [[], ["unrelated"], ["dry-eye-workup"]]) {
    const visible = filterDefinitionsForSectionGroups(definitions, [GROUP], effectiveGroupKeys);
    assert.ok(visible.some((definition) => definition.stableKey === "entrance:pupils"));
    assert.ok(visible.some((definition) => definition.stableKey === "custom:ordinary"));
  }
  assert.deepEqual(
    filterDefinitionsForSectionGroups(definitions, [GROUP], [])
      .map((definition) => definition.stableKey),
    ["entrance:pupils", "custom:ordinary"],
  );
  assert.deepEqual(
    filterDefinitionsForSectionGroups(definitions, [GROUP], ["dry-eye-workup"])
      .map((definition) => definition.stableKey),
    ["entrance:pupils", "custom:ordinary", "custom:zz-test-marker"],
  );
});

test("EncounterCharting pulls a group into only the current encounter and renders it without reloading", async () => {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  const originalDocument = globalThis.document;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  fhir.read = (async () => ({
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
  })) as typeof fhir.read;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({
        canWrite: false,
        definitions: [
          {
            stableKey: "custom:ordinary",
            sectionKey: "custom:ordinary",
            display: "Ordinary section",
            active: true,
          },
          {
            stableKey: "custom:zz-test-marker",
            sectionKey: "custom:zz-test-marker",
            display: "ZZ test marker",
            active: true,
          },
        ],
      });
    }
    if (url.includes("/clinical-graph/finding-section-groups")) {
      return jsonResponse({
        canWrite: false,
        canPullIn: true,
        groups: [GROUP],
        visitTypeCategories: [],
        visitTypeCategory: "comprehensive",
        defaultGroupKeys: [],
        pulledInGroupKeys: [],
        effectiveGroupKeys: [],
      });
    }
    if (url.includes("/clinical-graph/encounters/encounter-1/section-groups")) {
      return jsonResponse({
        override: { encounterId: "encounter-1", groupKeys: ["dry-eye-workup"] },
      });
    }
    if (url.includes("/clinical-graph/eye-growth/visibility")) {
      return jsonResponse({ defaultVisible: false });
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Document,
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <RoleProvider>
          <EncounterCharting
            patient={{ resourceType: "Patient", id: "patient-1" }}
            encounterId="encounter-1"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    assert.deepEqual(
      renderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("custom:"))
        .map((section: { id: string }) => section.id),
      ["custom:ordinary"],
    );

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Add section group" }).props.onChange({
        target: { value: "dry-eye-workup" },
      });
      await flushEffects();
    });

    assert.deepEqual(
      renderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("custom:"))
        .map((section: { id: string }) => section.id),
      ["custom:ordinary", "custom:zz-test-marker"],
    );
    const mutation = requests.find((request) =>
      request.url.includes("/clinical-graph/encounters/encounter-1/section-groups")
    );
    assert.equal(mutation?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(mutation?.init?.body)), {
      action: "add",
      groupKey: "dry-eye-workup",
    });
  } finally {
    renderer?.unmount();
    fhir.read = originalRead;
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});

test("section-group settings creates a keyed group from the existing visit-type category list", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (init?.method === "POST") {
      return jsonResponse({ group: GROUP }, 201);
    }
    return jsonResponse({
      canWrite: true,
      groups: [],
      visitTypeCategories: [
        { id: "comprehensive", label: "Comprehensive" },
        { id: "dry-eye", label: "Dry Eye" },
      ],
    });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<FindingSectionGroupsSettings />);
      await flushEffects();
    });
    await act(async () => {
      renderer.root.findAllByType("button")
        .find((button) => button.children.join("").includes("Create group"))!
        .props.onClick();
    });
    const textInputs = renderer.root.findAllByType("input").filter(
      (input) => input.props.type !== "checkbox",
    );
    await act(async () => {
      textInputs[0]!.props.onChange({ target: { value: "dry-eye-workup" } });
    });
    await act(async () => {
      renderer.root.findAllByType("input")
        .filter((input) => input.props.type !== "checkbox")[1]!
        .props.onChange({ target: { value: "Dry eye workup" } });
    });
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({
        target: { value: "custom:zz-test-" },
      });
    });
    const categoryCheckbox = renderer.root.findAllByType("input").find(
      (input) => input.props.type === "checkbox" &&
        input.parent?.children.some((child) => child === "Dry Eye"),
    );
    assert.ok(categoryCheckbox);
    await act(async () => {
      categoryCheckbox.props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
      await flushEffects();
    });

    const mutation = requests.find((request) => request.init?.method === "POST");
    assert.ok(mutation);
    assert.deepEqual(JSON.parse(String(mutation.init?.body)), {
      groupKey: "dry-eye-workup",
      label: "Dry eye workup",
      sectionKeyPrefixes: ["custom:zz-test-"],
      defaultForVisitTypeCategories: ["dry-eye"],
      active: true,
    });
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
