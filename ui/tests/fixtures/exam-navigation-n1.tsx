import React from "react";
import { createRoot } from "react-dom/client";
import type { Encounter, Patient } from "@medplum/fhirtypes";
import type { StartExamApi } from "../../src/components/StartExam";
import { RoleProvider } from "../../src/lib/role-context";
import { fhir } from "../../src/lib/fhir";
import type { ExamOverviewProjection } from "../../src/components/charting/ExamOverviewBoard";
import "../../src/styles/globals.css";

declare global { interface Window { n1: { storage: string[]; finishCalls: number; completenessReads: number; scrolls: string[] } } }
window.n1 = { storage: [], finishCalls: 0, completenessReads: 0, scrolls: [] };
localStorage.setItem("odos:encounter-chart-view", "diagnosis");
for (const method of ["getItem", "setItem"] as const) {
  const original = Storage.prototype[method];
  Storage.prototype[method] = function(key: string, value?: string) {
    window.n1.storage.push(`${method}:${key}`);
    return original.call(this, key, value!);
  } as typeof original;
}
const scrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = function(options) { window.n1.scrolls.push(this.id); scrollIntoView.call(this, options); };
const params = new URLSearchParams(location.search);
const patient: Patient = { resourceType: "Patient", id: "n1-patient", name: [{ given: ["Synthetic"], family: "Navigation" }] };
const encounter: Encounter = { resourceType: "Encounter", id: "n1-encounter", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/n1-patient" }, meta: { versionId: "1" } };
const labels = ["History", "Entrance", "Refraction", "Pretest", "Ocular Health", "Assessment"];
const keys = ["history", "entrance", "refraction", "pretest", "ocular-health", "assessment"];
const projection: ExamOverviewProjection = {
  patientReference: "Patient/n1-patient", encounterReference: "Encounter/n1-encounter", examScope: "comprehensive", findings: [],
  sections: keys.map((sectionKey, i) => ({ sectionKey, label: labels[i], state: i === 0 ? "partial" : "not-examined", findingObservationReferences: [], abnormalCount: 0, carriedUnreassertedCount: 0, deferredWithoutReasonCount: 0 })),
  completeness: { status: "incomplete", requiredSectionCount: 6, resolvedSectionCount: 0, documentationIssues: [],
    trace: keys.map((sectionKey, i) => ({ sectionKey, label: labels[i], state: i === 0 ? "partial" : "not-examined", resolved: false, carriedUnreassertedCount: 0 })) },
};
if (params.has("complete")) {
  projection.completeness.trace = projection.completeness.trace.map(row => ({ ...row, state: "examined", resolved: true }));
  projection.completeness.resolvedSectionCount = 6;
  projection.completeness.status = "complete";
}
const bundle = { resourceType: "Bundle", type: "searchset", entry: [] };
fhir.read = (async (type: string) => type === "Encounter" ? encounter : type === "Patient" ? patient : { resourceType: type, id: "synthetic" }) as typeof fhir.read;
fhir.executeTransaction = (async () => { window.n1.finishCalls++; return { resourceType: "Bundle", type: "transaction-response", entry: [{ response: { status: "200 OK" } }, { response: { status: "201 Created" } }] }; }) as typeof fhir.executeTransaction;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/exam-overview")) return json(projection);
  if (url.endsWith("/exam-view-state")) return json({ collapsed: [], shelved: [] });
  if (url.endsWith("/exam-scope")) return json({ examScope: "comprehensive", canWrite: false });
  if (url.endsWith("/void/ledger")) return json({ ledger: { encounterId: "n1-encounter", encounter: null, sections: {} }, canWriteDiagnosis: false });
  if (url.endsWith("/diagnosis-completeness")) { window.n1.completenessReads++; return json({ diagnoses: [{ conditionReference: "Condition/synthetic", display: "Synthetic diagnosis", missing: [{ display: "Synthetic finding" }] }] }); }
  if (url.includes("finding-section-groups")) return json({ canWrite: false, canPullIn: false, groups: [], overrideGroupKeys: [], effectiveGroupKeys: [] });
  if (url.includes("finding-definitions") || url.includes("procedure-definitions")) return json({ canWrite: false, definitions: [] });
  if (url.includes("eye-growth/visibility")) return json({ defaultVisible: false });
  if (url.includes("/diagnosis-quick-list")) return json({ canWrite: false, pinnedDiagnosisKeys: [], diagnoses: [], catalog: [] });
  if (url.endsWith("/findings")) return json({ encounterEditable: true, canWrite: false, canWriteDiagnosis: false, findings: [], catalog: [], searchIndex: [], auditDebt: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
  if (url.endsWith("/diagnosis-candidates")) return json({ findings: [] });
  if (url.endsWith("/previous-exams")) return json({ pageSize: 4, encounters: [] });
  if (url.endsWith("/follow-up-queue")) return json({ state: "not-recorded", rows: [] });
  if (url.includes("/longitudinal-imaging") || url.includes("/clinical-graph/imaging")) return json({ images: [] });
  if (url.endsWith("/hpi/definition")) return json({ definition: { fields: {} }, templates: [{ complaint: "glaucoma", label: "Glaucoma", presentations: "presentations", sections: [{ id: "additional-history", type: "text", label: "Additional history" }], narrative: "{presentation}" }], catalogs: { presentations: [{ code: "follow-up", display: "Follow Up" }] } });
  if (url.endsWith("/complaints")) return json({ complaints: [{ id: "c1", templateKey: "glaucoma", ordinal: 1, status: "active", renderedNarrative: "Synthetic complaint" }] });
  if (url.endsWith("/encounters/n1-encounter/hpi")) return json({ answers: [{ id: "presentation-1", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "follow-up" } }], followUpPrefills: [], templateNarratives: [] });
  if (url.endsWith("/hpi") && init?.method === "POST") { await new Promise(resolve => setTimeout(resolve, 30_000)); return json({ answers: [] }); }
  if (url.includes("/procedure-charges")) return json({ options: [], diagnoses: [], proposals: [], attachedProcedures: [] });
  if (url.endsWith("/visit-charge")) return json({ options: [], diagnoses: [], proposals: [], attachedProcedures: [] });
  return json(bundle);
};
const startApi: StartExamApi = {
  loadPrograms: async () => [], assignProvider: async () => {}, createProgram: async () => { throw Error("Not used"); }, now: () => new Date("2026-09-26T12:00:00Z"),
  executeTransaction: async () => ({ resourceType: "Bundle", type: "transaction-response", entry: [{ response: { status: "201 Created", location: "Encounter/n1-encounter/_history/1" } }, { response: { status: "201 Created" } }] }),
};
const { EncounterCharting } = await import("../../src/scenes/EncounterCharting");
const { StartExam } = await import("../../src/components/StartExam");
createRoot(document.getElementById("root")!).render(<RoleProvider initialRole={params.get("role") === "tech" ? "tech" : "doctor"}>
  {params.has("start") ? <StartExam patient={patient} api={startApi} /> : <EncounterCharting patient={patient} encounterId="n1-encounter" />}
</RoleProvider>);
