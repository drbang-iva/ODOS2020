import { parseDiagnosisIdentifier } from "./diagnosis-identifier.js";
import type { Bundle, Condition, Encounter, Observation, Patient, Provenance, Resource, } from "@medplum/fhirtypes";
import type { Application } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { fhirSearchNextPath, type FhirTransactionExecutionOptions } from "../fhir-client.js";
import { buildEncounterDiagnosisComponent, buildEncounterDiagnosisCondition, FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM, } from "../fhir/condition.js";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "./diagnosis-pick-endpoint.js";
import { isClosedEncounter , observePostCommandClosure } from "./encounter-sign-gate.js";
import { FhirFindingDefinitionStore } from "./finding-definition-store.js";
import { loadDiagnosisFindingContext, findingCommandResponse, findingTargetReadOnlyReason, type DiagnosisFindingContext } from "./diagnosis-findings-endpoint.js";
import { executeFindingCommand, type FindingCommandDeps } from "./current-finding-writer.js";
import { currentFindingIdentifier } from "./current-finding-identity.js";
import { CARRY_DIAGNOSIS_SYSTEM, CARRY_COMMAND_SYSTEM, CARRY_PLAN_URL, CARRY_VERSIONS_URL, CarryIntegrityError, carryHash, carryTag, carrySearch, carryCommandPlan, carryPlansForCondition, carryFindingsWitness, parseCarryPlan, carryOutcomeVersions, type CarryPlan } from "./diagnosis-carry-provenance.js";
import type { FindingQualifierValue } from "./custom-fields.js";
export type PreviousExamLaterality = "OD" | "OS" | "OU" | "UNKNOWN";
export interface PreviousExamDiagnosisIdentity {
    diagnosisKey?: string;
    coding: Array<{
        system?: string;
        code?: string;
        display?: string;
    }>;
    text?: string;
    laterality: PreviousExamLaterality;
}
export interface PreviousExamFinding {
    observationReference: string;
    code: string;
    display: string;
    presence: "present" | "absent";
    grade?: string;
    qualifiers?: Record<string, FindingQualifierValue>;
    laterality: PreviousExamLaterality;
}
export interface PreviousExamDiagnosis {
    conditionReference: string;
    display: string;
    identity: PreviousExamDiagnosisIdentity;
    findings: PreviousExamFinding[];
    checked: boolean;
    currentConditionReference?: string;
}
export interface PreviousExamGroup {
    encounterReference: string;
    date: string;
    visitType: string;
    diagnoses: PreviousExamDiagnosis[];
}
export interface PreviousExamsPage {
    pageSize: 4;
    encounters: PreviousExamGroup[];
    nextCursor?: string;
}
export interface DiagnosisCarryForwardFhirClient {
    readonly baseUrl: string;
    read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
    search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
    searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
    createWithOutcome<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<{
        resource: T;
        created: boolean;
    }>;
    update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T>;
    executeTransaction?(bundle: Bundle, extraHeaders?: Record<string, string>, options?: FhirTransactionExecutionOptions): Promise<Bundle>;
}
export interface DiagnosisCarryForwardEndpointDeps {
    fhirBaseUrl: string;
    now?: () => string;
    writeFindings?: typeof executeFindingCommand;
    rollbackFhir?: Pick<DiagnosisCarryForwardFhirClient, "read" | "executeTransaction">;
    authenticate(authHeader: string | undefined): Promise<{
        staffReference: string;
        actorRole: PracticeRoleId;
        fhir: DiagnosisCarryForwardFhirClient;
    } | null>;
}
export interface DiagnosisCarryForwardRouteDeps extends DiagnosisCarryForwardEndpointDeps {
    authenticateService(): Promise<void>;
    authenticateWrite: DiagnosisCarryForwardEndpointDeps["authenticate"];
}
const PAGE_SIZE = 4 as const;
const paramsSchema = z.object({ encounterId: z.string().trim().min(1).max(128) }).strict();
const querySchema = z.object({ cursor: z.string().trim().min(1).max(4096).optional() }).strict();
const pullBodySchema = z.object({
    commandId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    replan: z.boolean().optional(),
    sourceEncounterReference: z.string().regex(/^Encounter\/[^/]+$/),
    sourceConditionReference: z.string().regex(/^Condition\/[^/]+$/),
}).strict();
const patientReferencePattern = /^Patient\/([^/]+)$/;
const conditionReferencePattern = /^Condition\/([^/]+)$/;
const observationReferencePattern = /^Observation\/([^/]+)$/;
const cursorSigningKey = randomBytes(32);
const fullInstantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export function registerDiagnosisCarryForwardRoutes(app: Pick<Application, "get" | "post">, deps: DiagnosisCarryForwardRouteDeps): void {
    app.get("/clinical-graph/encounters/:encounterId/previous-exams", async (req, res) => {
        try {
            await deps.authenticateService();
            const result = await handlePreviousExamsReadRequest(deps, {
                authHeader: req.header("authorization"),
                params: req.params,
                query: req.query,
            });
            res.status(result.status).json(result.body);
        }
        catch (error) {
            console.error("odos-mcp: previous exams read failed:", error);
            if (!res.headersSent)
                res.status(500).json({ error: "previous exams read failed" });
        }
    });
    app.post("/clinical-graph/encounters/:encounterId/previous-exams", async (req, res) => {
        try {
            await deps.authenticateService();
            const result = await handleDiagnosisPullRequest({
                fhirBaseUrl: deps.fhirBaseUrl,
                rollbackFhir: deps.rollbackFhir,
                authenticate: deps.authenticateWrite,
            }, {
                authHeader: req.header("authorization"),
                params: req.params,
                body: req.body,
            });
            res.status(result.status).json(result.body);
        }
        catch (error) {
            console.error("odos-mcp: diagnosis pull-forward failed:", error);
            if (!res.headersSent)
                res.status(500).json({ error: "diagnosis pull-forward failed" });
        }
    });
}
export async function handlePreviousExamsReadRequest(deps: DiagnosisCarryForwardEndpointDeps, input: {
    authHeader: string | undefined;
    params: unknown;
    query: unknown;
}): Promise<{
    status: number;
    body: unknown;
}> {
    const staff = await deps.authenticate(input.authHeader);
    if (!staff)
        return { status: 401, body: { error: "Authentication required to read previous exams." } };
    if (!staffHasBusinessAction(staff, "chart.read")) {
        return { status: 403, body: { error: "chart.read role required" } };
    }
    const parsedParams = paramsSchema.safeParse(input.params);
    if (!parsedParams.success) {
        return { status: 400, body: { error: "A valid encounter id is required." } };
    }
    const parsedQuery = querySchema.safeParse(input.query);
    if (!parsedQuery.success) {
        return { status: 400, body: { error: "A valid previous-exams cursor is required." } };
    }
    try {
        const currentEncounter = await staff.fhir.read<Encounter>("Encounter", parsedParams.data.encounterId);
        const patientMatch = currentEncounter.subject?.reference?.match(patientReferencePattern);
        const currentDate = fullInstant(currentEncounter.period?.start);
        if (!patientMatch || !currentDate) {
            return { status: 422, body: { error: "The current encounter requires a Patient and recorded full start instant." } };
        }
        const patientReference = `Patient/${patientMatch[1]}`;
        await staff.fhir.read<Patient>("Patient", patientMatch[1]!);
        const currentIdentities = await currentDiagnosisIdentities(staff.fhir, currentEncounter, patientReference);
        const cursorPath = parsedQuery.data.cursor
            ? decodeCursor(parsedQuery.data.cursor, deps.fhirBaseUrl, {
                encounterId: parsedParams.data.encounterId,
                patientReference,
                currentDate,
            })
            : undefined;
        if (parsedQuery.data.cursor && !cursorPath) {
            return { status: 400, body: { error: "A valid previous-exams cursor is required." } };
        }
        if (cursorPath && !staff.fhir.searchUrl) {
            return { status: 500, body: { error: "FHIR pagination is unavailable." } };
        }
        const bundle = cursorPath
            ? await staff.fhir.searchUrl!<Encounter>(cursorPath, "Encounter")
            : await staff.fhir.search<Encounter>("Encounter", {
                subject: patientReference,
                date: `lt${currentDate}`,
                _sort: "-date",
                _count: String(PAGE_SIZE),
            });
        const encounters = bundleResources(bundle)
            .filter((encounter) => encounter.id &&
            encounter.status !== "entered-in-error" &&
            encounter.subject?.reference === patientReference)
            .slice(0, PAGE_SIZE);
        const groups = await Promise.all(encounters.map((encounter) => previousExamGroup(staff.fhir, encounter, patientReference, currentIdentities)));
        const next = bundle.link?.find((link) => link.relation === "next")?.url;
        const nextCursor = next
            ? encodeCursor({
                path: validatedNextPath(next, deps.fhirBaseUrl),
                encounterId: parsedParams.data.encounterId,
                patientReference,
                currentDate,
            })
            : undefined;
        const page: PreviousExamsPage = {
            pageSize: PAGE_SIZE,
            encounters: groups,
            ...(nextCursor ? { nextCursor } : {}),
        };
        return { status: 200, body: page };
    }
    catch (error) {
        if (error instanceof InvalidCursorError) {
            console.error("odos-mcp: previous exams next link is invalid:", error);
            return { status: 502, body: { error: "FHIR previous-exams next link is invalid." } };
        }
        return previousExamsDependencyResponse(error);
    }
}
export async function handleDiagnosisPullRequest(deps: DiagnosisCarryForwardEndpointDeps, input: {
    authHeader: string | undefined;
    params: unknown;
    body: unknown;
}): Promise<{
    status: number;
    body: unknown;
}> {
    const staff = await deps.authenticate(input.authHeader);
    if (!staff)
        return { status: 401, body: { error: "Authentication required to pull a diagnosis." } };
    if (!staffHasBusinessAction(staff, "chart.diagnosis.write")) {
        return { status: 403, body: { error: "chart.diagnosis.write role required" } };
    }
    const parsedParams = paramsSchema.safeParse(input.params);
    const parsedBody = pullBodySchema.safeParse(input.body);
    if (!parsedParams.success || !parsedBody.success) {
        return { status: 400, body: { error: "A current Encounter and source Encounter diagnosis are required." } };
    }
    try {
        const currentEncounterId = parsedParams.data.encounterId, request = parsedBody.data;
        const destinationEncounterReference = `Encounter/${currentEncounterId}`;
        const initialCurrentEncounter = await diagnosisPullRead(() => staff.fhir.read<Encounter>("Encounter", currentEncounterId));
        if (isClosedEncounter(initialCurrentEncounter))
            return carryRefusal("encounter-closed");
        const patientReference = initialCurrentEncounter.subject?.reference;
        if (!patientReference?.match(patientReferencePattern))
            return carryRefusal("patient-required");
        const [sourceEncounter, sourceCondition] = await Promise.all([
            diagnosisPullRead(() => staff.fhir.read<Encounter>("Encounter", request.sourceEncounterReference.slice(10))),
            diagnosisPullRead(() => staff.fhir.read<Condition>("Condition", request.sourceConditionReference.slice(10))),
            diagnosisPullRead(() => staff.fhir.read<Patient>("Patient", patientReference.slice(8))),
        ]);
        if (sourceEncounter.status === "entered-in-error" || sourceEncounter.subject?.reference !== patientReference ||
            sourceCondition.subject?.reference !== patientReference || sourceCondition.encounter?.reference !== request.sourceEncounterReference ||
            !encounterHasDiagnosis(sourceEncounter, request.sourceConditionReference) || excludedCondition(sourceCondition) || !sourceCondition.code)
            return carryRefusal("invalid-source");
        const sourceStart = fullInstant(sourceEncounter.period?.start), currentStart = fullInstant(initialCurrentEncounter.period?.start);
        if (!sourceStart || !currentStart || sourceStart >= currentStart)
            return carryRefusal("source-not-prior");
        if (!sourceCondition.meta?.versionId)
            return carryRefusal("source-version-required");
        const scopedDestination = await diagnosisPullRead(() => staff.fhir.read<Encounter>("Encounter", currentEncounterId));
        if (isClosedEncounter(scopedDestination))
            return carryRefusal("encounter-closed");
        if (scopedDestination.subject?.reference !== patientReference)
            return carryRefusal("patient-changed");
        const definitions = await new FhirFindingDefinitionStore(staff.fhir as unknown as ConstructorParameters<typeof FhirFindingDefinitionStore>[0]).list();
        const [sourceContext, destinationContext] = await Promise.all([
            loadDiagnosisFindingContext(staff.fhir, sourceEncounter.id!, definitions), loadDiagnosisFindingContext(staff.fhir, currentEncounterId, definitions),
        ]);
        if (sourceContext.incomplete)
            return carryLoadFailure(sourceContext);
        if (destinationContext.incomplete)
            return carryLoadFailure(destinationContext);
        if (isClosedEncounter(destinationContext.encounter))
            return carryRefusal("encounter-closed");
        if (sourceContext.projection.preRebuild || destinationContext.projection.preRebuild)
            return carryRefusal("pre-rebuild-test-encounter");
        if (sourceContext.projection.conflicts.length)
            return carryRefusal("source-finding-conflict");
        const fingerprint = carryHash({ commandId: request.commandId, sourceConditionReference: request.sourceConditionReference,
            sourceEncounterReference: request.sourceEncounterReference, destinationEncounterReference });
        let commandPlan = await carryCommandPlan(staff.fhir, request.commandId);
        if (commandPlan && (commandPlan.plan.fingerprint !== fingerprint || commandPlan.plan.actor !== staff.staffReference))
            return carryRefusal("command-reused");
        if (commandPlan && (commandPlan.plan.sourceCondition.reference !== request.sourceConditionReference || commandPlan.plan.sourceEncounter !== request.sourceEncounterReference || commandPlan.plan.destinationEncounter !== destinationEncounterReference || commandPlan.plan.targets.some(t => `Patient/${t.key.patientId}` !== patientReference)))
            throw new CarryIntegrityError("Carry command plan scope mismatch.");
        const identity = diagnosisIdentity(sourceCondition, sourceEncounter.id!);
        const identifier = { system: CARRY_DIAGNOSIS_SYSTEM, value: carryHash([1, currentEncounterId, identityKey(identity)]) };
        const lookupCondition = async () => {
            const owners = await carrySearch<Condition>(staff.fhir, "Condition", { identifier: `${identifier.system}|${identifier.value}` });
            if (owners.length > 1)
                throw new CarryIntegrityError("Duplicate carry Condition owners.");
            const owner = owners[0];
            if (owner && (owner.subject?.reference !== patientReference || owner.encounter?.reference !== destinationEncounterReference ||
                excludedCondition(owner) || identityKey(diagnosisIdentity(owner, currentEncounterId)) !== identityKey(identity) ||
                !owner.identifier?.some(i => i.system === identifier.system && i.value === identifier.value)))
                throw new CarryIntegrityError("Carry Condition owner does not match its identity.");
            return owner;
        };
        let condition = await lookupCondition();
        if (commandPlan && (!condition || `Condition/${condition.id}` !== commandPlan.plan.conditionReference))
            throw new CarryIntegrityError("Carry command plan has no matching Condition.");
        const progress: Record<string, unknown> = { alreadyPresent: false, conditionStep: "applied", planStep: "failed", linkStep: "failed", lineageStep: "not-attempted" };
        const fail = async (status: number, step: string, reason: string, unconfirmed = false) => ({ status, body: { ...progress, [step]: unconfirmed ? "unconfirmed" : "failed", reason, error: reason,
                ...(condition?.id ? { conditionReference: `Condition/${condition.id}` } : {}) } });
        const currentEncounter = await diagnosisPullRead(() => staff.fhir.read<Encounter>("Encounter", currentEncounterId));
        if (isClosedEncounter(currentEncounter))
            return carryRefusal("encounter-closed");
        if (currentEncounter.subject?.reference !== patientReference)
            return carryRefusal("patient-changed");
        const freshStart = fullInstant(currentEncounter.period?.start);
        if (!freshStart || sourceStart >= freshStart)
            return carryRefusal("source-not-prior");
        if (!currentEncounter.meta?.versionId)
            return carryRefusal("encounter-version-required");
        let completedOwnPlan = false;
        const inspectOtherPlans = async () => {
            if (!condition)
                return undefined;
            const plans = await carryPlansForCondition(staff.fhir, `Condition/${condition.id}`);
            if (plans.some(p => p.plan.conditionReference !== `Condition/${condition!.id}` || p.plan.destinationEncounter !== destinationEncounterReference || p.plan.targets.some(t => `Patient/${t.key.patientId}` !== patientReference)))
                throw new CarryIntegrityError("Carry plan owner mismatch.");
            const complete = [];
            for (const entry of plans)
                if (await carryFindingsWitness(staff.fhir, entry.plan) || !entry.plan.targets.length && encounterHasDiagnosis(currentEncounter, `Condition/${condition.id}`))
                    complete.push(entry);
            if (complete.length > 1)
                throw new CarryIntegrityError("Multiple completed carry findings witnesses.");
            if (complete.length) {
                if (!commandPlan || encounterHasDiagnosis(currentEncounter, `Condition/${condition.id}`))
                    return { status: 200, body: { conditionReference: `Condition/${condition.id}`, alreadyPresent: true } };
                completedOwnPlan = true;
            }
            const other = plans.find(p => p.plan.commandId !== request.commandId);
            if (other && !commandPlan && !request.replan)
                return { status: 409, body: { reason: "carry-incomplete", error: "Another carry is incomplete.", commandId: other.plan.commandId, conditionReference: `Condition/${condition.id}` } };
            if (request.replan && !commandPlan && (!encounterHasDiagnosis(currentEncounter, `Condition/${condition.id}`) || complete.length))
                return carryRefusal("replan-not-allowed");
            return undefined;
        };
        if (condition) {
            const resolved = await inspectOtherPlans();
            if (resolved)
                return resolved;
        }
        else {
            if (request.replan)
                return carryRefusal("replan-not-allowed");
            const existing = (await currentDiagnosisIdentities(staff.fhir, currentEncounter, patientReference)).get(identityKey(identity));
            if (existing)
                return { status: 200, body: { conditionReference: existing, alreadyPresent: true } };
            const resource = pulledDiagnosisCondition(sourceCondition, sourceEncounter.id!, currentEncounterId, patientReference, []);
            resource.identifier = [...(resource.identifier ?? []), identifier];
            delete resource.evidence;
            let created: boolean | undefined;
            try {
                const result = await staff.fhir.createWithOutcome(resource, { "If-None-Exist": `identifier=${encodeURIComponent(`${identifier.system}|${identifier.value}`)}`, "X-ODOS-Source": "diagnosis-carry-forward" });
                condition = result.resource;
                created = result.created;
                const found = await lookupCondition();
                if (!condition.id || condition.resourceType !== "Condition" || !found || found.id !== condition.id)
                    throw new CarryIntegrityError("Conditional Condition result could not be verified.");
                condition = found;
            }
            catch (error) {
                try {
                    condition = await lookupCondition();
                }
                catch {
                    return fail(502, "conditionStep", "condition-unconfirmed", true);
                }
                if (!condition)
                    return fail(dependencyStatus(error), "conditionStep", "condition-unconfirmed", true);
            }
            commandPlan = await carryCommandPlan(staff.fhir, request.commandId);
            if (commandPlan && commandPlan.plan.fingerprint !== fingerprint)
                return carryRefusal("command-reused");
            const resolved = await inspectOtherPlans();
            if (resolved)
                return resolved;
            if (created === false && !commandPlan)
                return carryRefusal("conflict");
        }
        const conditionReference = `Condition/${condition!.id}`;
        progress.conditionReference = conditionReference;
        let plan = commandPlan?.plan;
        if (!plan) {
            const targets: CarryPlan["targets"] = [];
            for (const fact of sourceContext.projection.currentFacts.filter(f => f.status === "live" && f.homes.includes(request.sourceConditionReference))) {
                const key = { ...fact.key, encounterId: currentEncounterId };
                const reason = findingTargetReadOnlyReason(destinationContext, key);
                if (reason)
                    return fail(409, "planStep", reason);
                if (!destinationContext.catalog.some(r => r.atomicFindingId === `${key.stableKey}::${key.fieldCode}::${key.optionCode}`))
                    return fail(409, "planStep", "inactive-definition");
                const owner = destinationContext.projection.currentFacts.find(f => currentFindingIdentifier(f.key).value === currentFindingIdentifier(key).value);
                if (owner && !owner.baseline)
                    return fail(409, "planStep", "destination-baseline-required");
                if (owner?.baseline?.kind === "legacy")
                    return carryRefusal("pre-rebuild-test-encounter");
                targets.push({ key, presence: fact.presence, qualifiers: fact.qualifiers, homes: owner?.status === "live" ? owner.homes : [], destinationBaseline: owner?.baseline ?? { kind: "absent", key } });
            }
            plan = { v: 1, commandId: request.commandId, fingerprint, sourceCondition: { reference: request.sourceConditionReference, versionId: sourceCondition.meta.versionId }, sourceEncounter: request.sourceEncounterReference, destinationEncounter: destinationEncounterReference, conditionReference, actor: staff.staffReference, recorded: deps.now?.() ?? new Date().toISOString(), targets };
            const resource = carryProvenance(plan, "plan", [conditionReference], CARRY_PLAN_URL, plan);
            try {
                const result = await staff.fhir.createWithOutcome(resource, carryHeaders(plan.commandId, "plan"));
                const stored = parseCarryPlan(result.resource);
                if (stored.fingerprint !== fingerprint || stored.conditionReference !== conditionReference || stored.actor !== staff.staffReference)
                    throw new CarryIntegrityError("Stored carry plan differs from this command.");
                plan = stored;
            }
            catch (error) {
                try {
                    const recovered = await carryCommandPlan(staff.fhir, request.commandId);
                    if (!recovered)
                        return fail(dependencyStatus(error), "planStep", "plan-unconfirmed", true);
                    if (recovered.plan.fingerprint !== fingerprint || recovered.plan.conditionReference !== conditionReference || recovered.plan.actor !== staff.staffReference)
                        throw new CarryIntegrityError("Stored carry plan differs from this command.");
                    plan = recovered.plan;
                }
                catch (recovery) {
                    if (recovery instanceof CarryIntegrityError)
                        throw recovery;
                    return fail(502, "planStep", "plan-unconfirmed", true);
                }
            }
        }
        progress.planStep = "applied";
        const freshEncounter = await diagnosisPullRead(() => staff.fhir.read<Encounter>("Encounter", currentEncounterId));
        if (isClosedEncounter(freshEncounter))
            return fail(409, "linkStep", "encounter-closed");
        if (freshEncounter.subject?.reference !== patientReference)
            return fail(409, "linkStep", "patient-changed");
        const linkStart = fullInstant(freshEncounter.period?.start);
        if (!linkStart || sourceStart >= linkStart)
            return fail(409, "linkStep", "source-not-prior");
        if (!encounterHasDiagnosis(freshEncounter, conditionReference)) {
            if (!freshEncounter.meta?.versionId)
                return fail(409, "linkStep", "encounter-version-required");
            const rank = Math.max(0, ...(freshEncounter.diagnosis ?? []).map(d => d.rank ?? 0)) + 1;
            try {
                await staff.fhir.update("Encounter", currentEncounterId, { ...freshEncounter, diagnosis: [...(freshEncounter.diagnosis ?? []), buildEncounterDiagnosisComponent(conditionReference, rank)] }, { "If-Match": `W/"${freshEncounter.meta.versionId}"`, "X-ODOS-Source": "diagnosis-carry-forward" });
                const verified = await staff.fhir.read<Encounter>("Encounter", currentEncounterId);
                if (verified.subject?.reference !== patientReference || !encounterHasDiagnosis(verified, conditionReference))
                    return fail(502, "linkStep", "link-unconfirmed", true);
            }
            catch (error) {
                try {
                    const recovered = await staff.fhir.read<Encounter>("Encounter", currentEncounterId);
                    if (recovered.subject?.reference !== patientReference || !encounterHasDiagnosis(recovered, conditionReference))
                        return fail(dependencyStatus(error), "linkStep", "link-unconfirmed", true);
                }
                catch {
                    return fail(502, "linkStep", "link-unconfirmed", true);
                }
            }
        }
        progress.linkStep = "applied";
        if (completedOwnPlan)
            return { status: 200, body: { ...progress, alreadyPresent: true, lineageStep: plan.targets.length ? "applied" : "not-attempted" } };
        if (plan.targets.length) {
            const findings = await (deps.writeFindings ?? executeFindingCommand)({ fhir: staff.fhir, definitions, catalog: destinationContext.catalog, staffReference: staff.staffReference, now: deps.now }, { commandId: plan.commandId, patientReference, encounterReference: destinationEncounterReference, surface: "carry-forward", targets: plan.targets.map(target => ({ kind: "fact", key: target.key, baseline: target.destinationBaseline, state: { status: "live", presence: target.presence, qualifiers: target.qualifiers, homes: [...new Set([...target.homes, conditionReference])] } })) });
            const response = findingCommandResponse(findings);
            progress.findings = response.body;
            const versions = carryOutcomeVersions(plan, findings);
            if (!versions)
                return { status: response.status === 200 ? 503 : response.status, body: { ...progress, lineageStep: "not-attempted" } };
            const resource = carryProvenance(plan, "findings", Object.keys(versions), CARRY_VERSIONS_URL, versions);
            try {
                await staff.fhir.createWithOutcome(resource, carryHeaders(plan.commandId, "findings"));
                const witness = await carryFindingsWitness(staff.fhir, plan);
                if (!witness || JSON.stringify(witness.versions) !== JSON.stringify(versions))
                    throw new CarryIntegrityError("Carry findings version witness differs from writer results.");
            }
            catch (error) {
                try {
                    const recovered = await carryFindingsWitness(staff.fhir, plan);
                    if (!recovered || JSON.stringify(recovered.versions) !== JSON.stringify(versions))
                        return fail(dependencyStatus(error), "lineageStep", "lineage-unconfirmed", true);
                }
                catch {
                    return fail(502, "lineageStep", "lineage-unconfirmed", true);
                }
            }
            progress.lineageStep = "applied";
        }
        const closure = await observePostCommandClosure(() => staff.fhir.read<Encounter>("Encounter", currentEncounterId));
        return { status: 200, body: { ...progress, ...closure } };
    }
    catch (error) {
        if (error instanceof CarryIntegrityError)
            return { status: 409, body: { reason: error.reason, error: error.message } };
        if (error instanceof DiagnosisPullReadError)
            return { status: dependencyStatus(error), body: { error: error.status === 404 || error.status === 410 ? "Diagnosis pull resources were not found." : "Diagnosis pull resources are outside the caller's patient compartment." } };
        return { status: dependencyStatus(error), body: { error: "FHIR diagnosis carry dependency failed." } };
    }
}
function carryRefusal(reason: string) { return { status: 409, body: { reason, error: reason } }; }
function dependencyStatus(error: unknown): number { const status = fhirErrorStatus(error); return status === 401 || status === 403 ? 403 : status === 404 || status === 410 ? 404 : status === 409 || status === 412 ? 409 : status === 503 ? 503 : 502; }
function carryLoadFailure(context: {
    kind: string;
    reason: string;
}) { return { status: context.kind === "refused" ? 403 : context.kind === "missing" ? 404 : 502, body: { error: context.reason } }; }
function carryHeaders(commandId: string, kind: "plan" | "findings") { return { "If-None-Exist": `_tag=${encodeURIComponent(`${CARRY_COMMAND_SYSTEM}|${carryTag(commandId, kind)}`)}`, "X-ODOS-Source": "diagnosis-carry-forward" }; }
function carryProvenance(plan: CarryPlan, kind: "plan" | "findings", targets: string[], url: string, value: unknown): Provenance {
    return { ...buildProvenance({ targetReferences: targets, recorded: plan.recorded, activityCode: "CREATE", activityDisplay: "Diagnosis pull-forward", agents: [{ typeCode: "author", whoReference: plan.actor }], entityReferences: [plan.sourceCondition.reference] }) as Provenance,
        meta: { tag: [{ system: CARRY_COMMAND_SYSTEM, code: carryTag(plan.commandId, kind) }] }, extension: [{ url, valueString: JSON.stringify(value) }] };
}
async function currentDiagnosisIdentities(fhir: DiagnosisCarryForwardFhirClient, encounter: Encounter, patientReference: string): Promise<Map<string, string>> {
    const identities = new Map<string, string>();
    for (const diagnosis of encounter.diagnosis ?? []) {
        const match = diagnosis.condition.reference?.match(conditionReferencePattern);
        if (!match)
            continue;
        const condition = await diagnosisPullRead(() => fhir.read<Condition>("Condition", match[1]!));
        if (condition.subject?.reference !== patientReference ||
            condition.encounter?.reference !== `Encounter/${encounter.id}` ||
            excludedCondition(condition))
            continue;
        const reference = `Condition/${match[1]}`;
        identities.set(identityKey(diagnosisIdentity(condition, encounter.id ?? "")), reference);
    }
    return identities;
}
async function previousExamGroup(fhir: DiagnosisCarryForwardFhirClient, encounter: Encounter, patientReference: string, currentIdentities: ReadonlyMap<string, string>): Promise<PreviousExamGroup> {
    const encounterId = encounter.id!;
    const diagnoses: PreviousExamDiagnosis[] = [];
    const definitions = await new FhirFindingDefinitionStore(fhir as unknown as ConstructorParameters<typeof FhirFindingDefinitionStore>[0]).list();
    const context = await loadDiagnosisFindingContext(fhir, encounterId, definitions);
    if (context.incomplete)
        throw Object.assign(new Error(context.reason), { status: context.kind === "refused" ? 403 : context.kind === "missing" ? 404 : 502 });
    for (const diagnosis of encounter.diagnosis ?? []) {
        const match = diagnosis.condition.reference?.match(conditionReferencePattern);
        if (!match)
            continue;
        const condition = await fhir.read<Condition>("Condition", match[1]!);
        if (condition.subject?.reference !== patientReference ||
            condition.encounter?.reference !== `Encounter/${encounterId}` ||
            excludedCondition(condition))
            continue;
        const identity = diagnosisIdentity(condition, encounterId);
        const currentConditionReference = currentIdentities.get(identityKey(identity));
        diagnoses.push({
            conditionReference: `Condition/${match[1]}`,
            display: conditionDisplay(condition),
            identity,
            findings: context.projection.preRebuild
                ? await evidenceFindings(fhir, condition, patientReference, `Encounter/${encounterId}`)
                : context.projection.currentFacts.filter(fact => fact.status === "live" && fact.homes.includes(`Condition/${match[1]}`)).map(fact => ({
                    observationReference: fact.baseline?.kind === "canonical" ? fact.baseline.reference : fact.contributors[0].reference,
                    code: `${fact.key.stableKey}::${fact.key.fieldCode}::${fact.key.optionCode}`,
                    display: context.catalog.find(row => row.atomicFindingId === `${fact.key.stableKey}::${fact.key.fieldCode}::${fact.key.optionCode}`)?.display ?? fact.key.optionCode,
                    presence: fact.presence, qualifiers: fact.qualifiers,
                    ...(typeof fact.qualifiers.grade === "string" ? { grade: fact.qualifiers.grade } : {}), laterality: fact.eye,
                })),
            checked: currentConditionReference !== undefined,
            ...(currentConditionReference ? { currentConditionReference } : {}),
        });
    }
    return {
        encounterReference: `Encounter/${encounterId}`,
        date: encounter.period?.start ?? "",
        visitType: encounter.type?.flatMap((type) => [
            type.text,
            ...(type.coding ?? []).flatMap((coding) => [coding.display, coding.code]),
        ]).find((value): value is string => Boolean(value?.trim())) ?? "Visit type not recorded",
        diagnoses,
    };
}
async function evidenceFindings(fhir: DiagnosisCarryForwardFhirClient, condition: Condition, patientReference: string, encounterReference: string): Promise<PreviousExamFinding[]> {
    const findings: PreviousExamFinding[] = [];
    for (const detail of condition.evidence?.flatMap((evidence) => evidence.detail ?? []) ?? []) {
        const match = detail.reference?.match(observationReferencePattern);
        if (!match)
            continue;
        const observation = await fhir.read<Observation>("Observation", match[1]!);
        if (observation.subject?.reference !== patientReference ||
            observation.encounter?.reference !== encounterReference ||
            observation.status === "entered-in-error" ||
            observation.status === "cancelled" ||
            typeof observation.valueBoolean !== "boolean")
            continue;
        const coding = observation.code.coding?.find((candidate) => candidate.code);
        const code = coding?.code ?? observation.code.text;
        if (!code)
            continue;
        const grade = observation.component?.find((component) => component.code.coding?.some((candidate) => candidate.code === "GRADE"));
        const gradeValue = grade?.valueString ?? grade?.valueCodeableConcept?.coding?.find((candidate) => candidate.code)?.code;
        findings.push({
            observationReference: `Observation/${match[1]}`,
            code,
            display: coding?.display ?? observation.code.text ?? code,
            presence: observation.valueBoolean ? "present" : "absent",
            ...(gradeValue ? { grade: gradeValue } : {}),
            laterality: recordedLaterality(observation),
        });
    }
    return findings;
}
function diagnosisIdentity(condition: Condition, encounterId: string): PreviousExamDiagnosisIdentity {
    const identifier = condition.identifier?.find((candidate) => candidate.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM && candidate.value)?.value;
    const parsedIdentifier = parseDiagnosisIdentifier(identifier, encounterId);
    const coding = (condition.code?.coding ?? [])
        .map(({ system, code, display }) => ({
        ...(system ? { system } : {}),
        ...(code ? { code } : {}),
        ...(display ? { display } : {}),
    }))
        .filter((row) => row.system || row.code || row.display)
        .sort((left, right) => (left.system ?? "").localeCompare(right.system ?? "") ||
        (left.code ?? "").localeCompare(right.code ?? "") ||
        (left.display ?? "").localeCompare(right.display ?? ""));
    return {
        ...(parsedIdentifier.diagnosisKey ? { diagnosisKey: parsedIdentifier.diagnosisKey } : {}),
        coding,
        ...(condition.code?.text ? { text: condition.code.text } : {}),
        laterality: recordedLaterality(condition) !== "UNKNOWN"
            ? recordedLaterality(condition)
            : parsedIdentifier.laterality ?? "UNKNOWN",
    };
}
function recordedLaterality(resource: Condition | Observation): PreviousExamLaterality {
    const extensionCode = resource.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
        ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
    const bodySites = resource.resourceType === "Condition"
        ? resource.bodySite ?? []
        : resource.bodySite ? [resource.bodySite] : [];
    const bodySiteLaterality = bodySites.map(lateralityFromBodySite)
        .find((laterality) => laterality !== "UNKNOWN");
    return lateralityFromValue(extensionCode) !== "UNKNOWN"
        ? lateralityFromValue(extensionCode)
        : bodySiteLaterality ?? "UNKNOWN";
}
function lateralityFromBodySite(bodySite: NonNullable<Condition["bodySite"]>[number]): PreviousExamLaterality {
    return [
        ...(bodySite.coding ?? []).flatMap((coding) => coding.code ? [coding.code] : []),
        ...(bodySite.text ? [bodySite.text] : []),
    ].map(lateralityFromValue).find((laterality) => laterality !== "UNKNOWN") ?? "UNKNOWN";
}
function lateralityFromValue(value: string | undefined): PreviousExamLaterality {
    if (value === "OD" || value === "right")
        return "OD";
    if (value === "OS" || value === "left")
        return "OS";
    if (value === "OU" || value === "bilateral")
        return "OU";
    return "UNKNOWN";
}
function conditionDisplay(condition: Condition): string {
    return condition.code?.text
        ?? condition.code?.coding?.find((coding) => coding.display)?.display
        ?? condition.code?.coding?.find((coding) => coding.code)?.code
        ?? "Diagnosis not recorded";
}
function excludedCondition(condition: Condition): boolean {
    const status = condition.verificationStatus?.coding?.find((coding) => coding.system === FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM)?.code;
    return status === "refuted" || status === "entered-in-error";
}
function encounterHasDiagnosis(encounter: Encounter, conditionReference: string): boolean {
    return (encounter.diagnosis ?? []).some((diagnosis) => diagnosis.condition.reference === conditionReference);
}
function pulledDiagnosisCondition(source: Condition, sourceEncounterId: string, currentEncounterId: string, patientReference: string, evidenceReferences: string[]): Condition {
    const sourceIdentity = diagnosisIdentity(source, sourceEncounterId);
    const identifier = sourceIdentity.diagnosisKey
        ? [{
                system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
                value: `${currentEncounterId}::${sourceIdentity.diagnosisKey}::${diagnosisIdentifierSuffix(source)}`,
            }]
        : undefined;
    const condition = buildEncounterDiagnosisCondition({
        patientReference,
        encounterReference: `Encounter/${currentEncounterId}`,
        code: structuredClone(source.code!),
        verificationStatus: "confirmed",
        ...(identifier ? { identifiers: identifier } : {}),
        evidenceObservationReferences: evidenceReferences,
    });
    const extensions = source.extension?.filter((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality);
    const bodySite = source.bodySite?.filter((site) => lateralityFromBodySite(site) !== "UNKNOWN");
    return {
        ...condition,
        ...(extensions?.length ? { extension: structuredClone(extensions) } : {}),
        ...(bodySite?.length ? { bodySite: structuredClone(bodySite) } : {}),
    };
}
function diagnosisIdentifierSuffix(condition: Condition): "right" | "left" | "bilateral" | "unspecified" | "none" {
    const laterality = recordedLaterality(condition);
    if (laterality === "OD")
        return "right";
    if (laterality === "OS")
        return "left";
    if (laterality === "OU")
        return "bilateral";
    const sourceValue = condition.identifier?.find((candidate) => candidate.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM)?.value?.split("::").at(-1);
    if (sourceValue === "right" || sourceValue === "left" || sourceValue === "bilateral" ||
        sourceValue === "unspecified" || sourceValue === "none") {
        return sourceValue;
    }
    return "unspecified";
}
function identityKey(identity: PreviousExamDiagnosisIdentity): string {
    return identity.diagnosisKey
        ? JSON.stringify(["catalog", identity.diagnosisKey, identity.laterality])
        : JSON.stringify(["literal", identity.coding, identity.text, identity.laterality]);
}
function previousExamsDependencyResponse(error: unknown): {
    status: number;
    body: {
        error: string;
    };
} {
    const status = fhirErrorStatus(error);
    if (status === 401 || status === 403) {
        return {
            status: 403,
            body: { error: "Previous exams are outside the caller's patient compartment." },
        };
    }
    if (status === 404 || status === 410) {
        return {
            status: 404,
            body: { error: "Previous exams resources were not found." },
        };
    }
    console.error("odos-mcp: previous exams dependency failed:", error);
    return { status: 502, body: { error: "FHIR previous-exams dependency failed." } };
}
function fhirErrorStatus(error: unknown): number | undefined {
    if (error instanceof DiagnosisPullReadError)
        return error.status;
    const status = typeof error === "object" && error !== null && "status" in error
        ? (error as {
            status?: unknown;
        }).status
        : undefined;
    return typeof status === "number" ? status : undefined;
}
async function diagnosisPullRead<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    }
    catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error
            ? (error as {
                status?: unknown;
            }).status
            : undefined;
        if (status === 401 || status === 403 || status === 404 || status === 410) {
            throw new DiagnosisPullReadError(status);
        }
        throw error;
    }
}
interface PreviousExamsCursorContext {
    path: string;
    encounterId: string;
    patientReference: string;
    currentDate: string;
}
function encodeCursor(context: PreviousExamsCursorContext): string {
    const payload = Buffer.from(JSON.stringify({ v: 2, ...context }), "utf8").toString("base64url");
    const signature = createHmac("sha256", cursorSigningKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}
function decodeCursor(cursor: string, fhirBaseUrl: string, expected: Omit<PreviousExamsCursorContext, "path">): string | undefined {
    try {
        const [payload, signature, extra] = cursor.split(".");
        if (!payload || !signature || extra !== undefined)
            return undefined;
        const expectedSignature = createHmac("sha256", cursorSigningKey).update(payload).digest();
        const receivedSignature = Buffer.from(signature, "base64url");
        if (!receivedSignature.length ||
            receivedSignature.length !== expectedSignature.length ||
            !timingSafeEqual(receivedSignature, expectedSignature))
            return undefined;
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
        if (typeof decoded !== "object" || decoded === null ||
            (decoded as {
                v?: unknown;
            }).v !== 2 ||
            typeof (decoded as {
                path?: unknown;
            }).path !== "string" ||
            (decoded as {
                encounterId?: unknown;
            }).encounterId !== expected.encounterId ||
            (decoded as {
                patientReference?: unknown;
            }).patientReference !== expected.patientReference ||
            (decoded as {
                currentDate?: unknown;
            }).currentDate !== expected.currentDate)
            return undefined;
        return validatedNextPath((decoded as {
            path: string;
        }).path, fhirBaseUrl);
    }
    catch {
        return undefined;
    }
}
function validatedNextPath(url: string, fhirBaseUrl: string): string {
    const path = fhirSearchNextPath(url, fhirBaseUrl, "Encounter");
    if (!path)
        throw new InvalidCursorError();
    return path;
}
function fullInstant(value: string | undefined): string | undefined {
    if (!value)
        return undefined;
    const match = value.match(fullInstantPattern);
    if (!match)
        return undefined;
    const [, year, month, day, hour, minute, second] = match;
    const numeric = [year, month, day, hour, minute, second].map(Number);
    if (numeric[1]! < 1 || numeric[1]! > 12 || numeric[2]! < 1 || numeric[2]! > 31 ||
        numeric[3]! > 23 || numeric[4]! > 59 || numeric[5]! > 59)
        return undefined;
    const calendar = new Date(Date.UTC(numeric[0]!, numeric[1]! - 1, numeric[2]!));
    if (calendar.getUTCFullYear() !== numeric[0] ||
        calendar.getUTCMonth() !== numeric[1]! - 1 ||
        calendar.getUTCDate() !== numeric[2])
        return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
function bundleResources<T extends Resource>(bundle: Bundle<T>): T[] {
    return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}
function staffMayRead(role: PracticeRoleId): boolean {
    try {
        assertBusinessActionAllowed(role, "chart.read");
        return true;
    }
    catch {
        return false;
    }
}
function staffMayWrite(role: PracticeRoleId): boolean {
    try {
        assertBusinessActionAllowed(role, "chart.diagnosis.write");
        return true;
    }
    catch {
        return false;
    }
}
class InvalidCursorError extends Error {
}
class DiagnosisPullReadError extends Error {
    constructor(readonly status: 401 | 403 | 404 | 410) {
        super("Diagnosis pull FHIR read failed");
    }
}
