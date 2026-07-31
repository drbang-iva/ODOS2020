import assert from "node:assert/strict";
import test from "node:test";
import type { MedicationRequest, Patient, Practitioner } from "@medplum/fhirtypes";
import { ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL } from "../src/fhir/medicationOrder.js";
import {
  isWenoSwitchConfigured,
  type WenoSwitchConfig,
  wenoSwitchConfigFromEnv,
} from "../src/integrations/weno/config.js";
import {
  buildWenoSwitchNewRx,
  createWenoSwitchMessageId,
  parseWenoSwitchResponse,
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

function statusResponse(code: string, description: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><Message><Header><MessageID>0</MessageID></Header><Body><Status><Code>${code}</Code><Description>${description}</Description></Status></Body></Message>`;
}

function errorResponse(): string {
  return `<?xml version="1.0" encoding="utf-8"?><Message><Header><MessageID>0</MessageID></Header><Body><Error><Code>900</Code><DescriptionCode>P001</DescriptionCode><Description>Test transmission failure</Description></Error></Body></Message>`;
}

function assertOrdered(value: string, needles: string[]): void {
  let prior = -1;
  for (const needle of needles) {
    const index = value.indexOf(needle);
    assert.ok(index > prior, `${needle} must follow the prior field`);
    prior = index;
  }
}
