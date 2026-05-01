import { randomUUID } from "node:crypto";
import {
  buildOsodAuditEventRow,
  type OsodActorRole,
  type OsodAuditEventRecord,
} from "../../authz/osodAudit.js";
import {
  assertInstallPolicy,
  readSmartClientApp,
  SMART_APP_REGISTRY_POLICY_URL,
  SmartAppRegistryError,
  V055B_SMART_CAPABILITIES,
  type OSODSmartClientApp,
} from "./smart-client-app.js";

export interface SmartAppInstallationRecord {
  readonly id: string;
  readonly canonicalResourceType: "Endpoint" | "Device";
  readonly canonicalResourceId: string;
  readonly clientId?: string;
  readonly installState: "pending-review" | "installed" | "rejected" | "removed" | "blocked";
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  readonly blockReason?: string;
  readonly compatibilityGapAttested: boolean;
}

export class InMemorySmartAppInstallationRepository {
  readonly records: SmartAppInstallationRecord[] = [];

  save(record: SmartAppInstallationRecord): SmartAppInstallationRecord {
    this.records.push(record);
    return record;
  }
}

export function assertSmartAppAdminActionAllowed(input: {
  readonly actorId?: string;
  readonly actorRole?: OsodActorRole | string;
}): void {
  if (!input.actorId || input.actorRole !== "practice-admin") {
    throw new SmartAppRegistryError(
      "admin-authorization-required",
      "SMART app registry admin actions require a human-supervised practice-admin session.",
      403,
    );
  }
}

export function reviewSmartAppInstall(input: {
  readonly app: OSODSmartClientApp;
  readonly adminUserId?: string;
  readonly adminRole?: OsodActorRole | string;
  readonly practiceJurisdiction?: string;
  readonly requiredCapabilities?: readonly string[];
  readonly supportedCapabilities?: readonly string[];
  readonly adminAttestedCompatibilityGap?: boolean;
  readonly repository?: InMemorySmartAppInstallationRepository;
  readonly now?: string;
}): { readonly installation?: SmartAppInstallationRecord; readonly auditRows: readonly OsodAuditEventRecord[] } {
  assertSmartAppAdminActionAllowed({ actorId: input.adminUserId, actorRole: input.adminRole });
  const app = readSmartClientApp(input.app.canonicalRecord);
  const auditRows: OsodAuditEventRecord[] = [];
  const now = input.now ?? new Date().toISOString();
  try {
    assertCapabilityMatch({
      requiredCapabilities: input.requiredCapabilities ?? [],
      supportedCapabilities: input.supportedCapabilities ?? V055B_SMART_CAPABILITIES,
      adminAttestedCompatibilityGap: input.adminAttestedCompatibilityGap ?? false,
    });
    assertInstallPolicy(app.policy, { practiceJurisdiction: input.practiceJurisdiction });
    const installation: SmartAppInstallationRecord = {
      id: randomUUID(),
      canonicalResourceType: app.canonicalRecord.resourceType,
      canonicalResourceId: app.canonicalRecord.id ?? "unassigned",
      clientId: app.clientId,
      installState: "installed",
      reviewedBy: input.adminUserId,
      reviewedAt: now,
      compatibilityGapAttested: input.adminAttestedCompatibilityGap ?? false,
    };
    input.repository?.save(installation);
    auditRows.push(
      buildOsodAuditEventRow({
        eventType: "smart-app-installed",
        actorId: input.adminUserId,
        actorRole: "practice-admin",
        resourceType: installation.canonicalResourceType,
        resourceId: installation.canonicalResourceId,
        policyUrl: SMART_APP_REGISTRY_POLICY_URL,
        actionReason: "SMART app installed after local admin review",
      }),
    );
    return { installation, auditRows };
  } catch (error) {
    const code = error instanceof SmartAppRegistryError ? error.code : "smart-app-install-rejected";
    const eventType = code === "jurisdiction-violation" ? "smart-app-jurisdiction-blocked" : "smart-app-install-rejected";
    const installation: SmartAppInstallationRecord = {
      id: randomUUID(),
      canonicalResourceType: app.canonicalRecord.resourceType,
      canonicalResourceId: app.canonicalRecord.id ?? "unassigned",
      clientId: app.clientId,
      installState: "blocked",
      reviewedBy: input.adminUserId,
      reviewedAt: now,
      blockReason: error instanceof Error ? error.message : String(error),
      compatibilityGapAttested: input.adminAttestedCompatibilityGap ?? false,
    };
    input.repository?.save(installation);
    auditRows.push(
      buildOsodAuditEventRow({
        eventType,
        actorId: input.adminUserId,
        actorRole: "practice-admin",
        resourceType: installation.canonicalResourceType,
        resourceId: installation.canonicalResourceId,
        policyUrl: SMART_APP_REGISTRY_POLICY_URL,
        actionOutcome: "denied",
        actionReason: installation.blockReason,
      }),
    );
    return { auditRows };
  }
}

export function capabilityGaps(input: {
  readonly requiredCapabilities: readonly string[];
  readonly supportedCapabilities?: readonly string[];
}): string[] {
  const supported = new Set(input.supportedCapabilities ?? V055B_SMART_CAPABILITIES);
  return input.requiredCapabilities.filter((capability) => !supported.has(capability));
}

function assertCapabilityMatch(input: {
  readonly requiredCapabilities: readonly string[];
  readonly supportedCapabilities: readonly string[];
  readonly adminAttestedCompatibilityGap: boolean;
}): void {
  const gaps = capabilityGaps(input);
  if (gaps.length && !input.adminAttestedCompatibilityGap) {
    throw new SmartAppRegistryError(
      "compatibility-gap-attestation-required",
      `Compatibility gap requires admin attestation: ${gaps.join(", ")}`,
    );
  }
}
