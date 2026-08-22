import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AssessmentSection } from "../../src/components/charting/AssessmentSection";
import { AutoRefractionSection } from "../../src/components/charting/AutoRefractionSection";
import { CoverTestSection } from "../../src/components/charting/CoverTestSection";
import { CupDiscSection } from "../../src/components/charting/CupDiscSection";
import type { CustomFindingDefinition } from "../../src/components/charting/CustomFindingSection";
import { CvfSection } from "../../src/components/charting/CvfSection";
import { DilationSection } from "../../src/components/charting/DilationSection";
import { DryEyeSection } from "../../src/components/charting/DryEyeSection";
import { EntranceMeasurementSection } from "../../src/components/charting/EntranceMeasurementSection";
import { EntranceStateSection } from "../../src/components/charting/EntranceStateSection";
import { EomSection } from "../../src/components/charting/EomSection";
import { ExamEntrySheet, isExamEntrySheetSectionId } from "../../src/components/charting/ExamEntrySheet";
import { ExamOverviewBoard, type ExamOverviewProjection } from "../../src/components/charting/ExamOverviewBoard";
import { EyeGrowthSection } from "../../src/components/charting/EyeGrowthSection";
import { GonioscopySection } from "../../src/components/charting/GonioscopySection";
import { HpiSection } from "../../src/components/charting/HpiSection";
import { ImagingSection } from "../../src/components/charting/ImagingSection";
import { IopSection } from "../../src/components/charting/IopSection";
import { MyopiaManagementSection } from "../../src/components/charting/MyopiaManagementSection";
import { OrthoKSection } from "../../src/components/charting/OrthoKSection";
import { PrescriptionSection } from "../../src/components/charting/PrescriptionSection";
import { RefractionSection } from "../../src/components/charting/RefractionSection";
import { SoftContactLensSection } from "../../src/components/charting/SoftContactLensSection";
import { SpecialtyContactLensSection } from "../../src/components/charting/SpecialtyContactLensSection";
import { VaSection } from "../../src/components/charting/VaSection";
import { WearingSection } from "../../src/components/charting/WearingSection";
import { PretestVitalsSection } from "../../src/components/charting/PretestVitalsSection";
import { VisitChargesSheetContent } from "../../src/components/charting/VisitChargesSheet";
import { chartEditorInventory } from "../../src/components/charting/SpineNav";
import type { ProcedureChargeApi, VisitChargeApi } from "../../src/lib/clinical-graph-client";
import { fhir } from "../../src/lib/fhir";
import { RoleProvider } from "../../src/lib/role-context";
import "../../src/styles/globals.css";

const FIXTURE_SECTIONS = [
  "hpi", "wearing", "auto-refraction", "pretest-vitals", "manual-keratometry", "pachymetry", "va",
  "pupils", "stereopsis", "color-vision", "eom", "cvf", "cover-test", "iop",
  "dilation", "refraction", "eye-growth", "soft-contact-lens",
  "specialty-contact-lens", "ortho-k", "myopia-management", "cup-disc",
  "gonioscopy", "dry-eye", "imaging", "assessment", "prescription",
  "visit-charges",
] as const;

export type FixtureSectionId = typeof FIXTURE_SECTIONS[number];

const DEFERRED_SECTIONS = new Set<FixtureSectionId>([
  "wearing", "auto-refraction", "pretest-vitals", "refraction", "soft-contact-lens", "specialty-contact-lens",
]);

const FIXTURE_PROJECTION: ExamOverviewProjection = {
  encounterReference: "Encounter/test",
  patientReference: "Patient/test",
  findings: [],
  sections: [
    { sectionKey: "history", label: "History", state: "not-examined", findingObservationReferences: [], abnormalCount: 0, carriedUnreassertedCount: 0, deferredWithoutReasonCount: 0 },
    { sectionKey: "pretest", label: "Pretest", state: "not-examined", findingObservationReferences: [], abnormalCount: 0, carriedUnreassertedCount: 0, deferredWithoutReasonCount: 0 },
    { sectionKey: "assessment", label: "Assessment", state: "not-examined", findingObservationReferences: [], abnormalCount: 0, carriedUnreassertedCount: 0, deferredWithoutReasonCount: 0 },
  ],
  completeness: { status: "unconfigured", requiredSectionCount: 0, resolvedSectionCount: 0, trace: [], documentationIssues: [] },
};

window.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/clinical-graph/refraction/definition")) {
    return Response.json({
      definition: {
        fields: {
          type: { options: [{ code: "MANIFEST", display: "Manifest" }] },
          sourceType: { options: [{ code: "manual", display: "Manual" }] },
          sphere: { minimum: -20, maximum: 20, step: 0.25 },
          axis: { minimum: 0, maximum: 180, step: 1 },
        },
      },
      diagnosisOptions: [],
      refractiveThreshold: 0,
    });
  }
  if (url.includes("/clinical-graph/refraction/history")) return Response.json({ glasses: [], softCl: [], specialtyCl: [] });
  if (url.endsWith("/clinical-graph/iop/definition")) {
    return Response.json({
      definitions: {
        intraocularPressure: { fields: { value: { minimum: 3, maximum: 80, step: 1 }, method: { options: [{ code: "GAT", display: "GAT", active: true }] }, date: {}, timeOfDay: {} } },
        cornealHysteresis: { fields: { value: { minimum: 0, maximum: 15, step: 0.1 } } },
      },
    });
  }
  if (url.includes("/clinical-graph/iop/history")) {
    return Response.json({
      readings: [],
      cornealHysteresis: [],
      perEye: {
        OD: { average: null, tMax: null, count: 0, target: null },
        OS: { average: null, tMax: null, count: 0, target: null },
      },
      threshold: 22,
    });
  }
  if (url.endsWith("/clinical-graph/glaucoma/cup-disc/definition")) {
    return Response.json({ definition: { fields: { verticalCupDiscRatio: { minimum: 0, maximum: 1, step: 0.05 }, horizontalCupDiscRatio: { minimum: 0, maximum: 1, step: 0.05 } } } });
  }
  if (url.endsWith("/clinical-graph/wearing/definition")) {
    return Response.json({ definition: { fields: { eyeglassType: { options: [] }, sourceType: { options: [] } } } });
  }
  if (url.endsWith("/clinical-graph/auto-refraction/definition")) {
    return Response.json({ definitions: { autoRefraction: { fields: {} }, autoKeratometry: { fields: {} } } });
  }
  if (url.endsWith("/clinical-graph/contact-lens/soft/definition")) {
    return Response.json({ definition: { fields: {} } });
  }
  if (url.endsWith("/clinical-graph/contact-lens/specialty/definition")) {
    return Response.json({ definition: { fields: {} }, canManageFields: false });
  }
  if (url.includes("/clinical-graph/contact-lens/keratometry")) {
    return Response.json({ eyes: { OD: null, OS: null } });
  }
  if (url.endsWith("/clinical-graph/hpi/definition")) return Response.json({ definition: {} });
  if (url.endsWith("/clinical-graph/complaint-definitions")) return Response.json({ definitions: [], genericOptions: { conditions: [], qualities: [], treatments: [] } });
  if (url.includes("/complaints")) return Response.json({ complaints: [] });
  if (url.endsWith("/clinical-graph/diagnosis-catalog")) return Response.json({ diagnoses: [] });
  if (url.includes("/clinical-graph/protocols/")) return Response.json({ applications: [], offers: [] });
  if (url.includes("/clinical-graph/eye-growth/history")) return Response.json({ rows: [] });
  if (url.includes("/clinical-graph/imaging?")) return Response.json({ images: [] });
  if (url.includes("/clinical-graph/dilation/history")) return Response.json({ notes: [], administrations: [] });
  if (url.includes("/clinical-graph/custom/") && url.includes("/history")) return Response.json({ rows: [] });
  if (url.includes("/history")) return Response.json({ rows: [] });
  if (url.includes("/fhir/R4/")) return Response.json({ resourceType: "Bundle", type: "searchset", total: 0, entry: [] });
  if (url.endsWith("/commercial-engine/patients/test/packages")) return Response.json({ packages: [] });
  if (url.endsWith("/commercial-engine/patients/test/credit-bank")) {
    return Response.json({ creditBank: { patientFhirId: "test", balanceCents: 2500, ledger: [{ id: "credit-1", entryType: "deposit", amountCents: 2500, actorUserId: "synthetic", createdAt: "2026-08-17T12:00:00Z" }] } });
  }
  if (url.endsWith("/desk/whoami")) return Response.json({ roles: ["provider"] });
  return Response.json({});
};

fhir.authHeader = () => "Bearer synthetic-entry-sheet";

function Fixture() {
  const params = new URLSearchParams(window.location.search);
  const initialSection = params.get("section");
  const [active, setActive] = useState<FixtureSectionId | undefined>(isFixtureSectionId(initialSection) ? initialSection : undefined);
  const forceSheet = params.get("audit") === "sheet";
  const mapped = active ? isExamEntrySheetSectionId(active) : false;
  const sheetOpen = Boolean(active && (mapped || forceSheet));
  const editor = active ? renderEditor(active) : null;
  const showReturnButton = params.get("returnButton") === "true";

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-bg-deep text-white">
      <div className="flex min-h-14 flex-wrap items-center gap-3 border-b border-white/10 px-4" data-testid="fixture-exam-context">
        {(forceSheet && active ? [active] : FIXTURE_SECTIONS).map((sectionId) => (
          <button key={sectionId} type="button" onClick={() => setActive(sectionId)}>
            Open {sectionLabel(sectionId)}
          </button>
        ))}
      </div>
      {active && !sheetOpen ? (
        <div className="h-[calc(100vh-56px)]" data-testid="fixture-full-page-editor" data-fixture-section={active}>
          {editor}
        </div>
      ) : (
        <div className="odos-exam-overview-stage" data-entry-sheet-open={sheetOpen ? "true" : "false"}>
          <section className="min-h-0 overflow-hidden border-r border-white/10" data-testid="fixture-exam-column">
            {showReturnButton && (
              <div className="odos-exam-editor-return">
                <button type="button" data-testid="return-to-exam-overview" className="odos-exam-editor-return-button">
                  Back to exam overview
                </button>
              </div>
            )}
            <ExamOverviewBoard
              projection={FIXTURE_PROJECTION}
              editorEntries={chartEditorInventory()}
              activeEditorId={mapped ? active : undefined}
              refreshing={false}
              onOpenEditor={(sectionId) => isFixtureSectionId(sectionId) && setActive(sectionId)}
              onRefresh={() => undefined}
            />
          </section>
          {active && sheetOpen && (
            <ExamEntrySheet sectionId={active === "visit-charges" ? "visit-charges" : mapped ? active : "va"} onCancel={() => setActive(undefined)}>
              <div
                data-fixture-section={active}
                data-fixture-route={DEFERRED_SECTIONS.has(active) ? "deferred" : "candidate"}
                style={active === "va" ? { minWidth: "max-content" } : undefined}
              >
                {editor}
              </div>
            </ExamEntrySheet>
          )}
        </div>
      )}
    </main>
  );
}

function renderEditor(sectionId: FixtureSectionId): React.ReactNode {
  const props = { patientReference: "Patient/test", encounterReference: "Encounter/test", onSaved: () => undefined };
  switch (sectionId) {
    case "hpi": return <HpiSection {...props} />;
    case "wearing": return <WearingSection {...props} />;
    case "auto-refraction": return <AutoRefractionSection {...props} />;
    case "pretest-vitals": return <PretestVitalsSection {...props} />;
    case "manual-keratometry": return <EntranceMeasurementSection definition={manualKeratometryDefinition()} {...props} />;
    case "pachymetry": return <EntranceMeasurementSection definition={pachymetryDefinition()} {...props} />;
    case "va": return <VaSection {...props} />;
    case "pupils": return <EntranceStateSection definition={pupilsDefinition()} {...props} />;
    case "stereopsis": return <EntranceStateSection definition={stereopsisDefinition()} {...props} />;
    case "color-vision": return <EntranceStateSection definition={colorVisionDefinition()} {...props} />;
    case "eom": return <EomSection definition={emptyDefinition("entrance:eom", "EOM / diplopia", true)} {...props} />;
    case "cvf": return <CvfSection definition={emptyDefinition("entrance:cvf", "Confrontation visual fields", true)} fieldDefectDefinition={fieldDefectDefinition()} {...props} />;
    case "cover-test": return <CoverTestSection {...props} />;
    case "iop": return <IopSection {...props} />;
    case "dilation": return <DilationSection definition={dilationDefinition()} {...props} />;
    case "refraction": return <RefractionSection {...props} />;
    case "eye-growth": return <EyeGrowthSection {...props} />;
    case "soft-contact-lens": return <SoftContactLensSection {...props} />;
    case "specialty-contact-lens": return <SpecialtyContactLensSection {...props} />;
    case "ortho-k": return <OrthoKSection {...props} />;
    case "myopia-management": return <MyopiaManagementSection {...props} />;
    case "cup-disc": return <CupDiscSection {...props} />;
    case "gonioscopy": return <GonioscopySection {...props} />;
    case "dry-eye": return <DryEyeSection {...props} />;
    case "imaging": return <ImagingSection {...props} />;
    case "assessment": return <AssessmentSection {...props} onRefer={() => undefined} />;
    case "prescription": return <PrescriptionSection {...props} />;
    case "visit-charges": return <VisitChargesFixture />;
  }
}

const VISIT_API: VisitChargeApi = {
  async read() {
    return {
      options: [{ procedureConceptKey: "office-visit-new-low", display: "Office visit — new, low complexity" }],
      diagnoses: [{ reference: "Condition/one", display: "Primary open-angle glaucoma", rank: 1 }],
      selectedProcedureConceptKey: "office-visit-new-low",
      proposal: { id: "visit-1", procedureConceptKey: "office-visit-new-low", dxPointers: ["Condition/one"], state: "accepted" },
    };
  },
  async save() { return {}; },
};

const PROCEDURE_API: ProcedureChargeApi = {
  async read() {
    return {
      options: [{ procedureConceptKey: "gonioscopy", display: "Gonioscopy", billingCode: "SYNTH" }],
      diagnoses: [{ reference: "Condition/one", display: "Primary open-angle glaucoma", rank: 1 }],
      proposals: [{ id: "procedure-1", procedureConceptKey: "gonioscopy", dxPointers: ["Condition/one"], state: "accepted" }],
      attachedProcedures: [],
    };
  },
  async create() { throw new Error("not reached"); },
  async patch() { throw new Error("not reached"); },
};

function VisitChargesFixture() {
  const [visitCharge, setVisitCharge] = useState<Awaited<ReturnType<VisitChargeApi["read"]>>>();
  return (
    <VisitChargesSheetContent
      encounter={{
        resourceType: "Encounter",
        id: "test",
        status: "in-progress",
        class: { code: "AMB" },
        subject: { reference: "Patient/test" },
        extension: [{
          url: "https://odos2020.com/fhir/StructureDefinition/intended-coverage",
          valueReference: { reference: "Coverage/synthetic" },
        }],
      }}
      encounterId="test"
      patientReference="Patient/test"
      disabled={false}
      visitCharge={visitCharge}
      onVisitChargeChange={setVisitCharge}
      visitApi={VISIT_API}
      procedureApi={PROCEDURE_API}
    />
  );
}

function isFixtureSectionId(value: string | null): value is FixtureSectionId {
  return value !== null && (FIXTURE_SECTIONS as readonly string[]).includes(value);
}

function sectionLabel(sectionId: FixtureSectionId): string {
  if (sectionId === "visit-charges") return "Visit & charges";
  if (sectionId === "va") return "Visual Acuity";
  if (sectionId === "iop") return "IOP";
  return sectionId.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function emptyDefinition(stableKey: string, display: string, perEye: boolean): CustomFindingDefinition {
  return { stableKey, sectionKey: stableKey, display, active: true, perEye, customFields: [] };
}

function pupilsDefinition(): CustomFindingDefinition {
  return {
    ...emptyDefinition("entrance:pupils", "Pupils", true),
    normalTemplate: "PERRLA; no RAPD OU",
    customFields: [
      { localCode: "CUSTOM_PUPIL_SIZE_BRIGHT", display: "Size — bright", valueType: "number", min: 1, max: 9, step: 0.5, unit: "mm", order: 0, active: true },
      { localCode: "CUSTOM_PUPIL_SIZE_NEAR", display: "Size — near", valueType: "number", min: 1, max: 9, step: 0.5, unit: "mm", order: 1, active: true },
    ],
  };
}

function stereopsisDefinition(): CustomFindingDefinition {
  return {
    ...emptyDefinition("entrance:stereo", "Stereopsis", false),
    customFields: [
      { localCode: "CUSTOM_STEREO_TEST", display: "Test", valueType: "select", options: [{ code: "stereo-fly", display: "Stereo Fly", active: true }], order: 0, active: true },
      { localCode: "CUSTOM_STEREO_ARC_SECONDS", display: "Seconds of arc", valueType: "select", options: [], order: 1, active: true },
      { localCode: "CUSTOM_STEREO_UNABLE", display: "Unable to test", valueType: "select", options: [{ code: "yes", display: "yes", active: true }], order: 2, active: true },
    ],
  };
}

function colorVisionDefinition(): CustomFindingDefinition {
  return {
    ...emptyDefinition("entrance:color", "Color Vision", true),
    customFields: [
      { localCode: "CUSTOM_COLOR_TEST", display: "Test", valueType: "select", options: [{ code: "ishihara", display: "Ishihara", active: true }], order: 0, active: true },
      { localCode: "CUSTOM_COLOR_CORRECT", display: "Correct", valueType: "number", min: 0, max: 100, step: 1, order: 1, active: true },
      { localCode: "CUSTOM_COLOR_UNABLE", display: "Unable", valueType: "select", options: [{ code: "yes", display: "yes", active: true }], order: 2, active: true },
    ],
  };
}

function manualKeratometryDefinition(): CustomFindingDefinition {
  return {
    ...emptyDefinition("manual_keratometry", "Manual keratometry", true),
    customFields: [
      { localCode: "CUSTOM_FLAT_K", display: "Flat K", valueType: "number", min: 30, max: 60, step: 0.01, unit: "[diop]", order: 0, active: true },
      { localCode: "CUSTOM_FLAT_AXIS", display: "Flat axis", valueType: "number", min: 0, max: 180, step: 1, order: 1, active: true },
      { localCode: "CUSTOM_STEEP_K", display: "Steep K", valueType: "number", min: 30, max: 60, step: 0.01, unit: "[diop]", order: 2, active: true },
      { localCode: "CUSTOM_STEEP_AXIS", display: "Steep axis", valueType: "number", min: 0, max: 180, step: 1, order: 3, active: true },
      { localCode: "CUSTOM_MIRES_QUALITY", display: "Mires quality", valueType: "select", options: [{ code: "clear", display: "Clear", active: true }], order: 4, active: true },
    ],
  };
}

function pachymetryDefinition(): CustomFindingDefinition {
  return {
    ...emptyDefinition("pachymetry", "Pachymetry", true),
    customFields: [
      { localCode: "CUSTOM_PACH_VALUE", display: "Corneal thickness", valueType: "number", min: 300, max: 800, step: 1, unit: "um", order: 0, active: true },
      { localCode: "CUSTOM_PACH_METHOD", display: "Method", valueType: "select", options: [{ code: "ultrasound", display: "Ultrasound", active: true }], order: 1, active: true },
      { localCode: "CUSTOM_PACH_TIME", display: "Time", valueType: "string", order: 2, active: true },
    ],
  };
}

function fieldDefectDefinition(): CustomFindingDefinition {
  return {
    ...emptyDefinition("entrance:visual-field-defect", "Visual Field", false),
    customFields: [{ localCode: "CUSTOM_FIELD_DEFECT", display: "Field Defect", valueType: "select", options: [{ code: "no-defect", display: "No defect", active: true }], order: 0, active: true }],
  };
}

function dilationDefinition(): CustomFindingDefinition {
  return {
    ...emptyDefinition("entrance:dilation", "Dilation", false),
    fields: { agent: { options: [{ code: "tropicamide-1", display: "Tropicamide 1%", active: true }] } },
  };
}

createRoot(document.getElementById("root")!).render(<RoleProvider initialRole="doctor"><Fixture /></RoleProvider>);
