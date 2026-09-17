import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";
import type { CurrentFindingProjection } from "./current-finding-reader.js";
import { normalizeApplicationScope } from "../../../src/protocol-application-scope.js";
import type { Condition, Observation } from "@medplum/fhirtypes";
import {
  protocolItemClaimIdentifier,
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
  ProtocolItemType,
  ProtocolOfferDiagnosis,
  ProcedureChargeRule,
} from "./protocol-types.js";

function clinicianOwnedFollowUp(action: PlanActionInstance): boolean {
  return action.state === "modified" || action.provenance.source === "clinician-entered";
}

export interface ProtocolProjection {
  validateMutation?(scope: {encounterId: string; patientId: string}, items?: readonly {item: ProtocolItem; payload: Record<string,unknown>}[], references?: readonly string[]): Promise<void>;
  commitFinding(finding: ProtocolFindingInstance): Promise<string | undefined>;
  materializeAction(action: PlanActionInstance): Promise<string | undefined>;
  removeMaterialized?(reference: string, scope?: {encounterId:string;patientId:string}): Promise<void | (() => Promise<void>)>;
}

export interface OpenProtocolInput {
  encounterId: string;
  patientId: string;
  diagnosis: ProtocolOfferDiagnosis;
  actor: string;
  selections?: CommitSelection[];
}

export interface CommitSelection {
  itemKey: string;
  selected: boolean;
  payload?: Record<string, unknown>;
  skipReason?: "not-offered";
}

type ItemApplicationResult =
  | { outcome: "created" | "existing-application" }
  | { outcome: "merge-deduped" };

interface ItemAddWrites {
  actionIds: Set<string>;
  materializedRefs: Set<string>;
  chargeIds: Set<string>;
  sharedActions: Map<string, { before: PlanActionInstance; after: PlanActionInstance }>;
}

export interface ProtocolItemAddLock {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

class InProcessProtocolItemAddLock implements ProtocolItemAddLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

// docker-compose runs one MCP server process with no replicas, so this lock fences live writers in that process.
// The conditional FHIR claim and lease below remain the cross-process backstop and crash recovery mechanism.
const IN_PROCESS_ITEM_ADD_LOCK = new InProcessProtocolItemAddLock();
const IN_PROCESS_ENCOUNTER_LOCK = new InProcessProtocolItemAddLock();

const TAPPABLE_PROTOCOL_ITEM_TYPES: ReadonlySet<ProtocolItemType> = new Set([
  "order",
  "medication",
  "counseling",
  "education",
  "instruction",
  "follow-up",
  "series-prescription",
]);
const ITEM_CLAIM_LEASE_MS = 5_000;
const ITEM_CLAIM_WAIT_MS = 250;
const ITEM_CLAIM_POLL_MS = 25;

export function isTappableProtocolItem(item: ProtocolItem): boolean {
  return TAPPABLE_PROTOCOL_ITEM_TYPES.has(item.itemType);
}

export class AcceptedChargeUnapplyError extends Error {}

export class ProtocolFollowUpNotFoundError extends Error {}

export class ProtocolItemAddConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolItemAddConflictError";
  }
}

export class ProtocolActionMaterializationRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolActionMaterializationRefusal";
  }
}

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
  findingDefinitions?: readonly ClinicalFindingDefinition[];
  sharedProjection?: CurrentFindingProjection;
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
    private readonly itemAddLock: ProtocolItemAddLock = IN_PROCESS_ITEM_ADD_LOCK,
    private readonly encounterLock: ProtocolItemAddLock = itemAddLock === IN_PROCESS_ITEM_ADD_LOCK ? IN_PROCESS_ENCOUNTER_LOCK : itemAddLock,
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
    const definitions = (await this.definitions.list())
      .filter((definition) =>
        definition.status === "active" &&
        definition.trigger.kind === "diagnosis" &&
        definition.trigger.dxKeys.some((pattern) => confirmedCodes.some((code) => matchesCode(code, pattern)))
      )
      .map(publishedFromHead);
    return rankProtocolOffers(definitions, diagnoses);
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
    await this.definitions.preservePublishedSnapshot(head);
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
      ...(head.acceptCharges !== undefined ? { acceptCharges: head.acceptCharges } : {}),
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
    await this.definitions.preservePublishedSnapshot(head);
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
    const sharedKeys = new Set((input.findingDefinitions ?? []).filter(d=>d.valueSchema.type === "ocular-health-structure").map(d=>d.stableKey));
    const activeSharedKeys = new Set((input.findingDefinitions ?? []).filter(d=>d.active && sharedKeys.has(d.stableKey)).map(d=>d.stableKey));
    const sharedEyes = new Map<string,Set<"OD"|"OS">>();
    const addShared = (key: string, eyes: readonly string[]) => {
      if (!activeSharedKeys.has(key)) return;
      const entry=sharedEyes.get(key) ?? new Set<"OD"|"OS">();
      for (const eye of eyes) if (eye === "OD" || eye === "OS") entry.add(eye);
      sharedEyes.set(key,entry);
    };
    for (const fact of input.sharedProjection?.currentFacts ?? []) if (fact.status === "live" && !fact.legacy) addShared(fact.key.stableKey,[fact.eye]);
    for (const panel of input.sharedProjection?.panels ?? []) if (!panel.conflict && Object.keys(panel.values).length && panel.panelBaseline) addShared(panel.stableKey,[panel.eye]);
    for (const finding of findings.filter(row=>!row.observationReference)) if (sharedKeys.has(finding.findingDefKey)) {
      const sourceItem = sourceItems.get(`${finding.protocolApplicationId}:${finding.sourceItemKey}`);
      addShared(finding.findingDefKey,finding.laterality === "OU" || (!finding.laterality && sourceItem?.lateralityMode === "OU-always") ? ["OD","OS"] : finding.laterality ? [finding.laterality] : []);
    }
    for (const [findingDefKey,eyes] of sharedEyes) items.push({itemKey:uniqueItemKey(items,`finding-${findingDefKey}`),itemType:"finding-seed",defaultSelected:true,lateralityMode:"inherit-dx",
      payload:{findingDefKey,mode:"promptOnly",expand:{eyes:[...eyes].sort()}},capture:{source:"observed-estimate"}});
    for (const observation of input.observations.filter((row) =>
      ["final", "amended", "corrected"].includes(row.status)
    )) {
      const findingDefKey = observationFindingKey(observation, input.findingKeys);
      if (!findingDefKey || sharedKeys.has(findingDefKey)) continue;
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
      if (!input.findingKeys.has(finding.findingDefKey) || sharedKeys.has(finding.findingDefKey)) continue;
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
      application.confirmed && application.undoState === "active" && normalizeApplicationScope(application) === "whole"
    )) throw new Error("Protocol is already applied to this encounter.");
    if (!input.diagnosis.confirmed || protocol.trigger.kind !== "diagnosis" ||
      !protocol.trigger.dxKeys.some((pattern) => matchesCode(input.diagnosis.code, pattern))) {
      throw new Error("Confirmed diagnosis does not match protocol trigger.");
    }
    await this.projection.validateMutation?.(input, selectedProtocolItems(protocol.items,input.selections ?? []));
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
      scope: "whole",
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

  async addItem(protocolId: string, itemKey: string, input: OpenProtocolInput): Promise<{
    application: ProtocolApplication;
    alreadyApplied: boolean;
  }> {
    const claimKey = protocolItemClaimIdentifier(input.encounterId, protocolId, itemKey).value;
    return this.encounterLock.run(input.encounterId, () =>
      this.itemAddLock.run(claimKey, () => this.addItemWithoutProcessLock(protocolId, itemKey, input)));
  }

  private async addItemWithoutProcessLock(
    protocolId: string,
    itemKey: string,
    input: OpenProtocolInput,
    recoverConfirmedOrphan = true,
  ): Promise<{ application: ProtocolApplication; alreadyApplied: boolean }> {
    const protocol = await this.requireActiveDiagnosisProtocol(protocolId, input);
    const item = protocol.items.find((candidate) => candidate.itemKey === itemKey);
    if (!item) throw new Error("Protocol item not found.");
    if (!isTappableProtocolItem(item)) {
      throw new Error(`Protocol item type ${item.itemType} is not tappable.`);
    }
    const chargeSeedRef = typeof item.payload.chargeSeedRef === "string"
      ? item.payload.chargeSeedRef
      : undefined;
    const chargeSeed = chargeSeedRef
      ? protocol.items.find((candidate) => candidate.itemKey === chargeSeedRef)
      : undefined;
    if (chargeSeedRef && chargeSeed?.itemType !== "charge-seed") {
      throw new Error(`Protocol item ${itemKey} references an invalid charge seed.`);
    }
    await this.projection.validateMutation?.(input,[{item,payload:item.payload}]);
    const liveState = await this.inspectLiveItemOwner(protocol, item, chargeSeed, input);
    if (liveState.outcome === "already-applied") {
      if (liveState.application.protocolId === protocolId || (await this.applications.list()).some((row) =>
        row.encounterId === input.encounterId && row.protocolId === protocolId && row.confirmed &&
        row.undoState === "active" && row.dedupResolutions.some((resolution) =>
          resolution.itemKey === itemKey && resolution.reason === "action-exists" &&
          resolution.existingActionId === liveState.actionId))) {
        return { application: liveState.application, alreadyApplied: true };
      }
    }
    if (liveState.outcome === "missing-charge") throw missingRequiredCharge();

    const dispositions: ProtocolApplication["dispositions"] = [
      { itemKey: item.itemKey, outcome: "applied-default" },
      ...(chargeSeed ? [{ itemKey: chargeSeed.itemKey, outcome: "applied-default" as const }] : []),
    ];
    const claimIdentifier = protocolItemClaimIdentifier(input.encounterId, protocolId, itemKey);
    const at = this.now();
    const proposed = this.newApplication(protocol, input, at, dispositions);
    const application = await this.applications.createConditional(proposed, claimIdentifier);
    if (application.id !== proposed.id) {
      const settled = await this.waitForClaimedApplication(application);
      if (!settled) return this.addItemWithoutProcessLock(protocolId, itemKey, input, recoverConfirmedOrphan);
      const settledState = await this.inspectLiveItemOwner(protocol, item, chargeSeed, input);
      if (settledState.outcome === "already-applied") {
        return { application: settledState.application, alreadyApplied: true };
      }
      if (settledState.outcome === "missing-charge") throw missingRequiredCharge();
      if (recoverConfirmedOrphan && await this.releaseItemApplication(settled, true)) {
        return this.addItemWithoutProcessLock(protocolId, itemKey, input, false);
      }
      throw new ProtocolItemAddConflictError("The completed protocol item claim has no live plan action.");
    }
    const originalApplication = structuredClone(application);
    const writes: ItemAddWrites = {
      actionIds: new Set(),
      materializedRefs: new Set(),
      chargeIds: new Set(),
      sharedActions: new Map(),
    };
    try {
      const linkedDx = [input.diagnosis.reference];
      const primaryResult = await this.applySelectedItem(application, item, item.payload, linkedDx, [], at, writes);
      await this.requireInFlightItemApplication(application.id);
      if (chargeSeed && liveState.outcome === "already-applied" && !(await this.charges.list()).some((row) =>
        row.encounterId === input.encounterId && row.procedureConceptKey === String(chargeSeed.payload.procedureConceptKey) && row.state !== "removed")) {
        dispositions.find((row) => row.itemKey === chargeSeed.itemKey)!.outcome = "opted-out";
      } else if (chargeSeed) {
        await this.applySelectedItem(application, chargeSeed, chargeSeed.payload, linkedDx, [], at, writes);
        if (primaryResult.outcome !== "merge-deduped" && application.dedupResolutions.some((row) => row.reason === "charge-exists" && row.itemKey === chargeSeed.itemKey)) {
          dispositions.find((row) => row.itemKey === chargeSeed.itemKey)!.outcome = "opted-out";
        }
      }
      await this.requireInFlightItemApplication(application.id);
      const confirmed = await this.applications.saveWithIdentifiersIfCurrent(
        { ...application, confirmed: true, dispositions },
        [claimIdentifier],
        (current) => JSON.stringify(current) === JSON.stringify(originalApplication),
      );
      if (!confirmed) {
        throw new ProtocolItemAddConflictError("Protocol item claim expired while the item was being added; retry.");
      }
      return { application: liveState.outcome === "already-applied" && recoverConfirmedOrphan ? liveState.application : confirmed,
        alreadyApplied: liveState.outcome === "already-applied" && recoverConfirmedOrphan };
    } catch (error) {
      const current = await this.applications.get(application.id);
      if (current?.undoState === "active" && current.confirmed &&
        current.itemClaimLeaseExpiresAt === application.itemClaimLeaseExpiresAt) {
        return { application: liveState.outcome === "already-applied" && recoverConfirmedOrphan ? liveState.application : current,
          alreadyApplied: liveState.outcome === "already-applied" && recoverConfirmedOrphan };
      }
      await this.releaseItemApplication(application);
      await this.cleanupItemAddWrites(writes);
      throw error;
    }
  }

  async commit(applicationId: string, selections: CommitSelection[], linkedDx: string[]): Promise<void> {
    return this.encounterLock.run((await this.requireApplication(applicationId)).encounterId, () => this.commitLocked(applicationId, selections, linkedDx));
  }

  private async commitLocked(applicationId: string, selections: CommitSelection[], linkedDx: string[]): Promise<void> {
    const application = await this.requireApplication(applicationId);
    const originalApplication = structuredClone(application);
    if (application.confirmed) throw new Error("Protocol application is already confirmed.");
    if (application.undoState !== "active") throw new ProtocolItemAddConflictError("Protocol application is no longer active.");
    if ((await this.applications.list()).some((row) => row.id !== application.id && row.encounterId === application.encounterId &&
      row.protocolId === application.protocolId && row.confirmed && row.undoState === "active" && normalizeApplicationScope(row) === "whole")) {
      throw new ProtocolItemAddConflictError("Protocol is already applied to this encounter.");
    }
    const protocol = await this.requirePinnedProtocol(application);
    await this.projection.validateMutation?.(application,selectedProtocolItems(protocol.items,selections));
    const choices = new Map(selections.map((row) => [row.itemKey, row]));
    const at = this.now();
    const proposed = (await this.findings.list()).filter((row) => row.protocolApplicationId === application.id);
    const dispositions: ProtocolApplication["dispositions"] = [];
    const writes: ItemAddWrites = { actionIds: new Set(), chargeIds: new Set(), materializedRefs: new Set(), sharedActions: new Map() };
    try {
      for (const item of protocol.items) {
        const choice = choices.get(item.itemKey);
        const selected = choice?.selected ?? item.defaultSelected;
        if (!selected) {
          if (choice?.skipReason) application.dedupResolutions.push({ itemKey: item.itemKey, reason: choice.skipReason });
          dispositions.push({ itemKey: item.itemKey, outcome: "opted-out" });
          for (const finding of proposed.filter((row) =>
            row.sourceItemKey === item.itemKey && row.state === "proposed"
          )) await this.findings.save({ ...finding, state: "removed" });
          continue;
        }
        const payload = choice?.payload ?? item.payload;
        const modified = JSON.stringify(payload) !== JSON.stringify(item.payload);
        dispositions.push({ itemKey: item.itemKey, outcome: modified ? "applied-modified" : "applied-default" });
        await this.applySelectedItem(application, item, payload, linkedDx, proposed, at, writes);
        if (item.itemType === "charge-seed" && application.dedupResolutions.some((row) => row.itemKey === item.itemKey && row.reason === "charge-exists")) {
          dispositions[dispositions.length - 1].outcome = "opted-out";
        }
      }
      await this.saveApplication(originalApplication, { ...application, scope: "whole", confirmed: true, dispositions });
    } catch (error) {
      const current = await this.applications.get(application.id);
      if (current?.confirmed && current.undoState === "active" && JSON.stringify(current.dispositions) === JSON.stringify(dispositions) && JSON.stringify(current.dedupResolutions) === JSON.stringify(application.dedupResolutions)) return;
      await this.cleanupItemAddWrites(writes);
      for (const finding of await this.findings.list()) {
        if (finding.protocolApplicationId !== application.id) continue;
        if (finding.observationReference) await this.projection.removeMaterialized?.(finding.observationReference,finding);
        const original = proposed.find((row) => row.id === finding.id);
        await this.findings.save(current?.undoState === "active" && !current.confirmed && original ? original : { ...finding, state: "removed" });
      }
      throw error;
    }
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
        payload: collision.actionType === "follow-up" ? { ...input.payload, needsConfirmation: false } : input.payload,
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

  async confirmFollowUp(encounterId: string, actionId: string, actor: string, edit?: { interval: number; unit: "days" | "weeks" | "months"; reason?: string }): Promise<PlanActionInstance> {
    return this.encounterLock.run(encounterId, async () => {
      const action = await this.actions.get(actionId);
      if (!action || action.encounterId !== encounterId || action.actionType !== "follow-up" || ["removed", "cancelled"].includes(action.state)) {
        throw new ProtocolFollowUpNotFoundError("Live follow-up not found for this encounter.");
      }
      const payload = { ...action.payload, ...edit, needsConfirmation: false };
      const updated: PlanActionInstance = { ...action, payload, ...(edit ? {
        state: "modified", modifiedFields: [...new Set([...action.modifiedFields, ...changedFields(action.payload, payload)])],
        provenance: { ...action.provenance, source: "clinician-entered", actor },
      } : {}) };
      if (edit) updated.materializedFhirRef = await this.projection.materializeAction(updated);
      return this.actions.save(updated);
    });
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
    return this.encounterLock.run((await this.requireApplication(applicationId)).encounterId, () => this.unapplyLocked(applicationId));
  }

  private async unapplyLocked(applicationId: string): Promise<{ removed: string[]; preserved: string[] }> {
    const application = await this.requireApplication(applicationId);
    const removalFindings = (await this.findings.list()).filter(row=>row.protocolApplicationId === application.id);
    const removalActions = (await this.actions.list()).filter(row=>row.protocolApplicationId === application.id);
    await this.projection.validateMutation?.(application,[],[
      ...removalFindings.flatMap(row=>row.observationReference ? [row.observationReference] : []),
      ...removalActions.flatMap(row=>row.materializedFhirRef ? [row.materializedFhirRef] : []),
    ]);
    const linkedCharges = (await this.charges.list()).filter((row) => row.protocolApplicationId === application.id);
    const acceptedChargeCount = linkedCharges.filter((charge) => charge.state === "accepted").length;
    if (acceptedChargeCount) {
      throw new AcceptedChargeUnapplyError(
        `Cannot un-apply: ${acceptedChargeCount} accepted charge${acceptedChargeCount === 1 ? "" : "s"} must be resolved first.`,
      );
    }
    if (application.undoState !== "active") return { removed: [], preserved: [] };
    const encounterActions = (await this.actions.list()).filter((row) => row.encounterId === application.encounterId);
    const actions = encounterActions.filter((row) => row.protocolApplicationId === application.id);
    const followUps = encounterActions.filter((row) => row.actionType === "follow-up" && !["removed", "cancelled"].includes(row.state) &&
      Array.isArray(row.payload.alternatives) && row.payload.alternatives.some((entry) => entry.applicationId === application.id));
    const actionOriginals = new Map([...actions, ...followUps].map((row) => [row.id, row]));
    const changedFollowUpProjections = new Set<string>();
    const candidates = (await this.applications.list()).filter((row) => row.id !== application.id && row.encounterId === application.encounterId && row.confirmed && row.undoState === "active")
      .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
    const originals = new Map(candidates.map((row) => [row.id, structuredClone(row)]));
    const transfers = new Map<string, { applicationId: string; itemKey: string }>();
    for (const record of [
      ...actions.filter((row) => row.state === "selected" && row.modifiedFields.length === 0).map((row) => ({ id: row.id, field: "existingActionId" })),
      ...linkedCharges.filter((row) => row.state === "staged" && !row.chargeItemRef).map((row) => ({ id: row.id, field: "existingChargeId" })),
    ]) {
      const candidate = candidates.find((row) => row.dedupResolutions.some((resolution) => resolution[record.field] === record.id));
      if (!candidate) continue;
      const resolution = candidate.dedupResolutions.find((row) => row[record.field] === record.id)!;
      const itemKey = String(resolution.itemKey);
      candidate.dispositions = candidate.dispositions.map((row) => row.itemKey === itemKey ? { ...row, outcome: "applied-default" } : row);
      candidate.dedupResolutions = candidate.dedupResolutions.filter((row) => row !== resolution);
      transfers.set(record.id, { applicationId: candidate.id, itemKey });
    }
    const saved: ProtocolApplication[] = [];
    try {
      for (const candidate of candidates.filter((row) => JSON.stringify(row) !== JSON.stringify(originals.get(row.id)))) {
        saved.push(await this.saveApplication(originals.get(candidate.id)!, candidate));
      }
      await this.saveApplication(application, { ...application, undoState: "unapplied" });
    } catch (error) {
      for (const candidate of saved.reverse()) await this.saveApplication(candidate, originals.get(candidate.id)!);
      throw error;
    }
    const removed: string[] = [];
    const preserved: string[] = [];
    const originalFindings = (await this.findings.list()).filter((row) => row.protocolApplicationId === applicationId);
    const removedProjections = new Map<string, void | (() => Promise<void>)>();
    try {
      for (const action of actions) {
        const transfer = transfers.get(action.id);
        if (transfer) {
          await this.actions.save({ ...action, protocolApplicationId: transfer.applicationId });
          preserved.push(action.id);
        } else if (action.state === "selected" && action.modifiedFields.length === 0) {
          if (action.materializedFhirRef && this.projection.removeMaterialized) {
            const restore = await this.projection.removeMaterialized(action.materializedFhirRef,action);
            removedProjections.set(action.materializedFhirRef, restore);
          }
          await this.actions.save({ ...action, state: "removed" });
          removed.push(action.id);
        } else preserved.push(action.id);
      }
      for (const original of followUps) {
        const action = (await this.actions.get(original.id))!;
        if (["removed", "cancelled"].includes(action.state)) continue;
        const alternatives = (action.payload.alternatives as Array<Record<string, unknown>>).filter((entry) => entry.applicationId !== application.id);
        const plans = alternatives.filter((entry) => entry.source !== "clinician");
        const clinicianOwned = clinicianOwnedFollowUp(action);
        const payload = { ...action.payload };
        if (!clinicianOwned && plans.length) {
          const soonest = [...plans].sort((a, b) => protocolFollowUpDue(a, action.provenance.at) - protocolFollowUpDue(b, action.provenance.at))[0];
          Object.assign(payload, { interval: soonest.interval, unit: soonest.unit, reason: soonest.reason });
        }
        if (clinicianOwned ? plans.every((entry) => entry.interval === payload.interval && entry.unit === payload.unit) : alternatives.length < 2) {
          delete payload.alternatives;
          payload.needsConfirmation = false;
        } else {
          payload.alternatives = alternatives;
          payload.needsConfirmation = clinicianOwned && action.payload.needsConfirmation === false ? false : true;
        }
        const updated = { ...action, payload };
        if (["interval", "unit", "reason"].some((key) => payload[key] !== action.payload[key])) {
          changedFollowUpProjections.add(action.id);
          updated.materializedFhirRef = await this.projection.materializeAction(updated);
        }
        await this.actions.save(updated);
      }
      for (const finding of (await this.findings.list()).filter((row) => row.protocolApplicationId === applicationId)) {
        if (finding.state === "committed" && finding.provenance.source === "protocol-default") {
          if (finding.observationReference && this.projection.removeMaterialized) {
            const restore = await this.projection.removeMaterialized(finding.observationReference,finding);
            removedProjections.set(finding.observationReference, restore);
          }
          await this.findings.save({ ...finding, state: "removed" });
          removed.push(finding.id);
        } else if (finding.state !== "removed") preserved.push(finding.id);
      }
      for (const charge of linkedCharges) {
        const transfer = transfers.get(charge.id);
        if (transfer) {
          await this.charges.save({ ...charge, protocolApplicationId: transfer.applicationId, planActionRef: transfer.itemKey });
          preserved.push(charge.id);
        } else if (charge.state === "staged" && !charge.chargeItemRef) {
          await this.charges.save({ ...charge, state: "removed" });
          removed.push(charge.id);
        } else preserved.push(charge.id);
      }
      return { removed, preserved };
    } catch (error) {
      const projectionFailures: string[] = [];
      let findingRefusal: ProtocolFindingWriteRefusal | undefined;
      for (const action of actionOriginals.values()) {
        const current = await this.actions.get(action.id);
        const projectionRemoved = Boolean(action.materializedFhirRef && removedProjections.has(action.materializedFhirRef));
        if (!current || (!projectionRemoved && !changedFollowUpProjections.has(action.id) && JSON.stringify(current) === JSON.stringify(action))) continue;
        const restored = { ...action };
        if (projectionRemoved) {
          const restore = removedProjections.get(action.materializedFhirRef!);
          try {
            if (restore) await restore();
            else restored.materializedFhirRef = await this.projection.materializeAction(action);
          } catch (restoreError) {
            if (restoreError instanceof ProtocolFindingWriteRefusal) findingRefusal = restoreError;
            projectionFailures.push(`${action.materializedFhirRef}: ${String(restoreError)}`);
          }
        }
        if (changedFollowUpProjections.has(action.id)) {
          try {
            restored.materializedFhirRef = await this.projection.materializeAction(action);
          } catch (restoreError) {
            if (restoreError instanceof ProtocolFindingWriteRefusal) findingRefusal = restoreError;
            projectionFailures.push(`${action.materializedFhirRef}: ${String(restoreError)}`);
          }
        }
        await this.actions.saveWithIdentifiersIfCurrent(restored, [], (row) => JSON.stringify(row) === JSON.stringify(current));
      }
      for (const finding of originalFindings) {
        const current = await this.findings.get(finding.id);
        const projectionRemoved = Boolean(finding.observationReference && removedProjections.has(finding.observationReference));
        if (!current || (!projectionRemoved && JSON.stringify(current) === JSON.stringify(finding))) continue;
        const restored = { ...finding };
        if (projectionRemoved) {
          const restore = removedProjections.get(finding.observationReference!);
          try {
            if (restore) await restore();
            else restored.observationReference = await this.projection.commitFinding(finding);
          } catch (restoreError) {
            if (restoreError instanceof ProtocolFindingWriteRefusal) findingRefusal = restoreError;
            projectionFailures.push(`${finding.observationReference}: ${String(restoreError)}`);
          }
        }
        await this.findings.saveWithIdentifiersIfCurrent(restored, [], (row) => JSON.stringify(row) === JSON.stringify(current));
      }
      for (const charge of linkedCharges) {
        const current = await this.charges.get(charge.id);
        if (current && JSON.stringify(current) !== JSON.stringify(charge)) await this.charges.saveWithIdentifiersIfCurrent(charge, [], (row) => JSON.stringify(row) === JSON.stringify(current));
      }
      for (const candidate of saved.reverse()) await this.saveApplication(candidate, originals.get(candidate.id)!);
      await this.saveApplication({ ...application, undoState: "unapplied" }, application);
      if (findingRefusal) throw findingRefusal;
      if (projectionFailures.length) throw new Error(`Unapply failed: ${String(error)}; projection rollback refused: ${projectionFailures.join("; ")}`, { cause: error });
      throw error;
    }
  }

  async abandonOpenForSignedEncounter(encounterId: string): Promise<number> {
    return this.encounterLock.run(encounterId, () => this.abandonOpenForSignedEncounterLocked(encounterId));
  }

  private async abandonOpenForSignedEncounterLocked(encounterId: string): Promise<number> {
    const open = (await this.applications.list()).filter((row) =>
      row.encounterId === encounterId && !row.confirmed && row.undoState === "active"
    );
    for (const application of open) {
      const findings = (await this.findings.list()).filter((row) => row.protocolApplicationId === application.id && row.state === "proposed");
      await this.saveApplication(application, { ...application, undoState: "unapplied" });
      try {
        for (const finding of findings) await this.findings.save({ ...finding, state: "removed" });
      } catch (error) {
        for (const finding of findings) await this.findings.saveWithIdentifiersIfCurrent(finding, [], (row) => JSON.stringify(row) === JSON.stringify({ ...finding, state: "removed" }));
        await this.saveApplication({ ...application, undoState: "unapplied" }, application);
        throw error;
      }
    }
    return open.length;
  }

  private async upsertAction(
    application: ProtocolApplication,
    item: ProtocolItem,
    payload: Record<string, unknown>,
    linkedDx: string[],
    at: string,
    writes?: ItemAddWrites,
  ): Promise<ItemApplicationResult> {
    const actions = await this.actions.list();
    const existingForItem = actions.find((row) =>
      row.protocolApplicationId === application.id &&
      row.sourceItemKey === item.itemKey &&
      !["removed", "cancelled"].includes(row.state)
    );
    if (existingForItem) return { outcome: "existing-application" };
    const existing = item.mergeKey ? actions.find((row) =>
      row.encounterId === application.encounterId && row.mergeKey === item.mergeKey &&
      !["removed", "cancelled"].includes(row.state)
    ) : undefined;
    if (existing) {
      application.dedupResolutions.push({ itemKey: item.itemKey, reason: "action-exists", existingActionId: existing.id });
      const updated = { ...existing, linkedDx: [...new Set([...existing.linkedDx, ...linkedDx])] };
      if (item.itemType === "follow-up" && (payload.interval !== existing.payload.interval || payload.unit !== existing.payload.unit)) {
        const clinicianOwned = clinicianOwnedFollowUp(existing);
        const original = clinicianOwned
          ? { source: "clinician", interval: existing.payload.interval, unit: existing.payload.unit, reason: existing.payload.reason, actor: existing.provenance.actor }
          : { applicationId: existing.protocolApplicationId, protocolId: existing.provenance.protocolId, interval: existing.payload.interval, unit: existing.payload.unit, reason: existing.payload.reason };
        const alternative = { applicationId: application.id, protocolId: application.protocolId, interval: payload.interval, unit: payload.unit, reason: payload.reason };
        const prior = Array.isArray(existing.payload.alternatives) ? existing.payload.alternatives : [];
        const alternatives = clinicianOwned ? [original, ...prior.filter((row) => row.source !== "clinician")] : prior.length ? [...prior] : [original];
        if (!alternatives.some((row) => JSON.stringify(row) === JSON.stringify(alternative))) alternatives.push(alternative);
        const sooner = !clinicianOwned && protocolFollowUpDue(payload, existing.provenance.at) < protocolFollowUpDue(existing.payload, existing.provenance.at);
        updated.payload = { ...existing.payload, ...(sooner ? { interval: payload.interval, unit: payload.unit, reason: payload.reason } : {}), alternatives, needsConfirmation: true };
        writes?.sharedActions.set(existing.id, { before: existing, after: updated });
        updated.materializedFhirRef = await this.projection.materializeAction(updated);
      }
      writes?.sharedActions.set(existing.id, { before: existing, after: updated });
      await this.actions.save(updated);
      return { outcome: "merge-deduped" };
    }
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
    writes?.actionIds.add(action.id);
    try {
      action.materializedFhirRef = await this.projection.materializeAction(action);
      if (action.materializedFhirRef) writes?.materializedRefs.add(action.materializedFhirRef);
    } catch (error) {
      if (!(error instanceof ProtocolActionMaterializationRefusal)) throw error;
      action.materializationRefusal = { code: error.code, message: error.message };
    }
    await this.actions.save(action);
    return { outcome: "created" };
  }

  private async stageCharge(
    application: ProtocolApplication,
    item: ProtocolItem,
    payload: Record<string, unknown>,
    linkedDx: string[],
    at: string,
    writes?: ItemAddWrites,
  ): Promise<boolean> {
    const existing = (await this.charges.list()).find((row) =>
      row.encounterId === application.encounterId &&
      row.procedureConceptKey === String(payload.procedureConceptKey) &&
      row.state !== "removed"
    );
    if (existing) {
      if (existing.protocolApplicationId === application.id && existing.planActionRef === item.itemKey) return false;
      application.dedupResolutions.push({ itemKey: item.itemKey, reason: "charge-exists", existingChargeId: existing.id });
      return false;
    }
    const modifiedFields = changedFields(item.payload, payload);
    const ruleId = Array.isArray(payload.chargeRuleRefs) ? String(payload.chargeRuleRefs[0] ?? "") : "";
    const rule = ruleId ? await this.chargeRules.get(ruleId) : undefined;
    const charge: ChargeProposal = {
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
      protocolDefaultPayload: item.payload,
      modifiedFields,
      provenance: {
        source: modifiedFields.length ? "clinician-entered" : "protocol-default",
        actor: application.appliedBy,
        at,
        protocolId: application.protocolId,
        protocolVersion: application.protocolVersion,
      },
    };
    writes?.chargeIds.add(charge.id);
    await this.charges.save(charge);
    return true;
  }

  private async applySelectedItem(
    application: ProtocolApplication,
    item: ProtocolItem,
    payload: Record<string, unknown>,
    linkedDx: string[],
    proposed: ProtocolFindingInstance[],
    at: string,
    writes?: ItemAddWrites,
  ): Promise<ItemApplicationResult> {
    const modified = JSON.stringify(payload) !== JSON.stringify(item.payload);
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
      return { outcome: "created" };
    }
    if (item.itemType === "charge-seed") {
      return await this.stageCharge(application, item, payload, linkedDx, at, writes)
        ? { outcome: "created" }
        : { outcome: "existing-application" };
    }
    return this.upsertAction(application, item, payload, linkedDx, at, writes);
  }

  private async inspectLiveItemOwner(
    protocol: ProtocolDefinition,
    item: ProtocolItem,
    chargeSeed: ProtocolItem | undefined,
    input: OpenProtocolInput,
  ): Promise<
    | { outcome: "absent" }
    | { outcome: "already-applied"; application: ProtocolApplication; actionId: string }
    | { outcome: "missing-charge"; application: ProtocolApplication }
  > {
    const applications = await this.applications.list();
    const applicationById = new Map(applications.map((application) => [application.id, application]));
    const actions = await this.actions.list();
    const charges = await this.charges.list();
    const requested = applications.find((row) => row.encounterId === input.encounterId && row.protocolId === protocol.id && row.confirmed && row.undoState === "active" &&
      row.dedupResolutions.some((resolution) => resolution.itemKey === item.itemKey && resolution.reason === "action-exists"));
    const relevantResolutions = requested?.dedupResolutions.filter((row) => row.itemKey === item.itemKey || row.itemKey === chargeSeed?.itemKey) ?? [];
    for (const resolution of relevantResolutions) {
      if (resolution.reason === "action-exists" && !actions.some((row) => row.id === resolution.existingActionId && row.encounterId === input.encounterId && !["removed", "cancelled"].includes(row.state))) return { outcome: "absent" };
      if (resolution.reason === "charge-exists" && !charges.some((row) => row.id === resolution.existingChargeId && row.encounterId === input.encounterId && row.state !== "removed")) return { outcome: "absent" };
    }
    const referencedActionId = relevantResolutions.find((row) => row.reason === "action-exists" && row.itemKey === item.itemKey)?.existingActionId;
    const action = actions.find((row) => row.id === referencedActionId) ?? actions.find((candidate) => {
      if (candidate.encounterId !== input.encounterId || ["removed", "cancelled"].includes(candidate.state)) return false;
      if (!candidate.protocolApplicationId) return false;
      const owner = applicationById.get(candidate.protocolApplicationId);
      if (!owner?.confirmed || owner.undoState !== "active") return false;
      return item.mergeKey ? candidate.mergeKey === item.mergeKey : owner.protocolId === protocol.id && candidate.sourceItemKey === item.itemKey;
    });
    if (!action) return { outcome: "absent" };
    const storedOwner = action.protocolApplicationId ? applicationById.get(action.protocolApplicationId) : undefined;
    const owner = storedOwner?.confirmed && storedOwner.undoState === "active" ? storedOwner : requested;
    if (!owner) return { outcome: "absent" };
    if (!chargeSeed || relevantResolutions.some((row) => row.reason === "charge-exists")) return { outcome: "already-applied", application: owner, actionId: action.id };
    const ownerProtocol = await this.definitions.getSnapshot(owner.protocolId, owner.protocolVersion);
    const ownerItem = ownerProtocol?.items.find((candidate) => candidate.itemKey === action.sourceItemKey);
    const ownerChargeSeedKey = typeof ownerItem?.payload.chargeSeedRef === "string"
      ? ownerItem.payload.chargeSeedRef
      : chargeSeed.itemKey;
    const charge = (await this.charges.list()).find((candidate) =>
      candidate.encounterId === input.encounterId &&
      candidate.protocolApplicationId === owner.id &&
      candidate.procedureConceptKey === String(chargeSeed.payload.procedureConceptKey) &&
      candidate.state !== "removed"
    );
    const dependency = owner.dedupResolutions.find((row) => row.itemKey === ownerChargeSeedKey && row.reason === "charge-exists");
    const dependentCharge = dependency ? await this.charges.get(String(dependency.existingChargeId)) : undefined;
    if (dependency && (!dependentCharge || dependentCharge.state === "removed")) return { outcome: "absent" };
    if (charge || dependentCharge || owner.dispositions.some((disposition) =>
      disposition.itemKey === ownerChargeSeedKey && disposition.outcome === "opted-out" && !dependency
    )) return { outcome: "already-applied", application: owner, actionId: action.id };
    return { outcome: "missing-charge", application: owner };
  }

  private newApplication(
    protocol: ProtocolDefinition,
    input: OpenProtocolInput,
    at: string,
    dispositions: ProtocolApplication["dispositions"] = [],
  ): ProtocolApplication {
    return {
      id: this.id(),
      encounterId: input.encounterId,
      patientId: input.patientId,
      protocolId: protocol.id,
      protocolVersion: protocol.version,
      appliedBy: input.actor,
      appliedAt: at,
      stackedWith: [],
      dispositions,
      dedupResolutions: [],
      scope: "item",
      itemClaimLeaseExpiresAt: new Date(Date.parse(at) + ITEM_CLAIM_LEASE_MS).toISOString(),
      undoState: "active",
      confirmed: false,
    };
  }

  private async waitForClaimedApplication(
    claimed: ProtocolApplication,
  ): Promise<ProtocolApplication | undefined> {
    for (let waited = 0; waited < ITEM_CLAIM_WAIT_MS; waited += ITEM_CLAIM_POLL_MS) {
      const application = await this.applications.get(claimed.id);
      if (!application || application.undoState !== "active") return undefined;
      if (application.confirmed) return application;
      if (this.itemClaimLeaseExpired(application)) {
        if (await this.releaseItemApplication(application)) return undefined;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, ITEM_CLAIM_POLL_MS));
    }
    throw new ProtocolItemAddConflictError("Protocol item add is already in progress; retry shortly.");
  }

  private itemClaimLeaseExpired(application: ProtocolApplication): boolean {
    const expiresAt = application.itemClaimLeaseExpiresAt ?? new Date(
      Date.parse(application.appliedAt) + ITEM_CLAIM_LEASE_MS,
    ).toISOString();
    return Date.parse(expiresAt) <= Date.parse(this.now());
  }

  private async requireInFlightItemApplication(id: string): Promise<void> {
    const application = await this.applications.get(id);
    if (!application || application.undoState !== "active" || application.confirmed) {
      throw new ProtocolItemAddConflictError("Protocol item claim expired while the item was being added; retry.");
    }
  }

  private async releaseItemApplication(
    application: ProtocolApplication,
    expectedConfirmed = false,
  ): Promise<boolean> {
    const released = await this.applications.saveWithIdentifiersIfCurrent(
      { ...application, undoState: "unapplied" },
      [],
      (current) => current.undoState === "active" && current.confirmed === expectedConfirmed &&
        current.itemClaimLeaseExpiresAt === application.itemClaimLeaseExpiresAt,
    );
    if (!released) return false;
    for (const action of (await this.actions.list()).filter((candidate) =>
      candidate.protocolApplicationId === application.id &&
      !["removed", "cancelled"].includes(candidate.state)
    )) {
      if (action.materializedFhirRef) await this.projection.removeMaterialized?.(action.materializedFhirRef,action);
      await this.actions.save({ ...action, state: "removed" });
    }
    for (const charge of (await this.charges.list()).filter((candidate) =>
      candidate.protocolApplicationId === application.id && candidate.state === "staged"
    )) await this.charges.save({ ...charge, state: "removed" });
    return true;
  }

  private async cleanupItemAddWrites(writes: ItemAddWrites): Promise<void> {
    for (const { before, after } of writes.sharedActions.values()) {
      const restored = await this.actions.saveWithIdentifiersIfCurrent(before, [], (current) => JSON.stringify(current) === JSON.stringify(after));
      const unchanged = !restored && JSON.stringify(await this.actions.get(before.id)) === JSON.stringify(before);
      if ((restored || unchanged) && JSON.stringify(before.payload) !== JSON.stringify(after.payload)) await this.projection.materializeAction(before);
    }
    const removedMaterialized = new Set<string>();
    for (const actionId of writes.actionIds) {
      const action = await this.actions.get(actionId);
      if (!action || ["removed", "cancelled"].includes(action.state)) continue;
      if (action.materializedFhirRef) {
        await this.projection.removeMaterialized?.(action.materializedFhirRef,action);
        removedMaterialized.add(action.materializedFhirRef);
      }
      await this.actions.save({ ...action, state: "removed" });
    }
    for (const reference of writes.materializedRefs) {
      if (!removedMaterialized.has(reference)) await this.projection.removeMaterialized?.(reference);
    }
    for (const chargeId of writes.chargeIds) {
      const charge = await this.charges.get(chargeId);
      if (charge?.state === "staged") await this.charges.save({ ...charge, state: "removed" });
    }
  }

  private async requireActiveDiagnosisProtocol(
    protocolId: string,
    input: OpenProtocolInput,
  ): Promise<ProtocolDefinition> {
    const head = await this.definitions.get(protocolId);
    const protocol = head ? publishedFromHead(head) : undefined;
    if (!protocol || protocol.status !== "active") throw new Error("Active protocol not found.");
    if (!input.diagnosis.confirmed || protocol.trigger.kind !== "diagnosis" ||
      !protocol.trigger.dxKeys.some((pattern) => matchesCode(input.diagnosis.code, pattern))) {
      throw new Error("Confirmed diagnosis does not match protocol trigger.");
    }
    return protocol;
  }

  private async saveApplication(original: ProtocolApplication, updated: ProtocolApplication): Promise<ProtocolApplication> {
    const saved = await this.applications.saveWithIdentifiersIfCurrent(updated, [],
      (current) => JSON.stringify(current) === JSON.stringify(original));
    if (!saved) throw new ProtocolItemAddConflictError("Protocol application changed during the operation; retry.");
    return saved;
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

function missingRequiredCharge(): ProtocolItemAddConflictError {
  return new ProtocolItemAddConflictError(
    "The existing plan action's required charge is missing and was not opted out; restore or resolve it before retrying.",
  );
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

export function rankProtocolOffers(
  definitions: readonly ProtocolDefinition[],
  diagnoses: readonly ProtocolOfferDiagnosis[],
): ProtocolDefinition[] {
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
  return [...definitions].sort((left, right) =>
    scopeRank(right) - scopeRank(left) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
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

export function protocolFollowUpDue(payload: Record<string, unknown>, at: string): number {
  const due = new Date(at);
  if (payload.unit === "months") {
    const day = due.getUTCDate();
    due.setUTCDate(1);
    due.setUTCMonth(due.getUTCMonth() + Number(payload.interval));
    due.setUTCDate(Math.min(day, new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate()));
  } else due.setUTCDate(due.getUTCDate() + Number(payload.interval) * (payload.unit === "weeks" ? 7 : 1));
  return due.getTime();
}

export class ProtocolFindingWriteRefusal extends Error {
  constructor(readonly status: 409|422, message: string) { super(message); }
}
export function selectedProtocolItems(items: readonly ProtocolItem[], selections: readonly CommitSelection[]): Array<{item:ProtocolItem;payload:Record<string,unknown>}> {
  const choices = new Map(selections.map(selection=>[selection.itemKey,selection]));
  return items.flatMap(item=>{const choice=choices.get(item.itemKey);return (choice?.selected ?? item.defaultSelected) ? [{item,payload:choice?.payload ?? item.payload}] : [];});
}
export function assertProtocolFindingSelections(items: readonly {item:ProtocolItem;payload:Record<string,unknown>}[], definitions: readonly ClinicalFindingDefinition[]): void {
  const shared = new Set(definitions.filter(d=>d.valueSchema.type === "ocular-health-structure").map(d=>d.stableKey));
  for (const {item,payload} of items) if (item.itemType === "finding-seed" && (shared.has(String(payload.findingDefKey)) || shared.has(String(item.payload.findingDefKey))) &&
    [payload,item.payload].some(value=>value.defaultValue !== undefined || Object.values((value.defaultValues && typeof value.defaultValues === "object") ? value.defaultValues : {}).some(v=>v !== undefined)))
    throw new ProtocolFindingWriteRefusal(422,"shared-finding-charted-in-ocular-health");
}
