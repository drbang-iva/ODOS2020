import React from "react";
import { createRoot } from "react-dom/client";
import type { Patient, RelatedPerson } from "@medplum/fhirtypes";
import { buildAgeOfMajorityConfigResource } from "../../../mcp/src/clinic/age-of-majority-config";
import { EngageSheet, type EngageSheetApi } from "../../src/components/comms/EngageSheet";
import { dispatchEducation, listEducation } from "../../src/lib/communications-client";
import { CONSENT_AUTHORITY_EXTENSION_URL, RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL } from "../../src/lib/patient-identity";
import "../../src/styles/globals.css";

const patient: Patient = {
  resourceType: "Patient",
  id: "synthetic-child",
  name: [{ given: ["Synthetic"], family: "Child" }],
  birthDate: "2012-04-03",
};

const guarantor: RelatedPerson = {
  resourceType: "RelatedPerson",
  id: "synthetic-guarantor",
  active: true,
  patient: { reference: "Patient/synthetic-child" },
  name: [{ given: ["Synthetic"], family: "Guarantor" }],
  relationship: [{ coding: [{ code: "parent", display: "parent" }] }],
  telecom: [{ system: "phone", value: "+15555550111" }],
  extension: [
    { url: CONSENT_AUTHORITY_EXTENSION_URL, valueBoolean: true },
    { url: RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL, valueBoolean: true },
  ],
};

const api: EngageSheetApi = {
  async loadAgeOfMajorityConfig() { return buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 }); },
  listEducation,
  dispatchEducation,
  async listConsentGuardians() { return [guarantor]; },
};

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto min-h-screen max-w-5xl p-6" data-testid="synthetic-engage-fixture">
    <EngageSheet open patient={patient} onClose={() => undefined} api={api} idempotencyKeyFactory={() => "synthetic-notice-capture"} />
  </main>,
);
