import type { Application, Request, Response } from "express";
import type { MedicationRequest, Observation, Patient, Practitioner } from "@medplum/fhirtypes";
import { buildOdosAuditEventRow, type OdosAuditEventRecord } from "../authz/odosAudit.js";
import {
  NCPDP_PROVIDER_IDENTIFIER_SYSTEM,
  ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL,
  ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL,
  ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL,
  RXNORM_CODE_SYSTEM,
  WENO_CANCEL_MESSAGE_ID_IDENTIFIER_SYSTEM,
  WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
  pharmacyFromResource,
} from "../fhir/medicationOrder.js";
import {
  isWenoSwitchConfigured,
  type WenoSwitchConfig,
} from "../integrations/weno/config.js";
import {
  buildWenoSwitchCancelRx,
  buildWenoSwitchNewRx,
  createWenoSwitchMessageId,
  patientIsUnder19,
  sendWenoSwitchCancelRx,
  sendWenoSwitchNewRx,
  WenoPrescriptionSendError,
  type WenoSwitchNewRxResult,
} from "../integrations/weno/wenoSwitchNewRx.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import type { MedplumClient } from "../fhir-client.js";
import {
  searchDrugs,
  WenoDrugSearchValidationError,
  type WenoDrugRow,
} from "../jobs/syncWenoDrugDatabase.js";
import {
  searchPharmacies,
  WenoPharmacySearchValidationError,
  type PharmacyDirectoryRow,
  type PharmacySearchInput,
  type PharmacySearchType,
} from "../jobs/syncWenoPharmacyDirectory.js";

export const WENO_SEARCH_RESULT_LIMIT = 25;
const WENO_ERROR_NOTE_PREFIX = "WENO Switch error";
const WENO_OUTCOME_UNKNOWN_NOTE_PREFIX = "WENO Switch outcome unknown";
const WENO_CANCEL_RESERVATION_NOTE_PREFIX = "WENO Switch CancelRx outcome pending";
const WENO_CANCEL_RESERVATION_CLEARED_NOTE_PREFIX =
  "WENO Switch CancelRx outcome-unknown reservation cleared";
const WENO_CANCEL_COMPLETED_NOTE_PREFIX = "WENO Switch CancelRx completed";
const WENO_RESERVATION_CLEARED_NOTE_PREFIX = "WENO Switch outcome-unknown reservation cleared";
// These identify stored FHIR Observations only; WENO serializes literal vital names and units.
const LOINC_CODE_SYSTEM = "http://loinc.org";
const BODY_HEIGHT_LOINC_CODE = "8302-2";
const BODY_WEIGHT_LOINC_CODE = "29463-7";

export interface WenoDrugSearchClient {
  search(query: string): Promise<WenoDrugRow[]>;
}

export interface WenoPharmacySearchClient {
  search(input: PharmacySearchInput): Promise<PharmacyDirectoryRow[]>;
}

export interface WenoSearchRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  serviceFhir: MedplumClient;
  drugs: WenoDrugSearchClient;
  pharmacies: WenoPharmacySearchClient;
  switchConfig: WenoSwitchConfig;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
  sendCancelRx?: typeof sendWenoSwitchCancelRx;
  sendNewRx?: typeof sendWenoSwitchNewRx;
  createMessageId?: () => string;
  now?: () => string;
}

export function registerWenoSearchRoutes(
  app: Pick<Application, "get" | "post">,
  deps: WenoSearchRouteDeps,
): void {
  app.get("/weno/drugs/search", async (req, res) => handleDrugSearch(req, res, deps));
  app.get("/weno/pharmacies/search", async (req, res) => handlePharmacySearch(req, res, deps));
  app.get("/weno/switch/configuration", async (req, res) =>
    handleSwitchConfiguration(req, res, deps));
  app.post("/weno/medication-requests/:medicationRequestId/send", async (req, res) =>
    handlePrescriptionSend(req, res, deps));
  app.post("/weno/medication-requests/:medicationRequestId/cancel", async (req, res) =>
    handlePrescriptionCancel(req, res, deps));
  app.post("/weno/medication-requests/:medicationRequestId/clear-indeterminate-send", async (req, res) =>
    handleClearIndeterminateSend(req, res, deps));
  app.post("/weno/medication-requests/:medicationRequestId/clear-indeterminate-cancel", async (req, res) =>
    handleClearIndeterminateCancel(req, res, deps));
}

async function handleDrugSearch(req: Request, res: Response, deps: WenoSearchRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    if (!await deps.authenticate(req.header("authorization"))) {
      res.status(401).json({ error: "Authentication required to search the Formulary." });
      return;
    }
    const query = queryString(req.query.q, "q") ?? "";
    searchDrugs([], query);
    const results = await deps.drugs.search(query);
    res.json({ results: results.slice(0, WENO_SEARCH_RESULT_LIMIT).map(shapeDrugResult) });
  } catch (error) {
    console.error("odos-mcp: /weno/drugs/search failed:", error);
    if (!res.headersSent) {
      if (error instanceof WenoDrugSearchValidationError || error instanceof WenoQueryValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Formulary search failed." });
      }
    }
  }
}

async function handlePharmacySearch(req: Request, res: Response, deps: WenoSearchRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    if (!await deps.authenticate(req.header("authorization"))) {
      res.status(401).json({ error: "Authentication required to search the Directory." });
      return;
    }
    const input = pharmacySearchInput(req);
    searchPharmacies([], input);
    const results = await deps.pharmacies.search(input);
    res.json({ results: results.slice(0, WENO_SEARCH_RESULT_LIMIT).map(shapePharmacyResult) });
  } catch (error) {
    console.error("odos-mcp: /weno/pharmacies/search failed:", error);
    if (!res.headersSent) {
      if (error instanceof WenoPharmacySearchValidationError || error instanceof WenoQueryValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Directory search failed." });
      }
    }
  }
}

async function handleSwitchConfiguration(
  req: Request,
  res: Response,
  deps: WenoSearchRouteDeps,
): Promise<void> {
  try {
    await deps.authenticateService();
    if (!await deps.authenticate(req.header("authorization"))) {
      res.status(401).json({ error: "Authentication required to check WENO Switch configuration." });
      return;
    }
    const configured = isWenoSwitchConfigured(deps.switchConfig);
    res.json({
      configured,
      reason: configured
        ? "WENO Switch is configured."
        : "WENO Switch is not configured. Complete the WENO_SWITCH settings before sending.",
    });
  } catch (error) {
    console.error("odos-mcp: /weno/switch/configuration failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "WENO Switch configuration check failed." });
  }
}

async function handlePrescriptionSend(
  req: Request,
  res: Response,
  deps: WenoSearchRouteDeps,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to send a prescription." });
      return;
    }
    if (!isWenoSwitchConfigured(deps.switchConfig)) {
      res.status(503).json({
        error: "WENO Switch is not configured. Complete the WENO_SWITCH settings before sending.",
      });
      return;
    }
    const medicationRequestId = resourceId(req.params.medicationRequestId, "MedicationRequest");
    const medicationRequest = await staff.fhir.read<MedicationRequest>(
      "MedicationRequest",
      medicationRequestId,
    );
    const context = await prepareSendContext(staff, medicationRequest, deps);
    const reserved = await deps.serviceFhir.update<MedicationRequest>(
      "MedicationRequest",
      medicationRequestId,
      withMessageId(medicationRequest, context.messageId),
      versionHeaders(medicationRequest),
    );
    let result: WenoSwitchNewRxResult;
    try {
      result = await (deps.sendNewRx ?? sendWenoSwitchNewRx)(context.xml, {
        endpoint: deps.switchConfig.endpoint,
      });
    } catch (error) {
      const reason = sendFailureReason(error);
      const updated = await deps.serviceFhir.update<MedicationRequest>(
        "MedicationRequest",
        medicationRequestId,
        withWenoOutcomeUnknown(reserved, context.messageId, reason, context.sentTime),
        versionHeaders(reserved),
      );
      await deps.recordAudit(buildOdosAuditEventRow({
        eventType: "external-api-call",
        eventTime: context.sentTime,
        actorReference: staff.staffReference,
        actorRole: staff.actorRole,
        patientReference: medicationRequest.subject.reference,
        targetReference: `MedicationRequest/${medicationRequestId}`,
        actionOutcome: "granted",
        actionReason: `WENO_SWITCH_NEWRX_OUTCOME_UNKNOWN ${context.messageId}: ${reason}`,
      }));
      res.json({
        result: {
          kind: "unknown",
          messageId: context.messageId,
          description: reason,
        },
        medicationRequest: updated,
        resendable: false,
      });
      return;
    }
    const updated = result.kind === "status"
      ? await deps.serviceFhir.update<MedicationRequest>(
          "MedicationRequest",
          medicationRequestId,
          withElectronicTransmission(reserved),
          versionHeaders(reserved),
        )
      : await deps.serviceFhir.update<MedicationRequest>(
          "MedicationRequest",
          medicationRequestId,
          withWenoError(reserved, context.messageId, result, context.sentTime),
          versionHeaders(reserved),
        );
    await deps.recordAudit(buildOdosAuditEventRow({
      eventType: "external-api-call",
      eventTime: context.sentTime,
      actorReference: staff.staffReference,
      actorRole: staff.actorRole,
      patientReference: medicationRequest.subject.reference,
      targetReference: `MedicationRequest/${medicationRequestId}`,
      actionOutcome: "granted",
      actionReason: result.kind === "status"
        ? `WENO_SWITCH_NEWRX_STATUS ${result.code}: ${result.description}`
        : `WENO_SWITCH_NEWRX_ERROR ${result.code}/${result.descriptionCode}: ${result.description}`,
    }));
    res.json({
      result,
      medicationRequest: updated,
      resendable: result.kind === "error",
    });
  } catch (error) {
    if (!(error instanceof WenoPrescriptionSendError)) {
      console.error("odos-mcp: WENO prescription send failed:", error);
    }
    if (!res.headersSent) {
      const status = error instanceof WenoPrescriptionSendError
        ? error.status
        : fhirErrorStatus(error) ?? 500;
      res.status(status).json({
        error: error instanceof WenoPrescriptionSendError
          ? error.message
          : status === 409 || status === 412
            ? "The prescription changed before it could be reserved for sending. Reload and try again."
            : "WENO prescription send failed.",
      });
    }
  }
}

async function handlePrescriptionCancel(
  req: Request,
  res: Response,
  deps: WenoSearchRouteDeps,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to cancel a prescription." });
      return;
    }
    if (!isWenoSwitchConfigured(deps.switchConfig)) {
      res.status(503).json({
        error: "WENO Switch is not configured. Complete the WENO_SWITCH settings before cancelling.",
      });
      return;
    }
    const medicationRequestId = resourceId(req.params.medicationRequestId, "MedicationRequest");
    const medicationRequest = await staff.fhir.read<MedicationRequest>(
      "MedicationRequest",
      medicationRequestId,
    );
    const context = await prepareCancelContext(staff, medicationRequest, deps);
    const reserved = await deps.serviceFhir.update<MedicationRequest>(
      "MedicationRequest",
      medicationRequestId,
      withWenoCancelReservation(medicationRequest, context.messageId, context.sentTime),
      versionHeaders(medicationRequest),
    );
    let result: WenoSwitchNewRxResult;
    try {
      result = await (deps.sendCancelRx ?? sendWenoSwitchCancelRx)(context.xml, {
        endpoint: deps.switchConfig.endpoint,
      });
    } catch (error) {
      const reason = sendFailureReason(error);
      const updated = await deps.serviceFhir.update<MedicationRequest>(
        "MedicationRequest",
        medicationRequestId,
        withWenoOutcomeUnknown(reserved, context.messageId, reason, context.sentTime),
        versionHeaders(reserved),
      );
      await deps.recordAudit(buildOdosAuditEventRow({
        eventType: "external-api-call",
        eventTime: context.sentTime,
        actorReference: staff.staffReference,
        actorRole: staff.actorRole,
        patientReference: medicationRequest.subject.reference,
        targetReference: `MedicationRequest/${medicationRequestId}`,
        actionOutcome: "granted",
        actionReason: `WENO_SWITCH_CANCELRX_OUTCOME_UNKNOWN ${context.messageId}: ${reason}`,
      }));
      res.json({
        result: {
          kind: "unknown",
          messageId: context.messageId,
          description: reason,
        },
        medicationRequest: updated,
        resendable: false,
      });
      return;
    }
    const updated = result.kind === "status"
      ? await deps.serviceFhir.update<MedicationRequest>(
          "MedicationRequest",
          medicationRequestId,
          withCompletedWenoCancel(
            reserved,
            context.messageId,
            staff.staffReference,
            context.sentTime,
          ),
          versionHeaders(reserved),
        )
      : await deps.serviceFhir.update<MedicationRequest>(
          "MedicationRequest",
          medicationRequestId,
          withWenoError(
            withoutWenoCancelReservation(reserved, context.messageId),
            context.messageId,
            result,
            context.sentTime,
          ),
          versionHeaders(reserved),
        );
    await deps.recordAudit(buildOdosAuditEventRow({
      eventType: "external-api-call",
      eventTime: context.sentTime,
      actorReference: staff.staffReference,
      actorRole: staff.actorRole,
      patientReference: medicationRequest.subject.reference,
      targetReference: `MedicationRequest/${medicationRequestId}`,
      actionOutcome: "granted",
      actionReason: result.kind === "status"
        ? `WENO_SWITCH_CANCELRX_STATUS ${context.messageId} ${result.code}: ${result.description}`
        : `WENO_SWITCH_CANCELRX_ERROR ${context.messageId} ${result.code}/${result.descriptionCode}: ${result.description}`,
    }));
    res.json({
      result,
      medicationRequest: updated,
      resendable: result.kind === "error",
    });
  } catch (error) {
    if (!(error instanceof WenoPrescriptionSendError)) {
      console.error("odos-mcp: WENO prescription cancellation failed:", error);
    }
    if (!res.headersSent) {
      const status = error instanceof WenoPrescriptionSendError
        ? error.status
        : fhirErrorStatus(error) ?? 500;
      res.status(status).json({
        error: error instanceof WenoPrescriptionSendError
          ? error.message
          : status === 409 || status === 412
            ? "The prescription changed before cancellation could be recorded. Reload and review it again."
            : "WENO prescription cancellation failed.",
      });
    }
  }
}

async function handleClearIndeterminateSend(
  req: Request,
  res: Response,
  deps: WenoSearchRouteDeps,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({
        error: "Authentication required to clear an indeterminate WENO send.",
      });
      return;
    }
    const medicationRequestId = resourceId(req.params.medicationRequestId, "MedicationRequest");
    const medicationRequest = await staff.fhir.read<MedicationRequest>(
      "MedicationRequest",
      medicationRequestId,
    );
    const messageId = wenoMessageId(medicationRequest);
    if (
      !messageId
      || isElectronicallySent(medicationRequest)
      || !hasWenoOutcomeUnknown(medicationRequest, messageId)
    ) {
      throw new WenoPrescriptionSendError(
        409,
        "Only an indeterminate WENO send reservation can be cleared.",
      );
    }
    const clearedAt = deps.now?.() ?? new Date().toISOString();
    const updated = await deps.serviceFhir.update<MedicationRequest>(
      "MedicationRequest",
      medicationRequestId,
      withClearedIndeterminateReservation(
        medicationRequest,
        messageId,
        staff.staffReference,
        clearedAt,
      ),
      versionHeaders(medicationRequest),
    );
    await deps.recordAudit(buildOdosAuditEventRow({
      eventType: "update",
      eventTime: clearedAt,
      actorReference: staff.staffReference,
      actorRole: staff.actorRole,
      patientReference: medicationRequest.subject.reference,
      targetReference: `MedicationRequest/${medicationRequestId}`,
      actionOutcome: "granted",
      actionReason: `WENO_SWITCH_INDETERMINATE_RESERVATION_CLEARED ${messageId}`,
    }));
    res.json({
      medicationRequest: updated,
      clearedMessageId: messageId,
    });
  } catch (error) {
    if (!(error instanceof WenoPrescriptionSendError)) {
      console.error("odos-mcp: WENO indeterminate send clear failed:", error);
    }
    if (!res.headersSent) {
      const status = error instanceof WenoPrescriptionSendError
        ? error.status
        : fhirErrorStatus(error) ?? 500;
      res.status(status).json({
        error: error instanceof WenoPrescriptionSendError
          ? error.message
          : status === 409 || status === 412
            ? "The prescription changed before its WENO reservation could be cleared. Reload and review it again."
            : "The indeterminate WENO send reservation could not be cleared.",
      });
    }
  }
}

async function handleClearIndeterminateCancel(
  req: Request,
  res: Response,
  deps: WenoSearchRouteDeps,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({
        error: "Authentication required to clear an indeterminate WENO cancellation.",
      });
      return;
    }
    const medicationRequestId = resourceId(req.params.medicationRequestId, "MedicationRequest");
    const medicationRequest = await staff.fhir.read<MedicationRequest>(
      "MedicationRequest",
      medicationRequestId,
    );
    const messageId = wenoCancelMessageId(medicationRequest);
    if (!messageId || medicationRequest.status === "cancelled") {
      throw new WenoPrescriptionSendError(
        409,
        "Only an indeterminate WENO CancelRx reservation on a non-cancelled prescription can be cleared.",
      );
    }
    const clearedAt = deps.now?.() ?? new Date().toISOString();
    const updated = await deps.serviceFhir.update<MedicationRequest>(
      "MedicationRequest",
      medicationRequestId,
      withClearedIndeterminateCancelReservation(
        medicationRequest,
        messageId,
        staff.staffReference,
        clearedAt,
      ),
      versionHeaders(medicationRequest),
    );
    await deps.recordAudit(buildOdosAuditEventRow({
      eventType: "update",
      eventTime: clearedAt,
      actorReference: staff.staffReference,
      actorRole: staff.actorRole,
      patientReference: medicationRequest.subject.reference,
      targetReference: `MedicationRequest/${medicationRequestId}`,
      actionOutcome: "granted",
      actionReason: `WENO_SWITCH_CANCELRX_INDETERMINATE_RESERVATION_CLEARED ${messageId}`,
    }));
    res.json({
      medicationRequest: updated,
      clearedMessageId: messageId,
    });
  } catch (error) {
    if (!(error instanceof WenoPrescriptionSendError)) {
      console.error("odos-mcp: WENO indeterminate cancellation clear failed:", error);
    }
    if (!res.headersSent) {
      const status = error instanceof WenoPrescriptionSendError
        ? error.status
        : fhirErrorStatus(error) ?? 500;
      res.status(status).json({
        error: error instanceof WenoPrescriptionSendError
          ? error.message
          : status === 409 || status === 412
            ? "The prescription changed before its WENO CancelRx reservation could be cleared. Reload and review it again."
            : "The indeterminate WENO CancelRx reservation could not be cleared.",
      });
    }
  }
}

async function prepareSendContext(
  staff: AuthenticatedStaff,
  medicationRequest: MedicationRequest,
  deps: WenoSearchRouteDeps,
): Promise<{ messageId: string; sentTime: string; xml: string }> {
  if (medicationRequest.extension?.some((extension) =>
    extension.url === ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL
      && extension.valueBoolean === true
  )) {
    throw new WenoPrescriptionSendError(
      400,
      "Controlled substances cannot be transmitted electronically through this WENO send path.",
    );
  }
  if (wenoMessageId(medicationRequest)) {
    throw new WenoPrescriptionSendError(
      409,
      "This prescription already has a WENO message id and will not be sent again.",
    );
  }
  const codedDrug = wenoCodedDrug(medicationRequest);
  if (!codedDrug) {
    throw new WenoPrescriptionSendError(
      400,
      "A free-text drug cannot be sent electronically. Select a coded WENO formulary drug, then save the prescription again.",
    );
  }
  const pharmacy = pharmacyFromResource(medicationRequest);
  const performerNcpdp = medicationRequest.dispenseRequest?.performer?.identifier?.system
    === NCPDP_PROVIDER_IDENTIFIER_SYSTEM
    ? medicationRequest.dispenseRequest.performer.identifier.value?.trim()
    : undefined;
  if (!pharmacy || !performerNcpdp) {
    throw new WenoPrescriptionSendError(
      400,
      "A free-text pharmacy cannot be sent electronically. Select a coded WENO Directory pharmacy, then save the prescription again.",
    );
  }
  if (pharmacy.ncpdpId !== performerNcpdp) {
    throw new WenoPrescriptionSendError(
      400,
      "The saved pharmacy snapshot does not match the prescription NCPDP id. Select the pharmacy again and save before sending.",
    );
  }
  const patientId = referenceId(medicationRequest.subject.reference, "Patient");
  const practitionerId = referenceId(medicationRequest.requester?.reference, "Practitioner");
  const sentTime = deps.now?.() ?? new Date().toISOString();
  const [patient, prescriber] = await Promise.all([
    staff.fhir.read<Patient>("Patient", patientId),
    staff.fhir.read<Practitioner>("Practitioner", practitionerId),
  ]);
  let bodyHeightInches: { value: number; observedOn: string } | undefined;
  let bodyWeightPounds: { value: number; observedOn: string } | undefined;
  if (patientIsUnder19(patient.birthDate, sentTime)) {
    const [heightBundle, weightBundle] = await Promise.all([
      staff.fhir.search<Observation>("Observation", {
        patient: patientId,
        code: `${LOINC_CODE_SYSTEM}|${BODY_HEIGHT_LOINC_CODE}`,
        _sort: "-date",
        _count: "1",
      }),
      staff.fhir.search<Observation>("Observation", {
        patient: patientId,
        code: `${LOINC_CODE_SYSTEM}|${BODY_WEIGHT_LOINC_CODE}`,
        _sort: "-date",
        _count: "1",
      }),
    ]);
    const height = heightBundle.entry?.[0]?.resource;
    const weight = weightBundle.entry?.[0]?.resource;
    if (!height || !weight) {
      throw missingPediatricVitalsError();
    }
    bodyHeightInches = convertedVital(height, "height");
    bodyWeightPounds = convertedVital(weight, "weight");
  }
  const messageId = (deps.createMessageId ?? createWenoSwitchMessageId)();
  return {
    messageId,
    sentTime,
    xml: buildWenoSwitchNewRx({
      patient,
      prescriber,
      medicationRequest,
      pharmacy,
      ...codedDrug,
      config: deps.switchConfig,
      messageId,
      sentTime,
      bodyHeightInches,
      bodyWeightPounds,
    }),
  };
}

function missingPediatricVitalsError(): WenoPrescriptionSendError {
  return new WenoPrescriptionSendError(
    400,
    "This patient is under 19. WENO requires height and weight on an electronic prescription. Record both before sending.",
  );
}

function convertedVital(
  observation: Observation,
  kind: "height" | "weight",
): { value: number; observedOn: string } {
  const value = observation.valueQuantity?.value;
  const unit = observation.valueQuantity?.code ?? observation.valueQuantity?.unit;
  const observedOn = observationDate(observation);
  if (value === undefined || !Number.isFinite(value) || value <= 0 || !unit || !observedOn) {
    throw missingPediatricVitalsError();
  }
  const normalizedUnit = unit.trim().toLowerCase();
  const converted = kind === "height"
    ? convertHeightToInches(value, normalizedUnit)
    : convertWeightToPounds(value, normalizedUnit);
  if (converted === undefined) {
    throw new WenoPrescriptionSendError(
      400,
      kind === "height"
        ? "The most recent body height uses a unit WENO cannot convert to inches. Record height in inches or centimeters before sending."
        : "The most recent body weight uses a unit WENO cannot convert to pounds. Record weight in pounds or kilograms before sending.",
    );
  }
  return { value: roundMeasurement(converted), observedOn };
}

function convertHeightToInches(value: number, unit: string): number | undefined {
  if (["in", "inch", "inches"].includes(unit)) return value;
  if (["cm", "centimeter", "centimeters"].includes(unit)) return value / 2.54;
  if (["m", "meter", "meters"].includes(unit)) return value / 0.0254;
  return undefined;
}

function convertWeightToPounds(value: number, unit: string): number | undefined {
  if (["lb", "lbs", "pound", "pounds"].includes(unit)) return value;
  if (["kg", "kilogram", "kilograms"].includes(unit)) return value * 2.2046226218;
  if (["g", "gram", "grams"].includes(unit)) return value * 0.0022046226218;
  return undefined;
}

function observationDate(observation: Observation): string | undefined {
  const date = (observation.effectiveDateTime ?? observation.issued)?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : undefined;
}

function roundMeasurement(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function prepareCancelContext(
  staff: AuthenticatedStaff,
  medicationRequest: MedicationRequest,
  deps: WenoSearchRouteDeps,
): Promise<{ messageId: string; sentTime: string; xml: string }> {
  if (medicationRequest.status === "cancelled") {
    throw new WenoPrescriptionSendError(409, "This prescription is already cancelled.");
  }
  if (!wenoMessageId(medicationRequest)) {
    throw new WenoPrescriptionSendError(
      409,
      "This prescription has no stored WENO MessageID and cannot be cancelled.",
    );
  }
  if (!isElectronicallySent(medicationRequest)) {
    throw new WenoPrescriptionSendError(
      409,
      "Only an electronically sent prescription can be cancelled through WENO.",
    );
  }
  if (hasWenoCancelReservation(medicationRequest)) {
    throw new WenoPrescriptionSendError(
      409,
      "This prescription has an indeterminate WENO CancelRx outcome and cannot be resent.",
    );
  }
  const codedDrug = wenoCodedDrug(medicationRequest);
  if (!codedDrug) {
    throw new WenoPrescriptionSendError(
      400,
      "The electronically sent prescription no longer has its coded WENO drug metadata.",
    );
  }
  const pharmacy = pharmacyFromResource(medicationRequest);
  const performerNcpdp = medicationRequest.dispenseRequest?.performer?.identifier?.system
    === NCPDP_PROVIDER_IDENTIFIER_SYSTEM
    ? medicationRequest.dispenseRequest.performer.identifier.value?.trim()
    : undefined;
  if (!pharmacy || !performerNcpdp || pharmacy.ncpdpId !== performerNcpdp) {
    throw new WenoPrescriptionSendError(
      400,
      "The electronically sent prescription no longer has a matching WENO pharmacy snapshot.",
    );
  }
  const patientId = referenceId(medicationRequest.subject.reference, "Patient");
  const practitionerId = referenceId(medicationRequest.requester?.reference, "Practitioner");
  const [patient, prescriber] = await Promise.all([
    staff.fhir.read<Patient>("Patient", patientId),
    staff.fhir.read<Practitioner>("Practitioner", practitionerId),
  ]);
  const messageId = (deps.createMessageId ?? createWenoSwitchMessageId)();
  const sentTime = deps.now?.() ?? new Date().toISOString();
  return {
    messageId,
    sentTime,
    xml: buildWenoSwitchCancelRx({
      patient,
      prescriber,
      medicationRequest,
      pharmacy,
      quantityUnitOfMeasureCode: codedDrug.quantityUnitOfMeasureCode,
      config: deps.switchConfig,
      messageId,
      sentTime,
    }),
  };
}

function wenoCodedDrug(medicationRequest: MedicationRequest): {
  drugDbCode: string;
  drugDbCodeQualifier: string;
  quantityUnitOfMeasureCode: string;
} | undefined {
  for (const coding of medicationRequest.medicationCodeableConcept?.coding ?? []) {
    if (coding.system !== RXNORM_CODE_SYSTEM) continue;
    const drugDbCode = coding.code?.trim();
    const drugDbCodeQualifier = coding.extension?.find(
      (extension) => extension.url === ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL,
    )?.valueCode?.trim();
    const quantityUnitOfMeasureCode = coding.extension?.find(
      (extension) => extension.url === ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL,
    )?.valueCode?.trim();
    if (drugDbCode && drugDbCodeQualifier && quantityUnitOfMeasureCode) {
      return { drugDbCode, drugDbCodeQualifier, quantityUnitOfMeasureCode };
    }
  }
  return undefined;
}

function withMessageId(
  medicationRequest: MedicationRequest,
  messageId: string,
): MedicationRequest {
  return {
    ...medicationRequest,
    identifier: [
      ...(medicationRequest.identifier ?? []),
      { system: WENO_MESSAGE_ID_IDENTIFIER_SYSTEM, value: messageId },
    ],
  };
}

function withElectronicTransmission(medicationRequest: MedicationRequest): MedicationRequest {
  const extension = (medicationRequest.extension ?? []).filter(
    (candidate) => candidate.url !== ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  );
  return {
    ...medicationRequest,
    extension: [
      ...extension,
      { url: ODOS_TRANSMISSION_METHOD_EXTENSION_URL, valueCode: "electronically-sent" },
    ],
  };
}

function withWenoError(
  medicationRequest: MedicationRequest,
  messageId: string,
  result: Extract<WenoSwitchNewRxResult, { kind: "error" }>,
  sentTime: string,
): MedicationRequest {
  const identifiers = (medicationRequest.identifier ?? []).filter(
    (identifier) =>
      identifier.system !== WENO_MESSAGE_ID_IDENTIFIER_SYSTEM || identifier.value !== messageId,
  );
  return {
    ...medicationRequest,
    identifier: identifiers.length ? identifiers : undefined,
    note: [
      ...(medicationRequest.note ?? []),
      {
        time: sentTime,
        text: `${WENO_ERROR_NOTE_PREFIX} ${result.code}/${result.descriptionCode}: ${result.description}`,
      },
    ],
  };
}

function withWenoOutcomeUnknown(
  medicationRequest: MedicationRequest,
  messageId: string,
  reason: string,
  sentTime: string,
): MedicationRequest {
  return {
    ...medicationRequest,
    note: [
      ...(medicationRequest.note ?? []),
      {
        time: sentTime,
        text: `${WENO_OUTCOME_UNKNOWN_NOTE_PREFIX} ${messageId}: ${reason}`,
      },
    ],
  };
}

function withWenoCancelReservation(
  medicationRequest: MedicationRequest,
  messageId: string,
  reservedAt: string,
): MedicationRequest {
  return {
    ...medicationRequest,
    identifier: [
      ...(medicationRequest.identifier ?? []),
      { system: WENO_CANCEL_MESSAGE_ID_IDENTIFIER_SYSTEM, value: messageId },
    ],
    note: [
      ...(medicationRequest.note ?? []),
      {
        time: reservedAt,
        text: `${WENO_CANCEL_RESERVATION_NOTE_PREFIX} ${messageId}.`,
      },
    ],
  };
}

function withoutWenoCancelReservation(
  medicationRequest: MedicationRequest,
  messageId: string,
): MedicationRequest {
  const identifier = (medicationRequest.identifier ?? []).filter(
    (candidate) =>
      candidate.system !== WENO_CANCEL_MESSAGE_ID_IDENTIFIER_SYSTEM
      || candidate.value !== messageId,
  );
  const note = (medicationRequest.note ?? []).filter(
    (candidate) => candidate.text !== `${WENO_CANCEL_RESERVATION_NOTE_PREFIX} ${messageId}.`,
  );
  return {
    ...medicationRequest,
    identifier: identifier.length ? identifier : undefined,
    note: note.length ? note : undefined,
  };
}

function withCompletedWenoCancel(
  medicationRequest: MedicationRequest,
  messageId: string,
  staffReference: string,
  completedAt: string,
): MedicationRequest {
  const completed = withoutWenoCancelReservation(medicationRequest, messageId);
  return {
    ...completed,
    status: "cancelled",
    note: [
      ...(completed.note ?? []),
      {
        time: completedAt,
        text: `${WENO_CANCEL_COMPLETED_NOTE_PREFIX} ${messageId} by ${staffReference}.`,
      },
    ],
  };
}

function withClearedIndeterminateCancelReservation(
  medicationRequest: MedicationRequest,
  messageId: string,
  staffReference: string,
  clearedAt: string,
): MedicationRequest {
  const cleared = withoutWenoCancelReservation(medicationRequest, messageId);
  return {
    ...cleared,
    note: [
      ...(cleared.note ?? []),
      {
        time: clearedAt,
        text: `${WENO_CANCEL_RESERVATION_CLEARED_NOTE_PREFIX} ${messageId} by ${staffReference}.`,
      },
    ],
  };
}

function withClearedIndeterminateReservation(
  medicationRequest: MedicationRequest,
  messageId: string,
  staffReference: string,
  clearedAt: string,
): MedicationRequest {
  const identifiers = (medicationRequest.identifier ?? []).filter(
    (identifier) =>
      identifier.system !== WENO_MESSAGE_ID_IDENTIFIER_SYSTEM || identifier.value !== messageId,
  );
  return {
    ...medicationRequest,
    identifier: identifiers.length ? identifiers : undefined,
    note: [
      ...(medicationRequest.note ?? []),
      {
        time: clearedAt,
        text: `${WENO_RESERVATION_CLEARED_NOTE_PREFIX} ${messageId} by ${staffReference}.`,
      },
    ],
  };
}

function wenoMessageId(medicationRequest: MedicationRequest): string | undefined {
  return medicationRequest.identifier?.find(
    (identifier) => identifier.system === WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
  )?.value;
}

function hasWenoOutcomeUnknown(
  medicationRequest: MedicationRequest,
  messageId: string,
): boolean {
  return medicationRequest.note?.some(
    (note) => note.text?.startsWith(`${WENO_OUTCOME_UNKNOWN_NOTE_PREFIX} ${messageId}:`),
  ) ?? false;
}

function hasWenoCancelReservation(medicationRequest: MedicationRequest): boolean {
  return wenoCancelMessageId(medicationRequest) !== undefined;
}

function wenoCancelMessageId(medicationRequest: MedicationRequest): string | undefined {
  return medicationRequest.identifier?.find(
    (identifier) => identifier.system === WENO_CANCEL_MESSAGE_ID_IDENTIFIER_SYSTEM,
  )?.value;
}

function isElectronicallySent(medicationRequest: MedicationRequest): boolean {
  return medicationRequest.extension?.some(
    (extension) =>
      extension.url === ODOS_TRANSMISSION_METHOD_EXTENSION_URL
      && extension.valueCode === "electronically-sent",
  ) ?? false;
}

function sendFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return (message || "WENO Switch did not return a determinate response.")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function versionHeaders(resource: MedicationRequest): Record<string, string> | undefined {
  return resource.meta?.versionId
    ? { "If-Match": `W/"${resource.meta.versionId}"` }
    : undefined;
}

function resourceId(value: unknown, resourceType: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9.-]{1,64}$/.test(value)) {
    throw new WenoPrescriptionSendError(400, `${resourceType} id is invalid.`);
  }
  return value;
}

function referenceId(reference: string | undefined, resourceType: string): string {
  const match = new RegExp(`^${resourceType}/([A-Za-z0-9.-]{1,64})$`).exec(reference ?? "");
  if (!match) {
    throw new WenoPrescriptionSendError(
      400,
      `The prescription must reference a local ${resourceType}.`,
    );
  }
  return match[1];
}

function fhirErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

function pharmacySearchInput(req: Request): PharmacySearchInput {
  const searchTypeValue = queryString(req.query.searchType, "searchType");
  if (searchTypeValue && !isPharmacySearchType(searchTypeValue)) {
    throw new WenoQueryValidationError("Pharmacy search type must be local-retail or mail-order.");
  }
  const searchType: PharmacySearchType | undefined = searchTypeValue === "local-retail" || searchTypeValue === "mail-order"
    ? searchTypeValue
    : undefined;
  return {
    state: queryString(req.query.state, "state"),
    zip: queryString(req.query.zip, "zip"),
    city: queryString(req.query.city, "city"),
    county: queryString(req.query.county, "county"),
    searchType,
    onWeno: queryBoolean(req.query.onWeno, "onWeno"),
    name: queryString(req.query.name, "name"),
    street: queryString(req.query.street, "street"),
    open24hr: queryBoolean(req.query.open24hr, "open24hr"),
    all: queryBoolean(req.query.all, "all"),
    includeTestPharmacies: queryBoolean(req.query.includeTestPharmacies, "includeTestPharmacies"),
  };
}

function shapeDrugResult(row: WenoDrugRow) {
  return {
    drugDbCode: row.drugDbCode,
    drugDbCodeQualifier: row.drugDbCodeQualifier,
    quantityUnitOfMeasureCode: row.quantityUnitOfMeasureCode,
    psnDescription: row.psnDescription,
    route: row.route,
    strength: row.strength,
  };
}

function shapePharmacyResult(row: PharmacyDirectoryRow) {
  return {
    ncpdpId: row.ncpdpId,
    npi: row.npi,
    businessName: row.businessName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    phone: row.phone,
    onWeno: row.onWeno,
  };
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WenoQueryValidationError(`WENO search ${field} must be a single value.`);
  }
  return value;
}

function queryBoolean(value: unknown, field: string): boolean | undefined {
  const text = queryString(value, field);
  if (text === undefined) return undefined;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new WenoQueryValidationError(`WENO search ${field} must be true or false.`);
}

function isPharmacySearchType(value: string): value is PharmacySearchType {
  return value === "local-retail" || value === "mail-order";
}

class WenoQueryValidationError extends Error {}
