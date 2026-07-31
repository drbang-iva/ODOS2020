import type { DocumentReference, Resource, Task } from "@medplum/fhirtypes";
import { z } from "zod";
import {
  buildOdosAuditEventRow,
  type OdosAuditEventRecord,
} from "./odosAudit.js";
import {
  resolveBusinessActionRole,
  type BusinessAction,
  type PracticeRoleId,
} from "./roles.js";

export interface DocumentPrintAuditEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    roles: readonly PracticeRoleId[];
    fhir: {
      read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
    };
  } | null>;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
}

export interface DocumentPrintAuditEndpointResult {
  status: number;
  body: unknown;
}

const documentPrintAuditSchema = z.object({
  eventType: z.literal("document.print.requested"),
  documentKind: z.enum(["letter", "statement"]),
  documentReference: z.string().regex(/^(DocumentReference|Task)\/[A-Za-z0-9.-]{1,64}$/),
  patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]{1,64}$/),
}).strict();

export async function handleDocumentPrintAuditRequest(
  deps: DocumentPrintAuditEndpointDeps,
  input: {
    authHeader: string | undefined;
    body: unknown;
    ipAddress?: string;
    userAgent?: string;
  },
): Promise<DocumentPrintAuditEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to record document print." } };
  }
  const parsed = documentPrintAuditSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid document print audit." },
    };
  }

  const businessAction: BusinessAction = parsed.data.documentKind === "letter"
    ? "chart.read"
    : "claims.manage";
  const actorRole = resolveBusinessActionRole(staff.roles, businessAction);
  if (!actorRole) {
    return { status: 403, body: { error: `${businessAction} role required` } };
  }

  const [resourceType, resourceId] = parsed.data.documentReference.split("/") as [
    "DocumentReference" | "Task",
    string,
  ];
  let target: DocumentReference | Task;
  try {
    target = resourceType === "DocumentReference"
      ? await staff.fhir.read<DocumentReference>("DocumentReference", resourceId)
      : await staff.fhir.read<Task>("Task", resourceId);
  } catch (error) {
    const status = statusOf(error);
    if (status === 403 || status === 404) {
      return { status, body: { error: "Document is unavailable to this staff member." } };
    }
    throw error;
  }

  const targetPatientReference = target.resourceType === "DocumentReference"
    ? target.subject?.reference
    : target.for?.reference;
  if (targetPatientReference !== parsed.data.patientReference) {
    return { status: 403, body: { error: "Document does not belong to the requested patient." } };
  }

  const row = buildOdosAuditEventRow({
    eventType: parsed.data.eventType,
    actorReference: staff.staffReference,
    actorRole,
    patientReference: parsed.data.patientReference,
    targetReference: parsed.data.documentReference,
    actionOutcome: "granted",
    actionReason: `document-kind=${parsed.data.documentKind}; document-reference=${parsed.data.documentReference}`,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
  await deps.recordAudit(row);
  return { status: 201, body: { id: row.id } };
}

function statusOf(error: unknown): number | undefined {
  return error instanceof Error
    ? (error as Error & { status?: number }).status
    : undefined;
}
