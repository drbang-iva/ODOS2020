import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coverage, Encounter, Organization, Patient, Practitioner, RelatedPerson } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { OdosSearchPicker, type OdosSearchPickerOption } from "../src/components/inputs/OdosSearchPicker";
import { fhir } from "../src/lib/fhir";
import {
  addChargeLine,
  addDiagnosisLine,
  buildCoverageResource,
  buildProfessionalClaimInput,
  claimDraftFromProfessionalClaimInput,
  claimProviderFromPractitioner,
  coverageRelationshipCode,
  coverageGroupNumber,
  coverageIsSelf,
  coverageMemberId,
  dollarsToCents,
  initialClaimDraft,
  latestFinishedEncounter,
  loadEncounterClaimDraft,
  mergeProviderDefaults,
  removeChargeLine,
  removeDiagnosisLine,
  resolveSubscriberFromCoverage,
  previewStediClaimResubmission,
  submitStediClaimResubmission,
  submitProfessionalClaim,
  subscriberForClaim,
  subscriberFromCoverage,
  validateClaimDraft,
  type ClaimDraft,
} from "../src/lib/submit-claims";
import { PatientSearch } from "../src/scenes/PatientPicker";
import {
  ClaimReview,
  ClaimSubmissionResult,
  CoverageChoices,
  PersonFields,
  SubmissionAlert,
  SubmitClaims,
  createPayerOrganization,
  practitionerDisplay,
  searchPayerOrganizations,
  validateCoverageEntry,
} from "../src/scenes/claims/SubmitClaims";

const PATIENT: Patient = {
  resourceType: "Patient",
  id: "pat-1",
  name: [{ use: "official", given: ["Jane", "Q"], family: "Doe" }],
  birthDate: "1980-01-02",
  gender: "female",
  address: [{ use: "home", line: ["1 Main St"], city: "Greenville", state: "SC", postalCode: "29601" }],
};

test("assembled request matches ProfessionalClaimInput and ChargeItem payload fields", () => {
  const claim = buildProfessionalClaimInput(validDraft());
  assert.deepEqual(Object.keys(claim).sort(), [
    "billingProvider",
    "chargeItems",
    "coverageReference",
    "created",
    "diagnoses",
    "insurerReference",
    "patient",
    "patientAccountNumber",
    "patientReference",
    "payerId",
    "providerReference",
    "renderingProvider",
    "serviceDate",
    "subscriber",
  ]);
  assert.deepEqual(claim.diagnoses[0], {
    system: "http://hl7.org/fhir/sid/icd-10-cm",
    code: "TEST-DX",
    display: "Synthetic diagnosis",
  });
  assert.deepEqual(claim.chargeItems[0].code.coding?.[0], {
    system: "urn:ama:cpt",
    code: "TEST-PROC",
    display: "Synthetic procedure",
  });
  assert.equal(claim.chargeItems[0].status, "billable");
  assert.equal(claim.chargeItems[0].subject.reference, "Patient/pat-1");
  assert.equal(claim.chargeItems[0].quantity?.value, 1);
});

test("encounter-prefilled lines preserve persisted ids, coding systems, diagnosis pointers, and laterality", () => {
  const draft = validDraft();
  draft.diagnoses = [
    { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "DX-A", description: "First" },
    { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "DX-B", description: "Second" },
  ];
  draft.charges = [{
    id: "charge-1",
    codeType: "HCPCS",
    codeSystem: "https://odos.test/fhir/CodeSystem/synthetic-procedure",
    code: "PROC-A",
    description: "Synthetic procedure",
    feeDollars: "125.50",
    quantity: "1",
    diagnosisSequence: [2],
    laterality: "OS",
  }];
  const claim = buildProfessionalClaimInput(draft);
  assert.equal(claim.chargeItems[0].id, "charge-1");
  assert.equal(claim.chargeItems[0].code.coding?.[0]?.system, "https://odos.test/fhir/CodeSystem/synthetic-procedure");
  assert.deepEqual(claim.chargeItems[0].diagnosisSequence, [2]);
  assert.deepEqual(claim.chargeItems[0].bodysite, [{
    coding: [{
      system: "https://odos2020.com/fhir/CodeSystem/laterality",
      code: "OS",
    }],
    text: "OS",
  }]);
  const roundTrip = claimDraftFromProfessionalClaimInput(claim, "2026-08-11");
  assert.equal(roundTrip.charges[0]?.laterality, "OS");
});

test("claim draft client loads one encounter without submitting it", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const draft = await loadEncounterClaimDraft("enc-1", {
    authorization: "Bearer test",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        encounterReference: "Encounter/enc-1",
        patientReference: "Patient/pat-1",
        serviceDate: "2026-07-21",
        diagnoses: [],
        charges: [],
      });
    },
  });
  assert.equal(draft.encounterReference, "Encounter/enc-1");
  assert.equal(calls[0].url, "/claims/draft?encounterId=enc-1");
  assert.equal(calls[0].init?.method, undefined);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer test");
});

test("claim draft client converts a non-JSON failure into the HTTP status error", async () => {
  await assert.rejects(
    loadEncounterClaimDraft("enc-1", {
      fetchImpl: async () => new Response("upstream failure", { status: 500 }),
    }),
    /Claim draft load failed with HTTP 500/,
  );
});

test("claim validation names empty, over-length, and out-of-slot diagnosis pointer failures", () => {
  const empty = validDraft();
  empty.charges[0]!.diagnosisSequence = [];
  assert.match(validateClaimDraft(empty).join(" "), /at least one diagnosis pointer/);

  const overLength = validDraft();
  overLength.diagnoses = Array.from({ length: 5 }, (_, index) => ({
    code: `DX-${index + 1}`,
    description: "Synthetic diagnosis",
  }));
  overLength.charges[0]!.diagnosisSequence = [1, 2, 3, 4, 5];
  assert.match(validateClaimDraft(overLength).join(" "), /no more than four diagnosis pointers/);

  const outOfSlot = validDraft();
  outOfSlot.diagnoses = Array.from({ length: 15 }, (_, index) => ({
    code: `DX-${index + 1}`,
    description: "Synthetic diagnosis",
  }));
  outOfSlot.charges[0]!.diagnosisSequence = [13];
  assert.match(validateClaimDraft(outOfSlot).join(" "), /positions 1 through 12/);
});

test("claim submission converts a non-JSON failure into the HTTP status error", async () => {
  await assert.rejects(
    submitProfessionalClaim(buildProfessionalClaimInput(validDraft()), {
      fetchImpl: async () => new Response("<html>Bad gateway</html>", { status: 502 }),
    }),
    /Claim submission failed with HTTP 502/,
  );
});

test("Stedi resubmission preview and submit use the dedicated endpoints and explicit payer signal", async () => {
  const claim = buildProfessionalClaimInput(validDraft());
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return jsonResponse(String(input).endsWith("/preview")
      ? { determination: { status: "ready", claimFrequencyCode: "7", claimControlNumber: "PCCN-1" }, originalClaim: claim }
      : { claimId: "claim-2", claimReference: "Claim/claim-2", claimFrequencyCode: "7", claimControlNumber: "PCCN-1" });
  };

  await previewStediClaimResubmission({
    originalClaimReference: "Claim/claim-1",
    intent: "correct",
    payerClassification: "confirmed-non-medicare",
  }, { fetchImpl });
  await submitStediClaimResubmission({
    originalClaimReference: "Claim/claim-1",
    intent: "correct",
    payerClassification: "confirmed-non-medicare",
    patientControlNumber: "NEW-PCN-1",
    revisedClaim: claim,
  }, { fetchImpl });

  assert.deepEqual(calls.map((call) => call.url), ["/claims/resubmission/preview", "/claims/resubmission"]);
  assert.equal(calls[0].body.payerClassification, "confirmed-non-medicare");
  assert.equal(calls[1].body.patientControlNumber, "NEW-PCN-1");
  assert.deepEqual(calls[1].body.revisedClaim, claim);
});

test("inline picker keeps a multi-given-name Practitioner label aligned with the captured claim name", async () => {
  const originalWindow = globalThis.window;
  const practitioner: Practitioner = {
    resourceType: "Practitioner",
    id: "pract-1",
    name: [{ given: ["Eric", "Michael"], family: "Bang" }],
  };
  const option: OdosSearchPickerOption<Practitioner> = {
    value: "Practitioner/pract-1",
    label: practitionerDisplay(practitioner),
    item: practitioner,
  };
  const searches: string[] = [];
  let selected: OdosSearchPickerOption<Practitioner> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function PickerHarness() {
    const [selection, setSelection] = React.useState<OdosSearchPickerOption<Practitioner>>();
    const provider = selection ? claimProviderFromPractitioner(selection.item) : undefined;
    const selectedLabel = provider
      ? [provider.firstName, provider.lastName].filter(Boolean).join(" ")
      : undefined;
    return (
      <OdosSearchPicker
        label="Rendering provider"
        value={selection?.value ?? ""}
        selectedLabel={selectedLabel}
        placeholder="Search practitioner name"
        search={async (query) => {
          searches.push(query);
          return [option];
        }}
        onSelect={(next) => {
          selected = next;
          setSelection(next);
        }}
        onClear={() => setSelection(undefined)}
        searchDelayMs={0}
      />
    );
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  try {
    await act(async () => {
      renderer = create(<PickerHarness />);
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "input" && node.props.placeholder === "Search practitioner name")
        .props.onChange({ target: { value: "Eric" } });
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10));
      await Promise.resolve();
    });
    const result = renderer!.root.findAllByType("button").find((button) =>
      button.findAllByType("span").some((span) => span.children.join("") === "Eric Bang")
    );
    assert.ok(result, "Expected Eric Bang search result");
    act(() => result.props.onClick());
    assert.deepEqual(searches, ["Eric"]);
    assert.equal(selected?.value, "Practitioner/pract-1");
    assert.equal(claimProviderFromPractitioner(selected!.item).firstName, "Eric");
    assert.equal(practitionerDisplay(selected!.item), "Eric Bang");
    assert.equal(
      renderer!.root.find((node) => node.type === "input" && node.props.placeholder === "Search practitioner name").props.value,
      "Eric Bang",
    );
    assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /Practitioner\/pract-1/);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("inline picker closes its search results when focus leaves the picker", async () => {
  const originalWindow = globalThis.window;
  let renderer: ReactTestRenderer | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  try {
    await act(async () => {
      renderer = create(
        <OdosSearchPicker
          label="Rendering provider"
          value=""
          placeholder="Search practitioner name"
          search={async () => [{
            value: "Practitioner/pract-1",
            label: "Eric Bang",
            item: { resourceType: "Practitioner", id: "pract-1" } as Practitioner,
          }]}
          onSelect={() => undefined}
          onClear={() => undefined}
          searchDelayMs={0}
        />,
      );
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "input" && node.props.placeholder === "Search practitioner name")
        .props.onChange({ target: { value: "Eric" } });
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10));
      await Promise.resolve();
    });
    assert.ok(renderer!.root.findAllByType("button").some((button) =>
      button.findAllByType("span").some((span) => span.children.join("") === "Eric Bang")
    ));
    act(() => {
      renderer!.root.find((node) => node.type === "div" && node.props.className === "relative")
        .props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
    });
    assert.equal(renderer!.root.findAllByType("button").length, 0);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("inline picker creates and selects a payer Organization from only its name", async () => {
  const originalWindow = globalThis.window;
  const created: Organization = { resourceType: "Organization", id: "payer-new", name: "New Payer" };
  let createName = "";
  let selected: OdosSearchPickerOption<Organization> | undefined;
  let renderer: ReactTestRenderer | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  try {
    await act(async () => {
      renderer = create(
        <OdosSearchPicker
          label="Payor organization"
          value=""
          placeholder="Search payer name"
          search={async () => []}
          onSelect={(next) => { selected = next; }}
          onClear={() => undefined}
          onCreate={async (name) => {
            createName = name;
            return { value: "Organization/payer-new", label: name, item: created };
          }}
          createLabel="Create payer"
          searchDelayMs={0}
        />,
      );
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "input" && node.props.placeholder === "Search payer name")
        .props.onChange({ target: { value: "New Payer" } });
    });
    await waitForObservable(
      () => hasClaimsButton(renderer!, "Create payer “New Payer”"),
      "create option for settled payer query",
    );
    await act(async () => {
      claimsButton(renderer!, "Create payer “New Payer”").props.onClick();
      await Promise.resolve();
    });
    assert.equal(createName, "New Payer");
    assert.equal(selected?.value, "Organization/payer-new");
    assert.equal(selected?.item.name, "New Payer");
  } finally {
    if (renderer) act(() => renderer!.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("payer Organization search and create use the verified payer type coding", async () => {
  const originalSearch = fhir.search;
  const originalCreate = fhir.create;
  let searchParams: Record<string, string> | undefined;
  let createdResource: Organization | undefined;
  (fhir as any).search = async (resourceType: string, params: Record<string, string>) => {
    assert.equal(resourceType, "Organization");
    searchParams = params;
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: [
        { resource: { resourceType: "Organization", id: "payer-1", name: "Blue Test", active: true } },
        { resource: { resourceType: "Organization", id: "payer-old", name: "Old Blue", active: false } },
      ],
    };
  };
  (fhir as any).create = async (resource: Organization) => {
    createdResource = resource;
    return { ...resource, id: "payer-new" };
  };
  try {
    const options = await searchPayerOrganizations("Blue");
    assert.deepEqual(searchParams, {
      name: "Blue",
      type: "http://terminology.hl7.org/CodeSystem/organization-type|pay",
      _count: "20",
    });
    assert.deepEqual(options.map((option) => option.value), ["Organization/payer-1"]);

    const created = await createPayerOrganization("New Payer");
    assert.deepEqual(createdResource?.type, [{
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/organization-type",
        code: "pay",
        display: "Payer",
      }],
    }]);
    assert.equal(created.value, "Organization/payer-new");
  } finally {
    (fhir as any).search = originalSearch;
    (fhir as any).create = originalCreate;
  }
});

test("inline picker does not update selection after payer creation resolves post-unmount", async () => {
  const originalWindow = globalThis.window;
  let resolveCreate: (option: OdosSearchPickerOption<Organization>) => void = () => undefined;
  let selected = false;
  let renderer: ReactTestRenderer | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  try {
    await act(async () => {
      renderer = create(
        <OdosSearchPicker
          label="Payor organization"
          value=""
          placeholder="Search payer name"
          search={async () => []}
          onSelect={() => { selected = true; }}
          onClear={() => undefined}
          onCreate={() => new Promise((resolve) => { resolveCreate = resolve; })}
          createLabel="Create payer"
          searchDelayMs={0}
        />,
      );
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "input" && node.props.placeholder === "Search payer name")
        .props.onChange({ target: { value: "New Payer" } });
    });
    await waitForObservable(
      () => hasClaimsButton(renderer!, "Create payer “New Payer”"),
      "create option for settled payer query",
    );
    act(() => claimsButton(renderer!, "Create payer “New Payer”").props.onClick());
    await act(async () => {
      renderer!.unmount();
      resolveCreate({
        value: "Organization/payer-new",
        label: "New Payer",
        item: { resourceType: "Organization", id: "payer-new", name: "New Payer" },
      });
      await Promise.resolve();
    });
    assert.equal(selected, false);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("claim draft validation messages appear inline before final review", async () => {
  const originalSearch = fhir.search;
  const originalWindow = globalThis.window;
  let renderer: ReactTestRenderer | undefined;
  (fhir as any).search = async (resourceType: string) => {
    if (resourceType === "Basic" || resourceType === "Encounter" || resourceType === "Coverage") {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    }
    throw new Error(`Unexpected ${resourceType} search`);
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      scrollTo: () => undefined,
    },
  });
  try {
    await act(async () => {
      renderer = create(<SubmitClaims />);
      await Promise.resolve();
    });
    await selectPatientInClaims(renderer!, PATIENT);
    const rendered = JSON.stringify(renderer!.toJSON());
    assert.match(rendered, /FHIR provider reference is required\./);
    assert.match(rendered, /Select a Coverage\./);
    assert.match(rendered, /Patient account number is required\./);
    assert.match(rendered, /Rendering provider NPI is required\./);
    assert.match(rendered, /Diagnosis 1 code is required\./);
    assert.match(rendered, /Charge 1 code is required\./);
    assert.ok(renderer!.root.findAll((node) => node.props["aria-invalid"] === true).length > 0);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    (fhir as any).search = originalSearch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("stored Stedi input converts back to an editable correction draft with a blank new PCN", () => {
  const original = buildProfessionalClaimInput(validDraft());
  const draft = claimDraftFromProfessionalClaimInput(original, "2026-07-22");
  assert.equal(draft.patientAccountNumber, "");
  assert.equal(draft.created, "2026-07-22");
  assert.equal(draft.subscriberIsPatient, true);
  assert.equal(draft.diagnoses[0].code, "TEST-DX");
  assert.equal(draft.charges[0].code, "TEST-PROC");
  assert.equal(draft.charges[0].feeDollars, "125.50");
});

test("Submit Claims surfaces encounter prefill and billing identity defaults fill only blank fields", () => {
  const html = renderToStaticMarkup(<SubmitClaims initialEncounterId="enc-1" />);
  assert.match(html, /Load from encounter/);
  assert.match(html, /value="enc-1"/);
  assert.deepEqual(
    mergeProviderDefaults(
      { npi: "", name: "Per-claim override" },
      { npi: "1111111112", name: "Practice default", taxonomy: "152W00000X" },
    ),
    { npi: "1111111112", name: "Per-claim override", taxonomy: "152W00000X" },
  );
});

test("Claim Review renders named human summary, line detail, and calculated total without raw JSON", () => {
  const claim = buildProfessionalClaimInput(validDraft());
  claim.chargeItems[0].quantity = { value: 2 };
  const html = renderToStaticMarkup(
    <ClaimReview claim={claim} payerName="Blue Health" submitting={false} onEdit={() => undefined} onSubmit={() => undefined} />,
  );
  assert.match(html, /Patient/);
  assert.match(html, /Subscriber/);
  assert.match(html, /Blue Health/);
  assert.match(html, /Test Practice/);
  assert.match(html, /Eric Bang/);
  assert.match(html, /TEST-DX/);
  assert.match(html, /Synthetic diagnosis/);
  assert.match(html, /TEST-PROC/);
  assert.match(html, /Synthetic procedure/);
  assert.match(html, /Fee \$125\.50/);
  assert.match(html, /Qty 2/);
  assert.match(html, /\$251\.00/);
  assert.match(html, /Greenville, SC 29601/);
  assert.doesNotMatch(html, /patientReference/);
  assert.doesNotMatch(html, /<pre/);
});

test("Coverage creation stamps member ID twice and preserves group, relationship, payor, and period", () => {
  const coverage = buildCoverageResource({
    patientReference: "Patient/pat-1",
    payorReference: "Organization/payer-1",
    payorDisplay: "Test Payer",
    memberId: "MEM-123",
    groupNumber: "GRP-9",
    relationship: "self",
    effectiveDate: "2026-07-01",
  });
  assert.equal(coverage.subscriberId, "MEM-123");
  assert.equal(coverage.identifier?.[0]?.value, "MEM-123");
  assert.equal(coverageMemberId(coverage), "MEM-123");
  assert.equal(coverageGroupNumber(coverage), "GRP-9");
  assert.equal(coverage.relationship?.coding?.[0]?.code, "self");
  assert.equal(coverage.subscriber?.reference, "Patient/pat-1");
  assert.equal(coverage.payor[0].reference, "Organization/payer-1");
  assert.equal(coverage.period?.start, "2026-07-01");

  const html = renderToStaticMarkup(
    <CoverageChoices coverages={[{ ...coverage, id: "cov-1" }]} selectedReference="Coverage/cov-1" onSelect={() => undefined} />,
  );
  assert.match(html, /Test Payer/);
  assert.match(html, /Member MEM-123/);
  assert.match(html, /checked=""/);
});

test("subscriber prefill uses patient demographics for self and stays editable for other", () => {
  const self = coverageFixture("self");
  const other = coverageFixture("other");
  const selfSubscriber = subscriberFromCoverage(self, PATIENT);
  const otherSubscriber = subscriberFromCoverage(other, PATIENT, RELATED_PERSON);

  assert.equal(coverageIsSelf(self), true);
  assert.equal(selfSubscriber.firstName, "Jane");
  assert.equal(selfSubscriber.lastName, "Doe");
  assert.equal(selfSubscriber.dateOfBirth, "1980-01-02");
  assert.equal(selfSubscriber.memberId, "MEM-123");
  assert.equal(selfSubscriber.relationshipCode, "18");
  assert.equal(coverageIsSelf(other), false);
  assert.equal(otherSubscriber.firstName, "Alex");
  assert.equal(otherSubscriber.middleName, "R");
  assert.equal(otherSubscriber.lastName, "Subscriber");
  assert.equal(otherSubscriber.dateOfBirth, "1977-03-04");
  assert.equal(otherSubscriber.sex, "M");
  assert.equal(otherSubscriber.address1, "900 Test Ave");
  assert.equal(otherSubscriber.city, "Greenville");
  assert.equal(otherSubscriber.state, "SC");
  assert.equal(otherSubscriber.zip, "29601");
  assert.equal(otherSubscriber.memberId, "MEM-123");
  assert.equal(otherSubscriber.relationshipCode, "G8");

  const html = renderToStaticMarkup(<PersonFields person={otherSubscriber} includePolicy onChange={() => undefined} />);
  assert.match(html, /value="Alex"/);
  assert.doesNotMatch(html, /readonly/);
});

test("self subscriber is derived from live patient edits and missing-address errors point to Patient", () => {
  const draft = validDraft();
  draft.patient = {
    firstName: "Jane",
    lastName: "Doe",
    dateOfBirth: "1980-01-02",
    sex: "F",
  };
  draft.subscriber = {
    firstName: "Stale",
    lastName: "Snapshot",
    dateOfBirth: "1900-01-01",
    sex: "U",
    memberId: "MEM-123",
    relationshipCode: "18",
  };

  const missing = validateClaimDraft(draft).join(" ");
  assert.match(missing, /Patient address is required/);
  assert.doesNotMatch(missing, /Subscriber address is required/);

  draft.patient = {
    ...draft.patient,
    address1: "77 Live Form Lane",
    city: "Greenville",
    state: "SC",
    zip: "29601",
  };
  const subscriber = subscriberForClaim(draft);
  assert.equal(subscriber.firstName, "Jane");
  assert.equal(subscriber.address1, "77 Live Form Lane");
  assert.equal(subscriber.memberId, "MEM-123");
  assert.equal(buildProfessionalClaimInput(draft).subscriber.address1, "77 Live Form Lane");
});

test("group number is optional when creating Coverage", () => {
  const entry = {
    patientReference: "Patient/pat-1",
    payorReference: "Organization/payer-1",
    memberId: "MEM-123",
    groupNumber: "",
    relationship: "self" as const,
    effectiveDate: "2026-07-01",
  };
  assert.deepEqual(validateCoverageEntry(entry), []);
  assert.deepEqual(buildCoverageResource(entry).class, []);
});

test("rendering Practitioner carry-over includes name, NPI, and available contact methods", () => {
  const practitioner: Practitioner = {
    resourceType: "Practitioner",
    id: "pract-1",
    identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1234567893" }],
    name: [{ use: "official", given: ["Eric"], family: "Bang" }],
    telecom: [
      { system: "phone", value: "864-555-0100" },
      { system: "email", value: "provider@example.test" },
      { system: "fax", value: "864-555-0101" },
    ],
  };
  assert.deepEqual(claimProviderFromPractitioner(practitioner), {
    npi: "1234567893",
    firstName: "Eric",
    lastName: "Bang",
    phone: "864-555-0100",
    email: "provider@example.test",
    fax: "864-555-0101",
  });
});

test("latest signed encounter selection is encounter-scoped and chronological", () => {
  const encounters: Encounter[] = [
    { resourceType: "Encounter", id: "older", status: "finished", class: {}, period: { start: "2026-07-20T10:00:00Z" } },
    { resourceType: "Encounter", id: "unsigned", status: "in-progress", class: {}, period: { start: "2026-07-22T10:00:00Z" } },
    { resourceType: "Encounter", id: "latest", status: "finished", class: {}, period: { start: "2026-07-21T10:00:00Z" } },
  ];
  assert.equal(latestFinishedEncounter(encounters)?.id, "latest");
});

test("reselecting a patient restores their lone active Coverage without a signed encounter", async () => {
  const originalSearch = fhir.search;
  const originalWindow = globalThis.window;
  const coverage = coverageFixture("self");
  const otherPatient: Patient = {
    resourceType: "Patient",
    id: "pat-2",
    name: [{ given: ["Other"], family: "Patient" }],
    birthDate: "1990-02-03",
  };
  let renderer: ReactTestRenderer | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      scrollTo: () => undefined,
    },
  });
  (fhir as any).search = async (resourceType: string, params: Record<string, string>) => {
    if (resourceType === "Basic" || resourceType === "Encounter") {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    }
    if (resourceType === "Coverage") {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: params.beneficiary === "Patient/pat-1" ? [{ resource: coverage }] : [],
      };
    }
    throw new Error(`Unexpected ${resourceType} search`);
  };
  try {
    await act(async () => {
      renderer = create(<SubmitClaims />);
      await Promise.resolve();
    });
    await selectPatientInClaims(renderer!, PATIENT);
    let coverageRadio = renderer!.root.findByProps({ type: "radio" });
    await act(async () => {
      await coverageRadio.props.onChange();
    });
    assert.equal(renderer!.root.findByProps({ type: "radio" }).props.checked, true);

    act(() => claimsButton(renderer!, "Change").props.onClick());
    await selectPatientInClaims(renderer!, otherPatient);
    act(() => claimsButton(renderer!, "Change").props.onClick());
    await selectPatientInClaims(renderer!, PATIENT);

    coverageRadio = renderer!.root.findByProps({ type: "radio" });
    assert.equal(coverageRadio.props.checked, true);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    (fhir as any).search = originalSearch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("provider validation requires rendering name and one billing contact method", () => {
  const draft = validDraft();
  draft.renderingProvider = { npi: "2222222222" };
  draft.billingProvider = { ...draft.billingProvider, phone: "" };
  const errors = validateClaimDraft(draft).join(" ");
  assert.match(errors, /Rendering provider last name or organization name is required/);
  assert.match(errors, /Billing provider phone, email, or fax is required/);

  draft.renderingProvider.name = "Rendering Organization";
  draft.billingProvider.email = "billing@example.test";
  assert.doesNotMatch(validateClaimDraft(draft).join(" "), /provider (?:last name|phone)/i);
});

test("all FHIR subscriber relationships map to verified Claim.MD 837P relationship codes", () => {
  const expected = {
    self: "18",
    spouse: "01",
    child: "19",
    common: "53",
    parent: "G8",
    other: "G8",
    injured: "G8",
  } as const;
  for (const [relationship, relationshipCode] of Object.entries(expected)) {
    assert.equal(coverageRelationshipCode(coverageFixture(relationship as keyof typeof expected)), relationshipCode);
  }
});

test("subscriber resolution fetches only valid non-self RelatedPerson references", async () => {
  const calls: string[] = [];
  const other = coverageFixture("other");
  other.subscriber = { reference: "RelatedPerson/subscriber-1" };
  const resolved = await resolveSubscriberFromCoverage(other, PATIENT, async (id) => {
    calls.push(id);
    return RELATED_PERSON;
  });
  assert.deepEqual(calls, ["subscriber-1"]);
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.subscriber.firstName, "Alex");

  const self = await resolveSubscriberFromCoverage(coverageFixture("self"), PATIENT, async () => {
    throw new Error("self coverage must not read RelatedPerson");
  });
  assert.equal(self.error, undefined);
  assert.equal(self.subscriber.firstName, "Jane");
});

test("missing or failed RelatedPerson resolution leaves an editable blank subscriber and surfaces an alert", async () => {
  const missing = await resolveSubscriberFromCoverage(coverageFixture("other"), PATIENT, async () => RELATED_PERSON);
  assert.match(missing.error ?? "", /does not reference a valid RelatedPerson/);
  assert.equal(missing.subscriber.firstName, "");
  assert.equal(missing.subscriber.relationshipCode, "G8");

  const malformedCoverage = coverageFixture("other");
  malformedCoverage.subscriber = { reference: "Patient/not-a-related-person" };
  const malformed = await resolveSubscriberFromCoverage(malformedCoverage, PATIENT, async () => RELATED_PERSON);
  assert.match(malformed.error ?? "", /does not reference a valid RelatedPerson/);

  const failedCoverage = coverageFixture("other");
  failedCoverage.subscriber = { reference: "RelatedPerson/missing" };
  const failed = await resolveSubscriberFromCoverage(failedCoverage, PATIENT, async () => {
    throw new Error("FHIR 404 Not Found");
  });
  assert.match(failed.error ?? "", /FHIR 404 Not Found/);
  assert.equal(failed.subscriber.firstName, "");
  const html = renderToStaticMarkup(
    <><SubmissionAlert message={failed.error ?? ""} /><PersonFields person={failed.subscriber} includePolicy onChange={() => undefined} /></>,
  );
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /readonly/);
});

test("diagnosis and charge helpers add at least two rows and remove the selected row", () => {
  const diagnoses = addDiagnosisLine([{ code: "FIRST", description: "First" }]);
  diagnoses[1] = { code: "SECOND", description: "Second" };
  assert.equal(diagnoses.length, 2);
  assert.deepEqual(removeDiagnosisLine(diagnoses, 0), [{ code: "SECOND", description: "Second" }]);

  const charges = addChargeLine([{ codeType: "CPT", code: "FIRST", description: "First", feeDollars: "1.00", quantity: "1" }]);
  charges[1] = { codeType: "HCPCS", code: "SECOND", description: "Second", feeDollars: "2.00", quantity: "2" };
  assert.equal(charges.length, 2);
  assert.deepEqual(removeChargeLine(charges, 0), [charges[1]]);
});

test("125.50 dollars becomes 12550 cents while FHIR Money remains 125.50 USD", () => {
  assert.equal(dollarsToCents("125.50"), 12_550);
  const claim = buildProfessionalClaimInput(validDraft());
  assert.deepEqual(claim.chargeItems[0].priceOverride, { value: 125.5, currency: "USD" });
});

test("submit posts the claim envelope and returns Claim.MD success identifiers", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const claim = buildProfessionalClaimInput(validDraft());
  const result = await submitProfessionalClaim(claim, {
    authorization: "Bearer test",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ claimId: "claim-1", status: "A" });
    },
  });
  assert.deepEqual(result, { claimId: "claim-1", status: "A" });
  assert.equal(calls[0].url, "/claims/submit");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer test");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { claim });

  const html = renderToStaticMarkup(<ClaimSubmissionResult result={result} onAnother={() => undefined} />);
  assert.match(html, /claim-1/);
  assert.match(html, />A</);
  assert.match(html, /Compose another claim/);
});

test("502 submit errors surface in an alert and are not retried", async () => {
  let callCount = 0;
  const claim = buildProfessionalClaimInput(validDraft());
  await assert.rejects(
    submitProfessionalClaim(claim, {
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse({ error: "Claim submission failed: rejected" }, 502);
      },
    }),
    /Claim submission failed: rejected/,
  );
  assert.equal(callCount, 1);

  const html = renderToStaticMarkup(
    <ClaimReview claim={claim} error="Claim submission failed: rejected" submitting={false} onEdit={() => undefined} onSubmit={() => undefined} />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Claim submission failed: rejected/);
});

test("client validation blocks the builder-required references and nonempty line arrays", () => {
  const draft = validDraft();
  draft.patientReference = "";
  draft.providerReference = "";
  draft.coverageReference = "";
  draft.diagnoses = [];
  draft.charges = [];
  const errors = validateClaimDraft(draft).join(" ");
  assert.match(errors, /Select a patient/);
  assert.match(errors, /FHIR provider reference is required/);
  assert.match(errors, /Select a Coverage/);
  assert.match(errors, /At least one diagnosis is required/);
  assert.match(errors, /At least one charge is required/);
  assert.throws(() => buildProfessionalClaimInput(draft), /Select a patient/);
});

function validDraft(): ClaimDraft {
  const draft = initialClaimDraft("2026-07-09");
  return {
    ...draft,
    serviceDate: "2026-07-08",
    patientReference: "Patient/pat-1",
    providerReference: "Practitioner/pract-1",
    insurerReference: "Organization/payer-1",
    coverageReference: "Coverage/cov-1",
    patientAccountNumber: "PCN-1",
    payerId: "PAYER-1",
    billingProvider: { npi: "1111111111", name: "Test Practice", phone: "8645550100" },
    renderingProvider: { npi: "2222222222", firstName: "Eric", lastName: "Bang" },
    patient: {
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1980-01-02",
      sex: "F",
      address1: "1 Main St",
      city: "Greenville",
      state: "SC",
      zip: "29601",
    },
    subscriber: {
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1980-01-02",
      sex: "F",
      memberId: "MEM-123",
      groupNumber: "GRP-9",
      relationshipCode: "18",
    },
    subscriberIsPatient: true,
    diagnoses: [{ code: "TEST-DX", description: "Synthetic diagnosis" }],
    charges: [{ codeType: "CPT", code: "TEST-PROC", description: "Synthetic procedure", feeDollars: "125.50", quantity: "1" }],
  };
}

function coverageFixture(relationship: "child" | "parent" | "spouse" | "common" | "other" | "self" | "injured"): Coverage {
  return {
    ...buildCoverageResource({
      patientReference: "Patient/pat-1",
      payorReference: "Organization/payer-1",
      memberId: "MEM-123",
      groupNumber: "GRP-9",
      relationship,
      effectiveDate: "2026-07-01",
    }),
    id: `cov-${relationship}`,
  };
}

const RELATED_PERSON: RelatedPerson = {
  resourceType: "RelatedPerson",
  id: "subscriber-1",
  patient: { reference: "Patient/pat-1" },
  name: [{ given: ["Alex", "R"], family: "Subscriber" }],
  birthDate: "1977-03-04",
  gender: "male",
  address: [{ line: ["900 Test Ave"], city: "Greenville", state: "SC", postalCode: "29601" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function selectPatientInClaims(renderer: ReactTestRenderer, patient: Patient): Promise<void> {
  await act(async () => {
    renderer.root.findByType(PatientSearch).props.onSelect(patient);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  });
}

function claimsButton(renderer: ReactTestRenderer, label: string): any {
  const button = renderer.root.findAllByType("button").find((candidate) =>
    candidate.children.join("") === label
  );
  assert.ok(button, `Expected ${label} button`);
  return button;
}

function hasClaimsButton(renderer: ReactTestRenderer, label: string): boolean {
  return renderer.root.findAllByType("button").some((button) => button.children.join("") === label);
}

async function waitForObservable(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  assert.fail(`Timed out waiting for ${description}`);
}
