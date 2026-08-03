import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { MedicationStatement } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CustomFieldEditor, type CustomFieldEditorValue } from "../src/components/charting/CustomFieldEditor";
import { AestheticsConsentSection } from "../src/components/charting/AestheticsConsentSection";
import { CustomFindingSection } from "../src/components/charting/CustomFindingSection";
import { CustomSectionEditor } from "../src/components/charting/CustomSectionEditor";
import { CupDiscSection } from "../src/components/charting/CupDiscSection";
import { DryEyeSection } from "../src/components/charting/DryEyeSection";
import { DryEyeGlandStructureSection } from "../src/components/charting/DryEyeGlandStructureSection";
import { EyeCopyButton } from "../src/components/charting/EyeCopyButton";
import { PowerDropdown } from "../src/components/charting/PowerDropdown";
import { GonioscopySection } from "../src/components/charting/GonioscopySection";
import { MyopiaManagementSection } from "../src/components/charting/MyopiaManagementSection";
import {
  OcularHealthSection,
  applyAnteriorAllNormal,
  applyPosteriorAllNormal,
  changedDefinitions,
  copyEyeCapture,
  pendingStateEyes,
} from "../src/components/charting/OcularHealthSection";
import { SpineNav } from "../src/components/charting/SpineNav";
import { sectionStatus } from "../src/components/charting/types";
import { VaSection } from "../src/components/charting/VaSection";
import { OdosSelect } from "../src/components/inputs/OdosSelect";
import { OdosChips } from "../src/components/inputs/OdosChips";
import { OdosWheel } from "../src/components/inputs/OdosWheel";
import { PatientRoute } from "../src/App";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";
import { EncounterCharting } from "../src/scenes/EncounterCharting";

test("SpineNav preserves its section inventory for an empty custom registry and safely appends missing-status custom sections", () => {
  const before = renderToStaticMarkup(<SpineNav active="va" statuses={{}} onSelect={() => undefined} />);
  const emptyRegistry = renderToStaticMarkup(<SpineNav active="va" statuses={{}} onSelect={() => undefined} customSections={[]} />);
  assert.equal(emptyRegistry, before);
  assert.equal((before.match(/data-status=/g) ?? []).length, 27);
  assert.match(before, /ASSESSMENT &amp; PLAN/);
  assert.ok(before.indexOf("Assessment") < before.indexOf("Plan · Prescriptions"));

  const custom = renderToStaticMarkup(
    <SpineNav
      active="custom:skin-carotenoid-score-scs00000"
      statuses={{}}
      onSelect={() => undefined}
      customSections={[{ id: "custom:skin-carotenoid-score-scs00000", label: "Skin Carotenoid Score" }]}
      onAddSection={() => undefined}
    />,
  );
  assert.match(custom, /Skin Carotenoid Score/);
  assert.match(custom, /\+ Add section/);
  assert.equal((custom.match(/data-status=/g) ?? []).length, 28);
  assert.deepEqual(sectionStatus({}, "custom:missing"), { completed: false });
});

test("SpineNav groups the traditional spine and appends custom sections after every built-in group", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="va"
      statuses={{}}
      onSelect={() => undefined}
      customSections={[{ id: "custom:tear-pattern-eye00000", label: "Tear Pattern" }]}
    />,
  );
  const labels = [
    "HISTORY",
    "Chief Complaint / HPI / ROS",
    "PRETEST",
    "Wearing (WRx)",
    "Auto-Refraction / Auto-K",
    "Visual Acuity",
    "IOP",
    "REFRACTION",
    "Refraction History",
    "Eye Growth",
    "CONTACT LENSES",
    "Soft Contact Lenses",
    "Specialty Contact Lens",
    "Ortho-K",
    "Myopia Management",
    "OCULAR HEALTH",
    "Cup/Disc",
    "Dry Eye",
    "IMAGING",
    "Manual imaging",
    "ASSESSMENT &amp; PLAN",
    "Assessment",
    "Plan · Prescriptions",
    "Tear Pattern",
  ];
  let previousIndex = -1;
  for (const label of labels) {
    const index = html.indexOf(label);
    assert.ok(index > previousIndex, `${label} should follow the prior spine entry`);
    previousIndex = index;
  }
});

test("only the active SpineNav group opens by default and a new active section auto-opens its group", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SpineNav active="va" statuses={{}} onSelect={() => undefined} />);
  });

  function expandedGroups() {
    return renderer.root
      .findAll((node) => node.type === "section" && typeof node.props["data-spine-group"] === "string")
      .filter((group) => group.findAllByType("button").find((button) => button.props["aria-controls"])?.props["aria-expanded"])
      .map((group) => group.props["data-spine-group"]);
  }

  assert.deepEqual(expandedGroups(), ["PRETEST"]);
  const history = renderer.root.find((node) => node.type === "section" && node.props["data-spine-group"] === "HISTORY");
  const historyToggle = history.findAllByType("button").find((button) => button.props["aria-controls"]);
  assert.ok(historyToggle);
  await act(async () => historyToggle.props.onClick());
  assert.deepEqual(expandedGroups(), ["HISTORY"]);
  await act(async () => historyToggle.props.onClick());
  assert.deepEqual(expandedGroups(), []);
  await act(async () => {
    renderer.update(<SpineNav active="assessment" statuses={{}} onSelect={() => undefined} />);
  });
  assert.deepEqual(expandedGroups(), ["ASSESSMENT & PLAN"]);
  renderer.unmount();
});

test("SpineNav status dots expose complete, incomplete, and read-only labels without dropping detailed summaries", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="va"
      statuses={{
        va: { completed: true, summary: "OD 20/20 · OS 20/25" },
        "dry-eye": { completed: false, summary: "OSDI 34" },
      }}
      onSelect={() => undefined}
    />,
  );
  assert.match(html, /data-status="complete" role="img" aria-label="Complete — OD 20\/20 · OS 20\/25"/);
  assert.match(html, /data-status="incomplete" role="img" aria-label="Incomplete — OSDI 34"/);
  assert.match(html, /data-status="read-only" role="img" aria-label="Read only"/);
  assert.match(html, /title="Incomplete — OSDI 34"/);
});

test("ongoing Dry Eye, Eye Growth, and Myopia Management summaries stay incomplete", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="dry-eye"
      statuses={{
        "dry-eye": { completed: false, summary: "OSDI 34" },
        "eye-growth": { completed: false, summary: "OD axial length 24.12 mm" },
        "myopia-management": { completed: false, summary: "Atropine 0.025%" },
      }}
      onSelect={() => undefined}
    />,
  );
  assert.match(html, /OSDI 34/);
  assert.match(html, /OD axial length 24\.12 mm/);
  assert.match(html, /Atropine 0\.025%/);
  assert.doesNotMatch(html, /bg-emerald-400/);

  for (const file of ["DryEyeSection.tsx", "EyeGrowthSection.tsx", "MyopiaManagementSection.tsx"]) {
    const source = readFileSync(new URL(`../src/components/charting/${file}`, import.meta.url), "utf8");
    const markSaved = source.slice(source.indexOf("function markSaved"));
    assert.match(markSaved, /completed: false/);
  }
});

test("Dry Eye questionnaire persists total-score-only records and keeps unsaved scores bound to their instrument", async () => {
  const originalFetch = globalThis.fetch;
  const rows: Array<{ values: Array<{ code: string; value: number | string }> }> = [];
  const writes: Array<{ customFields: Array<{ code: string; value: number | string }> }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/clinical-graph/custom/dry-eye%3Asymptoms/history")) {
      return jsonResponse({ rows });
    }
    if (url.includes("/clinical-graph/custom/dry-eye%3Asymptoms") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        customFields: Array<{ code: string; value: number | string }>;
      };
      writes.push(body);
      rows.unshift({ values: body.customFields });
      return jsonResponse({ observationReference: "Observation/dry-eye-score-1" });
    }
    throw new Error(`Unexpected Dry Eye request: ${url}`);
  }) as typeof fetch;

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <DryEyeSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
      await flushEffects();
    });

    const instrument = () => renderer!.root.findByProps({ ariaLabel: "Questionnaire instrument" });
    const totalScore = () => renderer!.root.findByProps({ "aria-label": "Total score" });
    const dateAdministered = () => renderer!.root.findByProps({ "aria-label": "Date administered" });
    const unableToTest = () => renderer!.root.findByProps({ "aria-label": "Unable to test" });

    act(() => totalScore().props.onChange({ target: { value: "30" } }));
    act(() => instrument().props.onChange("SPEED"));
    assert.equal(totalScore().props.value, "", "an OSDI score must not be reattributed to SPEED");
    assert.match(JSON.stringify(renderer.toJSON()), /OSDI entry retained separately; its score was not applied to SPEED/);
    act(() => instrument().props.onChange("OSDI"));
    assert.equal(totalScore().props.value, "30", "the unsaved OSDI score must survive instrument switching");
    act(() => dateAdministered().props.onChange({ target: { value: "2026-08-03" } }));
    act(() => unableToTest().props.onChange({ target: { checked: true } }));

    const save = renderer.root.findAllByType("button").find((button) =>
      button.children.includes("Save questionnaire")
    );
    assert.ok(save);
    await act(async () => {
      await save.props.onClick();
    });

    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.customFields, [
      { code: "CUSTOM_INSTRUMENT", value: "OSDI" },
      { code: "CUSTOM_TOTAL_SCORE", value: 30 },
      { code: "CUSTOM_DATE_ADMINISTERED", value: "2026-08-03" },
      { code: "CUSTOM_UNABLE_TO_TEST", value: "unable" },
    ]);

    act(() => renderer!.unmount());
    await act(async () => {
      renderer = create(
        <DryEyeSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
      await flushEffects();
    });

    assert.equal(instrument().props.value, "OSDI");
    assert.equal(totalScore().props.value, "30");
    assert.equal(dateAdministered().props.value, "2026-08-03");
    assert.equal(unableToTest().props.checked, true);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /(?:OSDI|SPEED|DEQ-5) item \d+/);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("Eye Growth is default-visible for paediatric patients independent of reference-band coverage", async () => {
  const paediatric = renderToStaticMarkup(
    <SpineNav
      active="refraction-history"
      statuses={{}}
      onSelect={() => undefined}
      eyeGrowthDefaultVisible
    />,
  );
  assert.ok(paediatric.indexOf("Refraction History") < paediatric.indexOf("Eye Growth"));
  assert.doesNotMatch(paediatric, /Available on demand/);

  let selected: string | undefined;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <SpineNav
        active="refraction-history"
        statuses={{}}
        onSelect={(section) => {
          selected = section;
        }}
        eyeGrowthDefaultVisible={false}
      />,
    );
  });
  const refractionGroup = renderer.root.find((node) =>
    node.type === "section" && node.props["data-spine-group"] === "REFRACTION");
  const available = refractionGroup.findAllByType("button")
    .find((button) => button.props.className.includes("border-dashed"));
  assert.ok(available);
  assert.equal(available.props["aria-controls"], "spine-group-refraction-on-demand");
  assert.equal(
    refractionGroup.findByProps({ id: "spine-group-refraction-on-demand" }).props.hidden,
    true,
  );
  await act(async () => available.props.onClick());
  assert.equal(
    refractionGroup.findByProps({ id: "spine-group-refraction-on-demand" }).props.hidden,
    false,
  );
  const eyeGrowthLabel = refractionGroup.find((node) =>
    node.type === "span" && node.children.includes("Eye Growth"));
  const eyeGrowthButton = eyeGrowthLabel.parent;
  assert.ok(eyeGrowthButton);
  await act(async () => eyeGrowthButton.props.onClick());
  assert.equal(selected, "eye-growth");
  renderer.unmount();
});

test("Eye Growth screening and Myopia Management plan stay on separate surfaces", () => {
  const eyeGrowth = readFileSync(
    new URL("../src/components/charting/EyeGrowthSection.tsx", import.meta.url),
    "utf8",
  );
  const myopiaManagement = readFileSync(
    new URL("../src/components/charting/MyopiaManagementSection.tsx", import.meta.url),
    "utf8",
  );
  assert.match(eyeGrowth, /AxialGrowthChart/);
  assert.doesNotMatch(eyeGrowth, /CarePlan|Atropine|Treatment Plan|startEpisode/);
  assert.match(myopiaManagement, /Treatment Plan/);
  assert.doesNotMatch(myopiaManagement, /AxialGrowthChart|recordAxialLength|reference-population/);
});

test("atropine frequency input accepts alternate dosing text and saves it to MedicationStatement dosage", async () => {
  const originalSearch = fhir.search;
  const originalCreate = fhir.create;
  const loadedFrequency = "1 drop OU nightly";
  let savedAtropine: MedicationStatement | undefined;
  fhir.search = (async (resourceType: string) => ({
    resourceType: "Bundle",
    type: "searchset",
    entry: resourceType === "EpisodeOfCare"
      ? [{
          resource: {
            resourceType: "EpisodeOfCare",
            id: "episode-1",
            status: "active",
            patient: { reference: "Patient/patient-1" },
            type: [{ coding: [{ code: "myopia-management" }] }],
          },
        }]
      : resourceType === "MedicationStatement"
        ? [{
            resource: {
              resourceType: "MedicationStatement",
              id: "atropine-loaded",
              status: "active",
              subject: { reference: "Patient/patient-1" },
              medicationCodeableConcept: {
                coding: [{
                  system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                  code: "1223",
                }],
              },
              dosage: [{ text: loadedFrequency }],
            },
          }]
        : [],
  })) as typeof fhir.search;
  fhir.create = (async (resource: MedicationStatement) => {
    if (resource.resourceType === "MedicationStatement") {
      savedAtropine = resource;
      return { ...resource, id: "atropine-1" };
    }
    return { ...resource, id: "provenance-1" };
  }) as typeof fhir.create;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <MyopiaManagementSection
          patientReference="Patient/patient-1"
          encounterReference="Encounter/encounter-1"
          onSaved={() => undefined}
        />,
      );
      await flushEffects();
    });

    const frequencySelect = renderer.root.findAllByType(OdosSelect)
      .find((select) => select.props.ariaLabel === "Atropine frequency");
    assert.ok(frequencySelect);
    assert.deepEqual(
      frequencySelect.props.options.map((option: { value: string }) => option.value),
      ["1 drop OU qhs", loadedFrequency],
    );
    assert.equal(typeof frequencySelect.props.onInputChange, "function");
    const concentrationSelect = renderer.root.findAllByType(OdosSelect)
      .find((select) => select.props.ariaLabel === "Atropine concentration");
    assert.ok(concentrationSelect);
    assert.deepEqual(
      concentrationSelect.props.options.map((option: { value: string }) => option.value),
      ["0.01%", "0.025%", "0.05%", "0.1%"],
    );
    assert.equal(concentrationSelect.props.onInputChange, undefined);

    const alternateFrequency = "1 drop OU every other night";
    const frequencyInput = renderer.root.findAllByType("input")
      .find((input) => input.props["aria-label"] === "Atropine frequency");
    assert.ok(frequencyInput);
    await act(async () => frequencyInput.props.onChange({ target: { value: alternateFrequency } }));
    assert.equal(
      renderer.root.findAllByType("input")
        .find((input) => input.props["aria-label"] === "Atropine frequency")?.props.value,
      alternateFrequency,
    );

    const addAtropine = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Add atropine");
    assert.ok(addAtropine);
    await act(async () => addAtropine.props.onClick());
    assert.equal(savedAtropine?.dosage?.[0]?.text, alternateFrequency);
  } finally {
    renderer?.unmount();
    fhir.search = originalSearch;
    fhir.create = originalCreate;
  }
});

test("the generic renderer shows ordered fields, OD and OS columns, automatic notes, and history", () => {
  const html = renderToStaticMarkup(
    <CustomFindingSection
      definition={{
        stableKey: "custom:tear-pattern-eye00000",
        sectionKey: "custom:tear-pattern-eye00000",
        display: "Tear Pattern",
        active: true,
        perEye: true,
        customFields: [{
          localCode: "CUSTOM_PATTERN_12345678",
          display: "Pattern",
          valueType: "select",
          options: [{ code: "stable", display: "Stable", active: true }],
          order: 0,
          active: true,
        }],
      }}
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );
  assert.match(html, /Tear Pattern/);
  assert.match(html, />OD</);
  assert.match(html, />OS</);
  assert.match(html, /Pattern/);
  assert.match(html, /Stable/);
  assert.match(html, /Other \/ notes/);
  assert.match(html, /History/);
});

test("an optionless toggle displays its true fallback and can be unset", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ rows: [] })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <CustomFindingSection
          definition={{
            stableKey: "custom:optionless-toggle",
            display: "Optionless Toggle",
            active: true,
            perEye: false,
            customFields: [{
              localCode: "CUSTOM_TOGGLE",
              display: "Toggle",
              valueType: "string",
              inputControl: "toggle",
              order: 0,
              active: true,
            }],
          }}
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
      await flushEffects();
    });
    const checkbox = renderer.root.findByType("input");
    assert.equal(checkbox.props.checked, false);

    await act(async () => checkbox.props.onChange({ target: { checked: true } }));
    assert.equal(renderer.root.findByType("input").props.checked, true);
    assert.equal(
      renderer.root.findAll((node) => node.children.includes("Yes")).length,
      1,
    );

    await act(async () =>
      renderer.root.findByType("input").props.onChange({ target: { checked: false } })
    );
    assert.equal(renderer.root.findByType("input").props.checked, false);
    assert.equal(
      renderer.root.findAll((node) => node.children.includes("No")).length,
      1,
    );
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("gland-structure history reads the saved dropout grade back beside its meibography image", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/clinical-graph/dry-eye/meibography/image")) {
      return jsonResponse({
        contentType: "image/png",
        data: "iVBORw==",
        title: "synthetic-meibography.png",
      });
    }
    if (url.includes("/clinical-graph/dry-eye/meibography")) {
      return jsonResponse({
        rows: [{
          documentReference: "DocumentReference/meibo-1",
          imageUrl:
            "/clinical-graph/dry-eye/meibography/image?patient=Patient%2Fp1&document=DocumentReference%2Fmeibo-1",
          recordedAt: "2026-07-26T21:29:39.000Z",
          eye: "OD",
          lid: "lower",
          score: 2,
          scoringSystem: "arita",
        }],
      });
    }
    return jsonResponse({
      rows: [{
        eye: "OD",
        values: [
          { code: "CUSTOM_IMAGE_REFERENCE", value: "DocumentReference/meibo-1" },
          { code: "CUSTOM_DROPOUT_GRADE", value: "grade-2" },
        ],
      }],
    });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <DryEyeGlandStructureSection
          definition={{
            stableKey: "dry-eye:gland-structure",
            display: "Gland Structure",
            active: true,
            perEye: true,
            customFields: [{
              localCode: "CUSTOM_DROPOUT_GRADE",
              display: "Dropout grade",
              valueType: "select",
              options: [{ code: "grade-2", display: "Grade 2", active: true }],
              order: 1,
              active: true,
            }],
          }}
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          apiBase=""
          onSaved={() => undefined}
        />,
      );
      await flushEffects();
    });
    assert.equal(requests.length, 2);
    const text = renderer.root.findAll((node) => typeof node.children?.[0] === "string")
      .flatMap((node) => node.children)
      .join(" ")
      .replace(/\s+/g, " ");
    assert.match(text, /OD lower lid · score 2/);
    assert.match(text, /Grade 2/);
    const loadImage = renderer.root.find((node) =>
      node.type === "button" && node.props.children === "Load image"
    );
    await act(async () => loadImage.props.onClick());
    assert.equal(requests.length, 3);
    assert.equal(renderer.root.findByType("img").props.src, "data:image/png;base64,iVBORw==");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("gland-structure grade retry reuses the successful image upload", async () => {
  const originalFetch = globalThis.fetch;
  let uploadCalls = 0;
  let gradeCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method !== "POST") return jsonResponse({ rows: [] });
    if (url.includes("/clinical-graph/dry-eye/meibography")) {
      uploadCalls += 1;
      return jsonResponse({ documentReference: { id: "meibo-retry-1" } });
    }
    gradeCalls += 1;
    return gradeCalls === 1
      ? new Response(JSON.stringify({ error: "synthetic grade failure" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      : jsonResponse({});
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <DryEyeGlandStructureSection
          definition={{
            stableKey: "dry-eye:gland-structure",
            display: "Gland Structure",
            active: true,
            perEye: true,
            customFields: [{
              localCode: "CUSTOM_DROPOUT_GRADE",
              display: "Dropout grade",
              valueType: "select",
              options: [{ code: "grade-2", display: "Grade 2", active: true }],
              order: 1,
              active: true,
            }],
          }}
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          apiBase=""
          onSaved={() => undefined}
        />,
      );
      await flushEffects();
    });
    const fileInput = renderer.root.find((node) =>
      node.type === "input" && node.props.type === "file"
    );
    const scoreInput = renderer.root.findByProps({
      "aria-label": "Meibography total score",
    });
    const gradeSelect = renderer.root.findByProps({ "aria-label": "Dropout grade" });
    await act(async () => {
      fileInput.props.onChange({
        target: {
          files: [new File(["synthetic"], "meibo.png", { type: "image/png" })],
        },
      });
      scoreInput.props.onChange({ target: { value: "2" } });
      gradeSelect.props.onChange({ target: { value: "grade-2" } });
    });
    act(() => renderer.root.findByProps({
      "aria-label": "Meibography total score",
    }).props.onBlur());
    const save = () => renderer.root.find((node) =>
      node.type === "button" &&
      (node.props.children === "Save image + grade" || node.props.children === "Retry grade")
    );
    await act(async () => save().props.onClick());
    assert.equal(uploadCalls, 1);
    assert.equal(gradeCalls, 1);
    assert.equal(save().props.children, "Retry grade");

    await act(async () => save().props.onClick());
    assert.equal(uploadCalls, 1);
    assert.equal(gradeCalls, 2);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("the same generic renderer records a data-defined Procedure without an aesthetics component fork", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return init?.method === "POST" ? jsonResponse({ procedureReference: "Procedure/p1" }) : jsonResponse({ rows: [] });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <CustomFindingSection
          definition={{
            resourceKind: "procedure",
            stableKey: "procedure:aesthetics:neurotoxin-glabella",
            sectionKey: "procedure:aesthetics:neurotoxin-glabella",
            display: "Neurotoxin injection — glabella",
            active: true,
            perEye: false,
            customFields: [],
          }}
          patientReference="Patient/shared-1"
          encounterReference="Encounter/aesthetics-1"
          onSaved={() => undefined}
          apiBase=""
        />,
      );
      await flushEffects();
    });
    assert.match(renderToStaticMarkup(
      <CustomFindingSection
        definition={{
          resourceKind: "procedure",
          stableKey: "procedure:aesthetics:neurotoxin-glabella",
          display: "Neurotoxin injection — glabella",
          active: true,
          perEye: false,
          customFields: [],
        }}
        patientReference="Patient/shared-1"
        encounterReference="Encounter/aesthetics-1"
        onSaved={() => undefined}
      />,
    ), /Data-defined clinical procedure/);
    const remarks = renderer.root.findByType("textarea");
    await act(async () => remarks.props.onChange({
      target: { value: "  Conservative placement after counseling.  " },
    }));
    const record = renderer.root.find((node) =>
      node.type === "button" &&
      String(node.props.children).includes("Record Neurotoxin injection")
    );
    await act(async () => record.props.onClick());
    const post = requests.find((request) => request.method === "POST");
    assert.equal(
      post?.url,
      "/clinical-graph/procedure-definitions/procedure%3Aaesthetics%3Aneurotoxin-glabella/capture",
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(post?.body as Record<string, unknown>).filter(([key]) => key !== "performedDateTime")),
      {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
        remarks: "Conservative placement after counseling.",
      },
    );
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("aesthetics consent renders server-owned Questionnaire text and submits the shared Patient reference", async () => {
  const originalFetch = globalThis.fetch;
  let submitted: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      submitted = JSON.parse(String(init.body));
      return jsonResponse({ questionnaireResponseReference: "QuestionnaireResponse/qr1" });
    }
    return jsonResponse({
      questionnaire: {
        resourceType: "Questionnaire",
        status: "active",
        title: "Cosmetic procedure consent acknowledgement",
        item: [
          { linkId: "notice", type: "display", text: "Prototype notice" },
          { linkId: "ack", type: "boolean", text: "I acknowledge the proposed procedure." },
        ],
      },
    });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <AestheticsConsentSection
          patientReference="Patient/shared-1"
          encounterReference="Encounter/aesthetics-1"
          onSaved={() => undefined}
          apiBase=""
        />,
      );
      await flushEffects();
    });
    const checkbox = renderer.root.findByType("input");
    await act(async () => checkbox.props.onChange({ target: { checked: true } }));
    const submit = renderer.root.find((node) =>
      node.type === "button" && node.props.children === "Submit consent"
    );
    await act(async () => submit.props.onClick());
    assert.deepEqual(submitted, {
      patientReference: "Patient/shared-1",
      encounterReference: "Encounter/aesthetics-1",
      acknowledged: true,
    });
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("the generic renderer reaches and captures a nested child option under its parent", async () => {
  const originalFetch = globalThis.fetch;
  let postedBody: unknown;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      postedBody = JSON.parse(String(init.body));
      return jsonResponse({});
    }
    return jsonResponse({ rows: [] });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<CustomFindingSection
        definition={{
          stableKey: "custom:nested-findings-nest0000",
          display: "Nested Findings",
          active: true,
          perEye: false,
          customFields: [{
            localCode: "CUSTOM_NESTED_12345678",
            display: "Findings",
            valueType: "multi-select",
            options: [
              { code: "severity", display: "Severity", active: true },
              { code: "severity::central", display: "Central", active: true, parentCode: "severity" },
            ],
            order: 0,
            active: true,
          }],
        }}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        apiBase=""
        onSaved={() => undefined}
      />);
      await Promise.resolve();
    });
    const severity = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Severity");
    assert.ok(severity);
    assert.equal(severity.props["aria-pressed"], false);
    act(() => severity.props.onClick());
    const central = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Central");
    assert.ok(central);
    assert.equal(central.props["aria-pressed"], false);
    act(() => central.props.onClick());
    const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Nested Findings");
    assert.ok(saveButton);
    await act(async () => saveButton.props.onClick());
    assert.deepEqual(postedBody, {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      customFields: [{ code: "CUSTOM_NESTED_12345678", value: ["severity", "severity::central"] }],
    });
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("the custom-field editor captures hierarchy and priority metadata for new options", async () => {
  let saved: CustomFieldEditorValue | undefined;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<CustomFieldEditor
      onCancel={() => undefined}
      onSave={(value) => { saved = value; }}
    />);
  });
  const selects = renderer.root.findAllByType("select");
  act(() => selects[0]!.props.onChange({ target: { value: "multi-select" } }));
  const inputs = renderer.root.findAllByType("input");
  act(() => inputs[0]!.props.onChange({ target: { value: "Findings" } }));
  act(() => renderer.root.findByType("textarea").props.onChange({
    target: { value: "severity | Severity | | priority\nseverity::central | Central | severity" },
  }));
  const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save field");
  assert.ok(saveButton);
  await act(async () => saveButton.props.onClick());
  assert.deepEqual(saved?.options, [
    { code: "severity", display: "Severity", active: true, priority: true },
    { code: "severity::central", display: "Central", active: true, parentCode: "severity" },
  ]);
  renderer.unmount();
});

test("the shared section editor composes fields through the shipped custom-field editor affordance", () => {
  const html = renderToStaticMarkup(<CustomSectionEditor onCancel={() => undefined} onSave={() => undefined} />);
  assert.match(html, /Create chart section/);
  assert.match(html, /Chart OD and OS independently/);
  assert.match(html, /\+ Add field/);
  assert.match(html, /Create section/);
});

test("the ocular-health renderer exposes segment headers, accelerators, bilateral copy, deferred, priority, nesting, and Other controls", async () => {
  const definition = {
    stableKey: "ocular-health:anterior:lids-lashes",
    sectionKey: "ocular-health:anterior:lids-lashes",
    display: "Lids & Lashes",
    active: true,
    perEye: true,
    normalTemplate: "Normal lids.",
    allowDeferred: true,
    customFields: [{
      localCode: "CUSTOM_ABNORMAL_FINDINGS_02",
      display: "Abnormal findings",
      valueType: "multi-select" as const,
      options: [
        { code: "demodex", display: "Demodex", active: true, priority: true },
        { code: "demodex::collarettes", display: "collarettes", active: true, parentCode: "demodex", priority: true },
        { code: "anterior-blepharitis", display: "Anterior Blepharitis", active: true, priority: true },
        { code: "chalazion", display: "chalazion", active: true, priority: true },
        { code: "ptosis", display: "Ptosis", active: true },
      ],
      order: 0,
      active: true,
    }],
  };
  const html = renderToStaticMarkup(
    <OcularHealthSection
      definitions={[definition]}
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );
  assert.match(html, /Anterior All Normal/);
  assert.match(html, /Anterior Segment/);
  assert.match(html, /Nothing defaults to normal/);
  assert.match(html, /Copy to OS/);
  assert.match(html, /Copy to OD/);
  assert.match(html, /Not performed \/ deferred/);
  assert.equal((html.match(/>Other</g) ?? []).length, 2);
  assert.equal((html.match(/Choose an exam state before entering Other\./g) ?? []).length, 2);

  const fetchImpl = (async () => jsonResponse({
    rows: [{ eye: "OD", state: "abnormal", values: [{ code: "CUSTOM_ABNORMAL_FINDINGS_02", value: ["demodex"] }] }],
  })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={[definition]}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /Demodex/);
    assert.match(rendered, /Collarettes/);
    assert.match(rendered, /Anterior Blepharitis/);
    assert.match(rendered, /Chalazion/);
    assert.doesNotMatch(rendered, /\"children\":\[\"chalazion\"\]/);
    assert.equal(renderer.root.findByType("summary").children.join(""), "More findings (1)");
    assert.ok(rendered.indexOf("Demodex") < rendered.indexOf('"type":"summary"'));
    const demodex = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Demodex");
    const collarettes = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Collarettes");
    assert.ok(demodex);
    assert.ok(collarettes);
    assert.equal(renderer.root.findAllByType(EyeCopyButton).length, 2);
    const chipOptions = renderer.root.findAllByType(OdosChips).flatMap((chips) => chips.props.options);
    assert.ok(chipOptions.some((option: { value: string; label: string }) => option.value === "chalazion" && option.label === "Chalazion"));
    assert.ok(chipOptions.some((option: { value: string; label: string }) => option.value === "demodex::collarettes" && option.label === "Collarettes"));
    assert.equal(demodex.props["aria-pressed"], true);
    assert.equal(collarettes.props["aria-pressed"], false);
    act(() => collarettes.props.onClick());
    assert.equal(
      renderer.root.findAllByType("button").find((button) => button.children.join("") === "Collarettes")?.props["aria-pressed"],
      true,
    );
  } finally {
    renderer?.unmount();
  }
});

test("reopened history hydrates structures but posts only the one modified structure", async () => {
  const posts: string[] = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(url);
      return jsonResponse({});
    }
    return jsonResponse({
      rows: [
        { eye: "OD", state: "normal", values: [], normalTemplate: "Saved OD normal." },
        { eye: "OS", state: "normal", values: [], normalTemplate: "Saved OS normal." },
      ],
    });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={ocularDefinitions()}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    const abnormalButtons = renderer.root.findAllByType("button").filter((button) => button.children.join("") === "Abnormal");
    assert.equal(abnormalButtons.length, 18);
    act(() => abnormalButtons[8]!.props.onClick());
    const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Ocular Health");
    assert.ok(saveButton);
    await act(async () => saveButton.props.onClick());
    assert.equal(posts.length, 1);
    assert.match(posts[0]!, /ocular-health%3Aanterior%3Atear-film$/);
  } finally {
    renderer?.unmount();
  }
});

test("a saved normal keeps its captured template snapshot after the live template changes", async () => {
  const fetchImpl = (async () => jsonResponse({
    rows: [{ eye: "OD", state: "normal", values: [], normalTemplate: "Saved normal snapshot." }],
  })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    const [definition] = ocularDefinitions();
    assert.ok(definition);
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={[definition]}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    await act(async () => {
      renderer.update(<OcularHealthSection
        definitions={[{ ...definition, normalTemplate: "Later edited live template." }]}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
    });
    const templates = renderer.root.findAllByProps({ className: "mt-3 text-sm text-white/45" }).map((node) => node.children.join(""));
    assert.equal(templates[0], "Saved normal snapshot.");
    assert.equal(templates[1], "Later edited live template.");
  } finally {
    renderer?.unmount();
  }
});

test("SpineNav groups anterior and posterior definitions with Cup Disc in posterior", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="ocular-health:anterior:cornea"
      statuses={{}}
      onSelect={() => undefined}
      ocularHealthSections={[
        { id: "ocular-health:anterior:periocular-adnexa", label: "Periocular Adnexa", segment: "anterior" },
        { id: "ocular-health:anterior:cornea", label: "Cornea", segment: "anterior" },
        { id: "ocular-health:posterior:vitreous", label: "Vitreous", segment: "posterior" },
        { id: "ocular-health:posterior:fundus", label: "Fundus", segment: "posterior" },
      ]}
    />,
  );
  assert.ok(html.indexOf("ANTERIOR SEGMENT") < html.indexOf("Periocular Adnexa"));
  assert.ok(html.indexOf("Periocular Adnexa") < html.indexOf("Cornea"));
  assert.ok(html.indexOf("Cornea") < html.indexOf("POSTERIOR SEGMENT"));
  assert.ok(html.indexOf("POSTERIOR SEGMENT") < html.indexOf("Vitreous"));
  assert.ok(html.indexOf("Vitreous") < html.indexOf("Cup/Disc"));
  assert.ok(html.indexOf("Cup/Disc") < html.indexOf("Fundus"));
  assert.ok(html.indexOf("Fundus") < html.indexOf("Dry Eye"));
});

test("posterior seeded history renders honestly and zero-data eyes remain untouched", async () => {
  const definitions = posteriorDefinitions();
  const fetchImpl = (async (input) => String(input).includes("posterior%3Afundus")
    ? jsonResponse({ rows: [{ eye: "OD", state: "abnormal", values: [{ code: "CUSTOM_FUNDUS_FINDINGS", value: ["dot-blot-hemorrhage"] }] }] })
    : jsonResponse({ rows: [] })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={definitions}
        patientReference="Patient/p-posterior"
        encounterReference="Encounter/e-posterior"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    const rendered = JSON.stringify(renderer.toJSON());
    for (const definition of definitions) assert.match(rendered, new RegExp(definition.display));
    assert.match(rendered, /Posterior Segment/);
    assert.match(rendered, /Fundus All Normal/);
    assert.match(rendered, /Dot\/Blot Hemorrhage/);
    assert.equal(renderer.root.findAllByProps({ "aria-pressed": true }).length, 1);
    assert.equal(renderer.root.findAllByProps({ value: "" }).length, 10);
  } finally {
    renderer?.unmount();
  }
});

test("Fundus All Normal fills only the five posterior narratives and skips Cup Disc by construction", () => {
  const definitions = [...ocularDefinitions(), ...posteriorDefinitions()];
  const captures = Object.fromEntries(definitions.map((definition) => [definition.stableKey, {
    OD: { selections: [], other: "" },
    OS: { selections: [], other: "" },
  }]));
  const result = applyPosteriorAllNormal(definitions, captures);
  assert.equal(result.filled, 5);
  assert.equal(result.skipped, 0);
  assert.equal(definitions.some((definition) => definition.stableKey === "cup-disc"), false);
  for (const definition of posteriorDefinitions()) {
    assert.equal(result.captures[definition.stableKey]?.OD.state, "normal");
    assert.equal(result.captures[definition.stableKey]?.OS.state, "normal");
  }
  assert.equal(result.captures[ocularDefinitions()[0]!.stableKey]?.OD.state, undefined);
});

test("posterior re-save stays pristine, round-trips selections, and preserves the saved normal template snapshot", async () => {
  const [vitreous, fundus] = posteriorDefinitions();
  assert.ok(vitreous && fundus);
  const posts: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input, init) => {
    if (init?.method === "POST") {
      posts.push({ url: String(input), body: String(init.body) });
      return jsonResponse({});
    }
    if (String(input).includes("posterior%3Avitreous")) {
      return jsonResponse({ rows: [{ eye: "OD", state: "abnormal", values: [{ code: "CUSTOM_VITREOUS_FINDINGS", value: ["floaters"] }] }] });
    }
    return jsonResponse({ rows: [{ eye: "OD", state: "normal", values: [], normalTemplate: "Saved fundus normal snapshot." }] });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={[vitreous, fundus]}
        patientReference="Patient/p-posterior"
        encounterReference="Encounter/e-posterior"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    const normalButtons = renderer.root.findAllByType("button").filter((button) => button.children.join("") === "Normal");
    act(() => normalButtons[1]!.props.onClick());
    const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Ocular Health");
    assert.ok(saveButton);
    await act(async () => saveButton.props.onClick());
    assert.equal(posts.length, 1);
    assert.match(posts[0]!.url, /ocular-health%3Aposterior%3Avitreous$/);
    assert.match(posts[0]!.body, /CUSTOM_VITREOUS_FINDINGS/);
    assert.match(posts[0]!.body, /floaters/);
    await act(async () => saveButton.props.onClick());
    assert.equal(posts.length, 1);
    const templates = renderer.root.findAllByProps({ className: "mt-3 text-sm text-white/45" }).map((node) => node.children.join(""));
    assert.ok(templates.includes("Saved fundus normal snapshot."));
  } finally {
    renderer?.unmount();
  }
});

test("Vessels defaults A/V ratio to 2:3, saves a per-eye grade, and does not POST again while pristine", async () => {
  const vessels = posteriorDefinitions().find((definition) => definition.display === "Vessels");
  assert.ok(vessels);
  const posts: string[] = [];
  const fetchImpl = (async (_input, init) => {
    if (init?.method === "POST") {
      posts.push(String(init.body));
      return jsonResponse({});
    }
    return jsonResponse({ rows: [] });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={[vessels]}
        patientReference="Patient/p-vessels-grade"
        encounterReference="Encounter/e-vessels-grade"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    const selects = renderer.root.findAllByType(OdosSelect);
    assert.equal(selects.length, 2);
    assert.deepEqual(selects.map((select) => select.props.value), ["2:3", "2:3"]);
    const normalButtons = renderer.root.findAllByType("button").filter((button) => button.children.join("") === "Normal");
    act(() => normalButtons[0]!.props.onClick());
    act(() => selects[0]!.props.onChange("1:2"));
    const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Ocular Health");
    assert.ok(saveButton);
    await act(async () => saveButton.props.onClick());
    assert.equal(posts.length, 1);
    assert.match(posts[0]!, /CUSTOM_GRADE_A_V_RATIO/);
    assert.match(posts[0]!, /1:2/);
    await act(async () => saveButton.props.onClick());
    assert.equal(posts.length, 1);
  } finally {
    renderer?.unmount();
  }
});

test("anterior optional selects and numbers render blank, persist typed values, and hydrate per eye", async () => {
  const definitions = anteriorGradeDefinitions();
  const posts: Array<{ url: string; body: { eyes: Record<string, { customFields: Array<{ code: string; value: number | string }> }> } }> = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return jsonResponse({});
    }
    if (url.includes("tear-film")) {
      return jsonResponse({ rows: [{ eye: "OD", state: "normal", values: [{ code: "CUSTOM_GRADE_TBUT", value: 6 }] }] });
    }
    return jsonResponse({ rows: [] });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={definitions}
        patientReference="Patient/p-anterior-grades"
        encounterReference="Encounter/e-anterior-grades"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    const numbers = renderer.root.findAllByType(OdosWheel);
    assert.equal(numbers.length, 10);
    assert.deepEqual(numbers.slice(0, 2).map((input) => input.props.value), [6, 0]);
    assert.deepEqual([numbers[2]!.props.min, numbers[2]!.props.max, numbers[2]!.props.step], [0.1, 6.9, 0.1]);
    const selects = renderer.root.findAllByType(OdosSelect);
    assert.equal(selects.length, 2);
    assert.deepEqual(selects.map((select) => select.props.value), ["", ""]);

    act(() => numbers[0]!.props.onChange(6));
    act(() => selects[1]!.props.onChange("grade-2"));
    act(() => numbers[2]!.props.onChange(6.9));
    const normalButtons = renderer.root.findAllByType("button").filter((button) => button.children.join("") === "Normal");
    act(() => normalButtons[3]!.props.onClick());
    act(() => normalButtons[4]!.props.onClick());
    const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Ocular Health");
    assert.ok(saveButton);
    await act(async () => saveButton.props.onClick());
    assert.equal(posts.length, 3);
    assert.deepEqual(posts[0]!.body.eyes.OD?.customFields, [{ code: "CUSTOM_GRADE_TBUT", value: 6 }]);
    assert.deepEqual(posts[1]!.body.eyes.OS?.customFields, [{ code: "CUSTOM_GRADE_VAN_HERICK", value: "grade-2" }]);
    assert.deepEqual(posts[2]!.body.eyes.OD?.customFields, [{ code: "CUSTOM_GRADE_LOCS_III_NO_NUCLEAR_OPALESCENCE", value: 6.9 }]);
  } finally {
    renderer?.unmount();
  }
});

test("all-normal skips touched structures and copy-to-eye produces an independently editable clone", () => {
  const captures = {
    "ocular-health:anterior:cornea": {
      OD: { state: "abnormal" as const, selections: ["staining"], other: "" },
      OS: { selections: [], other: "" },
    },
    "ocular-health:anterior:lens": {
      OD: { selections: [], other: "" },
      OS: { selections: [], other: "" },
    },
    "dry-eye:conjunctival-staining": {
      OD: { selections: [], other: "" },
      OS: { selections: [], other: "" },
    },
  };
  const result = applyAnteriorAllNormal([
    { stableKey: "ocular-health:anterior:cornea" },
    { stableKey: "ocular-health:anterior:lens" },
    { stableKey: "dry-eye:conjunctival-staining" },
  ], captures);
  assert.equal(result.filled, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.captures["ocular-health:anterior:cornea"]?.OD.state, "abnormal");
  assert.equal(result.captures["ocular-health:anterior:lens"]?.OD.state, "normal");
  assert.equal(result.captures["ocular-health:anterior:lens"]?.OS.state, "normal");
  assert.equal(result.captures["dry-eye:conjunctival-staining"]?.OD.state, "normal");
  assert.equal(result.captures["dry-eye:conjunctival-staining"]?.OS.state, "normal");

  const source = { state: "abnormal" as const, selections: ["demodex", "demodex::collarettes"], other: "trace" };
  const copied = copyEyeCapture(source);
  copied.selections.push("ptosis");
  assert.deepEqual(source.selections, ["demodex", "demodex::collarettes"]);
  assert.equal(copied.state, "abnormal");
  assert.equal(copied.other, "trace");
});

test("pending-state eyes report touched notes without a state and ignore stated or untouched eyes", () => {
  const pending = pendingStateEyes([
    { stableKey: "ocular-health:anterior:cornea", display: "Cornea" },
    { stableKey: "ocular-health:anterior:lens", display: "Lens" },
  ], {
    "ocular-health:anterior:cornea": {
      OD: { state: "normal", selections: [], other: "clear" },
      OS: { selections: [], other: "trace scar" },
    },
    "ocular-health:anterior:lens": {
      OD: { selections: [], other: "" },
      OS: { state: "abnormal", selections: ["cataract"], other: "mild" },
    },
  });

  assert.deepEqual(pending, [{
    stableKey: "ocular-health:anterior:cornea",
    display: "Cornea",
    eye: "OS",
  }]);
});

test("hydrated state is pristine until a capture differs from its baseline", () => {
  const definitions = ocularDefinitions();
  const hydrated = Object.fromEntries(definitions.map((definition) => [definition.stableKey, {
    OD: { state: "normal" as const, selections: [], other: "", normalTemplate: definition.normalTemplate },
    OS: { state: "normal" as const, selections: [], other: "", normalTemplate: definition.normalTemplate },
  }]));
  assert.equal(changedDefinitions(definitions, hydrated, hydrated).length, 0);
  const edited = structuredClone(hydrated);
  edited[definitions[4]!.stableKey]!.OD.state = "abnormal";
  edited[definitions[4]!.stableKey]!.OD.normalTemplate = undefined;
  assert.deepEqual(changedDefinitions(definitions, edited, hydrated).map((definition) => definition.stableKey), [
    definitions[4]!.stableKey,
  ]);
});

test("EncounterCharting keeps the shipped eyecare branches, adds three dry-eye renderers, and reuses the custom renderer for procedure definitions", () => {
  const source = readFileSync(new URL("../src/scenes/EncounterCharting.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/activeSection === "/g) ?? []).length, 31);
  assert.equal((source.match(/activeSection\.startsWith\("custom:"\)/g) ?? []).length, 2);
  assert.equal((source.match(/activeSection\.startsWith\("procedure:"\)/g) ?? []).length, 2);
  assert.match(source, /Custom section catalog unavailable; charting built-ins only\./);
  assert.match(source, /<CustomFindingSection[\s\S]*definition=\{procedureDefinition\}/);
  assert.match(source, /key=\{dryEyeDefinition\.stableKey\}[\s\S]*definition=\{dryEyeDefinition\}/);
  assert.match(source, /key=\{customDefinition\.stableKey\}[\s\S]*definition=\{customDefinition\}/);
  assert.match(source, /key=\{procedureDefinition\.stableKey\}[\s\S]*definition=\{procedureDefinition\}/);
  assert.match(source, /markSaved\("dry-eye:tear-stability", status\)/);
});

test("an aesthetics-tagged Encounter loads the procedure catalog into the shared clinical spine", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/encounter-1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "encounter-1",
        status: "in-progress",
        class: { code: "AMB" },
        subject: { reference: "Patient/shared-1" },
        serviceType: {
          coding: [{
            system: "https://odos2020.com/fhir/CodeSystem/scheduling-discipline",
            code: "aesthetics",
          }],
        },
      });
    }
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({ canWrite: false, definitions: [] });
    }
    if (url.includes("/clinical-graph/procedure-definitions")) {
      return jsonResponse({
        definitions: [
          {
            resourceKind: "procedure",
            discipline: "aesthetics",
            stableKey: "procedure:aesthetics:neurotoxin-glabella",
            sectionKey: "procedure:aesthetics:neurotoxin-glabella",
            display: "Neurotoxin injection — glabella",
            active: true,
            perEye: false,
            customFields: [],
          },
          {
            resourceKind: "procedure",
            discipline: "aesthetics",
            stableKey: "procedure:aesthetics:dermal-filler-nasolabial-fold",
            sectionKey: "procedure:aesthetics:dermal-filler-nasolabial-fold",
            display: "Dermal filler — nasolabial fold",
            active: true,
            perEye: false,
            customFields: [],
          },
          {
            resourceKind: "procedure",
            discipline: "aesthetics",
            stableKey: "procedure:aesthetics:chemical-peel-full-face",
            sectionKey: "procedure:aesthetics:chemical-peel-full-face",
            display: "Chemical peel — full face",
            active: true,
            perEye: false,
            customFields: [],
          },
        ],
      });
    }
    if (url.includes("/clinical-graph/aesthetics-consent")) {
      return jsonResponse({
        questionnaire: {
          resourceType: "Questionnaire",
          status: "active",
          title: "Cosmetic procedure consent acknowledgement",
          item: [],
        },
      });
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
            patient={{ resourceType: "Patient", id: "shared-1" }}
            encounterId="encounter-1"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    const text = renderer.root.findAll((node) => typeof node.children?.[0] === "string")
      .flatMap((node) => node.children)
      .join(" ");
    assert.match(text, /AESTHETICS/);
    assert.match(text, /Cosmetic consent/);
    assert.match(text, /Neurotoxin injection — glabella/);
    assert.match(text, /Dermal filler — nasolabial fold/);
    assert.match(text, /Chemical peel — full face/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("an eyecare-tagged Encounter does not load or render aesthetics procedure sections", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/encounter-eyecare")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "encounter-eyecare",
        status: "in-progress",
        class: { code: "AMB" },
        subject: { reference: "Patient/shared-1" },
        serviceType: {
          coding: [{
            system: "https://odos2020.com/fhir/CodeSystem/scheduling-discipline",
            code: "eyecare",
          }],
        },
      });
    }
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({ canWrite: false, definitions: [] });
    }
    if (url.includes("/clinical-graph/finding-section-groups")) {
      return jsonResponse({
        canWrite: false,
        groups: [],
        visitTypeCategories: [],
        effectiveGroupKeys: [],
      });
    }
    if (url.includes("/clinical-graph/eye-growth/visibility")) {
      return jsonResponse({ defaultVisible: false });
    }
    if (url.includes("/clinical-graph/procedure-definitions")) {
      return jsonResponse({
        definitions: [{
          resourceKind: "procedure",
          discipline: "aesthetics",
          stableKey: "procedure:aesthetics:neurotoxin-glabella",
          sectionKey: "procedure:aesthetics:neurotoxin-glabella",
          display: "Neurotoxin injection — glabella",
          active: true,
          perEye: false,
          customFields: [],
        }],
      });
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
            patient={{ resourceType: "Patient", id: "shared-1" }}
            encounterId="encounter-eyecare"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    const text = renderer.root.findAll((node) => typeof node.children?.[0] === "string")
      .flatMap((node) => node.children)
      .join(" ");
    assert.doesNotMatch(text, /AESTHETICS/);
    assert.equal(
      renderer.root.findByType(SpineNav).props.customSections
        .some((section: { id: string }) => section.id === "procedure:aesthetics:neurotoxin-glabella"),
      false,
    );
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("changing encounterId remounts charting and clears encounter-scoped completion statuses", async () => {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  const originalDocument = globalThis.document;
  fhir.read = (async (resourceType: string, id: string) => {
    if (resourceType === "Patient") {
      return { resourceType: "Patient", id: "shared-1" };
    }
    return {
      resourceType: "Encounter",
      id,
      status: "in-progress",
      class: { code: "AMB" },
      subject: { reference: "Patient/shared-1" },
    };
  }) as typeof fhir.read;
  globalThis.fetch = (async (input) => String(input).includes("finding-definitions")
    ? jsonResponse({ canWrite: false, definitions: [] })
    : jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] })) as typeof fetch;
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
          <PatientRoute patientId="shared-1" mode="encounter" encounterId="encounter-a" />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    await act(async () => renderer.root.findByType(VaSection).props.onSaved({
      completed: true,
      summary: "Encounter A complete",
    }));
    assert.equal(renderer.root.findByType(SpineNav).props.statuses.va?.summary, "Encounter A complete");

    await act(async () => {
      renderer.update(
        <RoleProvider>
          <PatientRoute patientId="shared-1" mode="encounter" encounterId="encounter-b" />
        </RoleProvider>,
      );
      await flushEffects();
    });
    assert.equal(renderer.root.findByType(SpineNav).props.statuses.va, undefined);
  } finally {
    renderer?.unmount();
    fhir.read = originalRead;
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("CupDiscSection clears every eye field before loading a different encounter", async () => {
  const originalFetch = globalThis.fetch;
  const encounterB = deferred<Response>();
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/definition")) return jsonResponse({ definition: { fields: {} } });
    if (url.includes("Encounter%2Fencounter-a")) {
      return jsonResponse({
        eyes: {
          OD: { verticalCupDiscRatio: 0.8 },
          OS: { verticalCupDiscRatio: 0.4 },
        },
      });
    }
    if (url.includes("Encounter%2Fencounter-b")) return encounterB.promise;
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<CupDiscSection
        patientReference="Patient/patient-1"
        encounterReference="Encounter/encounter-a"
        onSaved={() => undefined}
      />);
      await flushEffects();
    });
    const picker = (label: string) => renderer.root.findAllByType(PowerDropdown).find((node) =>
      node.props.ariaLabel === label
    )!;
    assert.equal(picker("OD vertical cup disc ratio picker").props.value, "0.8");
    act(() => picker("OD horizontal cup disc ratio picker").props.onChange("0.7"));

    act(() => renderer.update(<CupDiscSection
      patientReference="Patient/patient-1"
      encounterReference="Encounter/encounter-b"
      onSaved={() => undefined}
    />));

    assert.equal(picker("OD vertical cup disc ratio picker").props.value, "");
    assert.equal(picker("OD horizontal cup disc ratio picker").props.value, "");
    assert.equal(picker("OS vertical cup disc ratio picker").props.value, "");

    await act(async () => {
      encounterB.resolve(jsonResponse({ eyes: { OS: { verticalCupDiscRatio: 0.2 } } }));
      await flushEffects();
    });
    assert.equal(picker("OD vertical cup disc ratio picker").props.value, "");
    assert.equal(picker("OD horizontal cup disc ratio picker").props.value, "");
    assert.equal(picker("OS vertical cup disc ratio picker").props.value, "0.2");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("CupDiscSection preserves descriptor codes and selected order through OdosChips", async () => {
  const originalFetch = globalThis.fetch;
  let postedBody: unknown;
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") {
      postedBody = JSON.parse(String(init.body));
      return jsonResponse({ eyes: {} });
    }
    if (String(input).includes("/definition")) {
      return jsonResponse({
        definition: {
          fields: {
            discAppearanceDescriptors: {
              options: [
                { code: "notching", display: "Notching", active: true },
                { code: "pallor", display: "Pallor", active: true },
              ],
            },
          },
        },
      });
    }
    return jsonResponse({ eyes: {} });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<CupDiscSection
        patientReference="Patient/patient-1"
        encounterReference="Encounter/encounter-1"
        onSaved={() => undefined}
      />);
      await flushEffects();
    });
    const vertical = renderer.root.findAllByType(PowerDropdown).find((node) =>
      node.props.ariaLabel === "OD vertical cup disc ratio picker"
    );
    const notching = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Notching");
    assert.ok(vertical);
    assert.ok(notching);
    assert.equal(notching.props["aria-pressed"], false);
    act(() => vertical.props.onChange("0.50"));
    act(() => notching.props.onClick());
    const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Cup/Disc");
    assert.ok(saveButton);
    await act(async () => saveButton.props.onClick());
    assert.deepEqual(postedBody, {
      patientReference: "Patient/patient-1",
      encounterReference: "Encounter/encounter-1",
      eyes: {
        OD: {
          verticalCupDiscRatio: 0.5,
          discAppearanceDescriptors: ["notching"],
        },
      },
    });
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("GonioscopySection clears encounter state before fetch and hydrates pigmentation and note without dirty records", async () => {
  const originalFetch = globalThis.fetch;
  const encounterB = deferred<Response>();
  const postedBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      postedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({});
    }
    if (url.includes("Encounter%2Fencounter-a")) {
      return jsonResponse({
        records: [],
        pigmentation: { OD: "3+" },
        note: "Encounter A note",
      });
    }
    if (url.includes("Encounter%2Fencounter-b")) return encounterB.promise;
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<GonioscopySection
        patientReference="Patient/patient-1"
        encounterReference="Encounter/encounter-a"
        onSaved={() => undefined}
      />);
      await flushEffects();
    });
    const select = (label: string) => renderer.root.find((node) =>
      (node.type === "select" && node.props["aria-label"] === label)
      || (node.type === OdosSelect && node.props.ariaLabel === label)
    );
    assert.equal(select("OD TM pigmentation").props.value, "3+");
    assert.equal(renderer.root.findByType("textarea").props.value, "Encounter A note");
    act(() => select("OD all quadrants").props.onChange({ target: { value: "ss" } }));
    assert.equal(select("OD all quadrants").props.value, "ss");

    act(() => renderer.update(<GonioscopySection
      patientReference="Patient/patient-1"
      encounterReference="Encounter/encounter-b"
      onSaved={() => undefined}
    />));

    assert.equal(select("OD all quadrants").props.value, "");
    assert.equal(select("OD TM pigmentation").props.value, "");
    assert.equal(select("OS TM pigmentation").props.value, "");
    assert.equal(renderer.root.findByType("textarea").props.value, "");

    await act(async () => {
      encounterB.resolve(jsonResponse({
        records: [{
          eye: "OS",
          quadrant: "nasal",
          value: "ptm",
          entryMode: "quadrant-specific",
          source: "clinician-entered",
        }],
        pigmentation: { OS: "2+" },
        note: "Encounter B note",
      }));
      await flushEffects();
    });
    assert.equal(select("OS TM pigmentation").props.value, "2+");
    assert.equal(renderer.root.findByType("textarea").props.value, "Encounter B note");
    const quadrantToggles = renderer.root.findAllByType("button").filter((button) =>
      button.props["aria-expanded"] === false && button.children.join("").includes("Show quadrants")
    );
    assert.equal(quadrantToggles.length, 2);
    act(() => quadrantToggles[1]!.props.onClick());
    assert.equal(select("OS nasal").props.value, "ptm");

    await act(async () => renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Save Gonioscopy"
    )!.props.onClick());
    assert.deepEqual(postedBodies[0]?.records, []);

    assert.equal(renderer.root.findAllByType(EyeCopyButton).length, 2);
    act(() => renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "← Copy to OD"
    )!.props.onClick());
    assert.equal(select("OD TM pigmentation").props.value, "2+");
    const odQuadrantToggle = renderer.root.findAllByType("button").find((button) =>
      button.props["aria-expanded"] === false && button.children.join("").includes("Show quadrants")
    );
    assert.ok(odQuadrantToggle);
    act(() => odQuadrantToggle.props.onClick());
    assert.equal(select("OD nasal").props.value, "ptm");
    assert.equal(select("OD temporal").props.value, "");

    await act(async () => renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Save Gonioscopy"
    )!.props.onClick());
    assert.deepEqual(postedBodies[1]?.records, [{
      eye: "OD",
      quadrant: "nasal",
      value: "ptm",
      entryMode: "quadrant-specific",
    }]);
    act(() => select("OD temporal").props.onChange("ss"));
    const copyToOd = renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "← Copy to OD"
    );
    assert.equal(copyToOd?.props.disabled, true);
    assert.equal(copyToOd?.props.title, "Document matching source values before replacing this eye.");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("GonioscopySection eye copy preserves anatomical quadrant names", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({
    records: [{
      eye: "OD",
      quadrant: "nasal",
      value: "ptm",
      entryMode: "quadrant-specific",
      source: "clinician-entered",
    }],
  })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<GonioscopySection
        patientReference="Patient/patient-1"
        encounterReference="Encounter/encounter-1"
        onSaved={() => undefined}
      />);
      await flushEffects();
    });
    const select = (label: string) => renderer.root.find((node) =>
      node.type === OdosSelect && node.props.ariaLabel === label
    );
    act(() => renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Copy to OS →"
    )!.props.onClick());
    const quadrantToggles = renderer.root.findAllByType("button").filter((button) =>
      button.props["aria-expanded"] === false && button.children.join("").includes("Show quadrants")
    );
    assert.equal(quadrantToggles.length, 2);
    act(() => quadrantToggles[1]!.props.onClick());
    assert.equal(select("OS nasal").props.value, "ptm");
    assert.equal(select("OS temporal").props.value, "");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("GonioscopySection preserves documented target pigmentation when the source is blank", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({
    records: [{
      eye: "OD",
      quadrant: "nasal",
      value: "ptm",
      entryMode: "quadrant-specific",
      source: "clinician-entered",
    }],
    pigmentation: { OD: "", OS: "3+" },
  })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<GonioscopySection
        patientReference="Patient/patient-1"
        encounterReference="Encounter/encounter-1"
        onSaved={() => undefined}
      />);
      await flushEffects();
    });
    const copyToOs = renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Copy to OS →"
    );
    assert.ok(copyToOs);
    assert.equal(copyToOs.props.disabled, true);
    assert.equal(copyToOs.props.title, "Document matching source values before replacing this eye.");
    act(() => copyToOs.props.onClick());
    const osPigmentation = renderer.root.find((node) =>
      node.type === "select" && node.props["aria-label"] === "OS TM pigmentation"
    );
    assert.equal(osPigmentation.props.value, "3+");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("EncounterCharting retains the shared ChartSidebar after the chart-open prototype is removed", () => {
  const encounterCharting = readFileSync(new URL("../src/scenes/EncounterCharting.tsx", import.meta.url), "utf8");

  assert.match(encounterCharting, /import \{ ChartSidebar \} from "\.\.\/components\/ChartSidebar";/);
  assert.match(encounterCharting, /<ChartSidebar patient=\{patient\} \/>/);
});

test("EncounterCharting collapses its chart sidebar at the existing tablet container breakpoint and persists expansion", async () => {
  const css = readFileSync(new URL("../src/styles/charting.css", import.meta.url), "utf8");
  const tablet = css.match(/@container \(max-width: 1023px\) \{[\s\S]*\n\}/)?.[0] ?? "";

  assert.match(css, /\.odos-charting-workspace \{[\s\S]*container-type: inline-size/);
  assert.match(css, /\.odos-charting-body \{[\s\S]*overflow: hidden/);
  assert.match(css, /@media \(min-width: 768px\) \{[\s\S]*\.odos-spine-nav \{[\s\S]*position: sticky;[\s\S]*height: 100%;[\s\S]*overflow-y: auto/);
  assert.match(tablet, /\.odos-chart-sidebar-shell \{[\s\S]*position: absolute/);
  assert.match(tablet, /\.odos-chart-sidebar-panel \{[\s\S]*visibility: hidden;[\s\S]*transform: translateX\(calc\(100% \+ 2px\)\)/);
  assert.match(tablet, /\.odos-chart-sidebar-shell\.is-open \.odos-chart-sidebar-panel \{[\s\S]*visibility: visible;[\s\S]*transform: translateX\(0\)/);
  assert.match(tablet, /\.odos-chart-sidebar-toggle \{[\s\S]*display: flex/);

  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const documentStub = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
  globalThis.fetch = (async (input) => String(input).includes("finding-definitions")
    ? jsonResponse({ canWrite: false, definitions: [] })
    : jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] })) as typeof fetch;
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <RoleProvider>
          <EncounterCharting patient={{ resourceType: "Patient", id: "patient-1" }} encounterId="encounter-1" />
        </RoleProvider>,
      );
      await flushEffects();
    });
    const toggle = () => renderer.root.find((node) => node.type === "button" && node.props["aria-controls"] === "encounter-chart-sidebar");
    assert.equal(renderer.root.find((node) => node.props.className === "odos-chart-sidebar-shell").props.className, "odos-chart-sidebar-shell");
    assert.equal(toggle().props["aria-expanded"], false);
    assert.equal(toggle().props["aria-label"], "Expand chart sidebar");
    assert.equal(renderer.root.findByType("main").props.inert, undefined);
    await act(async () => toggle().props.onClick());
    assert.equal(toggle().props["aria-expanded"], true);
    assert.equal(renderer.root.findByType("main").props.inert, "");

    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = create(
        <RoleProvider>
          <EncounterCharting patient={{ resourceType: "Patient", id: "patient-1" }} encounterId="encounter-1" />
        </RoleProvider>,
      );
      await flushEffects();
    });
    assert.equal(toggle().props["aria-expanded"], true);
    await act(async () => toggle().props.onClick());
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

function ocularDefinitions() {
  return ["periocular-adnexa", "lids-lashes", "palpebral-conjunctiva", "bulbar-conjunctiva", "tear-film", "cornea", "anterior-chamber", "iris-pupil", "lens"].map((name) => ({
    stableKey: `ocular-health:anterior:${name}`,
    sectionKey: `ocular-health:anterior:${name}`,
    display: name.split("-").map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" "),
    active: true,
    perEye: true,
    normalTemplate: `Live ${name} normal.`,
    allowDeferred: true,
    customFields: [{
      localCode: `CUSTOM_${name.toUpperCase()}_FINDINGS`,
      display: "Abnormal findings",
      valueType: "multi-select" as const,
      options: [{ code: "finding", display: "Finding", active: true, priority: true }],
      order: 0,
      active: true,
    }],
  }));
}

function posteriorDefinitions() {
  return [
    ["vitreous", "Vitreous", "CUSTOM_VITREOUS_FINDINGS", "Floaters"],
    ["fundus", "Fundus", "CUSTOM_FUNDUS_FINDINGS", "Dot/blot hemorrhage"],
    ["macula", "Macula", "CUSTOM_MACULA_FINDINGS", "Drusen"],
    ["vessels", "Vessels", "CUSTOM_VESSELS_FINDINGS", "AV nicking"],
    ["periphery", "Periphery", "CUSTOM_PERIPHERY_FINDINGS", "Retinal hole"],
  ].map(([name, display, localCode, finding]) => ({
    stableKey: `ocular-health:posterior:${name}`,
    sectionKey: `ocular-health:posterior:${name}`,
    display: display!,
    active: true,
    perEye: true,
    normalTemplate: `Live ${name} normal.`,
    allowDeferred: false,
    customFields: [{
      localCode: localCode!,
      display: "Abnormal findings",
      valueType: "multi-select" as const,
      options: [{ code: finding!.toLowerCase().replaceAll("/", "-").replaceAll(" ", "-"), display: finding!, active: true, priority: true }],
      order: 0,
      active: true,
    }, ...(name === "vessels" ? [{
      localCode: "CUSTOM_GRADE_A_V_RATIO",
      display: "A/V ratio",
      valueType: "select" as const,
      options: ["2:3", "1:2", "1:3", "1:4"].map((value) => ({ code: value, display: value, active: true })),
      order: 1,
      active: true,
    }] : [])],
  }));
}

function anteriorGradeDefinitions() {
  const abnormal = (name: string) => ({
    localCode: `CUSTOM_${name.toUpperCase().replaceAll("-", "_")}_FINDINGS`,
    display: "Abnormal findings",
    valueType: "multi-select" as const,
    options: [{ code: "finding", display: "Finding", active: true, priority: true }],
    order: 0,
    active: true,
  });
  return [{
    stableKey: "ocular-health:anterior:tear-film",
    sectionKey: "ocular-health:anterior:tear-film",
    display: "Tear Film",
    active: true,
    perEye: true,
    customFields: [abnormal("tear-film"), {
      localCode: "CUSTOM_GRADE_TBUT",
      display: "TBUT",
      valueType: "number" as const,
      unit: "s",
      min: 0,
      max: 60,
      step: 1,
      order: 1,
      active: true,
    }],
  }, {
    stableKey: "ocular-health:anterior:anterior-chamber",
    sectionKey: "ocular-health:anterior:anterior-chamber",
    display: "Anterior Chamber",
    active: true,
    perEye: true,
    customFields: [abnormal("anterior-chamber"), {
      localCode: "CUSTOM_GRADE_VAN_HERICK",
      display: "Van Herick",
      valueType: "select" as const,
      options: ["Grade 4 (wide open)", "Grade 3", "Grade 2", "Grade 1 (narrow)", "Grade 0 (closed)"].map((value) => ({ code: value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), display: value, active: true })),
      order: 1,
      active: true,
    }],
  }, {
    stableKey: "ocular-health:anterior:lens",
    sectionKey: "ocular-health:anterior:lens",
    display: "Lens",
    active: true,
    perEye: true,
    customFields: [abnormal("lens"), ...[
      ["CUSTOM_GRADE_LOCS_III_NO_NUCLEAR_OPALESCENCE", "LOCS III — NO (nuclear opalescence)"],
      ["CUSTOM_GRADE_LOCS_III_NC_NUCLEAR_COLOR", "LOCS III — NC (nuclear color)"],
      ["CUSTOM_GRADE_LOCS_III_C_CORTICAL", "LOCS III — C (cortical)"],
      ["CUSTOM_GRADE_LOCS_III_P_POSTERIOR_SUBCAPSULAR", "LOCS III — P (posterior subcapsular)"],
    ].map(([localCode, display], index) => ({
      localCode: localCode!,
      display: display!,
      valueType: "number" as const,
      min: 0.1,
      max: 6.9,
      step: 0.1,
      order: index + 1,
      active: true,
    }))],
  }];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
