import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Account,
  Bundle,
  Patient,
} from "@medplum/fhirtypes";
import {
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
      { system: "https://example.test/account-id", value: "acct-44" },
      { system: ODOS_MRN_SYSTEM, value: mrn },
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

function sequentialUuid(): () => string {
  let sequence = 0;
  return () => `token-${++sequence}`;
}
