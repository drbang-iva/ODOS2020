import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { OdosSelect } from "../src/components/inputs/OdosSelect";
import { OdosWheel } from "../src/components/inputs/OdosWheel";
import { PowerDropdown } from "../src/components/charting/PowerDropdown";
import { RefractionSection } from "../src/components/charting/RefractionSection";
import { SoftContactLensSection } from "../src/components/charting/SoftContactLensSection";
import {
  copyRefractionValues,
  copySoftContactLensValues,
  refractionCopySources,
  softContactLensCopySources,
  type PrescriptionHistoryResponse,
} from "../src/components/charting/prescription-copy";

const CURRENT_ENCOUNTER = "Encounter/current";

test("copy-forward offers only populated spectacle sources and pairs both eyes", () => {
  const blocks = [
    refractionBlock("manifest", "MANIFEST", {
      OD: { sphere: "-1.25", cylinder: "-0.50", axis: "090", add: "2.00" },
      OS: { sphere: "-1.00", cylinder: "-0.75", axis: "085", add: "2.00" },
    }),
    refractionBlock("final", "FINAL_RX"),
    refractionBlock("empty", "CYCLOPLEGIC"),
  ];
  const history: PrescriptionHistoryResponse = {
    glasses: [
      glassesRow("FINAL_RX", "OD", "2026-08-07T12:00:00.000Z", "Encounter/prior", { sphere: -2, cylinder: -0.5, axis: 90, add: 2.25 }, "prior-distance"),
      glassesRow("FINAL_RX", "OS", "2026-08-07T12:00:00.000Z", "Encounter/prior", { sphere: -1.75, cylinder: -0.75, axis: 85, add: 2.25 }, "prior-distance"),
      glassesRow("FINAL_RX", "OS", "2026-08-07T12:00:00.000Z", "Encounter/prior", { sphere: -9 }, "prior-reading"),
      glassesRow("WEARING_RX", "OD", "2026-08-08T11:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.5, cylinder: -0.5, axis: 95, add: 2 }, "wearing-current"),
      glassesRow("WEARING_RX", "OS", "2026-08-08T11:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.25, cylinder: -0.75, axis: 80, add: 2 }, "wearing-current"),
      glassesRow("AUTO_REFRACTION", "OD", "2026-08-08T12:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.75, cylinder: -0.5, axis: 92 }, "auto-current"),
      glassesRow("AUTO_REFRACTION", "OS", "2026-08-08T12:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.5, cylinder: -0.75, axis: 88 }, "auto-current"),
      glassesRow("FINAL_RX", "OD", "2026-08-08T12:30:00.000Z", CURRENT_ENCOUNTER, { sphere: -9 }),
      glassesRow("FINAL_RX", "OD", "2026-08-07T13:00:00.000Z", "Encounter/prior-empty", {}),
    ],
    softCl: [],
    specialtyCl: [],
  };

  const sources = refractionCopySources(blocks, "final", history, CURRENT_ENCOUNTER, {
    MANIFEST: "Manifest",
    FINAL_RX: "Final/Rx",
    CYCLOPLEGIC: "Cycloplegic",
  });

  assert.deepEqual(sources.map(({ id, label }) => ({ id, label })), [
    { id: "encounter:manifest", label: "Manifest (current encounter)" },
    { id: "prior-final-rx", label: "Prior visit Final/Rx · 8/7/2026" },
    { id: "wearing-rx", label: "Wearing Rx · 8/8/2026" },
    { id: "auto-refraction", label: "Auto-refraction · 8/8/2026" },
  ]);
  assert.deepEqual(sources[0]?.eyes, {
    OD: { sphere: "-1.25", cylinder: "-0.50", axis: "090", add: "2.00" },
    OS: { sphere: "-1.00", cylinder: "-0.75", axis: "085", add: "2.00" },
  });
  assert.deepEqual(sources[1]?.eyes, {
    OD: { sphere: "-2.00", cylinder: "-0.50", axis: "90", add: "2.25" },
    OS: { sphere: "-1.75", cylinder: "-0.75", axis: "85", add: "2.25" },
  });
});

test("spectacle copy changes only allow-listed values and preserves target clinical identity", () => {
  const target = refractionBlock("final", "FINAL_RX", {
    purpose: "Distance",
    remarks: "Target-authored note",
    OD: { distanceVisualAcuity: "20/20" },
  });
  const source = {
    id: "prior-final-rx",
    label: "Prior visit Final/Rx",
    eyes: {
      OD: { sphere: "-2.00", cylinder: "-0.50", axis: "90", add: "2.25", signature: "source-signature" },
      OS: { sphere: "-1.75", cylinder: "-0.75", axis: "85", add: "2.25" },
    },
    type: "MANIFEST",
    purpose: "Source purpose",
    recordedAt: "2025-01-01T00:00:00Z",
    author: "Practitioner/source",
    finalized: true,
  } as never;

  const copied = copyRefractionValues(target, source);

  assert.equal(copied.type, "FINAL_RX");
  assert.equal(copied.purpose, "Distance");
  assert.equal(copied.remarks, "Target-authored note");
  assert.equal(copied.OD.distanceVisualAcuity, "20/20");
  assert.deepEqual(
    { sphere: copied.OD.sphere, cylinder: copied.OD.cylinder, axis: copied.OD.axis, add: copied.OD.add },
    { sphere: "-2.00", cylinder: "-0.50", axis: "90", add: "2.25" },
  );
  for (const blocked of ["signature", "released", "finalized", "recordedAt", "author"]) {
    assert.equal(blocked in copied, false);
    assert.equal(blocked in copied.OD, false);
  }
});

test("copy-forward offers a prior soft CL prescription and current trial but no empty or current final source", () => {
  const history: PrescriptionHistoryResponse = {
    glasses: [],
    softCl: [
      softClRow("OD", "2026-08-01T12:00:00.000Z", "Encounter/prior", "dispensed_successful", { product: "precision1", sphere: -2 }, "prior-prescription"),
      softClRow("OS", "2026-08-01T12:00:00.000Z", "Encounter/prior", "dispensed_successful", { product: "precision1", sphere: -1.75 }, "prior-prescription"),
      softClRow("OD", "2026-08-08T12:00:00.000Z", CURRENT_ENCOUNTER, "order_trial_doctor_fit", { product: "precision7", sphere: -2.25 }, "current-trial"),
      softClRow("OS", "2026-08-08T12:00:00.000Z", CURRENT_ENCOUNTER, "order_trial_doctor_fit", { product: "precision7", sphere: -2 }, "current-trial"),
      softClRow("OD", "2026-08-08T13:00:00.000Z", CURRENT_ENCOUNTER, "dispensed_successful", { product: "precision1", sphere: -8 }),
      softClRow("OD", "2026-08-02T12:00:00.000Z", "Encounter/empty", "dispensed", {}),
    ],
    specialtyCl: [],
  };

  const sources = softContactLensCopySources(history, CURRENT_ENCOUNTER);

  assert.deepEqual(sources.map(({ id, label }) => ({ id, label })), [
    { id: "prior-soft-cl", label: "Prior contact lens Rx · 8/1/2026" },
    { id: "current-trial-soft-cl", label: "Current trial lens · 8/8/2026" },
  ]);
  assert.deepEqual(sources[1]?.eyes, {
    OD: { product: "precision7", sphere: "-2.25" },
    OS: { product: "precision7", sphere: "-2.00" },
  });
});

test("legacy rows without group identity never synthesize a two-eye prescription", () => {
  const history: PrescriptionHistoryResponse = {
    glasses: [
      glassesRow("AUTO_REFRACTION", "OD", "2026-08-08T12:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.75 }),
      glassesRow("AUTO_REFRACTION", "OS", "2026-08-08T12:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.5 }),
    ],
    softCl: [
      softClRow("OD", "2026-08-01T12:00:00.000Z", "Encounter/prior", "dispensed_successful", { product: "precision1", sphere: -2 }),
      softClRow("OS", "2026-08-01T12:00:00.000Z", "Encounter/prior", "dispensed_successful", { product: "precision1", sphere: -1.75 }),
    ],
    specialtyCl: [],
  };

  const refraction = refractionCopySources(
    [refractionBlock("final", "FINAL_RX")],
    "final",
    history,
    CURRENT_ENCOUNTER,
    { FINAL_RX: "Final/Rx" },
  );
  const softCl = softContactLensCopySources(history, CURRENT_ENCOUNTER);

  assert.equal(Object.keys(refraction[0]!.eyes).length, 1);
  assert.equal(Object.keys(softCl[0]!.eyes).length, 1);
});

test("soft CL copy leaves status, expiry, release, and authorship with the draft target", () => {
  const target = {
    status: "",
    remarks: "Target note",
    OD: softClEye({ expirationDate: "", startDate: "" }),
    OS: softClEye({ expirationDate: "", startDate: "" }),
  };
  const source = {
    id: "current-trial-soft-cl",
    label: "Current trial lens",
    eyes: {
      OD: { manufacturer: "alcon", product: "precision7", baseCurve: "8.4", diameter: "14.2", sphere: "-2.25", expirationDate: "2030-01-01" },
      OS: { manufacturer: "alcon", product: "precision7", baseCurve: "8.4", diameter: "14.2", sphere: "-2.00" },
    },
    status: "dispensed_successful",
    released: true,
    signature: "Practitioner/source",
    recordedAt: "2026-08-08T12:00:00Z",
  } as never;

  const copied = copySoftContactLensValues(target, source);

  assert.equal(copied.status, "");
  assert.equal(copied.remarks, "Target note");
  assert.equal(copied.OD.product, "precision7");
  assert.equal(copied.OS.sphere, "-2.00");
  assert.equal(copied.OD.expirationDate, "");
  assert.equal(copied.OD.startDate, "");
  for (const blocked of ["signature", "released", "finalized", "recordedAt", "author"]) {
    assert.equal(blocked in copied, false);
    assert.equal(blocked in copied.OD, false);
  }
});

test("RefractionSection pulls both Manifest eyes into editable Final/Rx draft values", async () => {
  const originalFetch = globalThis.fetch;
  const savedBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/refraction/definition")) {
      return Response.json(refractionDefinition());
    }
    if (url.includes("/clinical-graph/refraction/history?")) {
      return Response.json({
        glasses: [
          glassesRow("FINAL_RX", "OD", "2026-08-07T12:00:00.000Z", "Encounter/prior", { sphere: -2 }),
          glassesRow("FINAL_RX", "OS", "2026-08-07T12:00:00.000Z", "Encounter/prior", { sphere: -1.75 }),
          glassesRow("WEARING_RX", "OD", "2026-08-08T10:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.5 }),
          glassesRow("WEARING_RX", "OS", "2026-08-08T10:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.25 }),
          glassesRow("AUTO_REFRACTION", "OD", "2026-08-08T11:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.75 }),
          glassesRow("AUTO_REFRACTION", "OS", "2026-08-08T11:00:00.000Z", CURRENT_ENCOUNTER, { sphere: -1.5 }),
        ],
        softCl: [],
        specialtyCl: [],
      });
    }
    if (url.endsWith("/clinical-graph/refraction") && init?.method === "POST") {
      savedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ blocks: [{ eyes: { OD: {}, OS: {} } }, { eyes: { OD: {}, OS: {} } }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(<RefractionSection patientReference="Patient/synthetic" encounterReference={CURRENT_ENCOUNTER} onSaved={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const odSpheres = renderer.root.findAllByType(PowerDropdown).filter((item) => item.props.ariaLabel === "OD sphere");
    const osSpheres = renderer.root.findAllByType(PowerDropdown).filter((item) => item.props.ariaLabel === "OS sphere");
    const odCylinders = renderer.root.findAllByType(PowerDropdown).filter((item) => item.props.ariaLabel === "OD cylinder");
    const osCylinders = renderer.root.findAllByType(PowerDropdown).filter((item) => item.props.ariaLabel === "OS cylinder");
    const odAxes = renderer.root.findAllByType(OdosWheel).filter((item) => item.props.ariaLabel === "OD axis");
    const osAxes = renderer.root.findAllByType(OdosWheel).filter((item) => item.props.ariaLabel === "OS axis");
    act(() => {
      odSpheres[0]!.props.onChange("-1.25");
      osSpheres[0]!.props.onChange("-1.00");
      odCylinders[0]!.props.onChange("-0.50");
      osCylinders[0]!.props.onChange("-0.75");
      odAxes[0]!.props.onChange(90);
      osAxes[0]!.props.onChange(85);
    });

    const pull = renderer.root.findAllByType(OdosSelect).find((item) => item.props.ariaLabel === "Pull values into refraction 2");
    assert.ok(pull);
    assert.deepEqual(pull.props.options.map((option: { label: string }) => option.label), [
      "Pull from…",
      "Manifest (current encounter)",
      "Prior visit Final/Rx · 8/7/2026",
      "Wearing Rx · 8/8/2026",
      "Auto-refraction · 8/8/2026",
    ]);
    const manifestSource = pull.props.options.find((option: { label: string }) => option.label === "Manifest (current encounter)");
    assert.ok(manifestSource);
    act(() => pull.props.onChange(manifestSource.value));
    assert.equal(odSpheres[1]!.props.value, "-1.25");
    assert.equal(osSpheres[1]!.props.value, "-1.00");
    assert.equal(odCylinders[1]!.props.value, "-0.50");
    assert.equal(osCylinders[1]!.props.value, "-0.75");

    act(() => odSpheres[1]!.props.onChange("-1.50"));
    const save = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Refraction");
    assert.ok(save);
    await act(async () => {
      await save.props.onClick();
      await Promise.resolve();
    });

    const blocks = savedBodies[0]?.blocks as Array<Record<string, unknown>>;
    assert.equal(blocks[1]?.type, "FINAL_RX");
    assert.equal((blocks[1]?.OD as Record<string, unknown>).sphere, -1.5);
    assert.equal((blocks[1]?.OS as Record<string, unknown>).sphere, -1);
    assert.deepEqual(Object.keys(savedBodies[0]!).sort(), ["blocks", "encounterReference", "patientReference", "sourceType"]);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("SoftContactLensSection pulls a current trial into a separately selected final-state draft", async () => {
  const originalFetch = globalThis.fetch;
  let savedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/contact-lens/soft/definition")) {
      return Response.json(softClDefinition());
    }
    if (url.includes("/clinical-graph/refraction/history?")) {
      return Response.json({
        glasses: [],
        softCl: [
          softClRow("OD", "2026-08-08T12:00:00.000Z", CURRENT_ENCOUNTER, "order_trial", {
            manufacturer: "alcon", product: "precision7", baseCurve: 8.4, diameter: 14.2, sphere: -2.25,
          }, "current-trial"),
          softClRow("OS", "2026-08-08T12:00:00.000Z", CURRENT_ENCOUNTER, "order_trial", {
            manufacturer: "alcon", product: "precision7", baseCurve: 8.4, diameter: 14.2, sphere: -2,
          }, "current-trial"),
        ],
        specialtyCl: [],
      });
    }
    if (url.endsWith("/clinical-graph/contact-lens/soft") && init?.method === "POST") {
      savedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ eyes: { OD: {}, OS: {} } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(<SoftContactLensSection patientReference="Patient/synthetic" encounterReference={CURRENT_ENCOUNTER} onSaved={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const status = renderer.root.findAllByType(OdosSelect).find((item) => item.props.ariaLabel === "Status");
    const pull = renderer.root.findAllByType(OdosSelect).find((item) => item.props.ariaLabel === "Pull contact lens values from");
    assert.ok(status);
    assert.ok(pull);
    act(() => status.props.onChange("dispensed_successful"));
    act(() => pull.props.onChange("current-trial-soft-cl"));

    const odSphere = renderer.root.findAll((item) => item.props.ariaLabel === "OD sphere").find((item) => typeof item.props.onChange === "function");
    assert.ok(odSphere);
    assert.equal(odSphere.props.value, "-2.25");
    act(() => odSphere.props.onChange("-2.50"));
    const save = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Soft Contact Lenses");
    assert.ok(save);
    await act(async () => {
      await save.props.onClick();
      await Promise.resolve();
    });

    assert.ok(savedBody);
    assert.equal(savedBody.status, "dispensed_successful");
    const eyes = savedBody.eyes as Record<string, Record<string, unknown>>;
    assert.equal(eyes.OD?.product, "precision7");
    assert.equal(eyes.OD?.sphere, -2.5);
    assert.equal(eyes.OS?.sphere, -2);
    assert.equal("expirationDate" in eyes.OD!, false);
    for (const blocked of ["signature", "released", "finalized", "recordedAt", "author"]) {
      assert.equal(blocked in savedBody, false);
      assert.equal(blocked in eyes.OD!, false);
    }
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("SoftContactLensSection routes obsolete copied catalog values through manual entry", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/contact-lens/soft/definition")) return Response.json(softClDefinition());
    if (url.includes("/clinical-graph/refraction/history?")) {
      return Response.json({
        glasses: [],
        softCl: [
          softClRow(
            "OD",
            "2026-08-01T12:00:00.000Z",
            "Encounter/prior",
            "dispensed_successful",
            { manufacturer: "retired-maker", product: "retired-lens", baseCurve: 8.5, diameter: 14.1, sphere: -2 },
            "prior-retired-cl",
          ),
          softClRow(
            "OS",
            "2026-08-01T12:00:00.000Z",
            "Encounter/prior",
            "dispensed_successful",
            { manufacturer: "alcon", product: "precision7", baseCurve: 8.6, diameter: 14.1, sphere: -1.75, colorMfPower: "retired" },
            "prior-retired-cl",
          ),
        ],
        specialtyCl: [],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(<SoftContactLensSection patientReference="Patient/synthetic" encounterReference={CURRENT_ENCOUNTER} onSaved={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const pull = renderer.root.findAllByType(OdosSelect).find((item) => item.props.ariaLabel === "Pull contact lens values from");
    assert.ok(pull);
    act(() => pull.props.onChange("prior-soft-cl"));

    const manualEntries = renderer.root.findAllByType("input").filter((input) => input.props.type === "checkbox");
    assert.equal(manualEntries[0]?.props.checked, true);
    assert.equal(manualEntries[1]?.props.checked, true);
    const retiredCascade = renderer.root.findAllByType("input").find((input) => input.props.value === "retired");
    assert.ok(retiredCascade);
    act(() => retiredCascade.props.onChange({ target: { value: "verified-retired" } }));
    assert.ok(renderer.root.findAllByType("input").some((input) => input.props.value === "verified-retired"));
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("patient navigation clears prior prescription sources before replacement history loads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/refraction/definition")) return Response.json(refractionDefinition());
    if (url.endsWith("/clinical-graph/contact-lens/soft/definition")) return Response.json(softClDefinition());
    if (url.includes("patient=Patient%2Ftwo")) return await new Promise<Response>(() => undefined);
    if (url.includes("/clinical-graph/refraction/history?")) {
      return Response.json({
        glasses: [glassesRow("FINAL_RX", "OD", "2026-08-07T12:00:00.000Z", "Encounter/prior", { sphere: -2 }, "prior-final")],
        softCl: [softClRow("OD", "2026-08-07T12:00:00.000Z", "Encounter/prior", "dispensed_successful", { product: "precision1", sphere: -2 }, "prior-cl")],
        specialtyCl: [],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  let refractionRenderer: ReactTestRenderer | undefined;
  let softClRenderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      refractionRenderer = create(<RefractionSection patientReference="Patient/one" encounterReference={CURRENT_ENCOUNTER} onSaved={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    let pull = refractionRenderer.root.findAllByType(OdosSelect).find((item) => item.props.ariaLabel === "Pull values into refraction 1");
    assert.ok(pull?.props.options.some((option: { label: string }) => option.label.startsWith("Prior visit Final/Rx")));
    await act(async () => {
      refractionRenderer!.update(<RefractionSection patientReference="Patient/two" encounterReference={CURRENT_ENCOUNTER} onSaved={() => undefined} />);
      await Promise.resolve();
    });
    pull = refractionRenderer.root.findAllByType(OdosSelect).find((item) => item.props.ariaLabel === "Pull values into refraction 1");
    assert.equal(pull?.props.options.some((option: { label: string }) => option.label.startsWith("Prior visit Final/Rx")), false);
    refractionRenderer.unmount();
    refractionRenderer = undefined;

    await act(async () => {
      softClRenderer = create(<SoftContactLensSection patientReference="Patient/one" encounterReference={CURRENT_ENCOUNTER} onSaved={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    let clPull = softClRenderer.root.findAllByType(OdosSelect).find((item) => item.props.ariaLabel === "Pull contact lens values from");
    assert.ok(clPull?.props.options.some((option: { label: string }) => option.label.startsWith("Prior contact lens Rx")));
    await act(async () => {
      softClRenderer!.update(<SoftContactLensSection patientReference="Patient/two" encounterReference={CURRENT_ENCOUNTER} onSaved={() => undefined} />);
      await Promise.resolve();
    });
    clPull = softClRenderer.root.findAllByType(OdosSelect).find((item) => item.props.ariaLabel === "Pull contact lens values from");
    assert.equal(clPull?.props.options.some((option: { label: string }) => option.label.startsWith("Prior contact lens Rx")), false);
  } finally {
    refractionRenderer?.unmount();
    softClRenderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

function refractionBlock(
  id: string,
  type: string,
  overrides: Partial<ReturnType<typeof refractionBlockBase>> & {
    OD?: Partial<ReturnType<typeof refractionEye>>;
    OS?: Partial<ReturnType<typeof refractionEye>>;
  } = {},
) {
  const base = refractionBlockBase(id, type);
  return {
    ...base,
    ...overrides,
    OD: { ...base.OD, ...overrides.OD },
    OS: { ...base.OS, ...overrides.OS },
  };
}

function refractionBlockBase(id: string, type: string) {
  return { id, type, purpose: "", remarks: "", OD: refractionEye(), OS: refractionEye() };
}

function refractionEye() {
  return {
    sphere: "",
    cylinder: "",
    axis: "",
    add: "",
    distanceVisualAcuity: "",
    nearVisualAcuity: "",
    distancePinholeVisualAcuity: "",
  };
}

function glassesRow(
  typeCode: string,
  eye: "OD" | "OS",
  date: string,
  encounterReference: string,
  values: Record<string, number>,
  groupId?: string,
) {
  return {
    type: typeCode === "WEARING_RX" ? "Wearing" : typeCode === "AUTO_REFRACTION" ? "Auto-refraction" : "Final/Rx",
    typeCode,
    eye,
    date,
    encounterReference,
    ...(groupId ? { groupId } : {}),
    ...values,
  };
}

function softClRow(
  eye: "OD" | "OS",
  date: string,
  encounterReference: string,
  status: string,
  values: Record<string, string | number>,
  groupId?: string,
) {
  return { eye, date, encounterReference, status, ...(groupId ? { groupId } : {}), ...values };
}

function softClEye(overrides: Record<string, string> = {}) {
  return {
    underlyingCondition: "",
    manufacturer: "",
    product: "",
    baseCurve: "",
    diameter: "",
    sphere: "",
    cylinder: "",
    axis: "",
    add: "",
    colorMfPower: "",
    distanceVisualAcuity: "",
    nearVisualAcuity: "",
    distancePinholeVisualAcuity: "",
    startDate: "",
    expirationDate: "",
    other: "",
    manualEntry: false,
    overRefraction: { sphere: "", cylinder: "", axis: "", distanceVisualAcuity: "", nearVisualAcuity: "" },
    ...overrides,
  };
}

function refractionDefinition() {
  return {
    definition: {
      fields: {
        type: { options: [
          { code: "MANIFEST", display: "Manifest", active: true },
          { code: "FINAL_RX", display: "Final/Rx", active: true },
        ] },
        sourceType: { options: [{ code: "manual", display: "Manual", active: true }] },
        sphere: { minimum: -20, maximum: 20, step: 0.25 },
        axis: { minimum: 0, maximum: 180, step: 1 },
      },
    },
    diagnosisOptions: [],
    refractiveThreshold: 0.75,
  };
}

function softClDefinition() {
  return {
    definition: {
      fields: {
        status: { options: [
          { code: "order_trial", display: "Order Trial", active: true },
          { code: "dispensed_successful", display: "Dispensed Successful", active: true },
        ] },
        manufacturer: { options: [{ code: "alcon", display: "Alcon Laboratories Inc", active: true }] },
        product: { options: [{
          code: "precision7",
          display: "Precision7",
          active: true,
          manufacturerCode: "alcon",
          baseCurveOptions: [{ code: "8.4", display: "8.4", active: true }],
          diameterOptions: [{ code: "14.2", display: "14.2", active: true }],
        }] },
      },
    },
  };
}
