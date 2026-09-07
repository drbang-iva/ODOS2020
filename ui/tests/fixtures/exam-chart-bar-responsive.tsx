import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { ExamChartBar } from "../../src/components/charting/EncounterHeader";
import {
  ExamOverviewBoard,
  type ClinicalExamCompleteness,
  type ExamOverviewProjection,
} from "../../src/components/charting/ExamOverviewBoard";
import type { VisitChargeResponse } from "../../src/lib/clinical-graph-client";
import "../../src/styles/globals.css";
import "../../src/styles/charting.css";

interface ResponsiveChartBarProps {
  patientName: string;
  patientDetail: string;
  completeness: ClinicalExamCompleteness;
  unassignedCount: number;
  visitCharge?: VisitChargeResponse;
  visitControlsOpen: boolean;
  onToggleVisitControls: () => void;
  onBlackout: () => void;
  requestFinishEncounter: () => void;
  signDisabled: boolean;
  signLabel: string;
}

const ResponsiveChartBar = ExamChartBar as unknown as (
  props: ResponsiveChartBarProps,
) => React.ReactNode;

const completeness: ClinicalExamCompleteness = {
  status: "incomplete",
  requiredSectionCount: 12,
  resolvedSectionCount: 8,
  trace: [],
  documentationIssues: [],
};

function Fixture() {
  const search = new URLSearchParams(window.location.search);
  const worstCase = search.has("worst");
  if (search.has("board")) {
    return (
      <div className="min-h-screen p-8">
        <ExamOverviewBoard
          projection={boardProjection}
          editorEntries={[]}
          refreshing={false}
          onOpenEditor={() => undefined}
          onRefresh={() => undefined}
        />
      </div>
    );
  }
  const visitCharge: VisitChargeResponse | undefined = worstCase ? {
    options: [{
      procedureConceptKey: "long-visit",
      display: "Comprehensive established patient visit with an intentionally long label",
    }],
    diagnoses: [],
    selectedProcedureConceptKey: "long-visit",
    proposal: {
      id: "responsive-proof",
      procedureConceptKey: "long-visit",
      dxPointers: [],
      state: "accepted",
    },
  } : undefined;

  useLayoutEffect(() => {
    if (!worstCase) return;
    const draftSlot = document.querySelector<HTMLElement>('[data-chart-bar-slot="drafts"]');
    if (draftSlot) {
      draftSlot.textContent = "99999 drafts";
      draftSlot.removeAttribute("aria-hidden");
    }
  }, [worstCase]);

  return (
    <ResponsiveChartBar
      patientName={worstCase ? "Alexandria Montgomery-Smith" : "Alex Morgan"}
      patientDetail={worstCase ? "DOB 01/23/1975 · 51y · they/them" : "DOB 01/23/1975 · 51y"}
      completeness={completeness}
      unassignedCount={worstCase ? 88888 : 0}
      visitCharge={visitCharge}
      visitControlsOpen={false}
      onToggleVisitControls={() => undefined}
      onBlackout={() => undefined}
      requestFinishEncounter={() => undefined}
      signDisabled={false}
      signLabel="Sign encounter"
    />
  );
}

const boardProjection = {
  encounterReference: "Encounter/synthetic-browser-proof",
  patientReference: "Patient/synthetic-browser-proof",
  visitTypeCategoryId: "exams",
  findings: [
    finding("eom-od", "entrance:eom", "entrance", "EOM", "OD", "normal"),
    finding("eom-os", "entrance:eom", "entrance", "EOM", "OS", "normal"),
    finding("pachy-od", "pachymetry_um", "entrance", "Pachymetry", "OD", "normal", {
      components: [quantityComponent("CUSTOM_CCT", "Central corneal thickness", 541, "um")],
    }),
    finding("pachy-os", "pachymetry_um", "entrance", "Pachymetry", "OS", "normal", {
      components: [quantityComponent("CUSTOM_CCT", "Central corneal thickness", 538, "um")],
    }),
    {
      ...finding("dilation", "entrance:dilation", "entrance", "Dilation", "OU", "unknown"),
      event: {
        administrations: [
          { agent: "tropicamide 1%", occurredAt: "2026-08-24T14:42:00.000Z" },
          { agent: "phenylephrine 2.5%", occurredAt: "2026-08-24T14:42:00.000Z" },
        ],
      },
    },
    {
      ...finding("cvf-od", "entrance:cvf", "entrance", "Confrontation fields", "OD", "abnormal", {
        components: [
          stringComponent("CUSTOM_CVF_UPPER_LEFT", "Upper left", "restricted"),
          stringComponent("CUSTOM_CVF_UPPER_RIGHT", "Upper right", "full"),
          stringComponent("CUSTOM_CVF_LOWER_LEFT", "Lower left", "full"),
          stringComponent("CUSTOM_CVF_LOWER_RIGHT", "Lower right", "full"),
        ],
      }),
      diagnoses: [{ display: "Visual field defect", laterality: "OD" }],
      attestation: { attestedBy: ["Dr. Avery Chen"], recordedAt: "2026-08-24T14:43:00.000Z" },
    },
    finding("cvf-os", "entrance:cvf", "entrance", "Confrontation fields", "OS", "normal"),
    deferredFinding("dilation-deferred", "entrance:dilation-deferred", "entrance", "Dilation", "patient driving"),
    refractionFinding("cycloplegic-od", "OD", -1, -0.5, 180, "20/20"),
    refractionFinding("cycloplegic-os", "OS", -1.25, undefined, undefined, "20/20"),
  ],
  sections: [
    section("entrance", "Entrance", [
      "eom-od", "eom-os", "pachy-od", "pachy-os", "dilation", "cvf-od", "cvf-os", "dilation-deferred",
    ]),
    section("refraction", "Refraction", ["cycloplegic-od", "cycloplegic-os"]),
  ],
  completeness,
} as ExamOverviewProjection;

function finding(
  id: string,
  findingKey: string,
  sectionKey: string,
  display: string,
  laterality: "OD" | "OS" | "OU",
  interpretation: "normal" | "abnormal" | "unknown",
  current: { components: Array<Record<string, unknown>> } = { components: [] },
) {
  return {
    observationReference: `Observation/${id}`,
    findingKey,
    sectionKey,
    display,
    laterality,
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation,
    provenance: { state: "current" },
    current: { recordedAt: "2026-08-24T14:43:00.000Z", ...current },
  };
}

function deferredFinding(id: string, findingKey: string, sectionKey: string, display: string, reason: string) {
  return {
    ...finding(id, findingKey, sectionKey, display, "OU", "unknown"),
    examination: { state: "deferred-with-reason", reason, sourceEncoding: "exam-state" },
  };
}

function refractionFinding(
  id: string,
  laterality: "OD" | "OS",
  sphere: number,
  cylinder: number | undefined,
  axis: number | undefined,
  distanceVisualAcuity: string,
) {
  return finding(id, "refraction", "refraction", "Refraction", laterality, "normal", {
    components: [
      { code: "REFRACTION_TYPE", display: "Refraction type", value: { kind: "code", code: "CYCLOPLEGIC", display: "Cycloplegic" } },
      { code: "REFRACTION_BLOCK_ID", display: "Refraction block ID", value: { kind: "string", value: "synthetic-cycloplegic-block" } },
      quantityComponent("SPHERE", "Sphere", sphere, "D"),
      ...(cylinder === undefined ? [] : [quantityComponent("CYLINDER", "Cylinder", cylinder, "D")]),
      ...(axis === undefined ? [] : [quantityComponent("AXIS", "Axis", axis, "degrees")]),
      stringComponent("DISTANCE_VA", "Distance visual acuity", distanceVisualAcuity),
    ],
  });
}

function quantityComponent(code: string, display: string, value: number, unit: string) {
  return { code, display, value: { kind: "quantity", value, unit } };
}

function stringComponent(code: string, display: string, value: string) {
  return { code, display, value: { kind: "string", value } };
}

function section(sectionKey: string, label: string, observationIds: string[]) {
  return {
    sectionKey,
    label,
    state: "examined",
    findingObservationReferences: observationIds.map((id) => `Observation/${id}`),
    abnormalCount: 0,
    carriedUnreassertedCount: 0,
    deferredWithoutReasonCount: 0,
  };
}

createRoot(document.getElementById("root")!).render(<Fixture />);
