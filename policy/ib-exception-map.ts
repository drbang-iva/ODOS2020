export const IB_ACTOR_CLASSIFICATION = "health-care-provider" as const;

export const IB_EXCEPTIONS = [
  "preventing-harm",
  "privacy",
  "security",
  "infeasibility",
  "health-IT-performance",
  "content-and-manner",
  "fees",
  "licensing",
] as const;

export type InformationBlockingException = (typeof IB_EXCEPTIONS)[number];

export const IB_EXCEPTION_BY_DENIAL_REASON = {
  "access-policy-compartment-isolation": "privacy",
  "compartment-isolation": "privacy",
  "outside-patient-compartment": "privacy",
  "minimum-necessary": "privacy",
  "break-glass-expired": "security",
  "security-context-missing": "security",
  "mandate-8-boundary": "security",
  "authentication-failed": "security",
  "integrity-check-failed": "security",
  "rate-limit": "health-IT-performance",
  "service-unavailable": "health-IT-performance",
  "query-too-expensive": "health-IT-performance",
  "unsupported-format": "content-and-manner",
  "not-licensed": "licensing",
  "fee-required": "fees",
  "patient-safety-risk": "preventing-harm",
  "technically-infeasible": "infeasibility",
} as const satisfies Record<string, InformationBlockingException>;

export function informationBlockingExceptionForDenial(
  reason: string | undefined,
): InformationBlockingException {
  const normalized = (reason ?? "").trim().toLowerCase();
  if (!normalized) {
    return "security";
  }

  for (const [needle, exception] of Object.entries(IB_EXCEPTION_BY_DENIAL_REASON)) {
    if (normalized.includes(needle) || normalized.includes(needle.replaceAll("-", " "))) {
      return exception;
    }
  }

  if (normalized.includes("privacy") || normalized.includes("compartment")) {
    return "privacy";
  }
  if (normalized.includes("rate") || normalized.includes("performance")) {
    return "health-IT-performance";
  }
  if (normalized.includes("license")) {
    return "licensing";
  }
  if (normalized.includes("fee")) {
    return "fees";
  }
  if (normalized.includes("harm") || normalized.includes("safety")) {
    return "preventing-harm";
  }
  if (normalized.includes("infeasible") || normalized.includes("impossible")) {
    return "infeasibility";
  }
  if (normalized.includes("format") || normalized.includes("content")) {
    return "content-and-manner";
  }

  return "security";
}

export function isInformationBlockingException(
  value: string | undefined,
): value is InformationBlockingException {
  return IB_EXCEPTIONS.includes(value as InformationBlockingException);
}
