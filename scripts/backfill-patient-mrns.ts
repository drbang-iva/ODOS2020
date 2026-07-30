#!/usr/bin/env tsx
import { randomInt, randomUUID } from "node:crypto";
import type {
  Account,
  Bundle,
  BundleEntry,
  Patient,
} from "@medplum/fhirtypes";
import { createMedplumClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import {
  ODOS_MRN_ALLOCATION_TOKEN_SYSTEM,
  ODOS_MRN_MAX,
  ODOS_MRN_MIN,
  ODOS_MRN_SYSTEM,
  isMinorOn,
  isValidOdosMrn,
  patientOdosMrn,
  reserveOdosMrn,
  type MrnReservationStore,
  type ReservedMrn,
} from "../ui/src/lib/patient-identity.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export interface PatientMrnBackfillAdapter extends MrnReservationStore {
  listPatients(): Promise<Patient[]>;
  listAccounts(): Promise<Account[]>;
  executeTransaction(bundle: Bundle): Promise<Bundle>;
}

export interface PatientMrnBackfillResult {
  scannedPatients: number;
  mrnsAdded: number;
  accountsAdded: number;
  accountsUpdated: number;
  unchangedPatients: number;
  minorsNeedingResponsibleParty: number;
}

export async function backfillPatientMrns(
  adapter: PatientMrnBackfillAdapter,
  options: {
    today: string;
    nextMrnBase?: () => number;
    nextUuid?: () => string;
  },
): Promise<PatientMrnBackfillResult> {
  const patients = await adapter.listPatients();
  const accounts = await adapter.listAccounts();
  const nextMrnBase = options.nextMrnBase ?? (() => randomInt(ODOS_MRN_MIN, ODOS_MRN_MAX + 1));
  const nextUuid = options.nextUuid ?? randomUUID;
  const result: PatientMrnBackfillResult = {
    scannedPatients: patients.length,
    mrnsAdded: 0,
    accountsAdded: 0,
    accountsUpdated: 0,
    unchangedPatients: 0,
    minorsNeedingResponsibleParty: 0,
  };

  for (const patient of patients) {
    if (!patient.id || !patient.meta?.versionId) {
      throw new Error("Patient backfill requires every Patient search row to include id and meta.versionId.");
    }
    const patientReference = `Patient/${patient.id}`;
    const patientAccounts = accounts.filter((account) =>
      account.subject?.some((subject) => subject.reference === patientReference),
    );
    if (patientAccounts.length > 1) {
      throw new Error(`${patientReference} has multiple Accounts; MRN backfill stopped without guessing.`);
    }
    const existingMrn = patientOdosMrn(patient);
    if (patient.identifier?.some(
      (identifier) => identifier.system === ODOS_MRN_SYSTEM && !isValidOdosMrn(identifier.value ?? ""),
    )) {
      throw new Error(`${patientReference} carries an invalid ODOS MRN; backfill stopped without replacing it.`);
    }
    const existingAccount = patientAccounts[0];
    if (existingAccount && !existingAccount.id) {
      throw new Error(`${patientReference} Account search row is missing id.`);
    }

    let reservation: ReservedMrn | undefined;
    let account = existingAccount;
    if (!existingMrn) {
      if (existingAccount) {
        throw new Error(`${patientReference} already has an Account without an ODOS MRN; backfill stopped without merging Accounts.`);
      }
      reservation = await reserveOdosMrn(adapter, nextMrnBase, nextUuid);
      account = reservation.account;
    } else if (!existingAccount) {
      reservation = await reserveSpecificMrn(adapter, existingMrn, nextUuid());
      account = reservation.account;
    } else if (!existingAccount.identifier?.some(
      (identifier) => identifier.system === ODOS_MRN_SYSTEM && identifier.value === existingMrn,
    )) {
      throw new Error(`${patientReference} Account does not carry the Patient ODOS MRN; backfill stopped without overwriting it.`);
    }
    if (!account?.id) throw new Error(`${patientReference} Account could not be resolved.`);

    const mrn = existingMrn ?? reservation!.mrn;
    const minor = isMinorOn(patient.birthDate, options.today);
    const finalizedAccount = buildBackfillAccount(account, patientReference, mrn, minor);
    const patientNeedsMrn = !existingMrn;
    const accountNeedsWrite = !sameBackfillAccount(account, finalizedAccount);
    if (!patientNeedsMrn && !accountNeedsWrite) {
      result.unchangedPatients += 1;
      if (minor && finalizedAccount.guarantor?.length === 0) result.minorsNeedingResponsibleParty += 1;
      continue;
    }

    const entries: BundleEntry[] = [];
    if (patientNeedsMrn) {
      entries.push({
        resource: {
          ...patient,
          identifier: [
            ...(patient.identifier ?? []),
            {
              use: "usual",
              type: { text: "ODOS medical record number" },
              system: ODOS_MRN_SYSTEM,
              value: mrn,
            },
          ],
        },
        request: {
          method: "PUT",
          url: patientReference,
          ifMatch: `W/"${patient.meta.versionId}"`,
        },
      });
    }
    entries.push({
      resource: finalizedAccount,
      request: {
        method: "PUT",
        url: `Account/${account.id}`,
        ...(account.meta?.versionId ? { ifMatch: `W/"${account.meta.versionId}"` } : {}),
      },
    });
    assertTransactionSuccess(await adapter.executeTransaction({
      resourceType: "Bundle",
      type: "transaction",
      entry: entries,
    }));

    if (patientNeedsMrn) result.mrnsAdded += 1;
    if (reservation) result.accountsAdded += 1;
    else result.accountsUpdated += 1;
    if (minor && finalizedAccount.guarantor?.length === 0) result.minorsNeedingResponsibleParty += 1;
  }
  return result;
}

function buildBackfillAccount(
  account: Account,
  patientReference: string,
  mrn: string,
  minor: boolean,
): Account {
  return {
    resourceType: "Account",
    id: account.id,
    meta: account.meta,
    identifier: [
      ...(account.identifier ?? []).filter(
        (identifier) =>
          identifier.system !== ODOS_MRN_SYSTEM
          && identifier.system !== ODOS_MRN_ALLOCATION_TOKEN_SYSTEM,
      ),
      {
        use: "usual",
        type: { text: "ODOS medical record number" },
        system: ODOS_MRN_SYSTEM,
        value: mrn,
      },
    ],
    status: "active",
    type: { text: "Patient account" },
    name: `ODOS chart ${mrn}`,
    subject: [{ reference: patientReference }],
    guarantor: minor
      ? account.guarantor?.filter((guarantor) => guarantor.party.reference !== patientReference) ?? []
      : account.guarantor?.length
        ? account.guarantor
        : [{ party: { reference: patientReference }, onHold: false }],
  };
}

function sameBackfillAccount(left: Account, right: Account): boolean {
  return JSON.stringify({
    identifier: left.identifier,
    status: left.status,
    type: left.type,
    name: left.name,
    subject: left.subject,
    guarantor: left.guarantor ?? [],
  }) === JSON.stringify({
    identifier: right.identifier,
    status: right.status,
    type: right.type,
    name: right.name,
    subject: right.subject,
    guarantor: right.guarantor ?? [],
  });
}

async function reserveSpecificMrn(
  adapter: MrnReservationStore,
  mrn: string,
  allocationToken: string,
): Promise<ReservedMrn> {
  const account = await adapter.createReservation({
    resourceType: "Account",
    identifier: [
      { use: "usual", type: { text: "ODOS medical record number" }, system: ODOS_MRN_SYSTEM, value: mrn },
      { system: ODOS_MRN_ALLOCATION_TOKEN_SYSTEM, value: allocationToken },
    ],
    status: "on-hold",
    name: `Pending ODOS chart ${mrn}`,
  }, `identifier=${ODOS_MRN_SYSTEM}|${mrn}`);
  const ownsReservation = account.identifier?.some(
    (identifier) =>
      identifier.system === ODOS_MRN_ALLOCATION_TOKEN_SYSTEM
      && identifier.value === allocationToken,
  );
  if (!ownsReservation || !account.id) {
    throw new Error(`ODOS MRN ${mrn} is already reserved by an Account not linked to its Patient.`);
  }
  return { mrn, allocationToken, account };
}

function assertTransactionSuccess(bundle: Bundle): void {
  const failed = (bundle.entry ?? []).find((entry) => !/^2\d\d/.test(entry.response?.status ?? ""));
  if (failed) throw new Error(`Patient MRN backfill transaction failed: ${failed.response?.status ?? "missing status"}.`);
}

class LivePatientMrnBackfillAdapter implements PatientMrnBackfillAdapter {
  constructor(private readonly fhir: MedplumClient) {}

  listPatients(): Promise<Patient[]> {
    return searchAll<Patient>(this.fhir, "Patient", {});
  }

  listAccounts(): Promise<Account[]> {
    return searchAll<Account>(this.fhir, "Account", {});
  }

  createReservation(account: Account, ifNoneExist: string): Promise<Account> {
    return this.fhir.create(account, { "If-None-Exist": ifNoneExist });
  }

  executeTransaction(bundle: Bundle): Promise<Bundle> {
    return this.fhir.executeTransaction(bundle);
  }
}

async function runCli(): Promise<void> {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL;
  assertLocalOrPrivateBaseUrl(baseUrl);
  const accessToken = process.env.MEDPLUM_ACCESS_TOKEN?.trim();
  const fhir = createMedplumClient({ baseUrl, accessToken });
  if (!accessToken) {
    const email = requireEnv("MEDPLUM_ADMIN_EMAIL");
    const password = requireEnv("MEDPLUM_ADMIN_PASSWORD");
    await fhir.login(email, password);
  }
  const result = await backfillPatientMrns(new LivePatientMrnBackfillAdapter(fhir), {
    today: new Date().toISOString().slice(0, 10),
  });
  console.log(JSON.stringify(result, null, 2));
}

function assertLocalOrPrivateBaseUrl(value: string): void {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const octets = host.split(".").map(Number);
  const privateIpv4 = octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && (
      octets[0] === 10
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] === 127
    );
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || !(host === "localhost" || host === "::1" || host.endsWith(".local") || privateIpv4)
  ) {
    throw new Error("MEDPLUM_BASE_URL must target a local or private self-hosted Medplum server.");
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
