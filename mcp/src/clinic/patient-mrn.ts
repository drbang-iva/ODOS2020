import type { Account } from "@medplum/fhirtypes";

export const ODOS_MRN_SYSTEM = "https://odos2020.com/fhir/NamingSystem/odos-mrn";
export const ODOS_MRN_ALLOCATION_TOKEN_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/odos-mrn-allocation-token";
export const ODOS_MRN_MIN = 100_001;
export const ODOS_MRN_MAX = 999_999;
const ODOS_MRN_ALLOCATION_ATTEMPTS = 100;

export interface MrnReservationStore {
  patientIdentifierExists(mrn: string): Promise<boolean>;
  createReservation(account: Account, ifNoneExist: string): Promise<Account>;
}

export interface ReservedMrn {
  mrn: string;
  allocationToken: string;
  account: Account;
}

export async function reserveOdosMrn(
  store: MrnReservationStore,
  nextBase: () => number,
  nextToken: () => string,
): Promise<ReservedMrn> {
  for (let attempt = 0; attempt < ODOS_MRN_ALLOCATION_ATTEMPTS; attempt += 1) {
    const mrn = formatOdosMrn(nextBase());
    if (await store.patientIdentifierExists(mrn)) continue;
    const allocationToken = nextToken();
    const account = await store.createReservation(
      buildMrnReservationAccount(mrn, allocationToken),
      `identifier=${ODOS_MRN_SYSTEM}|${mrn}`,
    );
    if (account.identifier?.some(
      (identifier) =>
        identifier.system === ODOS_MRN_ALLOCATION_TOKEN_SYSTEM
        && identifier.value === allocationToken,
    )) {
      if (!account.id) throw new Error("MRN reservation Account was returned without an id.");
      return { mrn, allocationToken, account };
    }
  }
  throw new Error(`Unable to allocate a unique ODOS MRN after ${ODOS_MRN_ALLOCATION_ATTEMPTS} attempts.`);
}

export function buildMrnReservationAccount(mrn: string, allocationToken: string): Account {
  if (!isValidOdosMrn(mrn)) throw new Error("Cannot reserve an invalid ODOS MRN.");
  if (!allocationToken) throw new Error("MRN allocation token is required.");
  return {
    resourceType: "Account",
    identifier: [
      { use: "usual", type: { text: "ODOS medical record number" }, system: ODOS_MRN_SYSTEM, value: mrn },
      { system: ODOS_MRN_ALLOCATION_TOKEN_SYSTEM, value: allocationToken },
    ],
    status: "on-hold",
    name: `Pending ODOS chart ${mrn}`,
  };
}

export function formatOdosMrn(value: number): string {
  if (!Number.isInteger(value) || value < ODOS_MRN_MIN || value > ODOS_MRN_MAX) {
    throw new Error(`ODOS MRN base must be an integer from ${ODOS_MRN_MIN} through ${ODOS_MRN_MAX}.`);
  }
  const base = String(value).padStart(6, "0");
  return `${base}${luhnCheckDigit(base)}`;
}

export function isValidOdosMrn(value: string): boolean {
  if (!/^\d{7}$/.test(value)) return false;
  const base = value.slice(0, 6);
  const numericBase = Number(base);
  return numericBase >= ODOS_MRN_MIN
    && numericBase <= ODOS_MRN_MAX
    && value[6] === luhnCheckDigit(base);
}

function luhnCheckDigit(base: string): string {
  if (!/^\d{6}$/.test(base)) throw new Error("ODOS MRN base must contain exactly six digits.");
  let sum = 0;
  let double = true;
  for (let index = base.length - 1; index >= 0; index -= 1) {
    let digit = Number(base[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}
