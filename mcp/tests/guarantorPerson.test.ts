import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, Bundle, Person, RelatedPerson, Resource } from "@medplum/fhirtypes";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";
import { registerPatientFromDemographics, type PatientRegistrationInput } from "../src/clinic/patient-registration-endpoint.js";
import { resolveSmsNumber, resolveVoiceNumber } from "../src/comms/suppression-gate.js";
import { generatePatientStatementForOperator } from "../src/statements/statements.js";

const NOW = "2026-09-13T12:00:00.000Z";
const PROJECT = "g1-synthetic-practice";
const INPUT: PatientRegistrationInput = {
  demographics: {
    firstName: "Synthetic", middleName: "", lastName: "Child", preferredName: "",
    birthDate: "2010-01-02", gender: "female",
    phones: [{ value: "", use: "home" }, { value: "", use: "mobile" }], textable: "",
    email: "", address: "1 Synthetic Way", city: "Greenville", state: "SC", postalCode: "29601",
  },
  responsibleParties: [{
    localId: "guardian", kind: "person", relationship: "legal-guardian",
    firstName: " Responsible ", middleName: " Middle ", lastName: " Synthetic ", phone: " 864-555-0101 ",
    address: " 1 Synthetic Way ", city: " Greenville ", state: " SC ", postalCode: " 29601 ",
    financialResponsible: true, consentAuthority: true, primary: true,
    courtOrderNotes: "", effectiveDate: "2026-08-25", endDate: "",
  }],
  confirmDuplicate: false,
};

async function registrationBundle(input = structuredClone(INPUT)): Promise<Bundle> {
  let submitted: Bundle | undefined;
  const captured = new Error("Captured the production registration request at the transport boundary");
  await assert.rejects(registerPatientFromDemographics(input, {
    staffReference: "Practitioner/g1-staff", actorRole: "staff", roles: ["staff"],
    project: { reference: `Project/${PROJECT}` },
  }, {
    serviceFhir: {
      baseUrl: "http://g1-synthetic.test",
      search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
      searchProject: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
      create: async (resource: Account) => ({ ...resource, id: "g1-reservation", meta: { ...resource.meta, versionId: "1" } }),
      executeTransactionAsActor: async (bundle: Bundle) => { submitted = structuredClone(bundle); throw captured; },
    } as never,
    now: () => NOW,
  }), error => error === captured);
  assert.ok(submitted);
  return submitted;
}

function entries(bundle: Bundle, type: "Person" | "RelatedPerson") {
  return (bundle.entry ?? []).filter(entry => entry.resource?.resourceType === type);
}

test("P1: one non-self party creates exactly one Person linked to its RelatedPerson", async () => {
  const bundle = await registrationBundle();
  const persons = entries(bundle, "Person");
  const related = entries(bundle, "RelatedPerson");
  assert.equal(persons.length, 1);
  assert.equal(related.length, 1);
  assert.match(persons[0].fullUrl!, /^urn:uuid:/);
  assert.deepEqual((persons[0].resource as Person).link, [{ target: { reference: related[0].fullUrl }, assurance: "level2" }]);
  assert.deepEqual(persons[0].request, { method: "POST", url: "Person" });
});

test("P2: a self responsible party creates no Person and retains two entries", async () => {
  const input = structuredClone(INPUT);
  input.demographics.birthDate = "1980-01-02";
  input.responsibleParties[0].kind = "self";
  const bundle = await registrationBundle(input);
  assert.equal(entries(bundle, "Person").length, 0);
  assert.deepEqual(bundle.entry?.map(entry => entry.resource?.resourceType), ["Patient", "Account"]);
});

test("P3: two non-self parties each link to their own RelatedPerson", async () => {
  const input = structuredClone(INPUT);
  input.responsibleParties.push({ ...input.responsibleParties[0], localId: "guardian-2", firstName: "Second", primary: false });
  const bundle = await registrationBundle(input);
  const persons = entries(bundle, "Person");
  assert.equal(persons.length, 2);
  for (const entry of persons) {
    const person = entry.resource as Person;
    const related = entries(bundle, "RelatedPerson").find(candidate => candidate.fullUrl === person.link?.[0].target.reference);
    assert.ok(related);
    assert.deepEqual(person.name, (related.resource as RelatedPerson).name);
  }
  assert.equal(new Set(persons.map(entry => (entry.resource as Person).link?.[0].target.reference)).size, 2);
});

test("P4: separate registrations with identical guarantors each request a new Person", async () => {
  const first = await registrationBundle();
  const secondInput = structuredClone(INPUT);
  secondInput.demographics.firstName = "Sibling";
  const second = await registrationBundle(secondInput);
  const persons = [...entries(first, "Person"), ...entries(second, "Person")];
  assert.equal(persons.length, 2);
  assert.equal(new Set(persons.map(entry => entry.fullUrl)).size, 2);
  for (const entry of persons) assert.deepEqual(entry.request, { method: "POST", url: "Person" });
});

test("P5: shared demographics preserve the base projection for both resources", async () => {
  const bundle = await registrationBundle();
  const person = entries(bundle, "Person")[0]?.resource as Person;
  const related = entries(bundle, "RelatedPerson")[0]?.resource as RelatedPerson;
  const expected = {
    name: [{ use: "official", given: ["Responsible", "Middle"], family: "Synthetic" }],
    telecom: [{ system: "phone", use: "home", value: "864-555-0101" }],
    address: [{ use: "home", line: ["1 Synthetic Way"], city: "Greenville", state: "SC", postalCode: "29601" }],
  };
  assert.ok(person);
  for (const resource of [person, related]) {
    assert.deepEqual({ name: resource.name, telecom: resource.telecom, address: resource.address }, expected);
  }
});

test("P6: Person and Patient explicitly belong to the same practice project", async () => {
  const bundle = await registrationBundle();
  const person = entries(bundle, "Person")[0]?.resource as Person;
  assert.equal(bundle.entry?.[0].resource?.meta?.project, PROJECT);
  assert.equal(person?.meta?.project, PROJECT);
});

test("P7 declaration: staff Person writes are practice-scoped create/update only", () => {
  for (const role of ["provider", "staff", "admin"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const persons = policy.resource?.filter(rule => rule.resourceType === "Person") ?? [];
    assert.deepEqual(persons, [
      { resourceType: "Person", interaction: ["read", "search", "history", "vread"] },
      ...(role === "staff" ? [{ resourceType: "Person", interaction: ["create", "update"], writeConstraint: [{
        language: "text/fhirpath",
        description: "Person links are managed by service operations; staff may edit demographics without changing links.",
        expression: "(%before.exists() implies ((%before.link.exists() or %after.link.exists()) implies (%before.link = %after.link))) and (%before.empty() implies %after.link.empty())",
      }] }] : []),
    ]);
    const relatedWrites = policy.resource?.filter(rule => rule.resourceType === "RelatedPerson" && rule.interaction?.includes("create")) ?? [];
    if (role === "staff") assert.deepEqual(relatedWrites.map(rule => rule.criteria), ["RelatedPerson?_compartment=%patient_compartment"]);
  }
});

test("P9: guardian SMS and voice resolution retain the base bytes", async () => {
  const bundle = await registrationBundle();
  const related = entries(bundle, "RelatedPerson")[0].resource as RelatedPerson;
  assert.equal(resolveSmsNumber(related, new Date(NOW)), "864-555-0101");
  assert.equal(resolveVoiceNumber(related, new Date(NOW)), "864-555-0101");
});

test("P8: a statement run retains the base minor recipient without reading Person", async () => {
  const bundle = await registrationBundle();
  const references = new Map(bundle.entry?.flatMap((entry, index) => entry.fullUrl
    ? [[entry.fullUrl, `${entry.resource!.resourceType}/g1-${index}`]] : []));
  const stored = new Map<string, Resource>();
  for (const entry of bundle.entry ?? []) {
    const resource = JSON.parse(JSON.stringify(entry.resource), (_key, value) =>
      typeof value === "string" ? references.get(value) ?? value : value) as Resource;
    resource.id = entry.fullUrl ? references.get(entry.fullUrl)!.split("/")[1] : resource.id;
    stored.set(`${resource.resourceType}/${resource.id}`, resource);
  }
  stored.set("Invoice/g1-invoice", {
    resourceType: "Invoice", id: "g1-invoice", status: "issued", subject: { reference: "Patient/g1-0" }, date: NOW,
    lineItem: [{ sequence: 1, priceComponent: [{ type: "base", amount: { value: 100, currency: "USD" } }] }],
    totalGross: { value: 100, currency: "USD" }, totalNet: { value: 100, currency: "USD" },
  });
  let sequence = 0;
  const fhir = {
    search: async (type: string, params: Record<string, string> = {}) => {
      assert.notEqual(type, "Person", "Statements must not consult the inert Person spine");
      return { resourceType: "Bundle", type: "searchset", entry: [...stored.values()]
        .filter(resource => resource.resourceType === type && (!params._id || params._id.split(",").includes(resource.id!)))
        .map(resource => ({ resource: structuredClone(resource) })) };
    },
    executeTransaction: async (request: Bundle) => ({
      resourceType: "Bundle", type: "transaction-response", entry: request.entry?.map(entry => {
        assert.equal(entry.resource?.resourceType, "Task");
        const id = entry.resource.id ?? `g1-task-${++sequence}`;
        stored.set(`Task/${id}`, { ...entry.resource, id, meta: { versionId: "1" } });
        return { response: { status: entry.request?.method === "PUT" ? "200" : "201", location: `Task/${id}/_history/1` } };
      }),
    }),
  };
  const run = await generatePatientStatementForOperator(fhir as never, { patientReference: "Patient/g1-0", generatedAt: NOW });
  assert.equal(run.generatedCount, 1, JSON.stringify(run.rejects));
  assert.equal(run.invalidRejects, 0);
  assert.deepEqual({
    name: run.statements[0].detail?.header.recipientName,
    address: run.statements[0].detail?.header.recipientAddress,
  }, {
    name: "Responsible Middle Synthetic",
    address: { lines: ["1 Synthetic Way"], cityStatePostal: "Greenville, SC 29601" },
  });
});

test("P10: every non-self account guarantor still targets a RelatedPerson entry", async () => {
  const input = structuredClone(INPUT);
  input.responsibleParties.push({ ...input.responsibleParties[0], localId: "guardian-2", primary: false });
  const bundle = await registrationBundle(input);
  const account = bundle.entry?.at(-1)?.resource as Account;
  assert.equal(account.guarantor?.length, 2);
  for (const guarantor of account.guarantor ?? []) {
    const target = bundle.entry?.find(entry => entry.fullUrl === guarantor.party.reference);
    assert.equal(target?.resource?.resourceType, "RelatedPerson");
  }
});

test("P12: Patient remains first and Account last with Person entries between", async () => {
  const input = structuredClone(INPUT);
  input.responsibleParties.push({ ...input.responsibleParties[0], localId: "guardian-2", primary: false });
  const bundle = await registrationBundle(input);
  assert.deepEqual(bundle.entry?.map(entry => entry.resource?.resourceType), ["Patient", "RelatedPerson", "Person", "RelatedPerson", "Person", "Account"]);
});
