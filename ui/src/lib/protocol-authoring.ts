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

export function protocolActionDisabled(
  busy: boolean,
  applicationId: string | undefined,
  diagnosisAvailable: boolean,
): boolean {
  return busy || (!applicationId && !diagnosisAvailable);
}

export function retainAppliedProtocolOffers<T extends { id: string }>(
  offers: T[],
  applications: Array<{ protocolId: string; confirmed: boolean; undoState: string }>,
): T[] {
  const activeIds = new Set(applications
    .filter((application) => application.confirmed && application.undoState === "active")
    .map((application) => application.protocolId));
  return offers.filter((offer) => activeIds.has(offer.id));
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

export async function applyEncounterProtocol(input: {
  protocolId: string;
  encounterId: string;
  patientId: string;
  diagnosis: { reference: string; code: string; confirmed: true };
  selections: Array<{ itemKey: string; selected: boolean }>;
}): Promise<{ application?: { id?: string } }> {
  return request("/clinical-graph/protocols/apply", { method: "POST", body: input });
}

export async function unapplyEncounterProtocol(
  applicationId: string,
): Promise<{ removed?: string[]; preserved?: string[] }> {
  return request(`/clinical-graph/protocols/${encodeURIComponent(applicationId)}/unapply`, {
    method: "POST",
  });
}

async function request<T>(
  path: string,
  options: { method?: "POST" | "PATCH"; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${clinicalGraphApiBase()}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...authHeaders(),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: (T & { error?: string; reason?: string }) | undefined;
    try {
      body = text ? JSON.parse(text) as T & { error?: string; reason?: string } : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      throw new Error([
        body?.reason,
        body?.error ?? `Protocol request failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      ].filter(Boolean).join(": "));
    }
    if (body === undefined) throw new Error(`Protocol request returned invalid JSON: ${response.status}.`);
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Protocol request timed out after 15 seconds.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
