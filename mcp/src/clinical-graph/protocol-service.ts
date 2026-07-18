import {
  PROTOCOL_BASIC_CODES,
  ProtocolBasicStore,
  type ProtocolFhirClient,
} from "./protocol-store.js";
import type {
  ChargeProposal,
  PlanActionInstance,
  ProtocolApplication,
  ProtocolDefinition,
  ProtocolFindingInstance,
  ProtocolItem,
  ProtocolOfferDiagnosis,
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

export class ProtocolService {
  readonly definitions: ProtocolBasicStore<ProtocolDefinition>;
  readonly applications: ProtocolBasicStore<ProtocolApplication>;
  readonly actions: ProtocolBasicStore<PlanActionInstance>;
  readonly findings: ProtocolBasicStore<ProtocolFindingInstance>;
  readonly charges: ProtocolBasicStore<ChargeProposal>;

  constructor(
    fhir: ProtocolFhirClient,
    private readonly projection: ProtocolProjection,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {
    this.definitions = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.protocolDefinition);
    this.applications = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.protocolApplication);
    this.actions = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.planActionInstance);
    this.findings = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.findingInstance);
    this.charges = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
  }

  async offers(diagnoses: ProtocolOfferDiagnosis[]): Promise<ProtocolDefinition[]> {
    const confirmedCodes = diagnoses.filter((row) => row.confirmed).map((row) => row.code);
    return (await this.definitions.list()).filter((definition) =>
      definition.status === "active" &&
      definition.trigger.kind === "diagnosis" &&
      definition.trigger.dxKeys.some((pattern) => confirmedCodes.some((code) => matchesCode(code, pattern)))
    );
  }

  async open(protocolId: string, input: OpenProtocolInput): Promise<{
    application: ProtocolApplication;
    proposedFindings: ProtocolFindingInstance[];
  }> {
    const protocol = await this.definitions.get(protocolId);
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
    for (const charge of (await this.charges.list()).filter((row) => row.protocolApplicationId === application.id)) {
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
        ruleVersion: 1,
        outcome: "no-rule",
        messages: ["Coverage rules are stored but not evaluated in Phase 5."],
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
    const protocol = await this.definitions.get(application.protocolId);
    if (!protocol || protocol.version !== application.protocolVersion) {
      throw new Error("Pinned protocol version is unavailable; refusing retroactive substitution.");
    }
    return protocol;
  }
}

export function matchesCode(code: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(code);
}

export function committedFindingEvidence(findings: ProtocolFindingInstance[]): ProtocolFindingInstance[] {
  return findings.filter((row) => row.state === "committed" && Boolean(row.observationReference));
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
