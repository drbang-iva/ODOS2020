import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SpineNav } from "../src/components/charting/SpineNav";
import { OdosSelect } from "../src/components/inputs/OdosSelect";
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

const DRY_EYE_GROUP: FindingSectionGroup = {
  id: "finding-section-group-dry-eye-workup",
  groupKey: "dry-eye-workup",
  label: "Dry Eye Workup",
  sectionKeyPrefixes: ["dry-eye:"],
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
  assert.deepEqual(
    filterDefinitionsForSectionGroups(definitions, [{ ...GROUP, active: false }], [])
      .map((definition) => definition.stableKey),
    ["entrance:pupils", "custom:ordinary"],
  );
});

test("dry-eye category renders the eight-section battery in order while comprehensive renders none and leaves Pupils", async () => {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  const originalDocument = globalThis.document;
  const definitions = [
    {
      stableKey: "entrance:pupils",
      sectionKey: "entrance:pupils",
      display: "Pupils",
      active: true,
      perEye: true,
      customFields: [],
    },
    {
      stableKey: "ocular-health:anterior:tear-film",
      sectionKey: "ocular-health:anterior:tear-film",
      display: "Tear Film",
      active: true,
      perEye: true,
      customFields: [],
    },
    ...[
      ["dry-eye:symptoms", "Symptoms"],
      ["dry-eye:tear-volume", "Tear Volume"],
      ["dry-eye:markers", "Tear Film Markers"],
      ["dry-eye:gland-structure", "Gland Structure"],
      ["dry-eye:gland-function", "Gland Function"],
      ["dry-eye:conjunctival-staining", "Surface Staining"],
      ["dry-eye:staging", "Staging & Subtype"],
    ].map(([stableKey, display]) => ({
      stableKey,
      sectionKey: stableKey,
      display,
      active: true,
      perEye: stableKey !== "dry-eye:symptoms" && stableKey !== "dry-eye:staging",
      customFields: [],
    })),
  ];
  fhir.read = (async (_resourceType: string, id: string) => ({
    resourceType: "Encounter",
    id,
    status: "in-progress",
    class: { code: "AMB" },
  })) as typeof fhir.read;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({ canWrite: false, definitions });
    }
    if (url.includes("/clinical-graph/finding-section-groups")) {
      const dryEye = url.includes("encounter-dry-eye");
      return jsonResponse({
        canWrite: false,
        canPullIn: true,
        groups: [DRY_EYE_GROUP],
        visitTypeCategories: [
          { id: "dry-eye", label: "Dry Eye" },
          { id: "comprehensive", label: "Comprehensive" },
        ],
        visitTypeCategory: dryEye ? "dry-eye" : "comprehensive",
        defaultGroupKeys: dryEye ? ["dry-eye-workup"] : [],
        overrideGroupKeys: [],
        effectiveGroupKeys: dryEye ? ["dry-eye-workup"] : [],
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
  let dryEyeRenderer!: ReactTestRenderer;
  let comprehensiveRenderer!: ReactTestRenderer;
  try {
    await act(async () => {
      dryEyeRenderer = create(
        <RoleProvider>
          <EncounterCharting
            patient={{ resourceType: "Patient", id: "patient-1" }}
            encounterId="encounter-dry-eye"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    assert.deepEqual(
      dryEyeRenderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("dry-eye:"))
        .map((section: { id: string }) => section.id),
      [
        "dry-eye:symptoms",
        "dry-eye:tear-stability",
        "dry-eye:tear-volume",
        "dry-eye:markers",
        "dry-eye:gland-structure",
        "dry-eye:gland-function",
        "dry-eye:conjunctival-staining",
        "dry-eye:staging",
      ],
    );
    await act(async () => {
      comprehensiveRenderer = create(
        <RoleProvider>
          <EncounterCharting
            patient={{ resourceType: "Patient", id: "patient-1" }}
            encounterId="encounter-comprehensive"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    assert.equal(
      comprehensiveRenderer.root.findByType(SpineNav).props.customSections
        .some((section: { id: string }) => section.id.startsWith("dry-eye:")),
      false,
    );
    assert.ok(
      comprehensiveRenderer.root.findByType(SpineNav).findAllByType("span")
        .some((span) => span.children.includes("Pupils")),
    );
    assert.deepEqual(
      filterDefinitionsForSectionGroups(definitions, [DRY_EYE_GROUP], [])
        .filter((definition) => definition.stableKey === "entrance:pupils")
        .map((definition) => definition.stableKey),
      ["entrance:pupils"],
    );
  } finally {
    dryEyeRenderer?.unmount();
    comprehensiveRenderer?.unmount();
    fhir.read = originalRead;
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
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
        overrideGroupKeys: [],
        pulledInGroupKeys: [],
        effectiveGroupKeys: [],
      });
    }
    if (url.includes("/clinical-graph/encounters/encounter-1/section-groups")) {
      const action = JSON.parse(String(init?.body)).action as "add" | "remove";
      return jsonResponse({
        override: {
          encounterId: "encounter-1",
          groupKeys: action === "add" ? ["dry-eye-workup"] : [],
        },
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
      renderer.root.find((node) =>
        node.type === OdosSelect && node.props.ariaLabel === "Add section group"
      ).props.onChange("dry-eye-workup");
      await flushEffects();
    });

    assert.deepEqual(
      renderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("custom:"))
        .map((section: { id: string }) => section.id),
      ["custom:ordinary", "custom:zz-test-marker"],
    );
    const mutations = requests.filter((request) =>
      request.url.includes("/clinical-graph/encounters/encounter-1/section-groups")
    );
    assert.equal(mutations[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(mutations[0]?.init?.body)), {
      action: "add",
      groupKey: "dry-eye-workup",
    });

    await act(async () => {
      renderer.root.findAllByType("button")
        .find((button) => button.children.join("") === "Remove Dry eye workup")!
        .props.onClick();
      await flushEffects();
    });

    assert.deepEqual(
      renderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("custom:"))
        .map((section: { id: string }) => section.id),
      ["custom:ordinary"],
    );
    const removeMutation = requests.filter((request) =>
      request.url.includes("/clinical-graph/encounters/encounter-1/section-groups")
    )[1];
    assert.deepEqual(JSON.parse(String(removeMutation?.init?.body)), {
      action: "remove",
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

test("EncounterCharting fails open when the section-group catalog returns 500", async () => {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  fhir.read = (async () => ({
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
  })) as typeof fhir.read;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({
        canWrite: false,
        definitions: [{
          stableKey: "custom:zz-test-marker",
          sectionKey: "custom:zz-test-marker",
          display: "ZZ test marker",
          active: true,
        }],
      });
    }
    if (url.includes("/clinical-graph/finding-section-groups")) {
      return jsonResponse({ error: "Synthetic catalog failure" }, 500);
    }
    if (url.includes("/clinical-graph/eye-growth/visibility")) {
      return jsonResponse({ defaultVisible: false });
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
  }) as typeof fetch;
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
      ["custom:zz-test-marker"],
    );
    assert.equal(
      renderer.root.findByProps({ role: "alert" }).children.join(""),
      "Section-group visibility could not be loaded.",
    );
    assert.ok(
      renderer.root.findByType(SpineNav).findAllByType("span")
        .some((span) => span.children.includes("Pupils")),
    );
  } finally {
    renderer?.unmount();
    fhir.read = originalRead;
    globalThis.fetch = originalFetch;
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
    const dialog = renderer.root.findByProps({ role: "dialog" });
    assert.equal(dialog.props["aria-modal"], "true");
    assert.equal(dialog.props["aria-labelledby"], "section-group-editor-title");
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

test("section-group settings dialog closes on Escape", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({
    canWrite: true,
    groups: [],
    visitTypeCategories: [],
  })) as typeof fetch;
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
    const dialog = renderer.root.findByProps({ role: "dialog" });
    await act(async () => {
      dialog.props.onKeyDown({
        key: "Escape",
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    });
    assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
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
