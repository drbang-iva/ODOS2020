import type {
  Appointment,
  Encounter,
  Identifier,
  Practitioner,
  Resource,
} from "@medplum/fhirtypes";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";
import { appointmentConfirmationExtension } from "../fhir/appointmentConfirmation.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../fhir/schedulingVisitType.js";
import { disciplineCoding } from "../scheduling/clinic-mode.js";
import {
  MIGRATION_TAG_CODE,
  MIGRATION_TAG_SYSTEM,
} from "./access-policy.js";
import {
  analyzeAppointmentExport,
  EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
  type AppointmentExportAmbiguity,
  type PreparedAppointmentRow,
  VERIFIED_APPOINTMENT_EXPORT_OFFICE,
} from "./appointment-export.js";
import type { ImportAction, ImportLedger, ImportResourceType } from "./import-ledger.js";
import {
  FORBIDDEN_M2A_EHR_SOURCE_KEY,
  FORBIDDEN_M2A_EPM_SOURCE_KEY,
} from "./patient-import.js";

export const EYEFINITY_PROVIDER_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/eyefinity-provider-id";
export const EYEFINITY_TECHNICAL_VISIT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/eyefinity-technical-visit";
export const EYEFINITY_EXAM_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/eyefinity-exam-id";
export const MIGRATED_IMAGING_VISIT_CODE = "migrated-imaging-visit";
export const MIGRATED_IMAGING_VISIT_DISPLAY = "Imaging visit — migrated";
export const MIGRATION_TEST_TAG_CODE = "operator-marked-test";
export const PRACTICE_TIME_ZONE = "America/New_York";

const HL7_V3_ACT_ENCOUNTER_CLASS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const EXAM_EXPORT_COLUMNS = ["ptSrNo", "exSrNo", "exDateTime", "exDevType", "exWhichEye"] as const;

const visitTypeMappingSchema = z.object({
  code: z.string().trim().min(1),
  display: z.string().trim().min(1),
});

export const appointmentEncounterImportManifestSchema = z.object({
  sourceOfficeNumber: z.literal(VERIFIED_APPOINTMENT_EXPORT_OFFICE),
  patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/),
  patientUid: z.string().trim().min(1),
  epmPatientId: z.string().trim().min(1),
  ehrPatientId: z.string().trim().min(1),
  organizationReference: z.string().regex(/^Organization\/[A-Za-z0-9.-]+$/),
  locationReference: z.string().regex(/^Location\/[A-Za-z0-9.-]+$/),
  visitTypeMap: z.record(visitTypeMappingSchema),
});

export type AppointmentEncounterImportManifest = z.infer<
  typeof appointmentEncounterImportManifestSchema
>;

export interface AppointmentEncounterImportResult {
  readonly analysis: {
    readonly sourceRows: number;
    readonly exactDuplicates: number;
    readonly rowsAfterExactDedupe: number;
    readonly collisionGroups: number;
    readonly collisionRows: number;
    readonly resolvedCancelGroups: number;
    readonly allCancelledSkipped: number;
    readonly ambiguousCollisionGroups: number;
  };
  readonly appointments: Readonly<Record<ImportAction, number>>;
  readonly encounters: Readonly<Record<ImportAction, number>>;
  readonly practitioners: Readonly<Record<ImportAction, number>>;
  readonly visitDays: number;
}

interface VisitDay {
  readonly date: string;
  readonly exSrNos: readonly string[];
}

interface ResourceResult<T extends Resource> {
  readonly resource?: T;
  readonly action: ImportAction;
}

type VisitFhirClient = Pick<
  MedplumClient,
  "search" | "searchUrl" | "create" | "update"
>;

export async function importLegacyAppointmentsAndEncounters(input: {
  readonly fhir: VisitFhirClient;
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly projectId: string;
  readonly manifest: AppointmentEncounterImportManifest;
  readonly appointmentsCsv: string;
  readonly examsTsv: string;
  readonly now?: Date;
}): Promise<AppointmentEncounterImportResult> {
  const manifest = appointmentEncounterImportManifestSchema.parse(input.manifest);
  const analysis = analyzeAppointmentExport(
    input.appointmentsCsv,
    manifest.sourceOfficeNumber,
  );
  const selectedRows = analysis.appointments.filter(
    (entry) => normalized(entry.row.PatientUID) === normalized(manifest.patientUid),
  );
  const selectedAmbiguities = analysis.ambiguities.filter(
    (entry) => normalized(entry.patientUid) === normalized(manifest.patientUid),
  );
  assertPatientId(selectedRows, manifest.epmPatientId);
  const appointmentCounts = actionCounts();
  const encounterCounts = actionCounts();
  const practitionerCounts = actionCounts();
  input.ledger.recordResourceAction({
    runId: input.runId,
    sourceKey: manifest.ehrPatientId,
    resourceType: "Patient",
    resourceReference: manifest.patientReference,
    action: "skipped",
    reason: "selected-patient-verified",
  });

  for (const sourceKey of analysis.duplicateSourceKeys.filter(
    (value) => appointmentSourceKeyPatientUid(value) === normalized(manifest.patientUid),
  )) {
    input.ledger.recordJunkRejection({
      runId: input.runId,
      sourceSystem: "eyefinity-appointments",
      sourceKey,
      reason: "byte-identical-export-duplicate",
    });
  }
  for (const sourceKey of analysis.allCancelledSourceKeys.filter(
    (value) => appointmentSourceKeyPatientUid(value) === normalized(manifest.patientUid),
  )) {
    input.ledger.recordJunkRejection({
      runId: input.runId,
      sourceSystem: "eyefinity-appointments",
      sourceKey,
      reason: "all-cancelled-collision-group",
    });
  }
  for (const ambiguity of selectedAmbiguities) {
    recordAppointmentCollision(input.ledger, ambiguity);
    recordResourceAction(
      input.ledger,
      input.runId,
      ambiguity.sourceKey,
      "Appointment",
      "conflict",
      "composite-collision-queued",
    );
  }

  const inconsistentProviders = inconsistentProviderIds(selectedRows);
  for (const providerId of inconsistentProviders) {
    if (input.ledger.readAdjudication("provider", providerId)?.decision === "exclude") {
      continue;
    }
    input.ledger.recordAmbiguity({
      sourceKind: "provider",
      sourceKey: providerId,
      ambiguityType: "source-name",
      details: { reason: "one-provider-id-has-multiple-source-names" },
    });
    recordResourceAction(
      input.ledger,
      input.runId,
      providerId,
      "Practitioner",
      "conflict",
      "provider-source-name-ambiguity",
    );
    practitionerCounts.conflict += 1;
  }

  const practitionerCache = new Map<string, ResourceResult<Practitioner>>();
  const excludedProviderIds = new Set<string>();
  const importedAppointments = new Map<string, Appointment>();
  for (const source of [...selectedRows].sort((left, right) =>
    left.sourceKey.localeCompare(right.sourceKey)
  )) {
    const visitType = manifest.visitTypeMap[normalized(source.row.appt_type)];
    if (!visitType) {
      const adjudication = input.ledger.readAdjudication("appointment", source.sourceKey);
      if (adjudication?.decision === "exclude") {
        recordResourceAction(
          input.ledger,
          input.runId,
          source.sourceKey,
          "Appointment",
          "skipped",
          "excluded-by-adjudication",
        );
        appointmentCounts.skipped += 1;
        continue;
      }
      const reason = "unmapped-legacy-visit-type";
      input.ledger.recordAmbiguity({
        sourceKind: "appointment",
        sourceKey: source.sourceKey,
        ambiguityType: "visit-type",
        details: { reason },
      });
      recordResourceAction(input.ledger, input.runId, source.sourceKey, "Appointment", "conflict", reason);
      appointmentCounts.conflict += 1;
      continue;
    }

    const providerId = normalized(source.row.ProviderID);
    let practitionerReference: string | undefined;
    if (providerId) {
      const adjudication = input.ledger.readAdjudication("provider", providerId);
      if (adjudication?.decision === "exclude") {
        if (!excludedProviderIds.has(providerId)) {
          recordResourceAction(
            input.ledger,
            input.runId,
            providerId,
            "Practitioner",
            "skipped",
            "excluded-by-adjudication",
          );
          practitionerCounts.skipped += 1;
          excludedProviderIds.add(providerId);
        }
      } else if (inconsistentProviders.has(providerId)) {
        const reason = "provider-source-name-ambiguity";
        recordResourceAction(input.ledger, input.runId, source.sourceKey, "Appointment", "conflict", reason);
        appointmentCounts.conflict += 1;
        continue;
      } else {
        let practitioner = practitionerCache.get(providerId);
        if (!practitioner) {
          practitioner = await upsertPractitioner({
            fhir: input.fhir,
            ledger: input.ledger,
            runId: input.runId,
            projectId: input.projectId,
            providerId,
            firstName: normalized(source.row.ProviderFirst) || undefined,
            lastName: normalized(source.row.ProviderLast),
          });
          practitionerCache.set(providerId, practitioner);
          practitionerCounts[practitioner.action] += 1;
        }
        if (!practitioner.resource?.id) {
          const reason = "provider-match-requires-adjudication";
          recordResourceAction(input.ledger, input.runId, source.sourceKey, "Appointment", "conflict", reason);
          appointmentCounts.conflict += 1;
          continue;
        }
        practitionerReference = `Practitioner/${practitioner.resource.id}`;
      }
    }

    const result = await upsertAppointment({
      fhir: input.fhir,
      ledger: input.ledger,
      runId: input.runId,
      projectId: input.projectId,
      manifest,
      source,
      practitionerReference,
      visitType,
      now: input.now ?? new Date(),
    });
    appointmentCounts[result.action] += 1;
    if (result.resource) importedAppointments.set(source.sourceKey, result.resource);
  }

  const visitDays = parseVisitDays(input.examsTsv, manifest.ehrPatientId);
  const rowsByDay = groupByVisitDate(selectedRows);
  const ambiguousDays = new Set(selectedAmbiguities.map((entry) => entry.visitDate));

  for (const visitDay of visitDays) {
    const daySourceKey = technicalVisitKey(manifest.ehrPatientId, visitDay.date);
    if (ambiguousDays.has(visitDay.date)) {
      const reason = "appointment-composite-collision";
      recordResourceAction(input.ledger, input.runId, daySourceKey, "Encounter", "skipped", reason);
      encounterCounts.skipped += 1;
      continue;
    }

    const dayAppointments = rowsByDay.get(visitDay.date) ?? [];
    if (dayAppointments.length > 1) {
      const appointmentSourceKeys = dayAppointments
        .filter((row) => !row.cancelled)
        .map((row) => row.sourceKey)
        .sort();
      const allocations = visitDay.exSrNos.map((exSrNo) => ({
        exSrNo,
        allocation: input.ledger.readCaptureAllocation(daySourceKey, exSrNo),
      }));
      const invalidAllocations = allocations.filter(({ allocation }) =>
        allocation
        && !dayAppointments.some(
          (row) =>
            row.sourceKey === allocation.appointmentSourceKey
            && !row.cancelled,
        )
      );
      const missingAllocations = allocations.filter(({ allocation }) => !allocation);
      input.ledger.recordAmbiguity({
        sourceKind: "visit-day",
        sourceKey: daySourceKey,
        ambiguityType: "multi-appointment-day",
        details: {
          appointmentSourceKeys,
          exSrNos: visitDay.exSrNos,
          missingExSrNos: missingAllocations.map(({ exSrNo }) => exSrNo),
          invalidExSrNos: invalidAllocations.map(({ exSrNo }) => exSrNo),
        },
      });
      if (missingAllocations.length > 0 || invalidAllocations.length > 0) {
        recordResourceAction(
          input.ledger,
          input.runId,
          daySourceKey,
          "Encounter",
          "skipped",
          allocations.some(({ allocation }) => allocation)
            ? "multi-appointment-day-partially-allocated"
            : "multi-appointment-day-queued",
        );
        encounterCounts.skipped += 1;
        continue;
      }

      const allocationsByAppointment = new Map<string, string[]>();
      for (const { exSrNo, allocation } of allocations) {
        const captures = allocationsByAppointment.get(allocation!.appointmentSourceKey) ?? [];
        captures.push(exSrNo);
        allocationsByAppointment.set(allocation!.appointmentSourceKey, captures);
      }
      const sittings = [...allocationsByAppointment]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sourceKey, exSrNos]) => ({
          sourceKey,
          exSrNos,
          appointment: importedAppointments.get(sourceKey),
        }));
      if (sittings.some(({ appointment }) => !appointment?.id)) {
        recordResourceAction(
          input.ledger,
          input.runId,
          daySourceKey,
          "Encounter",
          "skipped",
          "allocated-appointment-not-imported",
        );
        encounterCounts.skipped += 1;
        continue;
      }
      const decisions = sittings.map((sitting) => ({
        ...sitting,
        adjudication: input.ledger.readAdjudication("encounter", sitting.sourceKey),
      }));
      if (
        isOperatorChart(manifest)
        && decisions.some(({ adjudication }) => !adjudication)
      ) {
        for (const { sourceKey, adjudication } of decisions) {
          if (!adjudication) recordEncounterDecisionAmbiguity(input.ledger, sourceKey);
        }
        recordResourceAction(
          input.ledger,
          input.runId,
          daySourceKey,
          "Encounter",
          "skipped",
          "encounter-adjudication-incomplete",
        );
        encounterCounts.skipped += 1;
        continue;
      }

      input.ledger.resolveAmbiguity("visit-day", daySourceKey, "multi-appointment-day");
      for (const { sourceKey, exSrNos, appointment, adjudication } of decisions) {
        if (adjudication?.decision === "exclude") {
          recordResourceAction(
            input.ledger,
            input.runId,
            sourceKey,
            "Encounter",
            "skipped",
            "excluded-by-adjudication",
          );
          encounterCounts.skipped += 1;
          continue;
        }
        const result = await upsertEncounter({
          fhir: input.fhir,
          ledger: input.ledger,
          runId: input.runId,
          projectId: input.projectId,
          manifest,
          sourceKey,
          primaryIdentifier: {
            system: EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
            value: sourceKey,
          },
          appointment: appointment!,
          exSrNos,
          markAsTest: adjudication?.decision === "mark-as-test",
        });
        encounterCounts[result.action] += 1;
      }
      continue;
    }

    if (dayAppointments.length === 1 && !dayAppointments[0]!.cancelled) {
      const source = dayAppointments[0]!;
      const adjudication = input.ledger.readAdjudication("encounter", source.sourceKey);
      if (!adjudication && isOperatorChart(manifest)) {
        recordEncounterDecisionAmbiguity(input.ledger, source.sourceKey);
        recordResourceAction(
          input.ledger,
          input.runId,
          source.sourceKey,
          "Encounter",
          "skipped",
          "encounter-adjudication-required",
        );
        encounterCounts.skipped += 1;
        continue;
      }
      if (adjudication?.decision === "exclude") {
        recordResourceAction(
          input.ledger,
          input.runId,
          source.sourceKey,
          "Encounter",
          "skipped",
          "excluded-by-adjudication",
        );
        encounterCounts.skipped += 1;
        continue;
      }
      if (adjudication) {
        input.ledger.resolveAmbiguity("encounter", source.sourceKey, "encounter-decision");
      }
      const appointment = importedAppointments.get(source.sourceKey);
      if (!appointment?.id) {
        recordResourceAction(
          input.ledger,
          input.runId,
          source.sourceKey,
          "Encounter",
          "skipped",
          "appointment-not-imported",
        );
        encounterCounts.skipped += 1;
        continue;
      }
      const result = await upsertEncounter({
        fhir: input.fhir,
        ledger: input.ledger,
        runId: input.runId,
        projectId: input.projectId,
        manifest,
        sourceKey: source.sourceKey,
        primaryIdentifier: {
          system: EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
          value: source.sourceKey,
        },
        appointment,
        exSrNos: visitDay.exSrNos,
        markAsTest: adjudication?.decision === "mark-as-test",
      });
      encounterCounts[result.action] += 1;
      continue;
    }

    const adjudication = input.ledger.readAdjudication("encounter", daySourceKey);
    if (!adjudication && isOperatorChart(manifest)) {
      recordEncounterDecisionAmbiguity(input.ledger, daySourceKey);
      recordResourceAction(
        input.ledger,
        input.runId,
        daySourceKey,
        "Encounter",
        "skipped",
        "encounter-adjudication-required",
      );
      encounterCounts.skipped += 1;
      continue;
    }
    if (adjudication?.decision === "exclude") {
      recordResourceAction(
        input.ledger,
        input.runId,
        daySourceKey,
        "Encounter",
        "skipped",
        "excluded-by-adjudication",
      );
      encounterCounts.skipped += 1;
      continue;
    }
    if (adjudication) {
      input.ledger.resolveAmbiguity("encounter", daySourceKey, "encounter-decision");
    }

    const result = await upsertEncounter({
      fhir: input.fhir,
      ledger: input.ledger,
      runId: input.runId,
      projectId: input.projectId,
      manifest,
      sourceKey: daySourceKey,
      primaryIdentifier: {
        system: EYEFINITY_TECHNICAL_VISIT_IDENTIFIER_SYSTEM,
        value: daySourceKey,
      },
      visitDate: visitDay.date,
      exSrNos: visitDay.exSrNos,
      markAsTest: adjudication?.decision === "mark-as-test",
    });
    encounterCounts[result.action] += 1;
  }

  return {
    analysis: {
      sourceRows: analysis.sourceRows,
      exactDuplicates: analysis.exactDuplicates,
      rowsAfterExactDedupe: analysis.rowsAfterExactDedupe,
      collisionGroups: analysis.collisionGroups,
      collisionRows: analysis.collisionRows,
      resolvedCancelGroups: analysis.resolvedCancelGroups,
      allCancelledSkipped: analysis.allCancelledSkipped,
      ambiguousCollisionGroups: analysis.ambiguousCollisionGroups,
    },
    appointments: appointmentCounts,
    encounters: encounterCounts,
    practitioners: practitionerCounts,
    visitDays: visitDays.length,
  };
}

export function parseVisitDays(tsv: string, patientSourceKey: string): VisitDay[] {
  const rows = parse(tsv, {
    bom: true,
    columns: (headers: string[]) => {
      if (
        headers.length !== EXAM_EXPORT_COLUMNS.length
        || headers.some((header, index) => header !== EXAM_EXPORT_COLUMNS[index])
      ) {
        throw new Error(`Exam TSV headers do not match the verified schema: ${headers.join(",")}.`);
      }
      return headers;
    },
    delimiter: "\t",
    skip_empty_lines: true,
  }) as Array<Record<(typeof EXAM_EXPORT_COLUMNS)[number], string>>;

  const byDate = new Map<string, Set<string>>();
  for (const row of rows) {
    if (normalized(row.ptSrNo) !== normalized(patientSourceKey)) continue;
    const exSrNo = normalized(row.exSrNo);
    if (!exSrNo) throw new Error("Exam TSV row has no exSrNo.");
    const date = parseExamDate(row.exDateTime);
    const exams = byDate.get(date) ?? new Set<string>();
    exams.add(exSrNo);
    byDate.set(date, exams);
  }
  return [...byDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, exSrNos]) => ({ date, exSrNos: [...exSrNos].sort() }));
}

async function upsertPractitioner(input: {
  readonly fhir: VisitFhirClient;
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly firstName?: string;
  readonly lastName: string;
}): Promise<ResourceResult<Practitioner>> {
  const identifier = {
    system: EYEFINITY_PROVIDER_IDENTIFIER_SYSTEM,
    value: input.providerId,
  };
  const identified = await searchAll<Practitioner>(input.fhir, "Practitioner", {
    identifier: `${identifier.system}|${identifier.value}`,
  });
  if (identified.length > 1) {
    return practitionerConflict(input, "migration-identifier", identified.length);
  }

  let existing = identified[0];
  let reason = "matched-migration-identifier";
  if (!existing) {
    const native = (await searchAll<Practitioner>(input.fhir, "Practitioner", {
      family: input.lastName,
      ...(input.firstName ? { given: input.firstName } : {}),
    })).filter((candidate) => practitionerNameMatches(candidate, input.firstName, input.lastName));
    if (native.length > 1) {
      return practitionerConflict(input, "native-identity", native.length);
    }
    existing = native[0];
    reason = existing ? "adopted-native-name-match" : "no-existing-match";
  }

  const imported: Practitioner = {
    resourceType: "Practitioner",
    meta: migrationMeta(input.projectId),
    identifier: [identifier],
    active: true,
    name: [{
      family: input.lastName,
      ...(input.firstName ? { given: [input.firstName] } : {}),
    }],
  };
  if (!existing) {
    const created = await input.fhir.create<Practitioner>(imported, {
      "X-ODOS-Source": "scripts/import-legacy-visits-m2b1",
    });
    return recordedResource(input, input.providerId, created, "Practitioner", "created", reason);
  }
  assertVersioned(existing, "Practitioner");
  const desired = mergePractitioner(existing, imported);
  if (sameManagedState(existing, desired, managedPractitionerState)) {
    return recordedResource(
      input,
      input.providerId,
      existing,
      "Practitioner",
      "skipped",
      "already-converged",
    );
  }
  const updated = await input.fhir.update<Practitioner>(
    "Practitioner",
    existing.id!,
    desired,
    {
      "If-Match": `W/"${existing.meta!.versionId}"`,
      "X-ODOS-Source": "scripts/import-legacy-visits-m2b1",
    },
  );
  return recordedResource(input, input.providerId, updated, "Practitioner", "updated", reason);
}

async function upsertAppointment(input: {
  readonly fhir: VisitFhirClient;
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly projectId: string;
  readonly manifest: AppointmentEncounterImportManifest;
  readonly source: PreparedAppointmentRow;
  readonly practitionerReference?: string;
  readonly visitType: z.infer<typeof visitTypeMappingSchema>;
  readonly now: Date;
}): Promise<ResourceResult<Appointment>> {
  const identifier = {
    system: EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
    value: input.source.sourceKey,
  };
  const matches = await searchAll<Appointment>(input.fhir, "Appointment", {
    identifier: `${identifier.system}|${identifier.value}`,
  });
  if (matches.length > 1) {
    return appointmentConflict(input, "migration-identifier-multi-match");
  }

  const start = localDateTime(input.source.visitDate, input.source.startTime);
  const end = localDateTime(input.source.visitDate, input.source.endTime);
  const duration = (Date.parse(end) - Date.parse(start)) / 60_000;
  if (!Number.isInteger(duration) || duration <= 0) {
    return appointmentConflict(input, "non-positive-appointment-duration", "source-data");
  }
  const status: Appointment["status"] = input.source.cancelled
    ? "cancelled"
    : Date.parse(end) <= input.now.getTime()
    ? "fulfilled"
    : "booked";
  const imported: Appointment = {
    resourceType: "Appointment",
    meta: migrationMeta(input.projectId),
    identifier: [identifier],
    status,
    serviceCategory: [{ coding: [disciplineCoding("eyecare")] }],
    serviceType: [{
      coding: [{
        system: ODOS_VISIT_TYPE_SYSTEM,
        code: input.visitType.code,
        display: input.visitType.display,
      }],
      text: input.visitType.display,
    }],
    start,
    end,
    minutesDuration: duration,
    participant: [
      { actor: { reference: input.manifest.patientReference }, status: "accepted" },
      ...(input.practitionerReference
        ? [{ actor: { reference: input.practitionerReference }, status: "accepted" as const }]
        : []),
    ],
    extension: [
      appointmentConfirmationExtension(input.source.confirmed ? "confirmed" : "not-confirmed"),
    ],
  };
  const existing = matches[0];
  if (!existing) {
    const created = await input.fhir.create<Appointment>(imported, {
      "X-ODOS-Source": "scripts/import-legacy-visits-m2b1",
    });
    return recordedResource(
      input,
      input.source.sourceKey,
      created,
      "Appointment",
      "created",
      "no-existing-match",
    );
  }
  assertVersioned(existing, "Appointment");
  const desired = mergeAppointment(existing, imported);
  if (sameManagedState(existing, desired, managedAppointmentState)) {
    return recordedResource(
      input,
      input.source.sourceKey,
      existing,
      "Appointment",
      "skipped",
      "already-converged",
    );
  }
  const updated = await input.fhir.update<Appointment>(
    "Appointment",
    existing.id!,
    desired,
    {
      "If-Match": `W/"${existing.meta!.versionId}"`,
      "X-ODOS-Source": "scripts/import-legacy-visits-m2b1",
    },
  );
  return recordedResource(
    input,
    input.source.sourceKey,
    updated,
    "Appointment",
    "updated",
    "source-state-changed",
  );
}

type UpsertEncounterInput = {
  readonly fhir: VisitFhirClient;
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly projectId: string;
  readonly manifest: AppointmentEncounterImportManifest;
  readonly sourceKey: string;
  readonly primaryIdentifier: Identifier;
  readonly exSrNos: readonly string[];
  readonly markAsTest?: boolean;
} & (
  | { readonly appointment: Appointment; readonly visitDate?: never }
  | { readonly appointment?: never; readonly visitDate: string }
);

async function upsertEncounter(
  input: UpsertEncounterInput,
): Promise<ResourceResult<Encounter>> {
  const matches = await searchAll<Encounter>(input.fhir, "Encounter", {
    identifier: `${input.primaryIdentifier.system}|${input.primaryIdentifier.value}`,
  });
  if (matches.length > 1) {
    input.ledger.recordAmbiguity({
      sourceKind: "encounter",
      sourceKey: input.sourceKey,
      ambiguityType: "migration-identifier",
      details: { matchCount: matches.length },
    });
    recordResourceAction(
      input.ledger,
      input.runId,
      input.sourceKey,
      "Encounter",
      "conflict",
      "migration-identifier-multi-match",
    );
    return { action: "conflict" };
  }

  const practitionerReference = input.appointment?.participant
    ?.map((participant) => participant.actor?.reference)
    .find((reference) => reference?.startsWith("Practitioner/"));
  const period = input.appointment
    ? { start: input.appointment.start, end: input.appointment.end }
    : technicalVisitPeriod(input.visitDate);
  const visitType = input.appointment?.serviceType?.find((concept) =>
    concept.coding?.some((coding) => coding.system === ODOS_VISIT_TYPE_SYSTEM)
  );
  if (input.appointment && !visitType) {
    throw new Error(`Appointment ${input.appointment.id} has no ODOS visit type coding.`);
  }
  const encounterType = visitType ?? {
    coding: [{
      system: ODOS_VISIT_TYPE_SYSTEM,
      code: MIGRATED_IMAGING_VISIT_CODE,
      display: MIGRATED_IMAGING_VISIT_DISPLAY,
    }],
    text: MIGRATED_IMAGING_VISIT_DISPLAY,
  };
  const imported: Encounter = {
    resourceType: "Encounter",
    meta: migrationMeta(input.projectId, input.markAsTest),
    identifier: [
      input.primaryIdentifier,
      ...input.exSrNos.map((value) => ({
        system: EYEFINITY_EXAM_IDENTIFIER_SYSTEM,
        value,
      })),
    ],
    status: "finished",
    class: {
      system: HL7_V3_ACT_ENCOUNTER_CLASS_SYSTEM,
      code: "AMB",
    },
    serviceType: { coding: [disciplineCoding("eyecare")] },
    type: [encounterType],
    subject: { reference: input.manifest.patientReference },
    period,
    ...(input.appointment?.id
      ? { appointment: [{ reference: `Appointment/${input.appointment.id}` }] }
      : {}),
    ...(practitionerReference
      ? { participant: [{ individual: { reference: practitionerReference } }] }
      : {}),
    serviceProvider: { reference: input.manifest.organizationReference },
    location: [{ location: { reference: input.manifest.locationReference } }],
  };
  const existing = matches[0];
  if (!existing) {
    const created = await input.fhir.create<Encounter>(imported, {
      "X-ODOS-Source": "scripts/import-legacy-visits-m2b1",
    });
    return recordedResource(
      input,
      input.sourceKey,
      created,
      "Encounter",
      "created",
      "no-existing-match",
    );
  }
  assertVersioned(existing, "Encounter");
  const desired = mergeEncounter(existing, imported);
  if (sameManagedState(existing, desired, managedEncounterState)) {
    return recordedResource(
      input,
      input.sourceKey,
      existing,
      "Encounter",
      "skipped",
      "already-converged",
    );
  }
  const updated = await input.fhir.update<Encounter>(
    "Encounter",
    existing.id!,
    desired,
    {
      "If-Match": `W/"${existing.meta!.versionId}"`,
      "X-ODOS-Source": "scripts/import-legacy-visits-m2b1",
    },
  );
  return recordedResource(
    input,
    input.sourceKey,
    updated,
    "Encounter",
    "updated",
    "source-state-changed",
  );
}

function practitionerConflict(
  input: {
    readonly ledger: ImportLedger;
    readonly runId: string;
    readonly providerId: string;
  },
  ambiguityType: string,
  matchCount: number,
): ResourceResult<Practitioner> {
  input.ledger.recordAmbiguity({
    sourceKind: "provider",
    sourceKey: input.providerId,
    ambiguityType,
    details: { matchCount },
  });
  recordResourceAction(
    input.ledger,
    input.runId,
    input.providerId,
    "Practitioner",
    "conflict",
    `${ambiguityType}-multi-match:${matchCount}`,
  );
  return { action: "conflict" };
}

function appointmentConflict(
  input: {
    readonly ledger: ImportLedger;
    readonly runId: string;
    readonly source: PreparedAppointmentRow;
  },
  reason: string,
  ambiguityType = "migration-identifier",
): ResourceResult<Appointment> {
  input.ledger.recordAmbiguity({
    sourceKind: "appointment",
    sourceKey: input.source.sourceKey,
    ambiguityType,
    details: { reason },
  });
  recordResourceAction(
    input.ledger,
    input.runId,
    input.source.sourceKey,
    "Appointment",
    "conflict",
    reason,
  );
  return { action: "conflict" };
}

function recordedResource<T extends Practitioner | Appointment | Encounter>(
  input: { readonly ledger: ImportLedger; readonly runId: string },
  sourceKey: string,
  resource: T,
  resourceType: T["resourceType"],
  action: ImportAction,
  reason: string,
): ResourceResult<T> {
  if (!resource.id) throw new Error(`${resourceType} write returned no id.`);
  const migrationIdentifierSystems = resourceType === "Practitioner"
    ? [EYEFINITY_PROVIDER_IDENTIFIER_SYSTEM]
    : resourceType === "Appointment"
    ? [EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM]
    : [
      EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
      EYEFINITY_TECHNICAL_VISIT_IDENTIFIER_SYSTEM,
    ];
  recordResourceAction(
    input.ledger,
    input.runId,
    resource.identifier?.find(
      (identifier) =>
        identifier.value
        && migrationIdentifierSystems.includes(identifier.system ?? ""),
    )?.value ?? sourceKey,
    resourceType,
    action,
    reason,
    `${resourceType}/${resource.id}`,
  );
  return { resource, action };
}

function recordResourceAction(
  ledger: ImportLedger,
  runId: string,
  sourceKey: string,
  resourceType: ImportResourceType,
  action: ImportAction,
  reason: string,
  resourceReference?: string,
): void {
  ledger.recordResourceAction({
    runId,
    sourceKey,
    resourceType,
    resourceReference,
    action,
    reason,
  });
}

function recordAppointmentCollision(
  ledger: ImportLedger,
  ambiguity: AppointmentExportAmbiguity,
): void {
  ledger.recordAmbiguity({
    sourceKind: "appointment",
    sourceKey: ambiguity.sourceKey,
    ambiguityType: "composite-collision",
    details: {
      rowCount: ambiguity.rowCount,
      activeRows: ambiguity.activeRows,
      cancelledRows: ambiguity.cancelledRows,
    },
  });
}

function inconsistentProviderIds(rows: readonly PreparedAppointmentRow[]): Set<string> {
  const names = new Map<string, Set<string>>();
  for (const source of rows) {
    const providerId = normalized(source.row.ProviderID);
    const values = names.get(providerId) ?? new Set<string>();
    values.add(`${normalized(source.row.ProviderFirst).toLocaleLowerCase("en-US")}\u001f${
      normalized(source.row.ProviderLast).toLocaleLowerCase("en-US")
    }`);
    names.set(providerId, values);
  }
  return new Set([...names].filter(([, values]) => values.size > 1).map(([providerId]) => providerId));
}

function groupByVisitDate(
  rows: readonly PreparedAppointmentRow[],
): Map<string, PreparedAppointmentRow[]> {
  const result = new Map<string, PreparedAppointmentRow[]>();
  for (const row of rows) {
    const values = result.get(row.visitDate) ?? [];
    values.push(row);
    result.set(row.visitDate, values);
  }
  return result;
}

function mergePractitioner(existing: Practitioner, imported: Practitioner): Practitioner {
  return {
    ...existing,
    meta: mergeMigrationMeta(existing.meta, imported.meta?.tag),
    identifier: mergeIdentifiers(
      existing.identifier,
      imported.identifier ?? [],
      new Set([EYEFINITY_PROVIDER_IDENTIFIER_SYSTEM]),
    ),
    active: existing.active ?? true,
    name: upsertPractitionerName(existing.name ?? [], imported.name![0]!),
  };
}

function mergeAppointment(existing: Appointment, imported: Appointment): Appointment {
  return {
    ...existing,
    ...imported,
    id: existing.id,
    meta: mergeMigrationMeta(existing.meta, imported.meta?.tag),
    identifier: mergeIdentifiers(
      existing.identifier,
      imported.identifier ?? [],
      new Set([EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM]),
    ),
  };
}

function mergeEncounter(existing: Encounter, imported: Encounter): Encounter {
  return {
    ...existing,
    ...imported,
    id: existing.id,
    meta: mergeMigrationMeta(existing.meta, imported.meta?.tag),
    identifier: mergeIdentifiers(
      existing.identifier,
      imported.identifier ?? [],
      new Set([
        EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
        EYEFINITY_TECHNICAL_VISIT_IDENTIFIER_SYSTEM,
        EYEFINITY_EXAM_IDENTIFIER_SYSTEM,
      ]),
    ),
  };
}

function migrationMeta(
  projectId: string,
  markAsTest = false,
): NonNullable<Resource["meta"]> {
  return {
    project: projectId,
    tag: [
      { system: MIGRATION_TAG_SYSTEM, code: MIGRATION_TAG_CODE },
      ...(markAsTest
        ? [{ system: MIGRATION_TAG_SYSTEM, code: MIGRATION_TEST_TAG_CODE }]
        : []),
    ],
  };
}

function mergeMigrationMeta(
  existing: Resource["meta"],
  importedTags: NonNullable<Resource["meta"]>["tag"],
): NonNullable<Resource["meta"]> {
  return {
    ...existing,
    tag: [
      ...(existing?.tag ?? []).filter(
        (tag) =>
          tag.system !== MIGRATION_TAG_SYSTEM
          || (
            tag.code !== MIGRATION_TAG_CODE
            && tag.code !== MIGRATION_TEST_TAG_CODE
          ),
      ),
      ...(importedTags ?? []),
    ],
  };
}

function upsertPractitionerName(
  existing: NonNullable<Practitioner["name"]>,
  imported: NonNullable<Practitioner["name"]>[number],
): NonNullable<Practitioner["name"]> {
  const match = existing.findIndex((name) =>
    comparable(name.family) === comparable(imported.family)
    && comparable(name.given?.[0]) === comparable(imported.given?.[0])
  );
  if (match === -1) return [...existing, imported];
  return existing.map((name, index) => index === match ? imported : name);
}

function mergeIdentifiers(
  existing: readonly Identifier[] | undefined,
  imported: readonly Identifier[],
  managedSystems: ReadonlySet<string>,
): Identifier[] {
  return [
    ...(existing ?? []).filter(
      (identifier) => !identifier.system || !managedSystems.has(identifier.system),
    ),
    ...imported,
  ];
}

function managedPractitionerState(resource: Practitioner): unknown {
  return {
    tag: canonical(resource.meta?.tag),
    identifier: canonical(resource.identifier),
    active: resource.active,
    name: canonical(resource.name),
  };
}

function managedAppointmentState(resource: Appointment): unknown {
  return {
    tag: canonical(resource.meta?.tag),
    identifier: canonical(resource.identifier),
    status: resource.status,
    serviceCategory: canonical(resource.serviceCategory),
    serviceType: canonical(resource.serviceType),
    start: resource.start,
    end: resource.end,
    minutesDuration: resource.minutesDuration,
    participant: canonical(resource.participant),
    extension: canonical(resource.extension),
  };
}

function managedEncounterState(resource: Encounter): unknown {
  return {
    tag: canonical(resource.meta?.tag),
    identifier: canonical(resource.identifier),
    status: resource.status,
    class: resource.class,
    serviceType: resource.serviceType,
    type: canonical(resource.type),
    subject: resource.subject,
    period: resource.period,
    appointment: canonical(resource.appointment),
    participant: canonical(resource.participant),
    serviceProvider: resource.serviceProvider,
    location: canonical(resource.location),
  };
}

function sameManagedState<T>(
  left: T,
  right: T,
  select: (value: T) => unknown,
): boolean {
  return stableKey(select(left)) === stableKey(select(right));
}

function canonical<T>(values: readonly T[] | undefined): T[] {
  return [...(values ?? [])].sort((left, right) => stableKey(left).localeCompare(stableKey(right)));
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableKey(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function practitionerNameMatches(
  practitioner: Practitioner,
  firstName: string | undefined,
  lastName: string,
): boolean {
  return practitioner.name?.some(
    (name) =>
      comparable(name.family) === comparable(lastName)
      && (
        !firstName
        || name.given?.some((given) => comparable(given) === comparable(firstName))
      ),
  ) ?? false;
}

function localDateTime(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const wallClock = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const expected = [year, month, day, hour, minute, second];
  const offsets = new Set(
    [-86_400_000, 0, 86_400_000].map((delta) =>
      zoneOffsetMilliseconds(new Date(wallClock + delta), PRACTICE_TIME_ZONE)
    ),
  );
  const instants = [...offsets]
    .map((offset) => wallClock - offset)
    .filter((candidate, index, values) =>
      values.indexOf(candidate) === index
      && localParts(new Date(candidate), PRACTICE_TIME_ZONE).every(
        (value, partIndex) => value === expected[partIndex],
      )
    );
  if (instants.length !== 1) {
    throw new Error(`${date} ${time} is not an unambiguous ${PRACTICE_TIME_ZONE} wall time.`);
  }
  const instant = instants[0]!;
  const offsetMinutes = zoneOffsetMilliseconds(new Date(instant), PRACTICE_TIME_ZONE) / 60_000;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${
    String(absolute % 60).padStart(2, "0")
  }`;
  return `${date}T${time}${offset}`;
}

function localParts(date: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return [
    value("year"),
    value("month"),
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  ];
}

function zoneOffsetMilliseconds(date: Date, timeZone: string): number {
  const [year, month, day, hour, minute, second] = localParts(date, timeZone);
  return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!) - date.getTime();
}

function technicalVisitPeriod(date: string): Encounter["period"] {
  const instant = localDateTime(date, "00:00:00");
  return { start: instant, end: instant };
}

function appointmentSourceKeyPatientUid(sourceKey: string): string | undefined {
  try {
    const value = JSON.parse(sourceKey) as unknown;
    return Array.isArray(value) && typeof value[0] === "string"
      ? normalized(value[0])
      : undefined;
  } catch {
    return undefined;
  }
}

export function technicalVisitKey(patientSourceKey: string, date: string): string {
  return JSON.stringify([normalized(patientSourceKey), date]);
}

function parseExamDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(value.trim());
  if (!match) throw new Error(`Exam date is not parseable: "${value}".`);
  const date = match[1]!;
  localDateTime(date, "00:00:00");
  return date;
}

function assertPatientId(
  rows: readonly PreparedAppointmentRow[],
  epmPatientId: string,
): void {
  const mismatches = rows.filter(
    (row) => normalized(row.row.PatientID) !== normalized(epmPatientId),
  );
  if (mismatches.length > 0) {
    throw new Error("Selected PatientUID resolves to a different EPM PatientID.");
  }
}

function isOperatorChart(manifest: AppointmentEncounterImportManifest): boolean {
  return (
    manifest.epmPatientId === FORBIDDEN_M2A_EPM_SOURCE_KEY
    || manifest.ehrPatientId === FORBIDDEN_M2A_EHR_SOURCE_KEY
  );
}

function recordEncounterDecisionAmbiguity(
  ledger: ImportLedger,
  sourceKey: string,
): void {
  ledger.recordAmbiguity({
    sourceKind: "encounter",
    sourceKey,
    ambiguityType: "encounter-decision",
    details: { decisions: ["keep", "exclude", "mark-as-test"] },
  });
}

function assertVersioned(resource: Resource, resourceType: string): void {
  if (!resource.id || !resource.meta?.versionId) {
    throw new Error(`Matched ${resourceType} lacks id/meta.versionId for a version-aware update.`);
  }
}

function actionCounts(): Record<ImportAction, number> {
  return { created: 0, updated: 0, skipped: 0, conflict: 0 };
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function comparable(value: string | undefined): string {
  return normalized(value ?? "").toLocaleLowerCase("en-US");
}
