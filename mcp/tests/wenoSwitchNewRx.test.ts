import assert from "node:assert/strict";
import test from "node:test";
import type { MedicationRequest, Patient, Practitioner } from "@medplum/fhirtypes";
import {
  ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL,
  WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
} from "../src/fhir/medicationOrder.js";
import {
  isWenoSwitchConfigured,
  type WenoSwitchConfig,
  wenoSwitchConfigFromEnv,
} from "../src/integrations/weno/config.js";
import {
  buildWenoSwitchCancelRx,
  buildWenoSwitchNewRx,
  createWenoSwitchMessageId,
  parseWenoSwitchResponse,
  sendWenoSwitchCancelRx,
  sendWenoSwitchNewRx,
  WENO_SWITCH_CERT_ENDPOINT,
  type WenoSwitchPharmacy,
} from "../src/integrations/weno/wenoSwitchNewRx.js";

const CONFIG: Required<WenoSwitchConfig> = {
  partnerId: "1417",
  partnerPasswordMd5: "TEST_MD5_PLACEHOLDER",
  routingId: "TEST_ROUTING_ID",
  senderSoftwareDeveloper: "Test Developer",
  senderSoftwareVersion: "0.0.1-test",
  endpoint: "https://cert.example.test/weno-switch",
};

const PATIENT: Patient = {
  resourceType: "Patient",
  name: [{ family: "O'Neil & Sons", given: ["Jane <Test>"] }],
  gender: "female",
  birthDate: "1990-01-02",
  address: [{
    line: ["1 Main & First"],
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  }],
  telecom: [{ system: "phone", value: "5125550100" }],
};

const PRESCRIBER: Practitioner = {
  resourceType: "Practitioner",
  identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1234567893" }],
  name: [{ family: "Bang", given: ["Eric"] }],
  address: [{
    line: ["2 Clinic Rd"],
    city: "Austin",
    state: "TX",
    postalCode: "78702",
    country: "US",
  }],
  telecom: [{ system: "phone", value: "5125550101" }],
};

const MEDICATION_REQUEST: MedicationRequest = {
  resourceType: "MedicationRequest",
  status: "active",
  intent: "order",
  medicationCodeableConcept: { text: "Test Drug 10 mg tablet" },
  subject: { reference: "Patient/test-patient" },
  requester: { reference: "Practitioner/test-prescriber" },
  authoredOn: "2026-07-17T12:30:00-05:00",
  dosageInstruction: [{ text: "Take 1 tablet by mouth daily." }],
  dispenseRequest: {
    quantity: { unit: "30" },
    expectedSupplyDuration: { value: 30, unit: "days" },
    numberOfRepeatsAllowed: 2,
  },
  substitution: { allowedBoolean: false },
};

const TEST_PHARMACY: WenoSwitchPharmacy = {
  ncpdpId: "1234567",
  name: "Test Direct Pharmacy",
  addressLine1: "3 Cert Way",
  city: "Austin",
  state: "TX",
  postalCode: "78703",
  phone: "5125550102",
};

const CAPTURED_WRAPPED_ERROR_RESPONSE = `<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">&lt;Message xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" DatatypesVersion="20170715" TransportVersion="20170715" TransactionDomain="SCRIPT" TransactionVersion="20170715" StructuresVersion="20170715" ECLVersion="20170715"&gt;&lt;Header&gt;&lt;To Qualifier="D"&gt;Unknown due to rejected transaction&lt;/To&gt;&lt;From Qualifier="M"&gt;WENO_Switch&lt;/From&gt;&lt;MessageID&gt;683d421f4a0a450382da72b93caff71a&lt;/MessageID&gt;&lt;RelatesToMessageID&gt;0&lt;/RelatesToMessageID&gt;&lt;SentTime&gt;2026-08-22T00:58:16.04268Z&lt;/SentTime&gt;&lt;SenderSoftware&gt;&lt;SenderSoftwareDeveloper&gt;WENO_DEV&lt;/SenderSoftwareDeveloper&gt;&lt;SenderSoftwareProduct&gt;WENO_Switch&lt;/SenderSoftwareProduct&gt;&lt;SenderSoftwareVersionRelease&gt;V1&lt;/SenderSoftwareVersionRelease&gt;&lt;/SenderSoftware&gt;&lt;/Header&gt;&lt;Body&gt;&lt;Error&gt;&lt;Code&gt;900&lt;/Code&gt;&lt;DescriptionCode&gt;4010&lt;/DescriptionCode&gt;&lt;Description&gt;Transaction rejected - One or more of these fields does not match DrugDb code and qualifier provided: DEA schedule code, QuantityUnitOfMeasure Code, or proper drug description.&lt;/Description&gt;&lt;/Error&gt;&lt;/Body&gt;&lt;/Message&gt;</string>`;
const CAPTURED_ERROR_DESCRIPTION = "Transaction rejected - One or more of these fields does not match DrugDb code and qualifier provided: DEA schedule code, QuantityUnitOfMeasure Code, or proper drug description.";

test("WENO Switch config is all-or-nothing and reads only its own env keys", () => {
  assert.equal(isWenoSwitchConfigured(CONFIG), true);
  for (const field of Object.keys(CONFIG) as Array<keyof WenoSwitchConfig>) {
    assert.equal(isWenoSwitchConfigured({ ...CONFIG, [field]: undefined }), false, field);
    assert.equal(isWenoSwitchConfigured({ ...CONFIG, [field]: " " }), false, `${field} blank`);
  }
  assert.deepEqual(wenoSwitchConfigFromEnv({
    WENO_SWITCH_PARTNER_ID: CONFIG.partnerId,
    WENO_SWITCH_PARTNER_PASSWORD_MD5: CONFIG.partnerPasswordMd5,
    WENO_SWITCH_ROUTING_ID: CONFIG.routingId,
    WENO_SWITCH_SENDER_SOFTWARE_DEVELOPER: CONFIG.senderSoftwareDeveloper,
    WENO_SWITCH_SENDER_SOFTWARE_VERSION: CONFIG.senderSoftwareVersion,
    WENO_SWITCH_ENDPOINT: CONFIG.endpoint,
  }), CONFIG);
});

test("NewRx builder maps ODOS FHIR data into the verified ordered non-controlled wire shape", () => {
  const built = buildFixture("0123456789abcdef0123456789abcdef");
  assert.match(built, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(
    built,
    /<Message DatatypesVersion="20170715" TransportVersion="20170715" TransactionDomain="SCRIPT" TransactionVersion="20170715" StructuresVersion="20170715" ECLVersion="20170715">/,
  );
  assert.match(built, /<To Qualifier="P">1234567<\/To><From Qualifier="D">TEST_ROUTING_ID<\/From>/);
  assert.match(built, /<Password Type="PasswordDigest">TEST_MD5_PLACEHOLDER<\/Password>/);
  assert.match(built, /<LastName>O&apos;Neil &amp; Sons<\/LastName><FirstName>Jane &lt;Test&gt;<\/FirstName>/);
  assert.match(built, /<Gender>F<\/Gender><DateOfBirth><Date>1990-01-02<\/Date><\/DateOfBirth>/);
  assert.match(built, /<Identification><NPI>1234567893<\/NPI><\/Identification>/);
  assert.match(built, /<Suffix>OD<\/Suffix>/);
  assert.match(built, /<PrescriberPlaceOfService>11<\/PrescriberPlaceOfService>/);
  assert.match(built, /<DEASchedule><Code>C38046<\/Code><\/DEASchedule>/);
  assert.doesNotMatch(built, /DigitalSignature|DEANumber|<DEA>/);
  assert.match(built, /<Quantity><Value>30<\/Value><CodeListQualifier>38<\/CodeListQualifier><QuantityUnitOfMeasure><Code>TEST_UOM_CODE<\/Code>/);
  assert.match(built, /<WrittenDate><DateTime>2026-07-17T17:30:00\.000Z<\/DateTime><\/WrittenDate>/);
  assert.match(built, /<Substitutions>1<\/Substitutions><NumberOfRefills>2<\/NumberOfRefills>/);

  assertOrdered(built, [
    "<Patient>",
    "<Pharmacy>",
    "<Prescriber>",
    "<MedicationPrescribed>",
    "<DrugDescription>",
    "<DrugCoded>",
    "<Quantity>",
    "<DaysSupply>",
    "<WrittenDate>",
    "<Substitutions>",
    "<NumberOfRefills>",
    "<Sig>",
  ]);
});

test("under-19 NewRx emits the vendor Observation shape with literal values and exact element order", () => {
  const built = buildWenoSwitchNewRx({
    ...buildInput("pediatric-observation-shape"),
    patient: { ...PATIENT, birthDate: "2010-07-18" },
    bodyWeightPounds: { value: 112, observedOn: "2020-07-05" },
    bodyHeightInches: { value: 62, observedOn: "2020-07-05" },
  } as Parameters<typeof buildWenoSwitchNewRx>[0] & {
    bodyWeightPounds: { value: number; observedOn: string };
    bodyHeightInches: { value: number; observedOn: string };
  });
  const observation = built.match(/<Observation>.*?<\/Observation>/)?.[0];

  assert.equal(
    observation,
    "<Observation>"
      + "<Measurement><VitalSign>Weight</VitalSign><LOINCVersion>2.66</LOINCVersion><Value>112</Value><UnitOfMeasure>pounds</UnitOfMeasure><UCUMVersion>2.1</UCUMVersion><ObservationDate><Date>2020-07-05</Date></ObservationDate></Measurement>"
      + "<Measurement><VitalSign>Height</VitalSign><LOINCVersion>2.66</LOINCVersion><Value>62</Value><UnitOfMeasure>inches</UnitOfMeasure><UCUMVersion>2.1</UCUMVersion><ObservationDate><Date>2020-07-05</Date></ObservationDate></Measurement>"
      + "</Observation>",
  );
  assertOrdered(built, ["</Prescriber>", "<Observation>", "<MedicationPrescribed>"]);
  for (const measurement of observation?.match(/<Measurement>.*?<\/Measurement>/g) ?? []) {
    assertOrdered(measurement, [
      "<VitalSign>",
      "<LOINCVersion>",
      "<Value>",
      "<UnitOfMeasure>",
      "<UCUMVersion>",
      "<ObservationDate><Date>",
    ]);
  }
});

test("patient aged exactly 19 at SentTime emits no Observation", () => {
  const built = buildWenoSwitchNewRx({
    ...buildInput("exactly-nineteen-boundary"),
    patient: { ...PATIENT, birthDate: "2007-07-17" },
  });

  assert.doesNotMatch(built, /<Observation>/);
});

test("adult NewRx matches the captured golden", () => {
  const built = buildWenoSwitchNewRx({
    ...buildInput("adult-byte-identical-baseline"),
    patient: PATIENT,
  });

  assert.equal(built, PRE_CHANGE_ADULT_XML);
});

for (const builder of ["NewRx", "CancelRx"] as const) {
  for (const testCase of [
    { id: "present", name: "with an NPI", npi: "1098765432", expected: "1098765432" },
    { id: "missing", name: "without an NPI", npi: undefined, expected: "NONE" },
    { id: "blank", name: "with a blank NPI", npi: " \t ", expected: "NONE" },
  ]) {
    test(`${builder} pharmacy ${testCase.name} always emits an NPI element`, () => {
      const pharmacy = { ...TEST_PHARMACY, npi: testCase.npi };
      const built = builder === "NewRx"
        ? buildWenoSwitchNewRx({ ...buildInput(`newrx-npi-${testCase.id}`), pharmacy })
        : buildWenoSwitchCancelRx({ ...cancelRxInput(`cancelrx-npi-${testCase.id}`), pharmacy });

      assert.equal(
        pharmacyIdentification(built),
        `<NCPDPID>1234567</NCPDPID><NPI>${testCase.expected}</NPI>`,
      );
    });
  }
}

for (const missing of ["height", "weight"] as const) {
  test(`under-19 NewRx missing ${missing} throws the 400-class actionable error`, () => {
    const input = {
      ...buildInput(`missing-${missing}-measurement`),
      patient: { ...PATIENT, birthDate: "2010-07-18" },
      ...(missing === "height"
        ? { bodyWeightPounds: { value: 112, observedOn: "2020-07-05" } }
        : { bodyHeightInches: { value: 62, observedOn: "2020-07-05" } }),
    } as Parameters<typeof buildWenoSwitchNewRx>[0] & {
      bodyWeightPounds?: { value: number; observedOn: string };
      bodyHeightInches?: { value: number; observedOn: string };
    };

    assert.throws(
      () => buildWenoSwitchNewRx(input),
      (error: unknown) => error instanceof Error
        && error.name === "WenoPrescriptionSendError"
        && (error as Error & { status?: number }).status === 400
        && error.message === "This patient is under 19. WENO requires height and weight on an electronic prescription. Record both before sending.",
    );
  });
}

test("NewRx validation rejects a pediatric message whose required Observation is removed", async () => {
  let calls = 0;
  const built = buildWenoSwitchNewRx({
    ...buildInput("pediatric-validator-guard"),
    patient: { ...PATIENT, birthDate: "2010-07-18" },
    bodyWeightPounds: { value: 112, observedOn: "2020-07-05" },
    bodyHeightInches: { value: 62, observedOn: "2020-07-05" },
  } as Parameters<typeof buildWenoSwitchNewRx>[0] & {
    bodyWeightPounds: { value: number; observedOn: string };
    bodyHeightInches: { value: number; observedOn: string };
  });
  const malformed = built.replace(/<Observation>.*?<\/Observation>/, "");

  await assert.rejects(
    sendWenoSwitchNewRx(malformed, {
      fetchImpl: (async () => {
        calls += 1;
        return new Response(statusResponse("001", "Accepted"));
      }) as typeof fetch,
    }),
    /under 19.*Observation/i,
  );
  assert.equal(calls, 0);
});

test("NewRx builder defaults substitutions to allowed and place of service can be overridden", () => {
  const built = buildWenoSwitchNewRx({
    ...buildInput("1123456789abcdef0123456789abcdef"),
    medicationRequest: { ...MEDICATION_REQUEST, substitution: undefined },
    prescriberPlaceOfService: "12",
  });
  assert.match(built, /<Substitutions>0<\/Substitutions>/);
  assert.match(built, /<PrescriberPlaceOfService>12<\/PrescriberPlaceOfService>/);
});

test("NewRx builder extracts numeric Quantity Value from UI quantity strings", () => {
  for (const [unit, expected] of [
    ["2.5 mL", "2.5"],
    ["30 tablets", "30"],
    ["1 bottle", "1"],
  ]) {
    const built = buildWenoSwitchNewRx({
      ...buildInput("1223456789abcdef0123456789abcdef"),
      medicationRequest: {
        ...MEDICATION_REQUEST,
        dispenseRequest: {
          ...MEDICATION_REQUEST.dispenseRequest,
          quantity: { unit },
        },
      },
    });
    assert.match(built, new RegExp(`<Quantity><Value>${expected.replace(".", "\\.")}<\\/Value>`), unit);
  }

  const numericValue = buildWenoSwitchNewRx({
    ...buildInput("1323456789abcdef0123456789abcdef"),
    medicationRequest: {
      ...MEDICATION_REQUEST,
      dispenseRequest: {
        ...MEDICATION_REQUEST.dispenseRequest,
        quantity: { value: 5, unit: "bottle" },
      },
    },
  });
  assert.match(numericValue, /<Quantity><Value>5<\/Value>/);
});

test("NewRx builder rejects quantity text without a leading number", () => {
  for (const unit of ["as needed", "N/A"]) {
    assert.throws(
      () => buildWenoSwitchNewRx({
        ...buildInput("1423456789abcdef0123456789abcdef"),
        medicationRequest: {
          ...MEDICATION_REQUEST,
          dispenseRequest: {
            ...MEDICATION_REQUEST.dispenseRequest,
            quantity: { unit },
          },
        },
      }),
      new RegExp(`Quantity must begin with a numeric value; received ${JSON.stringify(unit).replace("/", "\\/")}`),
    );
  }
});

test("NewRx builder rejects a required FHIR field and an overlong drug description", () => {
  assert.throws(
    () => buildWenoSwitchNewRx({
      ...buildInput("2123456789abcdef0123456789abcdef"),
      patient: { ...PATIENT, birthDate: undefined },
    }),
    /missing required Patient date of birth/,
  );
  assert.throws(
    () => buildWenoSwitchNewRx({
      ...buildInput("3123456789abcdef0123456789abcdef"),
      medicationRequest: {
        ...MEDICATION_REQUEST,
        medicationCodeableConcept: { text: "x".repeat(106) },
      },
    }),
    /105 characters or fewer/,
  );
  assert.throws(
    () => buildWenoSwitchNewRx({
      ...buildInput("8123456789abcdef0123456789abcdef"),
      medicationRequest: {
        ...MEDICATION_REQUEST,
        extension: [{
          url: ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL,
          valueBoolean: true,
        }],
      },
    }),
    /non-controlled prescriptions only/,
  );
});

test("CancelRx uses a fresh MessageID and relates it to the stored NewRx MessageID", () => {
  const built = buildWenoSwitchCancelRx(cancelRxInput("cancel-message-id"));

  assert.match(
    built,
    /<MessageID>cancel-message-id<\/MessageID><RelatesToMessageID>original-newrx-id<\/RelatesToMessageID>/,
  );
});

test("CancelRx emits the six required MedicationPrescribed children in order without NewRx-only fields", () => {
  const built = buildWenoSwitchCancelRx(cancelRxInput("cancel-medication-id"));
  const medication = built.match(/<MedicationPrescribed>(.*?)<\/MedicationPrescribed>/)?.[1];
  assert.ok(medication);

  assertOrdered(medication, [
    "<DrugDescription>",
    "<Quantity>",
    "<WrittenDate>",
    "<Substitutions>",
    "<NumberOfRefills>",
    "<Sig>",
  ]);
  assert.doesNotMatch(medication, /<DrugCoded>|<DaysSupply>/);
});

test("CancelRx emits only the settled patient, pharmacy, prescriber, and medication body sections", () => {
  const built = buildWenoSwitchCancelRx(cancelRxInput("cancel-body-id"));

  assert.match(built, /<Body><CancelRx><Patient><HumanPatient>/);
  assertOrdered(built, ["<Patient>", "<Pharmacy>", "<Prescriber>", "<MedicationPrescribed>"]);
  assert.doesNotMatch(built, /<Observation\b|<BenefitsCoordination\b/);
});

test("CancelRx validation still rejects an injected Observation before transport", async () => {
  let calls = 0;
  const malformed = buildWenoSwitchCancelRx(cancelRxInput("cancel-observation-guard"))
    .replace("<MedicationPrescribed>", "<Observation><Measurement /></Observation><MedicationPrescribed>");

  await assert.rejects(
    sendWenoSwitchCancelRx(malformed, {
      fetchImpl: (async () => {
        calls += 1;
        return new Response(statusResponse("001", "Accepted"));
      }) as typeof fetch,
    }),
    /CancelRx must not contain Observation or BenefitsCoordination/,
  );
  assert.equal(calls, 0);
});

test("CancelRx rejects a controlled-substance-flagged MedicationRequest", () => {
  assert.throws(
    () => buildWenoSwitchCancelRx({
      ...cancelRxInput("cancel-controlled-id"),
      medicationRequest: {
        ...MEDICATION_REQUEST,
        identifier: [{ system: WENO_MESSAGE_ID_IDENTIFIER_SYSTEM, value: "original-newrx-id" }],
        extension: [{
          url: ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL,
          valueBoolean: true,
        }],
      },
    }),
    /non-controlled prescriptions only/,
  );
});

test("CancelRx send validates the message, posts through the Switch transport, and parses Status", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const xml = buildWenoSwitchCancelRx(cancelRxInput("cancel-transport-id"));

  const result = await sendWenoSwitchCancelRx(xml, {
    endpoint: CONFIG.endpoint,
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(statusResponse("001", "Accepted"), { status: 200 });
    }) as typeof fetch,
  });

  assert.deepEqual(result, { kind: "status", code: "001", description: "Accepted" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, CONFIG.endpoint);
  assert.equal(calls[0]?.init?.body, xml);
});

test("send validates before HTTP, posts only to cert, and preserves unknown Status codes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(statusResponse("937", "Accepted for switch processing"), { status: 200 });
  }) as typeof fetch;
  const xml = buildFixture("4123456789abcdef0123456789abcdef");

  const result = await sendWenoSwitchNewRx(xml, { fetchImpl });

  assert.deepEqual(result, {
    kind: "status",
    code: "937",
    description: "Accepted for switch processing",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, WENO_SWITCH_CERT_ENDPOINT);
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.body, xml);
  assert.deepEqual(calls[0]?.init?.headers, {
    Accept: "application/xml",
    "Content-Type": "application/xml; charset=utf-8",
  });
});

test("send uses an operator-supplied WENO Switch endpoint without inventing a production default", async () => {
  let calledUrl = "";
  const configuredEndpoint = "https://verified-endpoint.example.test/weno-switch";
  await sendWenoSwitchNewRx(
    buildFixture("b123456789abcdef0123456789abcdef"),
    {
      endpoint: configuredEndpoint,
      fetchImpl: (async (input) => {
        calledUrl = String(input);
        return new Response(statusResponse("001", "Accepted"), { status: 200 });
      }) as typeof fetch,
    },
  );
  assert.equal(calledUrl, configuredEndpoint);
  assert.notEqual(calledUrl, WENO_SWITCH_CERT_ENDPOINT);
});

test("send requires a full date-time before accepting Z or a numeric UTC offset", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(statusResponse("001", "Accepted"), { status: 200 });
  }) as typeof fetch;

  await sendWenoSwitchNewRx(buildFixture("1523456789abcdef0123456789abcdef"), { fetchImpl });
  const explicitOffsets = buildFixture("1623456789abcdef0123456789abcdef")
    .replace("2026-07-17T17:31:00.000Z", "2026-07-17T17:31:00+05:00")
    .replace("2026-07-17T17:30:00.000Z", "2026-07-17T17:30:00-0800");
  await sendWenoSwitchNewRx(explicitOffsets, { fetchImpl });

  const bareDate = buildFixture("1723456789abcdef0123456789abcdef")
    .replace("2026-07-17T17:31:00.000Z", "2026-07-18");
  await assert.rejects(
    sendWenoSwitchNewRx(bareDate, { fetchImpl }),
    /SentTime must include a UTC offset/,
  );
  assert.equal(calls, 2);
});

test("send parses a synchronous WENO Error without treating it as transport failure", async () => {
  const result = await sendWenoSwitchNewRx(
    buildFixture("5123456789abcdef0123456789abcdef"),
    {
      fetchImpl: (async () => new Response(errorResponse(), { status: 400 })) as typeof fetch,
    },
  );
  assert.deepEqual(result, {
    kind: "error",
    code: "900",
    descriptionCode: "P001",
    description: "Test transmission failure",
  });
});

test("send returns the parsed result from WENO's captured wrapped response", async () => {
  const result = await sendWenoSwitchNewRx(
    buildFixture("d123456789abcdef0123456789abcdef"),
    {
      fetchImpl: (async () => new Response(CAPTURED_WRAPPED_ERROR_RESPONSE, { status: 200 })) as typeof fetch,
    },
  );

  assert.deepEqual(result, {
    kind: "error",
    code: "900",
    descriptionCode: "4010",
    description: CAPTURED_ERROR_DESCRIPTION,
  });
});

test("send rejects missing required data before HTTP and blocks repeated MessageIDs", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(statusResponse("001", "Accepted"), { status: 200 });
  }) as typeof fetch;
  const invalid = buildFixture("6123456789abcdef0123456789abcdef")
    .replace("<Date>1990-01-02</Date>", "<Date></Date>");
  await assert.rejects(sendWenoSwitchNewRx(invalid, { fetchImpl }), /Patient date of birth/);
  const bareSentTime = buildFixture("9123456789abcdef0123456789abcdef")
    .replace("2026-07-17T17:31:00.000Z", "2026-07-17T17:31:00");
  await assert.rejects(sendWenoSwitchNewRx(bareSentTime, { fetchImpl }), /SentTime must include a UTC offset/);
  const bareWrittenDate = buildFixture("a123456789abcdef0123456789abcdef")
    .replace("2026-07-17T17:30:00.000Z", "2026-07-17T17:30:00");
  await assert.rejects(sendWenoSwitchNewRx(bareWrittenDate, { fetchImpl }), /WrittenDate must include a UTC offset/);
  assert.equal(calls, 0);

  const valid = buildFixture("7123456789abcdef0123456789abcdef");
  await sendWenoSwitchNewRx(valid, { fetchImpl });
  await assert.rejects(sendWenoSwitchNewRx(valid, { fetchImpl }), /already sent by this process/);
  assert.equal(calls, 1);
});

test("response parser requires the documented Status or Error body", () => {
  assert.deepEqual(parseWenoSwitchResponse(statusResponse("000", "Received")), {
    kind: "status",
    code: "000",
    description: "Received",
  });
  assert.throws(
    () => parseWenoSwitchResponse("<Message><Body><Verify /></Body></Message>"),
    /Body\/Status or Body\/Error/,
  );
});

test("response parser reads WENO's captured wrapped Error response", () => {
  assert.deepEqual(parseWenoSwitchResponse(CAPTURED_WRAPPED_ERROR_RESPONSE), {
    kind: "error",
    code: "900",
    descriptionCode: "4010",
    description: CAPTURED_ERROR_DESCRIPTION,
  });
});

test("response parser reads a synthetic Status inside WENO's captured envelope", () => {
  assert.deepEqual(parseWenoSwitchResponse(wrappedStatusResponse()), {
    kind: "status",
    code: "001",
    description: "Accepted",
  });
});

test("response parser names an unexpected root element", () => {
  assert.throws(
    () => parseWenoSwitchResponse(
      `<?xml version="1.0" encoding="utf-8"?><UnexpectedRoot><Body /></UnexpectedRoot>`,
    ),
    /UnexpectedRoot/,
  );
});

test("generated WENO Switch MessageIDs are 32-character process-unique values", () => {
  const first = createWenoSwitchMessageId();
  const second = createWenoSwitchMessageId();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.match(second, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

function buildFixture(messageId: string): string {
  return buildWenoSwitchNewRx(buildInput(messageId));
}

function buildInput(messageId: string) {
  return {
    patient: PATIENT,
    prescriber: PRESCRIBER,
    medicationRequest: MEDICATION_REQUEST,
    pharmacy: TEST_PHARMACY,
    drugDbCode: "TEST_DRUG_CODE",
    drugDbCodeQualifier: "TEST_DRUG_QUALIFIER",
    quantityUnitOfMeasureCode: "TEST_UOM_CODE",
    config: CONFIG,
    messageId,
    sentTime: "2026-07-17T12:31:00-05:00",
  };
}

function cancelRxInput(messageId: string) {
  return {
    patient: PATIENT,
    prescriber: PRESCRIBER,
    medicationRequest: {
      ...MEDICATION_REQUEST,
      identifier: [{ system: WENO_MESSAGE_ID_IDENTIFIER_SYSTEM, value: "original-newrx-id" }],
    },
    pharmacy: TEST_PHARMACY,
    quantityUnitOfMeasureCode: "TEST_UOM_CODE",
    config: CONFIG,
    messageId,
    sentTime: "2026-07-17T12:31:00-05:00",
  };
}

function statusResponse(code: string, description: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><Message><Header><MessageID>0</MessageID></Header><Body><Status><Code>${code}</Code><Description>${description}</Description></Status></Body></Message>`;
}

function errorResponse(): string {
  return `<?xml version="1.0" encoding="utf-8"?><Message><Header><MessageID>0</MessageID></Header><Body><Error><Code>900</Code><DescriptionCode>P001</DescriptionCode><Description>Test transmission failure</Description></Error></Body></Message>`;
}

function wrappedStatusResponse(): string {
  return CAPTURED_WRAPPED_ERROR_RESPONSE.replace(
    "&lt;Body&gt;&lt;Error&gt;&lt;Code&gt;900&lt;/Code&gt;&lt;DescriptionCode&gt;4010&lt;/DescriptionCode&gt;&lt;Description&gt;Transaction rejected - One or more of these fields does not match DrugDb code and qualifier provided: DEA schedule code, QuantityUnitOfMeasure Code, or proper drug description.&lt;/Description&gt;&lt;/Error&gt;&lt;/Body&gt;",
    "&lt;Body&gt;&lt;Status&gt;&lt;Code&gt;001&lt;/Code&gt;&lt;Description&gt;Accepted&lt;/Description&gt;&lt;/Status&gt;&lt;/Body&gt;",
  );
}

function assertOrdered(value: string, needles: string[]): void {
  let prior = -1;
  for (const needle of needles) {
    const index = value.indexOf(needle);
    assert.ok(index > prior, `${needle} must follow the prior field`);
    prior = index;
  }
}

function pharmacyIdentification(value: string): string {
  const identification = value.match(/<Pharmacy><Identification>(.*?)<\/Identification>/)?.[1];
  assert.ok(identification, "Pharmacy Identification must be present");
  return identification;
}

const PRE_CHANGE_ADULT_XML = `<?xml version="1.0" encoding="utf-8"?><Message DatatypesVersion="20170715" TransportVersion="20170715" TransactionDomain="SCRIPT" TransactionVersion="20170715" StructuresVersion="20170715" ECLVersion="20170715"><Header><To Qualifier="P">1234567</To><From Qualifier="D">TEST_ROUTING_ID</From><MessageID>adult-byte-identical-baseline</MessageID><SentTime>2026-07-17T17:31:00.000Z</SentTime><Security><UsernameToken><Username>1417</Username><Password Type="PasswordDigest">TEST_MD5_PLACEHOLDER</Password></UsernameToken></Security><SenderSoftware><SenderSoftwareDeveloper>Test Developer</SenderSoftwareDeveloper><SenderSoftwareProduct>ODOS 20/20</SenderSoftwareProduct><SenderSoftwareVersionRelease>0.0.1-test</SenderSoftwareVersionRelease></SenderSoftware></Header><Body><NewRx><Patient><HumanPatient><Name><LastName>O&apos;Neil &amp; Sons</LastName><FirstName>Jane &lt;Test&gt;</FirstName></Name><Gender>F</Gender><DateOfBirth><Date>1990-01-02</Date></DateOfBirth><Address><AddressLine1>1 Main &amp; First</AddressLine1><City>Austin</City><StateProvince>TX</StateProvince><PostalCode>78701</PostalCode><CountryCode>US</CountryCode></Address><CommunicationNumbers><PrimaryTelephone><Number>5125550100</Number></PrimaryTelephone></CommunicationNumbers></HumanPatient></Patient><Pharmacy><Identification><NCPDPID>1234567</NCPDPID><NPI>NONE</NPI></Identification><BusinessName>Test Direct Pharmacy</BusinessName><Address><AddressLine1>3 Cert Way</AddressLine1><City>Austin</City><StateProvince>TX</StateProvince><PostalCode>78703</PostalCode><CountryCode>US</CountryCode></Address><CommunicationNumbers><PrimaryTelephone><Number>5125550102</Number></PrimaryTelephone></CommunicationNumbers></Pharmacy><Prescriber><NonVeterinarian><Identification><NPI>1234567893</NPI></Identification><Name><LastName>Bang</LastName><FirstName>Eric</FirstName><Suffix>OD</Suffix></Name><Address><AddressLine1>2 Clinic Rd</AddressLine1><City>Austin</City><StateProvince>TX</StateProvince><PostalCode>78702</PostalCode><CountryCode>US</CountryCode></Address><CommunicationNumbers><PrimaryTelephone><Number>5125550101</Number></PrimaryTelephone></CommunicationNumbers><PrescriberPlaceOfService>11</PrescriberPlaceOfService></NonVeterinarian></Prescriber><MedicationPrescribed><DrugDescription>Test Drug 10 mg tablet</DrugDescription><DrugCoded><DrugDBCode><Code>TEST_DRUG_CODE</Code><Qualifier>TEST_DRUG_QUALIFIER</Qualifier></DrugDBCode><DEASchedule><Code>C38046</Code></DEASchedule></DrugCoded><Quantity><Value>30</Value><CodeListQualifier>38</CodeListQualifier><QuantityUnitOfMeasure><Code>TEST_UOM_CODE</Code></QuantityUnitOfMeasure></Quantity><DaysSupply>30</DaysSupply><WrittenDate><DateTime>2026-07-17T17:30:00.000Z</DateTime></WrittenDate><Substitutions>1</Substitutions><NumberOfRefills>2</NumberOfRefills><Sig><SigText>Take 1 tablet by mouth daily.</SigText></Sig></MedicationPrescribed></NewRx></Body></Message>`;


for (const [guard, use] of [["FB4", "home"], ["FB5", "mobile"]] as const) {
  test(`${guard}: NewRx skips obsolete phone before current ${use}`, () => {
    const patient: Patient = { ...PATIENT, telecom: [
      { system: "phone", use: "old", value: "2025550101" },
      { system: "phone", use, value: "2025550102" },
    ] };
    const xml = buildWenoSwitchNewRx({ ...buildInput(`synthetic-${guard}`), patient });
    const patientXml = xml.match(/<HumanPatient>(.*?)<\/HumanPatient>/s)?.[1];
    assert.ok(patientXml);
    assert.match(patientXml, /<PrimaryTelephone><Number>2025550102<\/Number><\/PrimaryTelephone>/);
    assert.doesNotMatch(patientXml, /2025550101/);
  });
}
