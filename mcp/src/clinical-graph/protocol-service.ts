import type { Condition, Observation } from "@medplum/fhirtypes";
import {
  PROTOCOL_BASIC_CODES,
  ProtocolBasicStore,
  ProtocolDefinitionStore,
  type ProtocolFhirClient,
} from "./protocol-store.js";
import type {
  ChargeProposal,
  DiagnosisVisitStatus,
  PlanActionInstance,
  ProtocolApplication,
  ProtocolDefinition,
  ProtocolDefinitionDraft,
  ProtocolFindingInstance,
  ProtocolItem,
  ProtocolOfferDiagnosis,
  ProcedureChargeRule,
} from "./protocol-types.js";

export interface ProtocolProjection {
  commitFinding(finding: ProtocolFindingInstance): Promise<string | undefined>;
  materializeAction(action: PlanActionInstance): Promise<string | undefined>;
  removeMaterialized?(reference: string): Promise<void>;
}

export interface OpenProtocolInput {
  encounterId: string;
  patientId: string;
  diagnosis: ProtocolOfferDiagnosis;
  actor: string;
}

export interface CommitSelection {
  itemKey: string;
  selected: boolean;
  payload?: Record<string, unknown>;
}

export class AcceptedChargeUnapplyError extends Error {}

export interface ProtocolCatalogs {
  findingKeys: ReadonlySet<string>;
  procedureKeys: ReadonlySet<string>;
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

export class ProtocolPublishValidationError extends Error {
  constructor(readonly issues: ProtocolValidationIssue[]) {
    super(issues[0]?.message ?? "Protocol publish validation failed.");
  }
}

export interface CaptureProtocolInput {
  encounterId: string;
  name: string;
  actor: string;
  confirmedDiagnoses: Array<{ code: string }>;
  observations: Observation[];
  findingKeys: ReadonlySet<string>;
}

export class ProtocolService {
  readonly definitions: ProtocolDefinitionStore;
  readonly applications: ProtocolBasicStore<ProtocolApplication>;
  readonly actions: ProtocolBasicStore<PlanActionInstance>;
  readonly findings: ProtocolBasicStore<ProtocolFindingInstance>;
  readonly charges: ProtocolBasicStore<ChargeProposal>;
  readonly chargeRules: ProtocolBasicStore<ProcedureChargeRule>;

  constructor(
    fhir: ProtocolFhirClient,
    private readonly projection: ProtocolProjection,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {
    this.definitions = new ProtocolDefinitionStore(fhir);
    this.applications = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.protocolApplication);
    this.actions = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.planActionInstance);
    this.findings = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.findingInstance);
    this.charges = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
    this.chargeRules = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.procedureChargeRule);
  }

  async offers(diagnoses: ProtocolOfferDiagnosis[]): Promise<ProtocolDefinition[]> {
    const confirmedCodes = diagnoses.filter((row) => row.confirmed).map((row) => row.code);
    return (await this.definitions.list())
      .filter((definition) =>
        definition.status === "active" &&
        definition.trigger.kind === "diagnosis" &&
        definition.trigger.dxKeys.some((pattern) => confirmedCodes.some((code) => matchesCode(code, pattern)))
      )
      .map(publishedFromHead)
      .sort((left, right) => {
        // Advisory status match first, then unscoped definitions, then scoped non-matches;
        // title and id make the rail stable without ever hiding a clinician-selectable variant.
        const scopeRank = (definition: ProtocolDefinition) => {
          if (definition.trigger.kind !== "diagnosis" || !definition.trigger.statusScope?.length) return 1;
          return diagnoses.some((diagnosis) =>
            diagnosis.confirmed &&
            diagnosis.visitStatus &&
            definition.trigger.kind === "diagnosis" &&
            definition.trigger.dxKeys.some((pattern) => matchesCode(diagnosis.code, pattern)) &&
            definition.trigger.statusScope?.includes(diagnosis.visitStatus as DiagnosisVisitStatus)
          ) ? 2 : 0;
        };
        return scopeRank(right) - scopeRank(left) ||
          left.title.localeCompare(right.title) ||
          left.id.localeCompare(right.id);
      });
  }

  async createDraft(
    input: Partial<ProtocolDefinitionDraft> & { title?: string },
    actor: string,
    origin: ProtocolDefinition["authoring"]["origin"] = "clinician",
    forkedFrom?: { id: string; version: number },
  ): Promise<ProtocolDefinition> {
    const at = this.now();
    const id = this.id();
    const draft = normalizeDraft({
      title: input.title?.trim() || "Untitled protocol",
      trigger: input.trigger ?? { kind: "diagnosis", dxKeys: [] },
      ownership: input.ownership ?? { ownerId: actor, sharing: "private" },
      categories: input.categories ?? [],
      items: input.items ?? [],
      ...(input.applicability ? { applicability: input.applicability } : {}),
      ...(input.mergePolicy ? { mergePolicy: input.mergePolicy } : {}),
      ...(input.provenanceNote ? { provenanceNote: input.provenanceNote } : {}),
    });
    return this.definitions.saveHead({
      id,
      version: 0,
      ...draft,
      draft,
      status: "draft",
      authoring: { origin, at, actor },
      audit: {
        createdBy: actor,
        createdAt: at,
        ...(forkedFrom ? { forkedFrom } : {}),
      },
    });
  }

  async saveDraft(id: string, draft: ProtocolDefinitionDraft): Promise<ProtocolDefinition> {
    const head = await this.definitions.get(id);
    if (!head) throw new Error("Protocol definition not found.");
    if (head.status === "retired") throw new Error("Retired protocols cannot be edited.");
    const normalized = normalizeDraft(draft);
    return this.definitions.saveHead({
      ...head,
      ...(head.version === 0 ? normalized : {}),
      draft: normalized,
      ...(head.version === 0 ? { status: "draft" as const } : {}),
    });
  }

  async publish(id: string, actor: string, catalogs: ProtocolCatalogs): Promise<ProtocolDefinition> {
    const head = await this.definitions.get(id);
    if (!head) throw new Error("Protocol definition not found.");
    if (!head.draft) throw new Error("Protocol has no unpublished draft.");
    const issues = validateProtocolDefinition(head.draft, catalogs);
    if (issues.length) throw new ProtocolPublishValidationError(issues);
    const at = this.now();
    const snapshot: ProtocolDefinition = {
      id: head.id,
      version: head.version + 1,
      ...normalizeDraft(head.draft),
      status: "active",
      authoring: head.authoring,
      audit: {
        ...head.audit,
        publishedBy: actor,
        publishedAt: at,
      },
    };
    await this.definitions.saveSnapshot(snapshot);
    return this.definitions.saveHead(snapshot);
  }

  async retire(id: string): Promise<ProtocolDefinition> {
    const head = await this.definitions.get(id);
    if (!head) throw new Error("Protocol definition not found.");
    return this.definitions.saveHead({ ...head, status: "retired" });
  }

  async fork(id: string, actor: string, title?: string): Promise<ProtocolDefinition> {
    const head = await this.definitions.get(id);
    if (!head) throw new Error("Protocol definition not found.");
    const source = head.version > 0
      ? await this.definitions.getSnapshot(head.id, head.version)
      : head;
    if (!source) throw new Error("Protocol version to fork is unavailable.");
    return this.createDraft({
      ...draftFromDefinition(source),
      title: title?.trim() || `Copy of ${source.title}`,
      ownership: { ownerId: actor, sharing: "private" },
    }, actor, "clinician", head.version > 0
      ? { id: head.id, version: head.version }
      : undefined);
  }

  async captureDraft(input: CaptureProtocolInput): Promise<ProtocolDefinition> {
    const findings = (await this.findings.list()).filter((row) =>
      row.encounterId === input.encounterId && row.state === "committed"
    );
    const applications = (await this.applications.list()).filter((row) =>
      row.encounterId === input.encounterId
    );
    const sourceItems = new Map<string, ProtocolItem>();
    for (const application of applications) {
      const snapshot = await this.definitions.getSnapshot(application.protocolId, application.protocolVersion);
      for (const item of snapshot?.items ?? []) sourceItems.set(`${application.id}:${item.itemKey}`, item);
    }
    const findingByObservation = new Map(findings.flatMap((finding) =>
      finding.observationReference ? [[finding.observationReference, finding] as const] : []
    ));
    const items: ProtocolItem[] = [];
    for (const observation of input.observations.filter((row) =>
      ["final", "amended", "corrected"].includes(row.status)
    )) {
      const findingDefKey = observationFindingKey(observation, input.findingKeys);
      if (!findingDefKey) continue;
      const protocolFinding = observation.id
        ? findingByObservation.get(`Observation/${observation.id}`)
        : undefined;
      const sourceItem = protocolFinding
        ? sourceItems.get(`${protocolFinding.protocolApplicationId}:${protocolFinding.sourceItemKey}`)
        : undefined;
      const deviceMeasured = observationIsDeviceMeasured(observation);
      const value = deviceMeasured ? undefined : structuredObservationValue(observation);
      items.push({
        itemKey: uniqueItemKey(items, `finding-${findingDefKey}`),
        itemType: "finding-seed",
        defaultSelected: true,
        lateralityMode: sourceItem?.lateralityMode === "OU-always" ? "OU-always" : "inherit-dx",
        payload: {
          findingDefKey,
          mode: value === undefined ? "promptOnly" : "seedValue",
          ...(value === undefined ? {} : { defaultValue: value }),
        },
        capture: {
          source: deviceMeasured ? "device-measured" : "observed-estimate",
          ...(value === undefined ? {} : { seedValueKept: true }),
        },
      });
    }
    for (const finding of findings.filter((row) => !row.observationReference)) {
      if (!input.findingKeys.has(finding.findingDefKey)) continue;
      const sourceItem = sourceItems.get(`${finding.protocolApplicationId}:${finding.sourceItemKey}`);
      const value = structuredFindingValue(finding.value);
      items.push({
        itemKey: uniqueItemKey(items, `finding-${finding.findingDefKey}`),
        itemType: "finding-seed",
        defaultSelected: true,
        lateralityMode: sourceItem?.lateralityMode === "OU-always" ? "OU-always" : "inherit-dx",
        payload: {
          findingDefKey: finding.findingDefKey,
          mode: value === undefined ? "promptOnly" : "seedValue",
          ...(value === undefined ? {} : { defaultValue: value }),
        },
        capture: {
          source: "observed-estimate",
          ...(value === undefined ? {} : { seedValueKept: true }),
        },
      });
    }
    for (const action of (await this.actions.list()).filter((row) =>
      row.encounterId === input.encounterId &&
      ["selected", "modified", "completed"].includes(row.state)
    )) {
      const sourceItem = action.protocolApplicationId && action.sourceItemKey
        ? sourceItems.get(`${action.protocolApplicationId}:${action.sourceItemKey}`)
        : undefined;
      const payload = structuredCapturePayload(action.payload);
      if (!Object.keys(payload).length) continue;
      items.push({
        itemKey: uniqueItemKey(items, action.sourceItemKey ?? action.actionType),
        itemType: action.actionType,
        defaultSelected: true,
        lateralityMode: sourceItem?.lateralityMode === "OU-always" ? "OU-always" : "inherit-dx",
        ...(action.mergeKey ? { mergeKey: action.mergeKey } : {}),
        payload,
        capture: { source: "structured" },
      });
    }
    for (const charge of (await this.charges.list()).filter((row) =>
      row.encounterId === input.encounterId && row.state === "staged"
    )) {
      const sourceItem = sourceItems.get(`${charge.protocolApplicationId}:${charge.planActionRef}`);
      const chargeRuleRefs = Array.isArray(sourceItem?.payload.chargeRuleRefs)
        ? sourceItem.payload.chargeRuleRefs
        : charge.coverageEvaluations.map((row) => row.ruleId).filter(Boolean);
      items.push({
        itemKey: uniqueItemKey(items, charge.planActionRef || `charge-${charge.procedureConceptKey}`),
        itemType: "charge-seed",
        defaultSelected: true,
        lateralityMode: sourceItem?.lateralityMode === "OU-always" ? "OU-always" : "inherit-dx",
        payload: {
          procedureConceptKey: charge.procedureConceptKey,
          chargeRuleRefs,
          ...(sourceItem?.payload.requiresOrderCompletion !== undefined
            ? { requiresOrderCompletion: sourceItem.payload.requiresOrderCompletion }
            : {}),
        },
        capture: { source: "structured" },
      });
    }
    return this.createDraft({
      title: input.name,
      trigger: { kind: "diagnosis", dxKeys: [...new Set(input.confirmedDiagnoses.map((row) => row.code))] },
      ownership: { ownerId: input.actor, sharing: "private" },
      categories: [],
      items,
    }, input.actor, "encounter-capture");
  }

  async open(protocolId: string, input: OpenProtocolInput): Promise<{
    application: ProtocolApplication;
    proposedFindings: ProtocolFindingInstance[];
  }> {
    const head = await this.definitions.get(protocolId);
    const protocol = head ? publishedFromHead(head) : undefined;
    if (!protocol || protocol.status !== "active") throw new Error("Active protocol not found.");
    if ((await this.applications.list()).some((application) =>
      application.encounterId === input.encounterId && application.protocolId === protocolId &&
      application.confirmed && application.undoState === "active"
    )) throw new Error("Protocol is already applied to this encounter.");
    if (!input.diagnosis.confirmed || protocol.trigger.kind !== "diagnosis" ||
      !protocol.trigger.dxKeys.some((pattern) => matchesCode(input.diagnosis.code, pattern))) {
      throw new Error("Confirmed diagnosis does not match protocol trigger.");
    }
    const at = this.now();
    const application = await this.applications.save({
      id: this.id(),
      encounterId: input.encounterId,
      patientId: input.patientId,
      protocolId: protocol.id,
      protocolVersion: protocol.version,
      appliedBy: input.actor,
      appliedAt: at,
      stackedWith: [],
      dispositions: [],
      dedupResolutions: [],
      undoState: "active",
      confirmed: false,
    });
    const proposedFindings = [];
    for (const item of protocol.items.filter((row) => row.itemType === "finding-seed")) {
      const payload = item.payload;
      for (const dimension of findingDimensions(payload)) {
        proposedFindings.push(await this.findings.save({
          id: this.id(),
          encounterId: input.encounterId,
          patientId: input.patientId,
          protocolApplicationId: application.id,
          sourceItemKey: item.itemKey,
          findingDefKey: String(payload.findingDefKey),
          ...dimension,
          state: "proposed",
          ...(payload.mode === "seedValue" ? { value: findingDefaultValue(payload, dimension.laterality) } : {}),
          editedBeforeCommit: false,
          provenance: {
            source: "protocol-default",
            ...(payload.entryMode === "propagated-uniform" ? { entryMode: "propagated-uniform" as const } : {}),
            actor: input.actor,
            at,
            protocolId: protocol.id,
            protocolVersion: protocol.version,
          },
        }));
      }
    }
    return { application, proposedFindings };
  }

  async commit(applicationId: string, selections: CommitSelection[], linkedDx: string[]): Promise<void> {
    const application = await this.requireApplication(applicationId);
    if (application.confirmed) throw new Error("Protocol application is already confirmed.");
    const protocol = await this.requirePinnedProtocol(application);
    const choices = new Map(selections.map((row) => [row.itemKey, row]));
    const at = this.now();
    const proposed = (await this.findings.list()).filter((row) => row.protocolApplicationId === application.id);
    const dispositions: ProtocolApplication["dispositions"] = [];

    for (const item of protocol.items) {
      const choice = choices.get(item.itemKey);
      const selected = choice?.selected ?? item.defaultSelected;
      if (!selected) {
        dispositions.push({ itemKey: item.itemKey, outcome: "opted-out" });
        for (const finding of proposed.filter((row) =>
          row.sourceItemKey === item.itemKey && row.state === "proposed"
        )) await this.findings.save({ ...finding, state: "removed" });
        continue;
      }
      const payload = choice?.payload ?? item.payload;
      const modified = JSON.stringify(payload) !== JSON.stringify(item.payload);
      dispositions.push({ itemKey: item.itemKey, outcome: modified ? "applied-modified" : "applied-default" });
      if (item.itemType === "finding-seed") {
        const itemFindings = proposed.filter((row) => row.sourceItemKey === item.itemKey);
        if (!itemFindings.length) throw new Error(`Proposed finding ${item.itemKey} is missing.`);
        for (const finding of itemFindings.filter((row) => row.state === "proposed")) {
          const committed: ProtocolFindingInstance = {
            ...finding,
            state: "committed",
            ...(payload.mode === "seedValue" ? { value: findingDefaultValue(payload, finding.laterality) } : {}),
            editedBeforeCommit: modified,
            provenance: {
              ...finding.provenance,
              source: modified ? "clinician-entered" : "protocol-default",
              actor: application.appliedBy,
              at,
            },
          };
          const observationReference = committed.value === undefined
            ? undefined
            : await this.projection.commitFinding(committed);
          if (observationReference) committed.observationReference = observationReference;
          await this.findings.save(committed);
        }
      } else if (item.itemType === "charge-seed") {
        await this.stageCharge(application, item, payload, linkedDx, at);
      } else {
        await this.upsertAction(application, item, payload, linkedDx, at);
      }
    }
    await this.applications.save({ ...application, confirmed: true, dispositions });
  }

  async addManualAction(input: Omit<PlanActionInstance, "id" | "protocolApplicationId" | "modifiedFields">): Promise<PlanActionInstance> {
    const collision = input.mergeKey
      ? (await this.actions.list()).find((row) =>
          row.encounterId === input.encounterId && row.mergeKey === input.mergeKey &&
          !["removed", "cancelled"].includes(row.state))
      : undefined;
    if (collision) {
      const changed = changedFields(collision.payload, input.payload);
      const updated = {
        ...collision,
        payload: input.payload,
        state: "modified" as const,
        modifiedFields: [...new Set([...collision.modifiedFields, ...changed])],
        provenance: { ...input.provenance, source: "clinician-entered" as const },
      };
      await this.actions.save(updated);
      return updated;
    }
    const created = {
      ...input,
      id: this.id(),
      protocolApplicationId: null,
      modifiedFields: [],
    };
    await this.actions.save(created);
    return created;
  }

  async editFinding(id: string, value: unknown, actor: string): Promise<ProtocolFindingInstance> {
    const finding = await this.findings.get(id);
    if (!finding || finding.state !== "committed") throw new Error("Committed finding not found.");
    return this.findings.save({
      ...finding,
      value,
      provenance: {
        ...finding.provenance,
        source: "clinician-entered",
        ...(finding.componentKey ? { entryMode: "quadrant-specific" as const } : {}),
        actor,
        at: this.now(),
      },
    });
  }

  async unapply(applicationId: string): Promise<{ removed: string[]; preserved: string[] }> {
    const application = await this.requireApplication(applicationId);
    const linkedCharges = (await this.charges.list()).filter((row) =>
      row.protocolApplicationId === application.id
    );
    const acceptedChargeCount = linkedCharges.filter((charge) => charge.state === "accepted").length;
    if (acceptedChargeCount) {
      throw new AcceptedChargeUnapplyError(
        `Cannot un-apply: ${acceptedChargeCount} accepted charge${acceptedChargeCount === 1 ? "" : "s"} must be resolved first.`,
      );
    }
    const removed: string[] = [];
    const preserved: string[] = [];
    for (const action of (await this.actions.list()).filter((row) => row.protocolApplicationId === applicationId)) {
      if (action.state === "selected" && action.modifiedFields.length === 0) {
        if (action.materializedFhirRef) await this.projection.removeMaterialized?.(action.materializedFhirRef);
        await this.actions.save({ ...action, state: "removed" });
        removed.push(action.id);
      } else preserved.push(action.id);
    }
    for (const finding of (await this.findings.list()).filter((row) => row.protocolApplicationId === applicationId)) {
      if (finding.state === "committed" && finding.provenance.source === "protocol-default") {
        if (finding.observationReference) await this.projection.removeMaterialized?.(finding.observationReference);
        await this.findings.save({ ...finding, state: "removed" });
        removed.push(finding.id);
      } else if (finding.state !== "removed") preserved.push(finding.id);
    }
    for (const charge of linkedCharges) {
      if (charge.state === "staged") {
        await this.charges.save({ ...charge, state: "removed" });
        removed.push(charge.id);
      } else preserved.push(charge.id);
    }
    await this.applications.save({ ...application, undoState: "unapplied" });
    return { removed, preserved };
  }

  async abandonOpenForSignedEncounter(encounterId: string): Promise<number> {
    const open = (await this.applications.list()).filter((row) =>
      row.encounterId === encounterId && !row.confirmed && row.undoState === "active"
    );
    for (const application of open) {
      for (const finding of (await this.findings.list()).filter((row) =>
        row.protocolApplicationId === application.id && row.state === "proposed"
      )) await this.findings.save({ ...finding, state: "removed" });
      await this.applications.save({ ...application, undoState: "unapplied" });
    }
    return open.length;
  }

  private async upsertAction(
    application: ProtocolApplication,
    item: ProtocolItem,
    payload: Record<string, unknown>,
    linkedDx: string[],
    at: string,
  ): Promise<void> {
    const actions = await this.actions.list();
    const existingForItem = actions.find((row) =>
      row.protocolApplicationId === application.id &&
      row.sourceItemKey === item.itemKey &&
      !["removed", "cancelled"].includes(row.state)
    );
    if (existingForItem) return;
    const existing = item.mergeKey ? actions.find((row) =>
      row.encounterId === application.encounterId && row.mergeKey === item.mergeKey &&
      !["removed", "cancelled"].includes(row.state)
    ) : undefined;
    if (existing) return;
    const action: PlanActionInstance = {
      id: this.id(),
      encounterId: application.encounterId,
      patientId: application.patientId,
      protocolApplicationId: application.id,
      sourceItemKey: item.itemKey,
      actionType: item.itemType,
      linkedDx,
      linkedFindings: [],
      state: "selected",
      ...(item.mergeKey ? { mergeKey: item.mergeKey } : {}),
      payload,
      protocolDefaultPayload: item.payload,
      modifiedFields: changedFields(item.payload, payload),
      provenance: {
        source: changedFields(item.payload, payload).length ? "clinician-entered" : "protocol-default",
        actor: application.appliedBy,
        at,
        protocolId: application.protocolId,
        protocolVersion: application.protocolVersion,
      },
    };
    action.materializedFhirRef = await this.projection.materializeAction(action);
    await this.actions.save(action);
  }

  private async stageCharge(
    application: ProtocolApplication,
    item: ProtocolItem,
    payload: Record<string, unknown>,
    linkedDx: string[],
    at: string,
  ): Promise<void> {
    const existing = (await this.charges.list()).find((row) =>
      row.protocolApplicationId === application.id &&
      row.planActionRef === item.itemKey &&
      row.state !== "removed"
    );
    if (existing) return;
    const ruleId = Array.isArray(payload.chargeRuleRefs) ? String(payload.chargeRuleRefs[0] ?? "") : "";
    const rule = ruleId ? await this.chargeRules.get(ruleId) : undefined;
    await this.charges.save({
      id: this.id(),
      encounterId: application.encounterId,
      protocolApplicationId: application.id,
      planActionRef: item.itemKey,
      procedureConceptKey: String(payload.procedureConceptKey),
      units: 1,
      laterality: "OU",
      dxPointers: linkedDx,
      evidenceRefs: [],
      coverageEvaluations: [{
        at,
        ruleId,
        ruleVersion: rule?.version ?? 1,
        outcome: rule?.outcome ?? "no-rule",
        messages: rule
          ? [`Coverage review rule ${rule.id} resolved (${rule.verificationStatus}).`]
          : ["No coverage review rule resolved for this charge proposal."],
      }],
      state: "staged",
      provenance: {
        source: "protocol-default",
        actor: application.appliedBy,
        at,
        protocolId: application.protocolId,
        protocolVersion: application.protocolVersion,
      },
    });
  }

  private async requireApplication(id: string): Promise<ProtocolApplication> {
    const application = await this.applications.get(id);
    if (!application) throw new Error("Protocol application not found.");
    return application;
  }

  private async requirePinnedProtocol(application: ProtocolApplication): Promise<ProtocolDefinition> {
    const protocol = await this.definitions.getSnapshot(application.protocolId, application.protocolVersion);
    if (!protocol || protocol.version !== application.protocolVersion) {
      throw new Error("Pinned protocol version is unavailable; refusing retroactive substitution.");
    }
    return protocol;
  }
}

export function validateProtocolDefinition(
  draft: ProtocolDefinitionDraft,
  catalogs: ProtocolCatalogs,
): ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  if (!draft.items.length) {
    issues.push({ reason: "EMPTY_ITEM_LIST", message: "Protocol must contain at least one item." });
  }
  for (const item of draft.items) {
    if (
      item.itemType === "finding-seed" &&
      item.capture?.source === "device-measured" &&
      item.payload.mode === "seedValue"
    ) {
      issues.push({
        reason: "DEVICE_MEASURED_SEED",
        itemKey: item.itemKey,
        message: `Device-measured finding ${item.itemKey} must remain promptOnly.`,
      });
    }
    const catalogKey = item.itemType === "finding-seed"
      ? stringValue(item.payload.findingDefKey)
      : item.itemType === "order"
        ? stringValue(item.payload.orderableKey)
        : item.itemType === "charge-seed"
          ? stringValue(item.payload.procedureConceptKey)
          : undefined;
    const known = item.itemType === "finding-seed" ? catalogs.findingKeys : catalogs.procedureKeys;
    if (catalogKey !== undefined && (!catalogKey || !known.has(catalogKey))) {
      issues.push({
        reason: "UNKNOWN_CATALOG_KEY",
        itemKey: item.itemKey,
        message: catalogKey
          ? `Unknown catalog key ${catalogKey} on ${item.itemKey}.`
          : `Missing catalog key on ${item.itemKey}.`,
      });
    }
    if (item.capture && capturedFreeText(item.payload)) {
      issues.push({
        reason: "CAPTURED_FREE_TEXT",
        itemKey: item.itemKey,
        message: `Captured item ${item.itemKey} contains free text that must be authored fresh.`,
      });
    }
  }
  return issues;
}

export function matchesCode(code: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(code);
}

export function committedFindingEvidence(findings: ProtocolFindingInstance[]): ProtocolFindingInstance[] {
  return findings.filter((row) => row.state === "committed" && Boolean(row.observationReference));
}

function normalizeDraft(draft: ProtocolDefinitionDraft): ProtocolDefinitionDraft {
  return structuredClone({
    ...draft,
    title: draft.title.trim(),
    categories: [...new Set(draft.categories.map((row) => row.trim()).filter(Boolean))],
    trigger: draft.trigger.kind === "diagnosis"
      ? {
          kind: "diagnosis" as const,
          dxKeys: [...new Set(draft.trigger.dxKeys.map((row) => row.trim()).filter(Boolean))],
          ...(draft.trigger.statusScope?.length
            ? { statusScope: [...new Set(draft.trigger.statusScope)] }
            : {}),
        }
      : {
          kind: "visit-type" as const,
          visitTypes: [...new Set(draft.trigger.visitTypes.map((row) => row.trim()).filter(Boolean))],
        },
    items: draft.items.map((item) => {
      const { mergeKey, ...content } = item;
      return {
        ...content,
        itemKey: item.itemKey.trim(),
        ...(mergeKey?.trim() ? { mergeKey: mergeKey.trim() } : {}),
      };
    }),
  });
}

function draftFromDefinition(definition: ProtocolDefinition): ProtocolDefinitionDraft {
  return normalizeDraft({
    title: definition.title,
    trigger: definition.trigger,
    ownership: definition.ownership,
    categories: definition.categories,
    items: definition.items,
    ...(definition.applicability ? { applicability: definition.applicability } : {}),
    ...(definition.mergePolicy ? { mergePolicy: definition.mergePolicy } : {}),
    ...(definition.provenanceNote ? { provenanceNote: definition.provenanceNote } : {}),
  });
}

function publishedFromHead(head: ProtocolDefinition): ProtocolDefinition {
  const { draft: _draft, ...published } = head;
  return structuredClone(published);
}

function observationFindingKey(
  observation: Observation,
  findingKeys: ReadonlySet<string>,
): string | undefined {
  return observation.code.coding?.map((coding) => coding.code).find((code) =>
    Boolean(code && findingKeys.has(code))
  );
}

function observationIsDeviceMeasured(observation: Observation): boolean {
  return Boolean(observation.device?.reference) ||
    (observation.note ?? []).some((note) => /(?:^|;\s*)sourceType=device(?:;|$)/i.test(note.text ?? ""));
}

function structuredObservationValue(observation: Observation): unknown {
  if (typeof observation.valueQuantity?.value === "number") return observation.valueQuantity.value;
  if (typeof observation.valueInteger === "number") return observation.valueInteger;
  if (typeof observation.valueBoolean === "boolean") return observation.valueBoolean;
  const code = observation.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  if (code) return code;
  if (observation.component?.length) {
    const entries = observation.component.flatMap((component) => {
      const key = component.code.coding?.find((coding) => coding.code)?.code;
      const value = component.valueQuantity?.value ??
        component.valueInteger ??
        component.valueBoolean ??
        component.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
      return key && value !== undefined ? [[key, value] as const] : [];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return undefined;
}

function structuredFindingValue(value: unknown): unknown {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const structured = Object.fromEntries(Object.entries(value).filter(([, entry]) =>
      typeof entry === "number" || typeof entry === "boolean"
    ));
    return Object.keys(structured).length ? structured : undefined;
  }
  return undefined;
}

function structuredCapturePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => {
    if (value === undefined || value === null) return false;
    if (/(?:patient|encounter)(?:id|ref|reference)?$/i.test(key)) return false;
    if (isTemporalCaptureKey(key)) return false;
    if (/(?:narrative|note|text|reason|instruction)/i.test(key)) return false;
    if (/(?:reference|refs?)$/i.test(key) && !["assetRef", "chargeRuleRefs", "chargeSeedRef"].includes(key)) return false;
    return typeof value !== "string" || Boolean(value.trim());
  }));
}

function isTemporalCaptureKey(key: string): boolean {
  return /^(?:date|time|at)$/i.test(key) ||
    /(?:Date|Time|At)$/.test(key) ||
    /(?:^|[_-])(?:date|time|at)$/i.test(key);
}

function capturedFreeText(payload: Record<string, unknown>): boolean {
  return Object.entries(payload).some(([key, value]) =>
    /(?:narrative|note|text|reason|instruction)/i.test(key) &&
    typeof value === "string" &&
    Boolean(value.trim())
  );
}

function uniqueItemKey(items: ProtocolItem[], base: string): string {
  const normalized = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
  if (!items.some((item) => item.itemKey === normalized)) return normalized;
  let suffix = 2;
  while (items.some((item) => item.itemKey === `${normalized}-${suffix}`)) suffix += 1;
  return `${normalized}-${suffix}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function changedFields(original: Record<string, unknown>, next: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(original), ...Object.keys(next)])]
    .filter((key) => JSON.stringify(original[key]) !== JSON.stringify(next[key]));
}

function findingDimensions(payload: Record<string, unknown>): Array<{
  laterality?: "OD" | "OS" | "OU";
  componentKey?: string;
}> {
  const expand = typeof payload.expand === "object" && payload.expand !== null
    ? payload.expand as { eyes?: unknown; components?: unknown }
    : undefined;
  const eyes = Array.isArray(expand?.eyes)
    ? expand.eyes.filter((eye): eye is "OD" | "OS" => eye === "OD" || eye === "OS")
    : [];
  const components = Array.isArray(expand?.components)
    ? expand.components.filter((component): component is string => typeof component === "string" && Boolean(component))
    : [];
  if (!eyes.length) return [{}];
  if (!components.length) return eyes.map((laterality) => ({ laterality }));
  return eyes.flatMap((laterality) => components.map((componentKey) => ({ laterality, componentKey })));
}

function findingDefaultValue(payload: Record<string, unknown>, laterality: "OD" | "OS" | "OU" | undefined): unknown {
  if (laterality && typeof payload.defaultValues === "object" && payload.defaultValues !== null) {
    return (payload.defaultValues as Record<string, unknown>)[laterality];
  }
  return payload.defaultValue;
}
