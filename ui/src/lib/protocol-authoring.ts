import { authHeaders, clinicalGraphApiBase, type DiagnosisVisitStatus } from "./clinical-graph-client";

export type LateralityMode = "inherit-dx" | "OU-always" | { fixed: "OD" | "OS" | "OU" };
export type ProtocolItemType =
  | "finding-seed"
  | "order"
  | "medication"
  | "counseling"
  | "education"
  | "instruction"
  | "follow-up"
  | "charge-seed";

export interface ProtocolItem {
  itemKey: string;
  itemType: ProtocolItemType;
  defaultSelected: boolean;
  lateralityMode: LateralityMode;
  mergeKey?: string;
  linkedDxScope?: string[];
  payload: Record<string, unknown>;
  capture?: {
    source: "device-measured" | "observed-estimate" | "structured";
    seedValueKept?: boolean;
  };
}

export type ProtocolTrigger =
  | { kind: "diagnosis"; dxKeys: string[]; statusScope?: DiagnosisVisitStatus[] }
  | { kind: "visit-type"; visitTypes: string[] };

export interface ProtocolDraft {
  title: string;
  trigger: ProtocolTrigger;
  applicability?: Record<string, unknown>;
  ownership: { ownerId: string; sharing: string };
  categories: string[];
  items: ProtocolItem[];
  mergePolicy?: Record<string, unknown>;
  provenanceNote?: string;
}

export interface ProtocolDefinition extends ProtocolDraft {
  id: string;
  version: number;
  draft?: ProtocolDraft;
  status: "draft" | "active" | "retired";
  authoring: {
    origin: "clinician" | "encounter-capture";
    at: string;
    actor: string;
  };
  audit: {
    createdBy: string;
    createdAt: string;
    publishedBy?: string;
    publishedAt?: string;
    forkedFrom?: { id: string; version: number };
  };
}

export interface ProtocolValidationIssue {
  reason:
    | "DEVICE_MEASURED_SEED"
    | "UNKNOWN_CATALOG_KEY"
    | "CAPTURED_FREE_TEXT"
    | "EMPTY_ITEM_LIST";
  itemKey?: string;
  message: string;
}

export interface ProtocolLibraryResponse {
  protocols: ProtocolDefinition[];
  catalogs: {
    findingKeys: string[];
    procedureKeys: string[];
  };
}

export function editableProtocolDraft(protocol: ProtocolDefinition): ProtocolDraft {
  return structuredClone(protocol.draft ?? {
    title: protocol.title,
    trigger: protocol.trigger,
    ownership: protocol.ownership,
    categories: protocol.categories,
    items: protocol.items,
    ...(protocol.applicability ? { applicability: protocol.applicability } : {}),
    ...(protocol.mergePolicy ? { mergePolicy: protocol.mergePolicy } : {}),
    ...(protocol.provenanceNote ? { provenanceNote: protocol.provenanceNote } : {}),
  });
}

export async function loadProtocolLibrary(): Promise<ProtocolLibraryResponse> {
  return request("/clinical-graph/protocols");
}

export async function createProtocolDraft(
  draft: Partial<ProtocolDraft> = {},
): Promise<{ protocol: ProtocolDefinition; validation: ProtocolValidationIssue[] }> {
  return request("/clinical-graph/protocols", { method: "POST", body: draft });
}

export async function saveProtocolDraft(
  id: string,
  draft: ProtocolDraft,
): Promise<{ protocol: ProtocolDefinition; validation: ProtocolValidationIssue[] }> {
  return request(`/clinical-graph/protocols/${encodeURIComponent(id)}/draft`, {
    method: "PATCH",
    body: draft,
  });
}

export async function publishProtocol(id: string): Promise<{ protocol: ProtocolDefinition }> {
  return request(`/clinical-graph/protocols/${encodeURIComponent(id)}/publish`, {
    method: "POST",
    body: {},
  });
}

export async function retireProtocol(id: string): Promise<{ protocol: ProtocolDefinition }> {
  return request(`/clinical-graph/protocols/${encodeURIComponent(id)}/retire`, {
    method: "POST",
    body: {},
  });
}

export async function forkProtocol(
  id: string,
  title?: string,
): Promise<{ protocol: ProtocolDefinition }> {
  return request(`/clinical-graph/protocols/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    body: title ? { title } : {},
  });
}

export async function captureEncounterProtocol(
  encounterId: string,
  name: string,
): Promise<{ protocol: ProtocolDefinition; validation: ProtocolValidationIssue[] }> {
  return request(`/clinical-graph/encounters/${encodeURIComponent(encounterId)}/save-as-protocol`, {
    method: "POST",
    body: { name },
  });
}

async function request<T>(
  path: string,
  options: { method?: "POST" | "PATCH"; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${clinicalGraphApiBase()}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...authHeaders(),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await response.json() as T & {
    error?: string;
    reason?: string;
  };
  if (!response.ok) {
    throw new Error([body.reason, body.error ?? `Protocol request failed: ${response.status}`].filter(Boolean).join(": "));
  }
  return body;
}
