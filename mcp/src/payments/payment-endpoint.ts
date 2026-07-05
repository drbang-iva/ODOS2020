import type { AdapterRegistration } from "./payment-config.js";

/**
 * osod-core payment endpoint helpers — the env-driven adapter registrations built at service
 * start, and the authn step that turns the UI's forwarded Medplum bearer token into a verified
 * staff identity. Authorization (who may take a payment) is the `payment.charge` business action
 * asserted in the route, same pattern as `audit.read` on /audit/events.
 */

/**
 * Build the practice's adapter registrations from env. The manual-cash adapter is always
 * registered (zero config — cash exists at every practice). Clover registers when its env vars
 * are present; a partial Clover config fails fast at service start rather than silently
 * disabling card payments. Env names match docs/payments-clover-sandbox.md.
 */
export function paymentAdapterRegistrationsFromEnv(
  env: Record<string, string | undefined>,
): AdapterRegistration[] {
  const registrations: AdapterRegistration[] = [{ method: "manual-cash" }];

  const cloverVars = [
    "CLOVER_BASE_URL",
    "CLOVER_ACCESS_TOKEN",
    "CLOVER_DEVICE_ID",
    "CLOVER_POS_ID",
  ] as const;
  const present = cloverVars.filter((name) => Boolean(env[name]));
  if (present.length === cloverVars.length) {
    registrations.push({
      method: "clover",
      config: {
        baseUrl: env.CLOVER_BASE_URL!,
        accessToken: env.CLOVER_ACCESS_TOKEN!,
        deviceId: env.CLOVER_DEVICE_ID!,
        posId: env.CLOVER_POS_ID!,
      },
    });
  } else if (present.length > 0) {
    const missing = cloverVars.filter((name) => !env[name]);
    throw new Error(
      `Clover payment adapter is partially configured — missing ${missing.join(", ")}. ` +
        "Set all four CLOVER_* vars or none (see docs/payments-clover-sandbox.md).",
    );
  }

  return registrations;
}

export interface VerifiedStaffToken {
  /** Practitioner / PractitionerRole reference for requestor + audit attribution. */
  staffReference: string;
}

/**
 * Verify the forwarded Medplum bearer token by asking Medplum who it belongs to (GET /auth/me).
 * Resolves the staff Practitioner/PractitionerRole reference, or null for anything else —
 * missing/non-Bearer headers, rejected tokens, or tokens whose profile is not staff (a Patient
 * token cannot take payments).
 */
export async function verifyMedplumStaffToken(opts: {
  baseUrl: string;
  authHeader: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<VerifiedStaffToken | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.authHeader?.match(/^Bearer (.+)$/)?.[1];
  if (!token) {
    return null;
  }

  const response = await fetchImpl(`${opts.baseUrl.replace(/\/$/, "")}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as {
    profile?: { resourceType?: string; id?: string };
  };
  const profile = body.profile;
  if (
    !profile?.id ||
    (profile.resourceType !== "Practitioner" && profile.resourceType !== "PractitionerRole")
  ) {
    return null;
  }
  return { staffReference: `${profile.resourceType}/${profile.id}` };
}
