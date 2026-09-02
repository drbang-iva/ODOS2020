// Dev-only harness for the §6 before/after demonstration. Lives in docs/build-log as evidence; copy to
// ui/dev-harness/ to run (the base checkout gets the same file with the ConfirmDestructiveProvider lines removed). Renders the real
// components with the real stylesheet; every network call is answered in-page, so no server,
// no login, no PHI. Query: ?surface=pupils|iop|va|arx&signed=1
import React from "react";
import ReactDOM from "react-dom/client";
import "../src/styles/globals.css";
import { EncounterEditContext } from "../src/components/charting/encounter-edit-context";
/*AFTER*/ import { ConfirmDestructiveProvider } from "../src/components/charting/ConfirmDestructive";
import { ExamEntrySheet } from "../src/components/charting/ExamEntrySheet";
import { EntranceStateSection } from "../src/components/charting/EntranceStateSection";
import { IopSection } from "../src/components/charting/IopSection";
import { VaSection } from "../src/components/charting/VaSection";
import { AutoRefractionSection } from "../src/components/charting/AutoRefractionSection";

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "pupils";
const status = params.get("signed") === "1" ? "finished" : "in-progress";
const ENCOUNTER = "Encounter/harness";

const PUPILS = {
  stableKey: "entrance:pupils", sectionKey: "entrance:pupils", display: "Pupils", active: true, perEye: true,
  normalTemplate: "PERRLA; no RAPD OU", allowDeferred: true,
  customFields: [
    { localCode: "CUSTOM_PUPIL_SIZE_BRIGHT", display: "Size — bright", valueType: "number" as const, min: 1, max: 9, step: 0.5, unit: "mm", order: 0, active: true },
    { localCode: "CUSTOM_PUPIL_SIZE_NEAR", display: "Size — near", valueType: "number" as const, min: 1, max: 9, step: 0.5, unit: "mm", order: 1, active: true },
  ],
};
const PUPILS_ROWS = [
  { recordedAt: "2026-09-02T09:00:00.000Z", eye: "OD", state: "abnormal", values: [{ label: "Size — bright", value: 4, unit: "mm" }, { label: "Size — near", value: 3, unit: "mm" }], other: "sluggish to light", observationReference: "Observation/p-od" },
  { recordedAt: "2026-09-02T09:00:00.000Z", eye: "OS", state: "normal", values: [], normalTemplate: "PERRLA; no RAPD OU", observationReference: "Observation/p-os" },
];
const ENTRIES: Record<string, Array<{ reference: string; sectionKey: string; findingKey: string; laterality: string }>> = {
  tonometry: [
    { reference: "Observation/iop-od", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OD" },
    { reference: "Observation/iop-os", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OS" },
  ],
  va: [
    { reference: "Observation/va-od", sectionKey: "va", findingKey: "VISUAL_ACUITY", laterality: "OD" },
    { reference: "Observation/va-os", sectionKey: "va", findingKey: "VISUAL_ACUITY", laterality: "OS" },
  ],
  "auto-refraction": [
    { reference: "Observation/ar-od", sectionKey: "auto-refraction", findingKey: "auto_refraction", laterality: "OD" },
    { reference: "Observation/ak-od", sectionKey: "auto-refraction", findingKey: "auto_keratometry", laterality: "OD" },
    { reference: "Observation/ar-os", sectionKey: "auto-refraction", findingKey: "auto_refraction", laterality: "OS" },
    { reference: "Observation/ak-os", sectionKey: "auto-refraction", findingKey: "auto_keratometry", laterality: "OS" },
    { reference: "Observation/pd", sectionKey: "auto-refraction", findingKey: "binocular_pd", laterality: "OU" },
  ],
};

window.fetch = async (input, init) => {
  const url = String(input);
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  if (path.includes("/clinical-graph/custom/entrance%3Apupils/history")) return Response.json({ rows: PUPILS_ROWS });
  if (path.endsWith("/clinical-graph/iop/definition")) return Response.json({ definitions: { intraocularPressure: { fields: { method: { options: [{ code: "GAT", display: "Goldmann", active: true }] } } }, cornealHysteresis: { fields: {} } } });
  if (path.includes("/clinical-graph/iop/history")) return Response.json({ readings: [], cornealHysteresis: [], perEye: { OD: { average: null, tMax: null, count: 0, target: null }, OS: { average: null, tMax: null, count: 0, target: null } }, threshold: 21 });
  if (path.endsWith("/clinical-graph/auto-refraction/definition")) return Response.json({ definitions: { autoRefraction: { fields: { sourceType: { options: [{ code: "manual", display: "Manual", active: true }] } } }, autoKeratometry: { fields: {} } } });
  if (path.includes("/clinical-graph/auto-refraction/history")) return Response.json({
    eyes: {
      OD: { sphere: -1.25, cylinder: -0.5, axis: 90, flatK: 42.5, flatAxis: 180, steepK: 43.25, steepAxis: 90, observationReferences: ["Observation/ar-od", "Observation/ak-od"] },
      OS: { sphere: -1, cylinder: -0.25, axis: 85, flatK: 42.75, flatAxis: 5, steepK: 43.5, steepAxis: 95, observationReferences: ["Observation/ar-os", "Observation/ak-os"] },
    },
    binocularPdDistance: 63.5, binocularPdNear: 60.25, binocularPdObservationReferences: ["Observation/pd"], remarks: "",
  });
  if (path.endsWith("/void") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { scope: string; sectionKey?: string; preview?: boolean; observationReference?: string | string[] };
    if (body.preview) {
      const entries = body.scope === "section" && body.sectionKey ? (ENTRIES[body.sectionKey] ?? []) : [];
      const count = body.scope === "encounter" ? 11 : body.scope === "section" ? (body.sectionKey === "entrance:pupils" ? PUPILS_ROWS.length : entries.length) : 1;
      const sections = body.scope === "encounter"
        ? [{ sectionKey: "entrance:pupils", label: "Pupils", count: 2 }, { sectionKey: "tonometry", label: "IOP", count: 2 }, { sectionKey: "va", label: "Visual acuity", count: 2 }, { sectionKey: "auto-refraction", label: "Auto-refraction / Auto-K", count: 5 }]
        : [];
      return Response.json({ voided: [], count, sections, preview: true, entries });
    }
    // The harness never voids: answer like a server that refused, so nothing on screen changes.
    return Response.json({ error: "harness: void disabled", code: "harness" }, { status: 409 });
  }
  console.warn("harness: unstubbed request", path);
  return Response.json({}, { status: 404 });
};

function alertRgb(): string {
  const probe = document.createElement("span");
  probe.style.color = "var(--odos-alert)";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}

(window as unknown as { __alertCount: () => { alert: string; count: number; elements: string[] } }).__alertCount = () => {
  const alert = alertRgb();
  const hits: string[] = [];
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    if (element.getClientRects().length === 0) continue;
    const style = getComputedStyle(element);
    const props = [style.color, style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor, style.backgroundColor];
    if (props.includes(alert)) hits.push(`${element.tagName.toLowerCase()}${element.className ? "." + String(element.className).split(" ").slice(0, 3).join(".") : ""}${element.textContent ? " '" + element.textContent.trim().slice(0, 30) + "'" : ""}`);
  }
  return { alert, count: hits.length, elements: hits };
};

function Surface() {
  if (surface === "arx") return <AutoRefractionSection patientReference="Patient/harness" encounterReference={ENCOUNTER} onSaved={() => undefined} />;
  const child = surface === "iop"
    ? <IopSection patientReference="Patient/harness" encounterReference={ENCOUNTER} onSaved={() => undefined} />
    : surface === "va"
      ? <VaSection patientReference="Patient/harness" encounterReference={ENCOUNTER} onSaved={() => undefined} />
      : <EntranceStateSection definition={PUPILS} patientReference="Patient/harness" encounterReference={ENCOUNTER} onSaved={() => undefined} />;
  return (
    <ExamEntrySheet sectionId={surface as "pupils" | "iop" | "va"} onCancel={() => undefined} encounterReference={ENCOUNTER} encounterStatus={status} onEncounterCleared={() => undefined}>
      {child}
    </ExamEntrySheet>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <EncounterEditContext.Provider value={{ encounterStatus: status }}>
    {/*AFTER-OPEN*/}<ConfirmDestructiveProvider>
    <div className="odos-charting-workspace bg-bg-deep text-white" style={{ position: "relative", width: 1440, height: 1000, overflow: "hidden" }}>
      <main className="relative h-full w-full">
        <Surface />
      </main>
    </div>
    {/*AFTER-CLOSE*/}</ConfirmDestructiveProvider>
  </EncounterEditContext.Provider>,
);
