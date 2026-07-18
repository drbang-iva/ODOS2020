import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { before, test } from "node:test";
import type {
  AuditEvent,
  Basic,
  ChargeItem,
  Claim,
  ClaimResponse,
  Coverage,
  Encounter,
  Organization,
  Patient,
  Practitioner,
  Provenance,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";
import {
  createAuthenticatedFhirClient,
  loadRepoEnv,
} from "./integration-helpers.js";
import type { ContractResourceType } from "./search-param-contract.js";

type AuthenticatedFhir = Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"];

type SmokeFixture = {
  fhir: AuthenticatedFhir;
  references: Record<
    "auditEvent" | "basic" | "chargeItem" | "claim" | "claimResponse" | "invoice" | "patient" | "payment" | "provenance" | "task",
    string
  >;
  timestamp: string;
};

type SmokeSearch = {
  name: string;
  resourceType: ContractResourceType;
  params: (fixture: SmokeFixture) => Record<string, string>;
  expectedReference: (fixture: SmokeFixture) => string;
};

const MEDPLUM_SKIP_MESSAGE =
  "MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for the Medplum search smoke lane.";
const TASK_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/task-type";
const TASK_CODE = "contract-search-smoke";
const TASK_STATUS_SYSTEM = "https://odos2020.com/fhir/CodeSystem/task-status";
const BASIC_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/contract-search-smoke";
const BASIC_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/contract-search-smoke";

let fixture: SmokeFixture | undefined;

before(async () => {
  loadRepoEnv();
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) return;

  await ensureContractIdentity({ baseUrl, email, password });
  const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  fixture = await seedSmokeFixture(fhir);
});

const searches: SmokeSearch[] = [
  {
    name: "ChargeItem subject",
    resourceType: "ChargeItem",
    params: (current) => ({ subject: current.references.patient, _count: "10" }),
    expectedReference: (current) => current.references.chargeItem,
  },
  {
    name: "Invoice subject with date sort",
    resourceType: "Invoice",
    params: (current) => ({ subject: current.references.patient, _sort: "-date", _count: "10" }),
    expectedReference: (current) => current.references.invoice,
  },
  {
    name: "Invoice date range",
    resourceType: "Invoice",
    params: (current) => ({ date: `ge${current.timestamp}`, _sort: "-date", _count: "10" }),
    expectedReference: (current) => current.references.invoice,
  },
  {
    name: "PaymentReconciliation active status",
    resourceType: "PaymentReconciliation",
    params: () => ({ status: "active", _count: "10" }),
    expectedReference: (current) => current.references.payment,
  },
  {
    name: "PaymentReconciliation created range",
    resourceType: "PaymentReconciliation",
    params: (current) => ({ created: `ge${current.timestamp}`, _sort: "-created", _count: "10" }),
    expectedReference: (current) => current.references.payment,
  },
  {
    name: "Claim patient with created sort",
    resourceType: "Claim",
    params: (current) => ({ patient: current.references.patient, _sort: "-created", _count: "10" }),
    expectedReference: (current) => current.references.claim,
  },
  {
    name: "ClaimResponse patient with created sort",
    resourceType: "ClaimResponse",
    params: (current) => ({ patient: current.references.patient, _sort: "-created", _count: "10" }),
    expectedReference: (current) => current.references.claimResponse,
  },
  {
    name: "Task code and business status",
    resourceType: "Task",
    params: () => ({
      code: `${TASK_CODE_SYSTEM}|${TASK_CODE}`,
      "business-status": `${TASK_STATUS_SYSTEM}|new`,
      _sort: "-authored-on",
      _count: "10",
    }),
    expectedReference: (current) => current.references.task,
  },
  {
    name: "Basic code and identifier",
    resourceType: "Basic",
    params: () => ({
      code: `${BASIC_CODE_SYSTEM}|contract-search-smoke`,
      identifier: `${BASIC_IDENTIFIER_SYSTEM}|contract-search-smoke`,
      _count: "10",
    }),
    expectedReference: (current) => current.references.basic,
  },
  {
    name: "Provenance target with recorded sort",
    resourceType: "Provenance",
    params: (current) => ({ target: current.references.patient, _sort: "-recorded", _count: "10" }),
    expectedReference: (current) => current.references.provenance,
  },
  {
    name: "AuditEvent patient and date",
    resourceType: "AuditEvent",
    params: (current) => ({ patient: current.references.patient, date: `ge${current.timestamp}`, _sort: "-date", _count: "10" }),
    expectedReference: (current) => current.references.auditEvent,
  },
];

for (const search of searches) {
  test(`Medplum 5.1.8 accepts ${search.name} search`, async (t) => {
    if (!fixture) {
      t.skip(MEDPLUM_SKIP_MESSAGE);
      return;
    }

    const bundle = await fixture.fhir.search<Resource>(
      search.resourceType as Resource["resourceType"],
      search.params(fixture),
    );
    const expectedReference = search.expectedReference(fixture);
    assert.equal(bundle.resourceType, "Bundle");
    assert.equal(bundle.type, "searchset");
    assert.ok(
      bundle.entry?.some((entry) =>
        `${entry.resource?.resourceType}/${entry.resource?.id}` === expectedReference),
      `${search.name} did not return ${expectedReference}`,
    );
  });
}

async function seedSmokeFixture(fhir: AuthenticatedFhir): Promise<SmokeFixture> {
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const today = timestamp.slice(0, 10);
  const suffix = randomBytes(8).toString("hex");
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    active: true,
    name: [{ family: `ContractSearch${suffix}`, given: ["Synthetic"] }],
  });
  const practitioner = await fhir.create<Practitioner>({
    resourceType: "Practitioner",
    active: true,
    name: [{ family: `ContractClinician${suffix}`, given: ["Synthetic"] }],
  });
  const organization = await fhir.create<Organization>({
    resourceType: "Organization",
    active: true,
    name: `Contract Payer ${suffix}`,
  });
  const patientReference = reference(patient);
  const practitionerReference = reference(practitioner);
  const organizationReference = reference(organization);
  const coverage = await fhir.create<Coverage>({
    resourceType: "Coverage",
    status: "active",
    beneficiary: { reference: patientReference },
    payor: [{ reference: organizationReference }],
  });
  const encounter = await fhir.create<Encounter>({
    resourceType: "Encounter",
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: patientReference },
    period: { start: timestamp, end: new Date().toISOString() },
  });
  const chargeItem = await fhir.create<ChargeItem>({
    resourceType: "ChargeItem",
    status: "billable",
    code: { text: "Contract search smoke charge" },
    subject: { reference: patientReference },
    context: { reference: reference(encounter) },
    occurrenceDateTime: timestamp,
    priceOverride: { value: 25, currency: "USD" },
  });
  const invoice = await fhir.create(buildOpticalInvoice({
    patientReference,
    date: timestamp,
    staffReference: practitionerReference,
    lineItems: [{ chargeItemReference: reference(chargeItem), amountCents: 2_500 }],
  }));
  const task = await fhir.create<Task>({
    resourceType: "Task",
    status: "in-progress",
    intent: "order",
    code: { coding: [{ system: TASK_CODE_SYSTEM, code: TASK_CODE }] },
    businessStatus: { coding: [{ system: TASK_STATUS_SYSTEM, code: "new" }] },
    authoredOn: timestamp,
    for: { reference: patientReference },
  });
  const payment = await fhir.create(buildPaymentReconciliation({
    outcome: "success",
    createdIso: timestamp,
    paymentDate: today,
    amountCents: 2_500,
    subjectReference: patientReference,
    invoiceReference: reference(invoice),
    taskReference: reference(task),
    staffReference: practitionerReference,
    processorTransactionId: `contract-${suffix}`,
    processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/contract-search-smoke",
    surface: "manual",
    tender: { code: "CASH" },
  }));
  const claim = await fhir.create<Claim>({
    resourceType: "Claim",
    status: "active",
    type: { text: "professional" },
    use: "claim",
    patient: { reference: patientReference },
    created: timestamp,
    insurer: { reference: organizationReference },
    provider: { reference: practitionerReference },
    priority: { text: "normal" },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: reference(coverage) } }],
    item: [{
      sequence: 1,
      productOrService: { text: "Contract search smoke service" },
      servicedDate: today,
      net: { value: 25, currency: "USD" },
    }],
    total: { value: 25, currency: "USD" },
  });
  const claimResponse = await fhir.create<ClaimResponse>({
    resourceType: "ClaimResponse",
    status: "active",
    type: { text: "professional" },
    use: "claim",
    patient: { reference: patientReference },
    created: timestamp,
    insurer: { reference: organizationReference },
    request: { reference: reference(claim) },
    requestor: { reference: practitionerReference },
    outcome: "complete",
  });
  const basic = await fhir.create<Basic>({
    resourceType: "Basic",
    code: { coding: [{ system: BASIC_CODE_SYSTEM, code: "contract-search-smoke" }] },
    identifier: [{ system: BASIC_IDENTIFIER_SYSTEM, value: "contract-search-smoke" }],
    subject: { reference: patientReference },
    created: today,
  });
  const provenance = await fhir.create<Provenance>({
    resourceType: "Provenance",
    target: [{ reference: patientReference }],
    recorded: timestamp,
    activity: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/contract-search-smoke", code: "read" }] },
    agent: [{ who: { reference: practitionerReference } }],
  });
  const auditEvent = await fhir.create<AuditEvent>({
    resourceType: "AuditEvent",
    type: { system: "http://terminology.hl7.org/CodeSystem/audit-event-type", code: "rest" },
    action: "R",
    recorded: timestamp,
    outcome: "0",
    agent: [{ requestor: true, who: { reference: practitionerReference } }],
    source: { observer: { reference: organizationReference } },
    entity: [{ what: { reference: patientReference } }],
  });

  return {
    fhir,
    timestamp,
    references: {
      auditEvent: reference(auditEvent),
      basic: reference(basic),
      chargeItem: reference(chargeItem),
      claim: reference(claim),
      claimResponse: reference(claimResponse),
      invoice: reference(invoice),
      patient: patientReference,
      payment: reference(payment),
      provenance: reference(provenance),
      task: reference(task),
    },
  };
}

async function ensureContractIdentity(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<void> {
  try {
    await createAuthenticatedFhirClient(input);
    return;
  } catch (error) {
    if (process.env.MEDPLUM_CONTRACT_BOOTSTRAP !== "1") throw error;
  }

  const base = input.baseUrl.replace(/\/$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const userResponse = await fetch(`${base}/auth/newuser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "new",
      firstName: "ODOS",
      lastName: "Contract CI",
      email: input.email,
      password: input.password,
      remember: false,
      codeChallengeMethod: "S256",
      codeChallenge: challenge,
      recaptchaToken: "",
    }),
  });
  if (!userResponse.ok) {
    throw new Error(`Medplum contract newuser failed: ${userResponse.status} ${await userResponse.text()}`);
  }

  let registration = await userResponse.json() as { login?: string; code?: string };
  if (!registration.code) {
    if (!registration.login) throw new Error("Medplum contract newuser response had no login or code.");
    const projectResponse = await fetch(`${base}/auth/newproject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: registration.login, projectName: "ODOS Contract CI" }),
    });
    if (!projectResponse.ok) {
      throw new Error(`Medplum contract newproject failed: ${projectResponse.status} ${await projectResponse.text()}`);
    }
    registration = await projectResponse.json() as { code?: string };
  }
  if (!registration.code) throw new Error("Medplum contract registration returned no authorization code.");

  const tokenResponse = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: registration.code,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Medplum contract registration token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
}

function reference(resource: Resource): string {
  assert.ok(resource.id, `${resource.resourceType} create returned no id.`);
  return `${resource.resourceType}/${resource.id}`;
}
