import type { AuditEvent, Basic, Bundle, Resource } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../authz/roles.js";
import { searchAll } from "../fhir-search.js";
import type { CorrespondenceLetterType } from "./template-store.js";

export const CORRESPONDENCE_POLICY_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/basic-kind";
export const CORRESPONDENCE_POLICY_CODE = "correspondence-policy";
export const CORRESPONDENCE_POLICY_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/correspondence-policy";
export const CORRESPONDENCE_POLICY_IDENTIFIER_VALUE = "primary";
export const CORRESPONDENCE_AUDIT_EVENT_TYPE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/audit-event-type";
export const CORRESPONDENCE_POLICY_WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/correspondence-policy",
} as const;

export interface CorrespondencePolicy {
  staffSendableLetterTypes: CorrespondenceLetterType[];
}

interface PolicyFhirClient {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(
    url: string,
    resourceType?: T["resourceType"],
  ): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T>;
}

const DEFAULT_POLICY: CorrespondencePolicy = {
  staffSendableLetterTypes: ["records-transfer"],
};

export class CorrespondencePolicyStore {
  constructor(private readonly fhir: PolicyFhirClient) {}

  async read(): Promise<CorrespondencePolicy> {
    const resource = await this.readResource();
    return resource ? parsePolicy(resource) : DEFAULT_POLICY;
  }

  async save(policy: CorrespondencePolicy): Promise<CorrespondencePolicy> {
    validatePolicy(policy);
    const existing = await this.readResource();
    const resource = buildPolicy(policy, existing);
    const saved = existing?.id
      ? await this.fhir.update(
          "Basic",
          existing.id,
          resource,
          CORRESPONDENCE_POLICY_WRITE_HEADERS,
        )
      : await this.fhir.create(resource, {
          ...CORRESPONDENCE_POLICY_WRITE_HEADERS,
          "If-None-Exist":
            `identifier=${CORRESPONDENCE_POLICY_IDENTIFIER_SYSTEM}|${CORRESPONDENCE_POLICY_IDENTIFIER_VALUE}`,
        });
    return parsePolicy(saved);
  }

  private async readResource(): Promise<Basic | undefined> {
    const resources = await searchAll<Basic>(this.fhir, "Basic", {
      code: `${CORRESPONDENCE_POLICY_CODE_SYSTEM}|${CORRESPONDENCE_POLICY_CODE}`,
      identifier:
        `${CORRESPONDENCE_POLICY_IDENTIFIER_SYSTEM}|${CORRESPONDENCE_POLICY_IDENTIFIER_VALUE}`,
      _count: "2",
    });
    return resources[0];
  }
}

export function assertCorrespondenceActionAllowed(
  role: PracticeRoleId,
  action: "draft" | "sign" | "send",
  letterType: CorrespondenceLetterType,
  staffSendableLetterTypes: readonly CorrespondenceLetterType[],
): void {
  if (action === "draft") return;
  const provider = role === "provider";
  if (action === "sign" && !provider) {
    throw new Error("Only a provider may sign clinical correspondence.");
  }
  if (
    action === "send"
    && !provider
    && !staffSendableLetterTypes.includes(letterType)
  ) {
    throw new Error("Only a provider may send this clinical correspondence type.");
  }
}

export function buildCorrespondenceAuditEvent(input: {
  action: "sign" | "send";
  actorReference: string;
  actorRole: PracticeRoleId;
  patientReference: string;
  documentReference: string;
  recordedAt: string;
}): AuditEvent {
  assertReference(input.actorReference, ["Practitioner", "PractitionerRole"]);
  assertReference(input.patientReference, ["Patient"]);
  assertReference(input.documentReference, ["DocumentReference"]);
  return {
    resourceType: "AuditEvent",
    type: {
      system: CORRESPONDENCE_AUDIT_EVENT_TYPE_SYSTEM,
      code: `correspondence.${input.action}`,
      display: `Correspondence ${input.action}`,
    },
    action: "U",
    recorded: input.recordedAt,
    outcome: "0",
    agent: [{
      who: { reference: input.actorReference },
      role: [{ text: input.actorRole }],
      requestor: true,
    }],
    source: { observer: { reference: "Device/odos-instance" } },
    entity: [
      { what: { reference: input.patientReference }, name: "patient" },
      { what: { reference: input.documentReference }, name: "correspondence" },
    ],
  };
}

function buildPolicy(policy: CorrespondencePolicy, existing?: Basic): Basic {
  validatePolicy(policy);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{
      system: CORRESPONDENCE_POLICY_IDENTIFIER_SYSTEM,
      value: CORRESPONDENCE_POLICY_IDENTIFIER_VALUE,
    }],
    code: {
      coding: [{
        system: CORRESPONDENCE_POLICY_CODE_SYSTEM,
        code: CORRESPONDENCE_POLICY_CODE,
        display: "Correspondence policy",
      }],
    },
    extension: policy.staffSendableLetterTypes.map((letterType) => ({
      url: "staff-sendable-letter-type",
      valueCode: letterType,
    })),
  };
}

function parsePolicy(resource: Basic): CorrespondencePolicy {
  const policy = {
    staffSendableLetterTypes: (resource.extension ?? []).flatMap((extension) =>
      extension.url === "staff-sendable-letter-type" && extension.valueCode
        ? [extension.valueCode]
        : []),
  };
  validatePolicy(policy);
  return policy;
}

function validatePolicy(policy: CorrespondencePolicy): void {
  if (
    policy.staffSendableLetterTypes.some(
      (letterType) => !/^[a-z][a-z0-9-]{0,63}$/.test(letterType),
    )
  ) {
    throw new Error("Staff-sendable correspondence types must use stable codes.");
  }
}

function assertReference(reference: string, resourceTypes: readonly string[]): void {
  const match = /^([A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(reference);
  if (!match || !resourceTypes.includes(match[1]!)) {
    throw new Error(`Expected ${resourceTypes.join(" or ")} reference.`);
  }
}
