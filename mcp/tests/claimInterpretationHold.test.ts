import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, ChargeItem, DiagnosticReport, Encounter, Media, Resource } from "@medplum/fhirtypes";
import { buildClaimDraft } from "../src/claims/claim-draft.js";
import { buildProcedureFeeDefinition, PROCEDURE_CONCEPT_SYSTEM, type ProcedureFeeInterpretation } from "../src/clinical-graph/procedure-fee-schedule.js";
import { buildProtocolBasic, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";
import type { ChargeProposal } from "../src/clinical-graph/protocol-types.js";

const proposalSystem = "https://odos2020.com/fhir/NamingSystem/charge-proposal-charge-item";
const heldPhoto = "Synthetic photograph was held: it needs an interpretation and report on this visit.";

function fixture(options: {
  reportStatus?: DiagnosticReport["status"];
  liveAnswer?: ProcedureFeeInterpretation;
  raw?: boolean;
  billingOnly?: boolean;
  unanswered?: boolean;
  evidenceDay?: string;
  serviceStart?: string;
} = {}) {
  const encounter: Encounter = {
    resourceType: "Encounter", id: "visit", status: "finished", class: {},
    subject: { reference: "Patient/synthetic" },
    period: { start: options.serviceStart ?? "2026-09-23T10:00:00-04:00" },
    diagnosis: [{ condition: { reference: "Condition/dx" }, rank: 1 }],
  };
  const proposal: ChargeProposal = {
    id: "photo-proposal", encounterId: "visit", planActionRef: "action", procedureConceptKey: "synthetic-photo",
    state: "finalized", units: 1, dxPointers: ["Condition/dx"], evidenceRefs: [], coverageEvaluations: [],
    interpretation: { answer: "fundus-photo", feeVersion: "1", at: "2026-09-23T10:00:00-04:00" },
  };
  const photo: ChargeItem = {
    resourceType: "ChargeItem", id: "photo", status: "billable", subject: encounter.subject!, context: { reference: "Encounter/visit" },
    code: { coding: [{ system: "urn:synthetic:billing", code: "PHOTO1", display: "Synthetic photograph" },
      ...(!options.billingOnly ? [{ system: PROCEDURE_CONCEPT_SYSTEM, code: "synthetic-photo" }] : [])] },
    supportingInformation: [{ reference: "Condition/dx" }], priceOverride: { value: 30, currency: "USD" },
    ...(!options.raw && !options.billingOnly ? { identifier: [{ system: proposalSystem, value: proposal.id }] } : {}),
  };
  const visit: ChargeItem = { ...photo, id: "visit-charge", identifier: [], code: { coding: [{ system: "urn:synthetic:billing", code: "VISIT1", display: "Synthetic visit" }] } };
  const fee = buildProcedureFeeDefinition({ procedureConceptKey: "synthetic-photo", display: "Synthetic photograph", billingCode: "PHOTO1",
    ...(!options.unanswered ? { interpretation: options.liveAnswer ?? "fundus-photo" } : {}) });
  const evidenceEncounter = options.evidenceDay ? { ...encounter, id: "evidence-visit", period: { start: options.evidenceDay } } : encounter;
  const media: Media = { resourceType: "Media", id: "image", status: "completed", content: {}, subject: encounter.subject,
    encounter: { reference: `Encounter/${evidenceEncounter.id}` }, modality: { coding: [{ code: "fundus-photo" }] } };
  const report: DiagnosticReport = { resourceType: "DiagnosticReport", id: "report", status: options.reportStatus ?? "entered-in-error", code: {},
    subject: encounter.subject, encounter: media.encounter, conclusion: "Synthetic interpretation", media: [{ link: { reference: "Media/image" } }] };
  const resources: Resource[] = [encounter, ...(options.evidenceDay ? [evidenceEncounter] : []), photo, visit, fee, media, report,
    { ...buildProtocolBasic(proposal, PROTOCOL_BASIC_CODES.chargeProposal), id: "proposal-basic" } as Basic,
    { resourceType: "Condition", id: "dx", subject: encounter.subject!, encounter: { reference: "Encounter/visit" },
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }], verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
      code: { coding: [{ system: "urn:synthetic:diagnosis", code: "DX1" }] } },
    { resourceType: "Coverage", id: "coverage", status: "active", beneficiary: encounter.subject!, order: 1, payor: [{ reference: "Organization/payer" }] },
  ];
  const fhir = {
    baseUrl: "http://localhost:18103/",
    async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
      const row = resources.find(resource => resource.resourceType === type && resource.id === id);
      if (!row) throw new Error(`Missing ${type}/${id}`);
      return structuredClone(row) as T;
    },
    async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
      const rows = resources.filter(resource => resource.resourceType === type)
        .filter(resource => !params.encounter || ("encounter" in resource && (resource.encounter as { reference?: string })?.reference === params.encounter))
        .filter(resource => !params.context || ("context" in resource && (resource.context as { reference?: string })?.reference === params.context));
      return { resourceType: "Bundle", type: "searchset", entry: rows.map(resource => ({ resource: structuredClone(resource) as T })) };
    },
  };
  return { fhir, resources, photo, report, media, proposal };
}

test("H1 retracted report holds the materialized photograph but keeps the visit", async () => {
  const { fhir } = fixture();
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["visit-charge"]);
  assert.deepEqual(draft.warnings, [heldPhoto]);
});

test("H2 counting report keeps the photograph without a warning", async () => {
  const { fhir } = fixture({ reportStatus: "final" });
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["photo", "visit-charge"]);
  assert.equal(draft.warnings, undefined);
});

test("H3 accepted snapshot beats a later not-required fee answer", async () => {
  const { fhir } = fixture({ liveAnswer: "not-required" });
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["visit-charge"]);
  assert.deepEqual(draft.warnings, [heldPhoto]);
});

test("H4 raw concept-coded OCT is held without OCT evidence", async () => {
  const { fhir } = fixture({ raw: true, liveAnswer: "oct" });
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["visit-charge"]);
  assert.deepEqual(draft.warnings, [heldPhoto]);
});

test("H8 unanswered concept fee holds a line with the classify warning", async () => {
  const { fhir } = fixture({ raw: true, unanswered: true });
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["visit-charge"]);
  assert.deepEqual(draft.warnings, ["Synthetic photograph was held: classify it in the fee schedule (does it need an interpretation?)."]);
});

test("H11 interpretation on a different literal service day does not satisfy", async () => {
  const { fhir } = fixture({ reportStatus: "final", serviceStart: "2026-09-23T23:30:00-04:00", evidenceDay: "2026-09-24T01:00:00Z" });
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["visit-charge"]);
  assert.deepEqual(draft.warnings, [heldPhoto]);
});

test("H14 missing named proposal and no matching fee leaves the charge ungated", async () => {
  const { fhir, resources } = fixture();
  resources.splice(0, resources.length, ...resources.filter(row => row.resourceType !== "Basic" && row.resourceType !== "ChargeItemDefinition"));
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["photo", "visit-charge"]);
  assert.equal(draft.warnings, undefined);
});

test("H14 unreadable proposal search falls through to the ChargeItem concept fee", async () => {
  const { fhir } = fixture();
  const sourceSearch = fhir.search;
  fhir.search = async (resourceType, params = {}) => {
    if (resourceType === "Basic") throw Object.assign(new Error("Synthetic Basic read denied"), { status: 403 });
    return sourceSearch(resourceType, params);
  };
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["visit-charge"]);
  assert.deepEqual(draft.warnings, [heldPhoto]);
});

test("H13 billing-code matching needs the fee schedule read to hold an imaging line", async () => {
  const { fhir } = fixture({ billingOnly: true });
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["visit-charge"]);
  assert.deepEqual(draft.warnings, [heldPhoto]);
});

test("H9 signed OCT and photograph charges are kept with one advisory pair warning", async () => {
  const { fhir, resources, photo, proposal } = fixture({ reportStatus: "final" });
  const octProposal: ChargeProposal = { ...proposal, id: "oct-proposal", procedureConceptKey: "synthetic-oct", state: "finalized",
    interpretation: { answer: "oct", feeVersion: "1", at: "2026-09-23T10:00:00-04:00" } };
  resources.push(
    { ...photo, id: "oct", identifier: [{ system: proposalSystem, value: octProposal.id }],
      code: { coding: [{ system: "urn:synthetic:billing", code: "OCT1", display: "Synthetic OCT" }, { system: PROCEDURE_CONCEPT_SYSTEM, code: "synthetic-oct" }] } },
    { ...buildProtocolBasic(octProposal, PROTOCOL_BASIC_CODES.chargeProposal), id: "oct-basic" } as Basic,
    buildProcedureFeeDefinition({ procedureConceptKey: "synthetic-oct", display: "Synthetic OCT", billingCode: "OCT1", interpretation: "oct" }),
    { resourceType: "Media", id: "oct-image", status: "completed", content: {}, encounter: { reference: "Encounter/visit" }, modality: { coding: [{ code: "oct" }] } },
    { resourceType: "DiagnosticReport", id: "oct-report", status: "corrected", code: {}, encounter: { reference: "Encounter/visit" }, conclusion: "Synthetic OCT interpretation", media: [{ link: { reference: "Media/oct-image" } }] },
  );
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["photo", "visit-charge", "oct"]);
  assert.deepEqual(draft.warnings, ["Synthetic photograph and Synthetic OCT: usually not billed together on the same day — document why both were needed."]);
});

test("H9 same-day signed charge on another encounter appears in the advisory", async () => {
  const { fhir, resources, photo, proposal } = fixture({ reportStatus: "final" });
  const otherEncounter: Encounter = {
    resourceType: "Encounter", id: "other-visit", status: "finished", class: {},
    subject: { reference: "Patient/synthetic" }, period: { start: "2026-09-23T15:00:00-04:00" },
  };
  const octProposal: ChargeProposal = { ...proposal, id: "other-oct-proposal", encounterId: "other-visit",
    procedureConceptKey: "synthetic-oct", state: "finalized",
    interpretation: { answer: "oct", feeVersion: "1", at: "2026-09-23T15:00:00-04:00" } };
  resources.push(
    otherEncounter,
    { ...photo, id: "other-oct", context: { reference: "Encounter/other-visit" },
      identifier: [{ system: proposalSystem, value: octProposal.id }],
      code: { coding: [{ system: "urn:synthetic:billing", code: "OCT2" },
        { system: PROCEDURE_CONCEPT_SYSTEM, code: "synthetic-oct" }] } },
    { ...buildProtocolBasic(octProposal, PROTOCOL_BASIC_CODES.chargeProposal), id: "other-oct-basic" } as Basic,
    buildProcedureFeeDefinition({ procedureConceptKey: "synthetic-oct", display: "Synthetic OCT", billingCode: "OCT2", interpretation: "oct" }),
    { resourceType: "Media", id: "other-oct-image", status: "completed", content: {},
      encounter: { reference: "Encounter/other-visit" }, modality: { coding: [{ code: "oct" }] } },
    { resourceType: "DiagnosticReport", id: "other-oct-report", status: "final", code: {},
      encounter: { reference: "Encounter/other-visit" }, conclusion: "Synthetic OCT interpretation",
      media: [{ link: { reference: "Media/other-oct-image" } }] },
  );
  const draft = await buildClaimDraft(fhir, "visit");
  assert.deepEqual(draft.charges.map(row => row.id), ["photo", "visit-charge"]);
  assert.deepEqual(draft.warnings, ["Synthetic photograph and Synthetic OCT: usually not billed together on the same day — document why both were needed."]);
});
