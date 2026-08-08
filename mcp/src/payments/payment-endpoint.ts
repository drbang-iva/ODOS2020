import type { AccessPolicy, ProjectMembership, User } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import {
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../authz/roles.js";
import type { AdapterRegistration } from "./payment-config.js";
import { assertStripeAdapterConfig, STRIPE_BASE_URL } from "./adapters/stripe-adapter.js";

/**
 * odos-core payment endpoint helpers — the env-driven adapter registrations built at service
 * start, and the authn step that turns the UI's forwarded Medplum bearer token into a verified
 * staff identity. Authorization (who may take a payment) is the `payment.charge` business action
 * asserted in the route, same pattern as `audit.read` on /audit/events.
 */

/**
 * Build the practice's adapter registrations from env. The manual-cash adapter is always
 * registered (zero config — cash exists at every practice). Clover registers when its env vars
 * are present; a partial Clover config fails fast at service start rather than silently
 * disabling card payments. Stripe registers from a test secret key; an explicit base URL without
 * that key is also a partial configuration error. Env names match the payment sandbox docs.
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

  if (env.STRIPE_SECRET_KEY) {
    const config = {
      baseUrl: env.STRIPE_BASE_URL || STRIPE_BASE_URL,
      secretKey: env.STRIPE_SECRET_KEY,
    };
    assertStripeAdapterConfig(config);
    registrations.push({
      method: "stripe",
      config,
    });
  } else if (env.STRIPE_BASE_URL) {
    throw new Error(
      "Stripe payment adapter is partially configured — missing STRIPE_SECRET_KEY. " +
        "Set STRIPE_SECRET_KEY or remove STRIPE_BASE_URL (see docs/payments-stripe-sandbox.md).",
    );
  }

  return registrations;
}

export interface VerifiedStaffToken {
  /** Practitioner / PractitionerRole reference for requestor + audit attribution. */
  staffReference: string;
  email?: string;
  userReference?: string;
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
    user?: { resourceType?: string; id?: string; email?: string; reference?: string };
  };
  const profile = body.profile;
  if (
    !profile?.id ||
    (profile.resourceType !== "Practitioner" && profile.resourceType !== "PractitionerRole")
  ) {
    return null;
  }
  const userReference = body.user?.reference ??
    (body.user?.resourceType === "User" && body.user.id ? `User/${body.user.id}` : undefined);
  return {
    staffReference: `${profile.resourceType}/${profile.id}`,
    ...(body.user?.email ? { email: body.user.email } : {}),
    ...(userReference ? { userReference } : {}),
  };
}

export interface ResolvedStaffRoles {
  staffReference: string;
  email: string;
  roles: PracticeRoleId[];
}

export class StaffRoleServiceUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Staff role service is temporarily unavailable.", { cause });
    this.name = "StaffRoleServiceUnavailableError";
  }
}

export async function resolveStaffRoles(opts: {
  baseUrl: string;
  authHeader: string | undefined;
  serviceClient: Pick<MedplumClient, "search" | "read">;
  refreshServiceClient?: () => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedStaffRoles | null> {
  const verified = await verifyMedplumStaffToken({
    baseUrl: opts.baseUrl,
    authHeader: opts.authHeader,
    fetchImpl: opts.fetchImpl,
  });
  if (!verified) return null;

  try {
    return await resolveRolesWithServiceClient(opts.serviceClient, verified);
  } catch (error) {
    if (!isUnauthorizedServiceError(error)) throw error;
    if (!opts.refreshServiceClient) throw new StaffRoleServiceUnavailableError(error);
    try {
      await opts.refreshServiceClient();
      return await resolveRolesWithServiceClient(opts.serviceClient, verified);
    } catch (retryError) {
      throw new StaffRoleServiceUnavailableError(retryError);
    }
  }
}

async function resolveRolesWithServiceClient(
  serviceClient: Pick<MedplumClient, "search" | "read">,
  verified: VerifiedStaffToken,
): Promise<ResolvedStaffRoles> {
  const memberships = await serviceClient.search<ProjectMembership>("ProjectMembership", {
    profile: verified.staffReference,
  });
  const policyIds = new Set<string>();
  for (const entry of memberships.entry ?? []) {
    const membership = entry.resource;
    if (!membership) continue;
    for (const access of membership.access ?? []) {
      const id = access.policy.reference?.match(/^AccessPolicy\/([^/]+)$/)?.[1];
      if (id) policyIds.add(id);
    }
    const legacyId = membership.accessPolicy?.reference?.match(/^AccessPolicy\/([^/]+)$/)?.[1];
    if (legacyId) policyIds.add(legacyId);
  }

  const found = new Set<PracticeRoleId>();
  for (const policyId of policyIds) {
    let policy: AccessPolicy;
    try {
      policy = await serviceClient.read<AccessPolicy>("AccessPolicy", policyId);
    } catch (error) {
      if (isUnauthorizedServiceError(error)) throw error;
      continue;
    }
    for (const tag of policy.meta?.tag ?? []) {
      if (
        tag.system === ODOS_PRACTICE_ROLE_SYSTEM &&
        tag.code &&
        PRACTICE_ROLE_IDS.includes(tag.code as PracticeRoleId)
      ) {
        found.add(tag.code as PracticeRoleId);
      }
    }
  }
  const roles = PRACTICE_ROLE_IDS.filter((role) => found.has(role));
  const userReference = verified.userReference ??
    memberships.entry?.map((entry) => entry.resource?.user.reference).find(Boolean);
  let email = verified.email;
  const userId = userReference?.match(/^User\/([^/]+)$/)?.[1];
  if (!email && userId) {
    email = (await serviceClient.read<User>("User", userId)).email;
  }
  return { staffReference: verified.staffReference, email: email ?? "unknown", roles };
}

function isUnauthorizedServiceError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 401) {
    return true;
  }
  return error instanceof Error && /FHIR\s+401\b/.test(error.message);
}
