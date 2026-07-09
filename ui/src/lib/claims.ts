import type { CoverageEligibilityResponse } from "@medplum/fhirtypes";

export interface MedicalEligibilitySummary {
  coverageStatus: "active" | "inactive" | "unknown";
  deductibleRemainingCents?: number;
  copayCents?: number;
  coinsurancePercent?: number;
  priorAuthRequired: boolean;
}

export function medicalEligibilitySummary(response: Pick<CoverageEligibilityResponse, "insurance">): MedicalEligibilitySummary {
  const insurance = response.insurance?.[0];
  const items = insurance?.item ?? [];
  return {
    coverageStatus: insurance?.inforce === true ? "active" : insurance?.inforce === false ? "inactive" : "unknown",
    deductibleRemainingCents: moneyBenefit(items, /deductible/i),
    copayCents: moneyBenefit(items, /co-?payment|copay/i),
    coinsurancePercent: unsignedBenefit(items, /co-?insurance|coinsurance/i),
    priorAuthRequired: items.some((item) => item.authorizationRequired || /prior auth/i.test(`${item.name ?? ""} ${item.description ?? ""}`)),
  };
}

function moneyBenefit(
  items: NonNullable<CoverageEligibilityResponse["insurance"]>[number]["item"],
  pattern: RegExp,
): number | undefined {
  const item = items?.find((candidate) => pattern.test(`${candidate.name ?? ""} ${candidate.description ?? ""}`));
  const value = item?.benefit?.find((benefit) => benefit.allowedMoney)?.allowedMoney;
  return typeof value?.value === "number" ? Math.round(value.value * 100) : undefined;
}

function unsignedBenefit(
  items: NonNullable<CoverageEligibilityResponse["insurance"]>[number]["item"],
  pattern: RegExp,
): number | undefined {
  const item = items?.find((candidate) => pattern.test(`${candidate.name ?? ""} ${candidate.description ?? ""}`));
  return item?.benefit?.find((benefit) => benefit.allowedUnsignedInt !== undefined)?.allowedUnsignedInt;
}
