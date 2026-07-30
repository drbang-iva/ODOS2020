import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Account,
  Bundle,
  Patient,
} from "@medplum/fhirtypes";
import {
  assertLocalOrPrivateBaseUrl,
  backfillPatientMrns,
  type PatientMrnBackfillAdapter,
} from "../../scripts/backfill-patient-mrns.ts";
import {
  EYEFINITY_EHR_PATIENT_ID_SYSTEM,
  EYEFINITY_EPM_PATIENT_ID_SYSTEM,
  ODOS_MRN_ALLOCATION_TOKEN_SYSTEM,
  ODOS_MRN_SYSTEM,
  formatOdosMrn,
  isValidOdosMrn,
} from "../../ui/src/lib/patient-identity.ts";

test("MRN backfill URL guard accepts bracketed IPv6 loopback and rejects public hosts", () => {
  assert.doesNotThrow(() => assertLocalOrPrivateBaseUrl("http://[::1]:8103"));
  assert.throws(
    () => assertLocalOrPrivateBaseUrl("https://example.com"),
    /must target a local or private self-hosted Medplum server/,
  );
  assert.throws(
    () => assertLocalOrPrivateBaseUrl("https://medplum.local"),
    /must target a local or private self-hosted Medplum server/,
  );
});

test("MRN backfill is idempotent, preserves migrated identifiers, and never invents a minor guarantor", async () => {
  const adapter = new FakePatientMrnBackfillAdapter([
    patient("adult", "1980-01-02", [
      { system: EYEFINITY_EPM_PATIENT_ID_SYSTEM, value: "6499570" },
      { system: EYEFINITY_EHR_PATIENT_ID_SYSTEM, value: "969" },
    ]),
    patient("minor", "2015-01-02", []),
  ]);
  const bases = [510_001, 510_002];

  const first = await backfillPatientMrns(adapter, {
    today: "2026-07-30",
    nextMrnBase: () => bases.shift()!,
    nextUuid: sequentialUuid(),
  });
  assert.deepEqual(first, {
    scannedPatients: 2,
    mrnsAdded: 2,
    accountsAdded: 2,
    accountsUpdated: 0,
    unchangedPatients: 0,
    minorsNeedingResponsibleParty: 1,
  });
  assert.equal(adapter.transactions.length, 2);
  const adult = adapter.patients.get("adult")!;
  assert.equal(adult.identifier?.some((identifier) =>
    identifier.system === EYEFINITY_EPM_PATIENT_ID_SYSTEM && identifier.value === "6499570"), true);
  assert.equal(adult.identifier?.some((identifier) =>
    identifier.system === EYEFINITY_EHR_PATIENT_ID_SYSTEM && identifier.value === "969"), true);
  assert.equal(isValidOdosMrn(adult.identifier?.find((identifier) => identifier.system === ODOS_MRN_SYSTEM)?.value ?? ""), true);
  const adultAccount = accountFor(adapter.accounts, "Patient/adult");
  const minorAccount = accountFor(adapter.accounts, "Patient/minor");
  assert.deepEqual(adultAccount.guarantor, [{ party: { reference: "Patient/adult" }, onHold: false }]);
  assert.deepEqual(minorAccount.guarantor, []);
  assert.equal(adultAccount.identifier?.some((identifier) => identifier.system === ODOS_MRN_ALLOCATION_TOKEN_SYSTEM), false);

  const second = await backfillPatientMrns(adapter, {
    today: "2026-07-30",
    nextMrnBase: () => {
      throw new Error("idempotent rerun must not request another MRN");
    },
    nextUuid: () => {
      throw new Error("idempotent rerun must not request another token");
    },
  });
  assert.deepEqual(second, {
    scannedPatients: 2,
    mrnsAdded: 0,
    accountsAdded: 0,
    accountsUpdated: 0,
    unchangedPatients: 2,
    minorsNeedingResponsibleParty: 1,
  });
  assert.equal(adapter.transactions.length, 2);
});

test("MRN backfill preserves unrelated fields on an existing Account full-resource update", async () => {
  const mrn = formatOdosMrn(620_001);
  assert.equal(isValidOdosMrn(mrn), true);
  const adapter = new FakePatientMrnBackfillAdapter([
    patient("adult", "1980-01-02", [{ system: ODOS_MRN_SYSTEM, value: mrn }]),
  ]);
  adapter.accounts.set("account-existing", {
    resourceType: "Account",
    id: "account-existing",
    meta: { versionId: "4" },
    identifier: [
      { system: ODOS_MRN_SYSTEM, value: mrn },
      { system: "https://example.test/account-id", value: "acct-44" },
    ],
    status: "on-hold",
    name: "Legacy account name",
    subject: [{ reference: "Patient/adult" }],
    owner: { reference: "Organization/practice" },
    servicePeriod: { start: "2020-01-01" },
    extension: [{ url: "https://example.test/account-note", valueString: "keep" }],
  });

  const result = await backfillPatientMrns(adapter, {
    today: "2026-07-30",
    nextMrnBase: () => {
      throw new Error("existing MRN must not allocate another");
    },
    nextUuid: () => {
      throw new Error("existing Account must not reserve another");
    },
  });

  assert.equal(result.accountsUpdated, 1);
  const account = accountFor(adapter.accounts, "Patient/adult");
  assert.deepEqual(account.owner, { reference: "Organization/practice" });
  assert.deepEqual(account.servicePeriod, { start: "2020-01-01" });
  assert.deepEqual(account.extension, [{ url: "https://example.test/account-note", valueString: "keep" }]);
  assert.equal(account.identifier?.some(
    (identifier) => identifier.system === "https://example.test/account-id" && identifier.value === "acct-44",
  ), true);
});

test("MRN backfill treats a complete Account with reordered identifiers as unchanged", async () => {
  const mrn = formatOdosMrn(630_001);
  const adapter = new FakePatientMrnBackfillAdapter([
    patient("adult", "1980-01-02", [{ system: ODOS_MRN_SYSTEM, value: mrn }]),
  ]);
  adapter.accounts.set("account-existing", {
    resourceType: "Account",
    id: "account-existing",
    meta: { versionId: "4" },
    identifier: [
      { system: ODOS_MRN_SYSTEM, value: mrn, use: "usual", type: { text: "ODOS medical record number" } },
      { system: "https://example.test/account-id", value: "acct-44" },
    ],
    status: "active",
    type: { text: "Patient account" },
    name: `ODOS chart ${mrn}`,
    subject: [{ reference: "Patient/adult" }],
    guarantor: [{ party: { reference: "Patient/adult" }, onHold: false }],
  });

  const result = await backfillPatientMrns(adapter, {
    today: "2026-07-30",
    nextMrnBase: () => {
      throw new Error("existing MRN must not allocate another");
    },
    nextUuid: () => {
      throw new Error("existing Account must not reserve another");
    },
  });

  assert.equal(result.accountsUpdated, 0);
  assert.equal(result.unchangedPatients, 1);
  assert.equal(adapter.transactions.length, 0);
});

test("MRN backfill fails before writes for ambiguous or inconsistent identity state", async (context) => {
  const firstMrn = formatOdosMrn(640_001);
  const secondMrn = formatOdosMrn(640_002);
  const cases: Array<{
    name: string;
    patient: Patient;
    accounts: Account[];
    error: RegExp;
  }> = [
    {
      name: "multiple patient Accounts",
      patient: patient("patient", "1980-01-02", [{ system: ODOS_MRN_SYSTEM, value: firstMrn }]),
      accounts: [
        account("one", "patient", firstMrn),
        account("two", "patient", firstMrn),
      ],
      error: /has multiple Accounts/,
    },
    {
      name: "invalid Patient ODOS MRN",
      patient: patient("patient", "1980-01-02", [{ system: ODOS_MRN_SYSTEM, value: "invalid" }]),
      accounts: [],
      error: /carries an invalid ODOS MRN/,
    },
    {
      name: "Patient and Account MRN mismatch",
      patient: patient("patient", "1980-01-02", [{ system: ODOS_MRN_SYSTEM, value: firstMrn }]),
      accounts: [account("one", "patient", secondMrn)],
      error: /Account does not carry the Patient ODOS MRN/,
    },
    {
      name: "existing Account without an ODOS MRN",
      patient: patient("patient", "1980-01-02", []),
      accounts: [{
        resourceType: "Account",
        id: "one",
        meta: { versionId: "1" },
        status: "active",
        subject: [{ reference: "Patient/patient" }],
      }],
      error: /already has an Account without an ODOS MRN/,
    },
    {
      name: "shared or multi-subject Account",
      patient: patient("patient", "1980-01-02", [{ system: ODOS_MRN_SYSTEM, value: firstMrn }]),
      accounts: [{
        ...account("one", "patient", firstMrn),
        subject: [{ reference: "Patient/patient" }, { reference: "Patient/other" }],
      }],
      error: /shared or multi-subject Account/,
    },
  ];

  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const adapter = new FakePatientMrnBackfillAdapter([fixture.patient]);
      for (const candidate of fixture.accounts) adapter.accounts.set(candidate.id!, candidate);
      const before = structuredClone({
        patients: [...adapter.patients.entries()],
        accounts: [...adapter.accounts.entries()],
      });

      await assert.rejects(
        backfillPatientMrns(adapter, {
          today: "2026-07-30",
          nextMrnBase: () => 650_001,
          nextUuid: sequentialUuid(),
        }),
        fixture.error,
      );
      assert.deepEqual([...adapter.patients.entries()], before.patients);
      assert.deepEqual([...adapter.accounts.entries()], before.accounts);
      assert.equal(adapter.transactions.length, 0);
    });
  }
});

test("MRN backfill validates every Patient before reserving or writing an earlier valid row", async () => {
  const adapter = new FakePatientMrnBackfillAdapter([
    patient("valid-first", "1980-01-02", []),
    patient("invalid-second", "1980-01-02", [{ system: ODOS_MRN_SYSTEM, value: "invalid" }]),
  ]);
  let allocationCalls = 0;

  await assert.rejects(
    backfillPatientMrns(adapter, {
      today: "2026-07-30",
      nextMrnBase: () => {
        allocationCalls += 1;
        return 650_001;
      },
      nextUuid: sequentialUuid(),
    }),
    /Patient\/invalid-second carries an invalid ODOS MRN/,
  );

  assert.equal(allocationCalls, 0);
  assert.equal(adapter.accounts.size, 0);
  assert.equal(adapter.transactions.length, 0);
  assert.equal(adapter.patients.get("valid-first")?.identifier?.length, 0);
});

class FakePatientMrnBackfillAdapter implements PatientMrnBackfillAdapter {
  readonly patients = new Map<string, Patient>();
  readonly accounts = new Map<string, Account>();
  readonly transactions: Bundle[] = [];
  private accountSequence = 0;

  constructor(patients: Patient[]) {
    for (const patient of patients) this.patients.set(patient.id!, structuredClone(patient));
  }

  async listPatients(): Promise<Patient[]> {
    return [...this.patients.values()].map((patient) => structuredClone(patient));
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].map((account) => structuredClone(account));
  }

  async createReservation(account: Account): Promise<Account> {
    const mrn = account.identifier?.find((identifier) => identifier.system === ODOS_MRN_SYSTEM)?.value;
    assert.ok(mrn);
    const existing = [...this.accounts.values()].find((candidate) =>
      candidate.identifier?.some((identifier) => identifier.system === ODOS_MRN_SYSTEM && identifier.value === mrn),
    );
    if (existing) return structuredClone(existing);
    const created = {
      ...structuredClone(account),
      id: `account-${++this.accountSequence}`,
      meta: { versionId: "1" },
    };
    this.accounts.set(created.id, created);
    return structuredClone(created);
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    this.transactions.push(structuredClone(bundle));
    for (const entry of bundle.entry ?? []) {
      if (entry.resource?.resourceType === "Patient") {
        const current = this.patients.get(entry.resource.id!);
        assert.ok(current);
        this.patients.set(entry.resource.id!, {
          ...structuredClone(entry.resource),
          meta: { versionId: String(Number(current.meta?.versionId ?? "0") + 1) },
        });
      }
      if (entry.resource?.resourceType === "Account") {
        const current = this.accounts.get(entry.resource.id!);
        assert.ok(current);
        this.accounts.set(entry.resource.id!, {
          ...structuredClone(entry.resource),
          meta: { versionId: String(Number(current.meta?.versionId ?? "0") + 1) },
        });
      }
    }
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: (bundle.entry ?? []).map(() => ({ response: { status: "200 OK" } })),
    };
  }
}

function patient(
  id: string,
  birthDate: string,
  identifier: NonNullable<Patient["identifier"]>,
): Patient {
  return {
    resourceType: "Patient",
    id,
    meta: { versionId: "1" },
    birthDate,
    identifier,
    name: [{ text: `Synthetic ${id}` }],
  };
}

function accountFor(accounts: ReadonlyMap<string, Account>, patientReference: string): Account {
  const account = [...accounts.values()].find((candidate) =>
    candidate.subject?.some((subject) => subject.reference === patientReference),
  );
  assert.ok(account);
  return account;
}

function account(id: string, patientId: string, mrn: string): Account {
  return {
    resourceType: "Account",
    id,
    meta: { versionId: "1" },
    identifier: [{ system: ODOS_MRN_SYSTEM, value: mrn }],
    status: "active",
    subject: [{ reference: `Patient/${patientId}` }],
  };
}

function sequentialUuid(): () => string {
  let sequence = 0;
  return () => `token-${++sequence}`;
}
