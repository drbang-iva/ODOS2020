import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  Account,
  Bundle,
  Coverage,
  Patient,
  Person,
  RelatedPerson,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import {
  CONSENT_AUTHORITY_EXTENSION_URL,
  RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL,
} from "../mcp/src/clinic/patient-registration-endpoint.js";
import { searchPhoneDigits } from "../mcp/src/clinic/guarantor-search.js";
import {
  GUARANTOR_CLAIM_URL,
  GUARANTOR_OPERATION_SYSTEM,
} from "../mcp/src/clinic/guarantor-link-operation.js";
import {
  createOperatorScriptFhirClient,
  type MedplumClient,
} from "../mcp/src/fhir-client.js";
import { FhirSearchLimitError, searchAll } from "../mcp/src/fhir-search.js";
import { assertLocalOrPrivateBaseUrl } from "./backfill-patient-mrns.js";

const MAX_ROWS = 50_000;
const READ_ONLY_ERROR = "guarantor-census is read-only";

type ResourceType = Resource["resourceType"];
type SearchParams = Record<string, string>;

interface CensusReadTransport {
  readonly baseUrl: string;
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  readExtended?<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: SearchParams): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  searchProject?<T extends Resource>(resourceType: T["resourceType"], projectId: string, params?: SearchParams): Promise<Bundle<T>>;
  searchProjectUrl?<T extends Resource>(url: string, resourceType: T["resourceType"], projectId: string): Promise<Bundle<T>>;
  history<T extends Resource>(resourceType: T["resourceType"], id?: string, params?: SearchParams): Promise<Bundle<T>>;
}

export interface ReadOnlyGuarantorCensusFhir extends Omit<CensusReadTransport, "readExtended" | "searchUrl" | "searchProject" | "searchProjectUrl"> {
  readExtended<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  searchProject<T extends Resource>(resourceType: T["resourceType"], projectId: string, params?: SearchParams): Promise<Bundle<T>>;
  searchProjectUrl<T extends Resource>(url: string, resourceType: T["resourceType"], projectId: string): Promise<Bundle<T>>;
  create(...args: unknown[]): Promise<never>;
  createWithOutcome(...args: unknown[]): Promise<never>;
  update(...args: unknown[]): Promise<never>;
  patch(...args: unknown[]): Promise<never>;
  executeTransaction(...args: unknown[]): Promise<never>;
  executeTransactionAsActor(...args: unknown[]): Promise<never>;
  delete(...args: unknown[]): Promise<never>;
  deleteAttempt(...args: unknown[]): Promise<never>;
  nullifyAttempt(...args: unknown[]): Promise<never>;
}

const refuseWrite = async (): Promise<never> => {
  throw new Error(READ_ONLY_ERROR);
};

export function createReadOnlyGuarantorCensusFhir(transport: CensusReadTransport): ReadOnlyGuarantorCensusFhir {
  return {
    baseUrl: transport.baseUrl,
    read: transport.read.bind(transport),
    async readExtended<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      if (!transport.readExtended) throw new Error("The FHIR transport cannot perform an extended read.");
      return transport.readExtended<T>(resourceType, id);
    },
    search: transport.search.bind(transport),
    async searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> {
      if (!transport.searchUrl) throw new Error("The FHIR transport cannot fetch a search page.");
      return transport.searchUrl<T>(url, resourceType);
    },
    async searchProject<T extends Resource>(resourceType: T["resourceType"], projectId: string, params?: SearchParams): Promise<Bundle<T>> {
      if (!transport.searchProject) throw new Error("The FHIR transport cannot search a project.");
      return transport.searchProject<T>(resourceType, projectId, params);
    },
    async searchProjectUrl<T extends Resource>(url: string, resourceType: T["resourceType"], projectId: string): Promise<Bundle<T>> {
      if (!transport.searchProjectUrl) throw new Error("The FHIR transport cannot fetch a project search page.");
      return transport.searchProjectUrl<T>(url, resourceType, projectId);
    },
    history: transport.history.bind(transport),
    create: refuseWrite,
    createWithOutcome: refuseWrite,
    update: refuseWrite,
    patch: refuseWrite,
    executeTransaction: refuseWrite,
    executeTransactionAsActor: refuseWrite,
    delete: refuseWrite,
    deleteAttempt: refuseWrite,
    nullifyAttempt: refuseWrite,
  };
}

type Ownership = "ownedByOnePerson" | "unowned" | "ownedByMultiplePersons";
type LatestOperation = "failedAttach" | "undoneAttach" | "none";

export interface GuarantorCensusDetailRow {
  bucket: string;
  projectId: string;
  resourceId: string;
  versionId?: string;
  patientId?: string;
  patientIds?: string[];
  name?: RelatedPerson["name"] | Person["name"];
  telecom?: RelatedPerson["telecom"] | Person["telecom"];
  address?: RelatedPerson["address"] | Person["address"];
  active?: boolean;
  period?: RelatedPerson["period"];
  ownership?: Ownership;
  claimState?: "active" | "inert" | "none";
  latestOperation?: LatestOperation;
  accountGuarantor?: boolean;
  crossProject?: boolean;
  coverageIds?: string[];
  changedHistoryVersionIds?: string[];
  suspectedInsuranceOverwrite?: true;
  duplicateGroupId?: string;
  linkCounts?: { missingRelatedPerson: number; nonRelatedPerson: number };
}

interface ProjectSummary {
  project: string;
  responsibleParties: {
    total: number;
    ownedByOnePerson: number;
    unowned: number;
    ownedByMultiplePersons: number;
    withActiveClaim: number;
    withInertClaim: number;
  };
  unowned: {
    active: { true: number; false: number };
    period: { current: number; ended: number; none: number };
    patientActive: { true: number; false: number; missing: number };
    accountGuarantor: { referenced: number; notReferenced: number };
    latestGuarantorOperation: { failedAttach: number; undoneAttach: number; none: number };
  };
  persons: {
    total: number;
    linked: number;
    zeroLinkActive: number;
    inactive: number;
    linksToMissingRelatedPerson: number;
    linksToNonRelatedPerson: number;
  };
  insuranceDamage: {
    coverageCount: number;
    subscriberRelatedPersonReferences: number;
    subscriberRefsToResponsibleParties: number;
    ofThoseActiveFalse: number;
    unreadableSubscriberReferences: number;
    historyVersionsExamined: number;
    suspectedOverwrites: number;
  };
  duplicateCandidates: {
    groups: number;
    recordsInGroups: number;
    sizeHistogram: { "2": number; "3": number; "4+": number };
  };
  g3bPreview: {
    wouldCreatePersonAndAttach: number;
    skipped: { claimed: number; multipleOwners: number; crossProject: number; suspectedInsuranceOverwrite: number; inDuplicateGroup: number };
  };
  crossProject: number;
}

export interface GuarantorCensusResult {
  summary: { asOfDate: string; projectCount: number; projects: ProjectSummary[] };
  detail: GuarantorCensusDetailRow[];
}

const projectOf = (resource: Resource): string => resource.meta?.project?.replace(/^Project\//, "") ?? "";
const referenceId = (value: string | undefined, resourceType: ResourceType): string | undefined => {
  const match = value?.match(new RegExp(`^(?:[^/]+/)?${resourceType}/([^/]+)$`));
  return match?.[1];
};
const hasRole = (person: RelatedPerson) => (person.extension ?? []).some(extension =>
  extension.url === CONSENT_AUTHORITY_EXTENSION_URL || extension.url === RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL);
const emptyProjectSummary = (project: string): ProjectSummary => ({
  project,
  responsibleParties: { total: 0, ownedByOnePerson: 0, unowned: 0, ownedByMultiplePersons: 0, withActiveClaim: 0, withInertClaim: 0 },
  unowned: {
    active: { true: 0, false: 0 }, period: { current: 0, ended: 0, none: 0 },
    patientActive: { true: 0, false: 0, missing: 0 }, accountGuarantor: { referenced: 0, notReferenced: 0 },
    latestGuarantorOperation: { failedAttach: 0, undoneAttach: 0, none: 0 },
  },
  persons: { total: 0, linked: 0, zeroLinkActive: 0, inactive: 0, linksToMissingRelatedPerson: 0, linksToNonRelatedPerson: 0 },
  insuranceDamage: {
    coverageCount: 0, subscriberRelatedPersonReferences: 0, subscriberRefsToResponsibleParties: 0,
    ofThoseActiveFalse: 0, unreadableSubscriberReferences: 0, historyVersionsExamined: 0, suspectedOverwrites: 0,
  },
  duplicateCandidates: { groups: 0, recordsInGroups: 0, sizeHistogram: { "2": 0, "3": 0, "4+": 0 } },
  g3bPreview: { wouldCreatePersonAndAttach: 0, skipped: { claimed: 0, multipleOwners: 0, crossProject: 0, suspectedInsuranceOverwrite: 0, inDuplicateGroup: 0 } },
  crossProject: 0,
});

function taskMovedIds(task: Task): string[] {
  return (task.input ?? []).filter(input => input.type?.text === "moved")
    .map(input => referenceId(input.valueReference?.reference, "RelatedPerson")).filter((id): id is string => Boolean(id));
}

function taskKind(task: Task): string | undefined {
  return task.code?.coding?.find(coding => coding.system === GUARANTOR_OPERATION_SYSTEM)?.code
    ?? task.input?.find(input => input.type?.text === "kind")?.valueCode;
}

const isTrustedTask = (task: Task, project: string, serviceReference: string) =>
  projectOf(task) === project && task.meta?.author?.reference === serviceReference
  && Boolean(task.code?.coding?.some(coding => coding.system === GUARANTOR_OPERATION_SYSTEM));

function demographicSignature(person: RelatedPerson): string {
  return JSON.stringify({ name: person.name ?? [], address: person.address ?? [], active: person.active });
}

async function readHistoryAll(
  fhir: ReadOnlyGuarantorCensusFhir,
  resourceType: "RelatedPerson",
  id: string,
): Promise<RelatedPerson[]> {
  let bundle = await fhir.history<RelatedPerson>(resourceType, id, { _count: "100" });
  const resources: RelatedPerson[] = [];
  let pagesRead = 0;
  let rowsRead = 0;
  for (;;) {
    pagesRead += 1;
    const entries = bundle.entry ?? [];
    rowsRead += entries.length;
    const page = entries.map(entry => entry.resource).filter((resource): resource is RelatedPerson => Boolean(resource));
    if (rowsRead > MAX_ROWS) {
      throw new FhirSearchLimitError(resourceType, MAX_ROWS, rowsRead, pagesRead);
    }
    resources.push(...page);
    const next = bundle.link?.find(link => link.relation === "next")?.url;
    if (!next) return resources;
    if (pagesRead >= MAX_ROWS) throw new FhirSearchLimitError(resourceType, MAX_ROWS, rowsRead, pagesRead);
    bundle = await fhir.searchUrl<RelatedPerson>(historyNextPath(next, fhir.baseUrl, id), resourceType);
  }
}

function historyNextPath(value: string, baseUrl: string, id: string): string {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const next = new URL(value, base);
  const basePath = base.pathname.replace(/\/$/, "");
  const expectedPath = `${basePath}/fhir/R4/RelatedPerson/${encodeURIComponent(id)}/_history`;
  if (next.origin !== base.origin || next.username || next.password || next.pathname !== expectedPath || !next.search || next.hash) {
    throw new Error("FHIR RelatedPerson history next link is invalid.");
  }
  return `${next.pathname}${next.search}`;
}

function normalizedDuplicateKey(person: RelatedPerson | Person): string | undefined {
  const name = person.name?.find(row => row.use === "official") ?? person.name?.[0];
  const family = name?.family?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  const first = name?.given?.[0]?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  const phone = searchPhoneDigits(person.telecom?.find(contact => contact.system === "phone")?.value ?? "");
  return family && first && phone ? `${family}|${first}|${phone}` : undefined;
}

function periodBucket(period: RelatedPerson["period"], today: string): "current" | "ended" | "none" {
  if (!period) return "none";
  if ((!period.start || period.start <= today) && (!period.end || period.end >= today)) return "current";
  return "ended";
}

export async function collectGuarantorCensus(
  fhir: ReadOnlyGuarantorCensusFhir,
  options: { today: string; serviceReference: string },
): Promise<GuarantorCensusResult> {
  const relatedPeople = await searchAll<RelatedPerson>(fhir, "RelatedPerson", {}, { maxRows: MAX_ROWS });
  const persons = await searchAll<Person>(fhir, "Person", {}, { maxRows: MAX_ROWS });
  const patients = await searchAll<Patient>(fhir, "Patient", {}, { maxRows: MAX_ROWS });
  const accounts = await searchAll<Account>(fhir, "Account", {}, { maxRows: MAX_ROWS });
  const coverages = await searchAll<Coverage>(fhir, "Coverage", {}, { maxRows: MAX_ROWS });
  const tasks = await searchAll<Task>(fhir, "Task", {}, { maxRows: MAX_ROWS });
  const allResources: Resource[] = [...relatedPeople, ...persons, ...patients, ...accounts, ...coverages, ...tasks];
  const missingProject = allResources.find(resource => !projectOf(resource));
  if (missingProject) throw new Error(`Cannot census ${missingProject.resourceType}/${missingProject.id ?? "unknown"}: meta.project is missing.`);

  const projectIds = [...new Set(allResources.map(projectOf))].sort();
  const aliases = new Map(projectIds.map((project, index) => [project, `project-${index + 1}`]));
  const detail: GuarantorCensusDetailRow[] = [];
  const projects: ProjectSummary[] = [];
  const relatedById = new Map(relatedPeople.filter(row => row.id).map(row => [row.id!, row]));
  const patientByProjectId = new Map(patients.filter(row => row.id).map(row => [`${projectOf(row)}/${row.id}`, row]));
  const ownersByProject = new Map<string, Map<string, Person[]>>();
  const crossRelatedByProject = new Map<string, Set<string>>();
  for (const person of persons) {
    for (const link of person.link ?? []) {
      const relatedId = referenceId(link.target.reference, "RelatedPerson");
      const related = relatedId ? relatedById.get(relatedId) : undefined;
      if (!relatedId || !related) continue;
      const relatedProject = projectOf(related);
      if (projectOf(person) !== relatedProject) {
        const crossRelated = crossRelatedByProject.get(relatedProject) ?? new Set<string>();
        crossRelated.add(relatedId);
        crossRelatedByProject.set(relatedProject, crossRelated);
        continue;
      }
      const owners = ownersByProject.get(relatedProject) ?? new Map<string, Person[]>();
      const rows = owners.get(relatedId) ?? [];
      if (!rows.includes(person)) rows.push(person);
      owners.set(relatedId, rows);
      ownersByProject.set(relatedProject, owners);
    }
  }

  for (const projectId of projectIds) {
    const summary = emptyProjectSummary(aliases.get(projectId)!);
    const localRelated = relatedPeople.filter(row => projectOf(row) === projectId);
    const responsible = localRelated.filter(hasRole);
    const responsibleIds = new Set(responsible.map(row => row.id).filter((id): id is string => Boolean(id)));
    const localPersons = persons.filter(row => projectOf(row) === projectId);
    const localAccounts = accounts.filter(row => projectOf(row) === projectId);
    const localCoverages = coverages.filter(row => projectOf(row) === projectId);
    const localTasks = tasks.filter(row => isTrustedTask(row, projectId, options.serviceReference));
    const owners = ownersByProject.get(projectId) ?? new Map<string, Person[]>();
    const crossRelated = crossRelatedByProject.get(projectId) ?? new Set<string>();
    summary.crossProject = crossRelated.size;

    const accountGuarantors = new Set(localAccounts.flatMap(account => account.guarantor ?? [])
      .map(guarantor => referenceId(guarantor.party.reference, "RelatedPerson"))
      .filter((id): id is string => Boolean(id)));

    const latestByRelated = new Map<string, Task>();
    for (const task of localTasks) {
      for (const id of taskMovedIds(task)) {
        const prior = latestByRelated.get(id);
        if (!prior || (task.meta?.lastUpdated ?? "") > (prior.meta?.lastUpdated ?? "")) latestByRelated.set(id, task);
      }
    }

    const coverageIdsByRelated = new Map<string, string[]>();
    const unreadableCoverageIds = new Map<string, string[]>();
    const subscriberReferences = new Set<string>();
    for (const coverage of localCoverages) {
      summary.insuranceDamage.coverageCount += 1;
      const subscriberId = referenceId(coverage.subscriber?.reference, "RelatedPerson");
      if (!subscriberId) continue;
      subscriberReferences.add(subscriberId);
      const subscriber = relatedById.get(subscriberId);
      if (!subscriber || projectOf(subscriber) !== projectId) {
        const ids = unreadableCoverageIds.get(subscriberId) ?? [];
        if (coverage.id) ids.push(coverage.id);
        unreadableCoverageIds.set(subscriberId, ids);
        continue;
      }
      const ids = coverageIdsByRelated.get(subscriberId) ?? [];
      if (coverage.id) ids.push(coverage.id);
      coverageIdsByRelated.set(subscriberId, ids);
    }
    summary.insuranceDamage.subscriberRelatedPersonReferences = subscriberReferences.size;
    summary.insuranceDamage.unreadableSubscriberReferences = unreadableCoverageIds.size;
    for (const [subscriberId, coverageIds] of unreadableCoverageIds) {
      detail.push({ bucket: "unreadableSubscriberReference", projectId, resourceId: subscriberId, coverageIds });
    }

    const suspected = new Set<string>();
    const changedVersions = new Map<string, string[]>();
    for (const related of responsible) {
      if (!related.id || !coverageIdsByRelated.has(related.id)) continue;
      summary.insuranceDamage.subscriberRefsToResponsibleParties += 1;
      if (related.active === false) summary.insuranceDamage.ofThoseActiveFalse += 1;
      const history = await readHistoryAll(fhir, "RelatedPerson", related.id);
      summary.insuranceDamage.historyVersionsExamined += history.length;
      const chronological = [...history].sort((left, right) => {
        const leftVersion = Number(left.meta?.versionId);
        const rightVersion = Number(right.meta?.versionId);
        if (Number.isInteger(leftVersion) && Number.isInteger(rightVersion)) return leftVersion - rightVersion;
        return (left.meta?.lastUpdated ?? "").localeCompare(right.meta?.lastUpdated ?? "");
      });
      for (let index = 1; index < chronological.length; index += 1) {
        const prior = chronological[index - 1]!;
        const current = chronological[index]!;
        if (demographicSignature(prior) !== demographicSignature(current)
          && current.meta?.author?.reference !== options.serviceReference) {
          suspected.add(related.id);
          const ids = changedVersions.get(related.id) ?? [];
          if (current.meta?.versionId) ids.push(current.meta.versionId);
          changedVersions.set(related.id, ids);
        }
      }
    }
    summary.insuranceDamage.suspectedOverwrites = suspected.size;

    const duplicateGroups = new Map<string, string[]>();
    const duplicateEligible: Array<RelatedPerson | Person> = [
      ...responsible.filter(row => (owners.get(row.id ?? "")?.length ?? 0) === 0),
      ...localPersons.filter(person => (person.link ?? []).some(link => {
        const id = referenceId(link.target.reference, "RelatedPerson");
        return id !== undefined && relatedById.has(id) && projectOf(relatedById.get(id)!) === projectId;
      })),
    ];
    for (const resource of duplicateEligible) {
      if (!resource.id) continue;
      const key = normalizedDuplicateKey(resource);
      if (!key) continue;
      const ids = duplicateGroups.get(key) ?? [];
      ids.push(`${resource.resourceType}/${resource.id}`);
      duplicateGroups.set(key, ids);
    }
    const actualDuplicateGroups = [...duplicateGroups.entries()].filter(([, members]) => members.length >= 2);
    const duplicateMembers = new Map<string, string>();
    for (const [key, members] of actualDuplicateGroups) {
      const groupId = createHash("sha256").update(`${projectId}|${key}`).digest("hex").slice(0, 12);
      for (const member of members) duplicateMembers.set(member, groupId);
      summary.duplicateCandidates.recordsInGroups += members.length;
      if (members.length === 2) summary.duplicateCandidates.sizeHistogram["2"] += 1;
      else if (members.length === 3) summary.duplicateCandidates.sizeHistogram["3"] += 1;
      else summary.duplicateCandidates.sizeHistogram["4+"] += 1;
    }
    summary.duplicateCandidates.groups = actualDuplicateGroups.length;

    summary.persons.total = localPersons.length;
    for (const person of localPersons) {
      const sameProjectRelatedLinks = (person.link ?? []).filter(link => {
        const id = referenceId(link.target.reference, "RelatedPerson");
        return id !== undefined && relatedById.has(id) && projectOf(relatedById.get(id)!) === projectId;
      });
      if (sameProjectRelatedLinks.length) summary.persons.linked += 1;
      if (person.active === false) summary.persons.inactive += 1;
      else if (!(person.link ?? []).length) summary.persons.zeroLinkActive += 1;
      let missingRelatedPerson = 0;
      let nonResponsibleParty = 0;
      for (const link of person.link ?? []) {
        const id = referenceId(link.target.reference, "RelatedPerson");
        if (!id) nonResponsibleParty += 1;
        else if (!relatedById.has(id)) missingRelatedPerson += 1;
      }
      summary.persons.linksToMissingRelatedPerson += missingRelatedPerson;
      summary.persons.linksToNonRelatedPerson += nonResponsibleParty;
      detail.push({
        bucket: "person", projectId, resourceId: person.id!, versionId: person.meta?.versionId,
        patientIds: sameProjectRelatedLinks.map(link => relatedById.get(referenceId(link.target.reference, "RelatedPerson")!)!)
          .map(row => referenceId(row.patient.reference, "Patient")).filter((id): id is string => Boolean(id)),
        name: person.name, telecom: person.telecom, address: person.address, active: person.active,
        duplicateGroupId: duplicateMembers.get(`Person/${person.id}`),
        linkCounts: { missingRelatedPerson, nonRelatedPerson: nonResponsibleParty },
      });
    }

    summary.responsibleParties.total = responsible.length;
    for (const related of localRelated) {
      const isResponsible = responsibleIds.has(related.id ?? "");
      if (!isResponsible) {
        detail.push({
          bucket: "subscriberOnly", projectId, resourceId: related.id!, versionId: related.meta?.versionId,
          patientId: referenceId(related.patient.reference, "Patient"), name: related.name, telecom: related.telecom,
          address: related.address, active: related.active, period: related.period,
          coverageIds: coverageIdsByRelated.get(related.id ?? ""),
        });
        continue;
      }
      const ownerCount = owners.get(related.id!)?.length ?? 0;
      const ownership: Ownership = ownerCount === 0 ? "unowned" : ownerCount === 1 ? "ownedByOnePerson" : "ownedByMultiplePersons";
      summary.responsibleParties[ownership] += 1;
      const claimRefs = (related.extension ?? []).filter(extension => extension.url === GUARANTOR_CLAIM_URL)
        .map(extension => referenceId(extension.valueReference?.reference, "Task")).filter((id): id is string => Boolean(id));
      const activeClaim = claimRefs.some(id => localTasks.some(task => task.id === id && task.status === "in-progress" && taskMovedIds(task).includes(related.id!)));
      const claimState = activeClaim ? "active" : claimRefs.length ? "inert" : "none";
      if (claimState === "active") summary.responsibleParties.withActiveClaim += 1;
      if (claimState === "inert") summary.responsibleParties.withInertClaim += 1;
      const latest = latestByRelated.get(related.id!);
      const latestOperation: LatestOperation = latest?.status === "failed" && taskKind(latest) === "attach"
        ? "failedAttach" : latest?.status === "completed" && taskKind(latest) === "correct" ? "undoneAttach" : "none";
      const patientId = referenceId(related.patient.reference, "Patient");
      const patient = patientId ? patientByProjectId.get(`${projectId}/${patientId}`) : undefined;
      const accountGuarantor = accountGuarantors.has(related.id!);
      const crossProject = crossRelated.has(related.id!);

      if (ownership === "unowned") {
        summary.unowned.active[related.active === false ? "false" : "true"] += 1;
        summary.unowned.period[periodBucket(related.period, options.today)] += 1;
        summary.unowned.patientActive[!patient ? "missing" : patient.active === false ? "false" : "true"] += 1;
        summary.unowned.accountGuarantor[accountGuarantor ? "referenced" : "notReferenced"] += 1;
        summary.unowned.latestGuarantorOperation[latestOperation] += 1;
        if (claimState === "active") summary.g3bPreview.skipped.claimed += 1;
        else if (crossProject) summary.g3bPreview.skipped.crossProject += 1;
        else if (suspected.has(related.id!)) summary.g3bPreview.skipped.suspectedInsuranceOverwrite += 1;
        else if (duplicateMembers.has(`RelatedPerson/${related.id}`)) summary.g3bPreview.skipped.inDuplicateGroup += 1;
        else summary.g3bPreview.wouldCreatePersonAndAttach += 1;
      } else if (ownership === "ownedByMultiplePersons") {
        summary.g3bPreview.skipped.multipleOwners += 1;
      }

      detail.push({
        bucket: "responsibleParty", projectId, resourceId: related.id!, versionId: related.meta?.versionId,
        patientId, name: related.name, telecom: related.telecom, address: related.address, active: related.active,
        period: related.period, ownership, claimState, latestOperation, accountGuarantor, crossProject,
        coverageIds: coverageIdsByRelated.get(related.id!), changedHistoryVersionIds: changedVersions.get(related.id!),
        ...(suspected.has(related.id!) ? { suspectedInsuranceOverwrite: true as const } : {}),
        duplicateGroupId: duplicateMembers.get(`RelatedPerson/${related.id}`),
      });
    }
    projects.push(summary);
  }

  return { summary: { asOfDate: options.today, projectCount: projects.length, projects }, detail };
}

function pathInside(candidate: string, root: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function writeDetailFile(path: string, detail: GuarantorCensusDetailRow[]): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${detail.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function executeGuarantorCensusCommand(options: {
  args: string[];
  fhir: ReadOnlyGuarantorCensusFhir;
  today: string;
  serviceReference: string;
  checkoutRoots: string[];
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}): Promise<number> {
  let detailPath: string | undefined;
  if (options.args.length === 0) detailPath = undefined;
  else if (options.args.length === 2 && options.args[0] === "--detail") detailPath = options.args[1];
  else {
    options.stderr("Usage: npm run guarantor-census -- [--detail /absolute/private/path.ndjson]");
    return 1;
  }
  if (detailPath) {
    if (!isAbsolute(detailPath)) {
      options.stderr("--detail must be an absolute path outside every ODOS and performance-od checkout.");
      return 1;
    }
    try {
      detailPath = resolve(await realpath(dirname(detailPath)), basename(detailPath));
    } catch (error) {
      options.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (options.checkoutRoots.some(root => pathInside(detailPath!, root))) {
      options.stderr("--detail must be an absolute path outside every ODOS and performance-od checkout.");
      return 1;
    }
  }
  try {
    const result = await collectGuarantorCensus(options.fhir, { today: options.today, serviceReference: options.serviceReference });
    if (detailPath) await writeDetailFile(detailPath, result.detail);
    options.stdout(JSON.stringify(result.summary, null, 2));
    return 0;
  } catch (error) {
    options.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof FhirSearchLimitError ? 2 : 1;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function runCli(): Promise<number> {
  const baseUrl = requireEnv("MEDPLUM_BASE_URL");
  assertLocalOrPrivateBaseUrl(baseUrl);
  const accessToken = process.env.MEDPLUM_ACCESS_TOKEN?.trim();
  const client = createOperatorScriptFhirClient({
    baseUrl, accessToken, extendedMode: true,
    reason: "Read-only guarantor census runs outside request handling.",
  });
  if (!accessToken) await client.login(requireEnv("MEDPLUM_ADMIN_EMAIL"), requireEnv("MEDPLUM_ADMIN_PASSWORD"));
  const configuredWriter = process.env.ODOS_REGISTRATION_WRITER_REFERENCE?.trim();
  const clientProfileType = ["Client", "Application"].join("");
  const clientId = process.env.MEDPLUM_CLIENT_ID?.trim()?.replace(new RegExp(`^${clientProfileType}/`), "");
  const serviceReference = configuredWriter || (clientId ? `${clientProfileType}/${clientId}` : "");
  if (!serviceReference) throw new Error("MEDPLUM_CLIENT_ID or ODOS_REGISTRATION_WRITER_REFERENCE is required.");
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const worktreeMarker = `${process.platform === "win32" ? "\\" : "/"}.worktrees${process.platform === "win32" ? "\\" : "/"}`;
  const markerIndex = checkout.indexOf(worktreeMarker);
  const primaryCheckout = markerIndex >= 0 ? checkout.slice(0, markerIndex) : checkout;
  const roots = [...new Set([checkout, primaryCheckout])];
  const performanceRoot = process.env.PERFORMANCE_OD_ROOT?.trim() || resolve(primaryCheckout, "..", "performance-od");
  try { roots.push(await realpath(performanceRoot)); } catch { roots.push(performanceRoot); }
  return executeGuarantorCensusCommand({
    args: process.argv.slice(2), fhir: createReadOnlyGuarantorCensusFhir(client as MedplumClient),
    today: new Date().toISOString().slice(0, 10), serviceReference,
    checkoutRoots: roots, stdout: value => console.log(value), stderr: value => console.error(value),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
