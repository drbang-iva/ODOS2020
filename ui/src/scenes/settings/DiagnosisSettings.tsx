import { useEffect, useMemo, useState } from "react";
import type { CatalogAdapter, CatalogItemBase } from "../../lib/catalog-adapter";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { CatalogScene, CatalogSection, type CatalogDescriptor } from "./CatalogEditor";

type DiagnosisRow = CatalogItemBase & {
  stableKey: string;
  display: string;
  clinicalFamily: string;
  codingStatus: "verified" | "placeholder" | "provisional";
  origin: "seed" | "practice";
  lateralityRequired: boolean;
  code: string;
  unspecifiedEye: string;
  right: string;
  left: string;
  bilateral: string;
};

type MappingRow = CatalogItemBase & {
  findingKey: string;
  findingDisplay: string;
  diagnosisKey: string;
  triggerKind: "always" | "abnormal" | "numeric" | "option";
  field: string;
  operator: ">=" | "<=" | ">" | "<" | "==";
  triggerValue: string;
  priority: boolean;
};

type FindingDefinition = {
  stableKey: string;
  display: string;
  allowDiagnosisMapping: boolean;
  diagnosisCandidates: Array<{
    id: string;
    diagnosisKey: string;
    trigger: Record<string, unknown>;
    priority?: boolean;
    active: boolean;
  }>;
};

export function DiagnosisSettings() {
  const [state, setState] = useState<{
    canWrite: boolean;
    diagnoses: DiagnosisRow[];
    mappings: MappingRow[];
    findings: FindingDefinition[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getJson<{ canWrite: boolean; diagnoses: Array<Record<string, unknown>> }>("/clinical-graph/diagnosis-catalog"),
      getJson<{ canWrite: boolean; definitions: FindingDefinition[] }>("/clinical-graph/finding-definitions"),
    ]).then(([catalog, findingCatalog]) => {
      if (cancelled) return;
      const diagnoses = catalog.diagnoses.map(diagnosisFromApi);
      setState({
        canWrite: catalog.canWrite && findingCatalog.canWrite,
        diagnoses,
        findings: findingCatalog.definitions,
        mappings: findingCatalog.definitions.flatMap(mappingRows),
      });
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, []);

  if (error || !state) {
    return (
      <main className="min-h-screen bg-[#060610] p-6 text-white">
        <div className="mx-auto max-w-5xl text-sm text-white/55">
          {error ? <span role="alert">Diagnosis settings could not be loaded: {error}</span> : "Loading diagnosis settings…"}
        </div>
      </main>
    );
  }
  return <DiagnosisSettingsReady {...state} />;
}

export function DiagnosisSettingsReady({
  canWrite,
  diagnoses,
  mappings,
  findings,
}: {
  canWrite: boolean;
  diagnoses: DiagnosisRow[];
  mappings: MappingRow[];
  findings: FindingDefinition[];
}) {
  const catalogDescriptor = useMemo(() => diagnosisDescriptor(), []);
  const mappingDescriptor = useMemo(
    () => diagnosisMappingDescriptor(findings, diagnoses),
    [diagnoses, findings],
  );
  return (
    <CatalogScene title="Suggested diagnoses" canWrite={canWrite}>
      {!canWrite && <div className="border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">Read only. The finding-definitions.write grant is required to edit diagnosis settings.</div>}
      <CatalogSection descriptor={mappingDescriptor} canWrite={canWrite} initialState={{ items: mappings, loading: false }} />
      <CatalogSection descriptor={catalogDescriptor} canWrite={canWrite} initialState={{ items: diagnoses, loading: false }} />
    </CatalogScene>
  );
}

function diagnosisDescriptor(): CatalogDescriptor<DiagnosisRow> {
  return {
    title: "Diagnosis catalog",
    singularLabel: "diagnosis",
    adapter: diagnosisAdapter(),
    fields: [
      { type: "text", key: "display", label: "Display", required: true },
      { type: "text", key: "clinicalFamily", label: "Clinical family", required: true },
      { type: "toggle", key: "lateralityRequired", label: "Laterality-specific coding" },
      { type: "text", key: "code", label: "ICD-10-CM code" },
      { type: "text", key: "unspecifiedEye", label: "ICD-10-CM · unspecified eye" },
      { type: "text", key: "right", label: "ICD-10-CM · right eye" },
      { type: "text", key: "left", label: "ICD-10-CM · left eye" },
      { type: "text", key: "bilateral", label: "ICD-10-CM · bilateral" },
    ],
    createItem: () => ({
      id: `new-${crypto.randomUUID()}`,
      stableKey: "",
      display: "",
      clinicalFamily: "",
      codingStatus: "provisional",
      origin: "practice",
      lateralityRequired: false,
      code: "",
      unspecifiedEye: "",
      right: "",
      left: "",
      bilateral: "",
      active: true,
    }),
    label: (row) => row.display,
    chips: (row) => [row.codingStatus.toUpperCase(), row.origin],
    facts: (row) => [row.stableKey, diagnosisCodeSummary(row)],
  };
}

function diagnosisMappingDescriptor(
  findings: FindingDefinition[],
  diagnoses: DiagnosisRow[],
): CatalogDescriptor<MappingRow> {
  return {
    title: "Suggested diagnoses by finding",
    singularLabel: "suggestion mapping",
    adapter: mappingAdapter(findings),
    fields: [
      {
        type: "select",
        key: "findingKey",
        label: "Finding",
        required: true,
        options: findings.filter((row) => row.allowDiagnosisMapping).map((row) => ({ value: row.stableKey, label: row.display })),
      },
      {
        type: "select",
        key: "diagnosisKey",
        label: "Diagnosis",
        required: true,
        options: diagnoses.filter((row) => row.active).map((row) => ({ value: row.stableKey, label: `${row.display} · ${row.codingStatus}` })),
      },
      {
        type: "select",
        key: "triggerKind",
        label: "Trigger",
        required: true,
        options: [
          { value: "always", label: "Always" },
          { value: "abnormal", label: "Abnormal or borderline" },
          { value: "numeric", label: "Numeric comparison" },
          { value: "option", label: "Selected option" },
        ],
      },
      { type: "text", key: "field", label: "Finding field" },
      {
        type: "select",
        key: "operator",
        label: "Numeric operator",
        options: [">=", "<=", ">", "<", "=="].map((value) => ({ value, label: value })),
      },
      { type: "text", key: "triggerValue", label: "Threshold or comma-separated options" },
      { type: "toggle", key: "priority", label: "Priority suggestion" },
    ],
    createItem: () => ({
      id: `new-${crypto.randomUUID()}`,
      findingKey: findings.find((row) => row.allowDiagnosisMapping)?.stableKey ?? "",
      findingDisplay: "",
      diagnosisKey: diagnoses.find((row) => row.active)?.stableKey ?? "",
      triggerKind: "always",
      field: "",
      operator: ">=",
      triggerValue: "",
      priority: false,
      active: true,
    }),
    validateItem: validateMapping,
    label: (row) => diagnoses.find((diagnosis) => diagnosis.stableKey === row.diagnosisKey)?.display ?? row.diagnosisKey,
    chips: (row) => [row.triggerKind, ...(row.priority ? ["priority"] : [])],
    groupBy: { label: "Finding", value: (row) => findings.find((finding) => finding.stableKey === row.findingKey)?.display ?? row.findingDisplay ?? row.findingKey },
  };
}

function diagnosisAdapter(): CatalogAdapter<DiagnosisRow> {
  return {
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    list: () => [],
    async save(row) {
      const icd10 = row.lateralityRequired
        ? { pattern: compact({ unspecifiedEye: row.unspecifiedEye, right: row.right, left: row.left, bilateral: row.bilateral }) }
        : row.code ? { code: row.code } : undefined;
      const body = compact({ display: row.display, clinicalFamily: row.clinicalFamily, lateralityRequired: row.lateralityRequired, icd10 });
      const path = row.id.startsWith("new-")
        ? "/clinical-graph/diagnosis-catalog"
        : `/clinical-graph/diagnosis-catalog/${encodeURIComponent(row.stableKey)}`;
      const result = await postJson<{ diagnosis: Record<string, unknown> }>(path, body);
      return diagnosisFromApi(result.diagnosis);
    },
    async deactivate(row) {
      const result = await postJson<{ diagnosis: Record<string, unknown> }>(
        `/clinical-graph/diagnosis-catalog/${encodeURIComponent(row.stableKey)}`,
        { active: false },
      );
      return diagnosisFromApi(result.diagnosis);
    },
  };
}

function mappingAdapter(findings: FindingDefinition[]): CatalogAdapter<MappingRow> {
  return {
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    list: () => [],
    async save(row) {
      const isNew = row.id.startsWith("new-");
      const body = {
        action: isNew ? "create-diagnosis-candidate" : "update-diagnosis-candidate",
        ...(!isNew ? { id: row.id } : {}),
        diagnosisKey: row.diagnosisKey,
        trigger: triggerFromRow(row),
        priority: row.priority,
      };
      const result = await postJson<{ candidate: FindingDefinition["diagnosisCandidates"][number] }>(
        `/clinical-graph/finding-definitions/${encodeURIComponent(row.findingKey)}`,
        body,
      );
      const finding = findings.find((candidate) => candidate.stableKey === row.findingKey);
      return mappingRow(finding?.display ?? row.findingDisplay, row.findingKey, result.candidate);
    },
    async deactivate(row) {
      const result = await postJson<{ candidate: FindingDefinition["diagnosisCandidates"][number] }>(
        `/clinical-graph/finding-definitions/${encodeURIComponent(row.findingKey)}`,
        { action: "update-diagnosis-candidate", id: row.id, active: false },
      );
      return mappingRow(row.findingDisplay, row.findingKey, result.candidate);
    },
  };
}

function diagnosisFromApi(value: Record<string, unknown>): DiagnosisRow {
  const icd10 = record(value.icd10);
  const pattern = record(icd10.pattern);
  return {
    id: String(value.stableKey),
    stableKey: String(value.stableKey),
    display: String(value.display),
    clinicalFamily: String(value.clinicalFamily),
    codingStatus: value.codingStatus as DiagnosisRow["codingStatus"],
    origin: value.origin as DiagnosisRow["origin"],
    lateralityRequired: value.lateralityRequired === true,
    code: typeof icd10.code === "string" ? icd10.code : "",
    unspecifiedEye: stringValue(pattern.unspecifiedEye),
    right: stringValue(pattern.right),
    left: stringValue(pattern.left),
    bilateral: stringValue(pattern.bilateral),
    active: value.active === true,
  };
}

function mappingRows(definition: FindingDefinition): MappingRow[] {
  return definition.diagnosisCandidates.map((candidate) => mappingRow(definition.display, definition.stableKey, candidate));
}

function mappingRow(
  findingDisplay: string,
  findingKey: string,
  candidate: FindingDefinition["diagnosisCandidates"][number],
): MappingRow {
  const trigger = record(candidate.trigger);
  const kind = trigger.kind as MappingRow["triggerKind"];
  return {
    id: candidate.id,
    findingKey,
    findingDisplay,
    diagnosisKey: candidate.diagnosisKey,
    triggerKind: kind,
    field: stringValue(trigger.field),
    operator: ([">=", "<=", ">", "<", "=="].includes(String(trigger.op)) ? trigger.op : ">=") as MappingRow["operator"],
    triggerValue: kind === "numeric" ? String(trigger.value ?? "") : Array.isArray(trigger.anyOf) ? trigger.anyOf.join(", ") : "",
    priority: candidate.priority === true,
    active: candidate.active,
  };
}

function triggerFromRow(row: MappingRow): Record<string, unknown> {
  if (row.triggerKind === "always" || row.triggerKind === "abnormal") return { kind: row.triggerKind };
  if (row.triggerKind === "numeric") return { kind: "numeric", field: row.field.trim(), op: row.operator, value: Number(row.triggerValue) };
  return { kind: "option", field: row.field.trim(), anyOf: row.triggerValue.split(",").map((value) => value.trim()).filter(Boolean) };
}

function validateMapping(row: MappingRow): void {
  if ((row.triggerKind === "numeric" || row.triggerKind === "option") && !row.field.trim()) throw new Error("Finding field is required for this trigger.");
  if (row.triggerKind === "numeric" && !Number.isFinite(Number(row.triggerValue))) throw new Error("Numeric trigger threshold must be a number.");
  if (row.triggerKind === "option" && !row.triggerValue.split(",").some((value) => value.trim())) throw new Error("Option trigger requires at least one value.");
}

function diagnosisCodeSummary(row: DiagnosisRow): string {
  return row.code || [row.right, row.left, row.bilateral, row.unspecifiedEye].filter(Boolean).join(" · ") || "No ICD-10-CM code";
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${clinicalGraphApiBase()}${path}`, { headers: authHeaders() });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${clinicalGraphApiBase()}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Request failed: ${response.status}`);
  return result;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, row]) => row !== undefined && row !== ""));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
