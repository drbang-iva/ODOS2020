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
  keyFindings: Array<{
    findingKey: string;
    label?: string;
    satisfiedBy: "this-encounter" | "any-on-file";
    withinMonths?: number;
    origin: "seed" | "practice";
    active: boolean;
  }>;
};

type KeyFindingRow = CatalogItemBase & {
  diagnosisKey: string;
  persistedDiagnosisKey?: string;
  findingKey: string;
  persistedFindingKey?: string;
  label: string;
  satisfiedBy: "this-encounter" | "any-on-file";
  withinMonths?: number;
  origin: "seed" | "practice";
};

type MappingRow = CatalogItemBase & {
  findingKey: string;
  persistedFindingKey?: string;
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
  active?: boolean;
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
  const [liveDiagnoses, setLiveDiagnoses] = useState(diagnoses);
  useEffect(() => setLiveDiagnoses(diagnoses), [diagnoses]);
  const catalogDescriptor = useMemo(
    () => diagnosisDescriptor((saved) => setLiveDiagnoses((current) => upsertDiagnosis(current, saved))),
    [],
  );
  const mappingDescriptor = useMemo(
    () => diagnosisMappingDescriptor(findings, liveDiagnoses),
    [findings, liveDiagnoses],
  );
  const keyFindingsDescriptor = useMemo(
    () => keyFindingDescriptor(
      findings,
      liveDiagnoses,
      (saved) => setLiveDiagnoses((current) => upsertDiagnosis(current, saved)),
    ),
    [findings, liveDiagnoses],
  );
  return (
    <CatalogScene title="Suggested diagnoses" canWrite={canWrite}>
      {!canWrite && <div className="border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">Read only. The finding-definitions.write grant is required to edit diagnosis settings.</div>}
      <CatalogSection descriptor={mappingDescriptor} canWrite={canWrite} initialState={{ items: mappings, loading: false }} />
      <CatalogSection descriptor={keyFindingsDescriptor} canWrite={canWrite} initialState={{ items: keyFindingRows(liveDiagnoses), loading: false }} />
      <CatalogSection descriptor={catalogDescriptor} canWrite={canWrite} initialState={{ items: liveDiagnoses, loading: false }} />
    </CatalogScene>
  );
}

export function diagnosisDescriptor(
  onSaved?: (row: DiagnosisRow) => void,
  request: typeof postJson = postJson,
): CatalogDescriptor<DiagnosisRow> {
  return {
    title: "Diagnosis catalog",
    singularLabel: "diagnosis",
    adapter: diagnosisAdapter(onSaved, request),
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
      keyFindings: [],
      active: true,
    }),
    label: (row) => row.display,
    chips: (row) => [row.codingStatus.toUpperCase(), row.origin],
    facts: (row) => [row.stableKey, diagnosisCodeSummary(row)],
  };
}

export function keyFindingDescriptor(
  findings: FindingDefinition[],
  diagnoses: DiagnosisRow[],
  onSaved?: (row: DiagnosisRow) => void,
  request: typeof postJson = postJson,
): CatalogDescriptor<KeyFindingRow> {
  const adapter = keyFindingAdapter(diagnoses, onSaved, request);
  return {
    title: "Key findings by diagnosis",
    singularLabel: "key finding",
    adapter,
    fields: [
      {
        type: "select",
        key: "diagnosisKey",
        label: "Diagnosis",
        required: true,
        options: diagnoses.filter((row) => row.active).map((row) => ({ value: row.stableKey, label: row.display })),
      },
      {
        type: "select",
        key: "findingKey",
        label: "Finding",
        required: true,
        options: findings.filter((row) => row.active !== false).map((row) => ({ value: row.stableKey, label: row.display })),
      },
      {
        type: "select",
        key: "satisfiedBy",
        label: "Satisfied by",
        required: true,
        options: [
          { value: "this-encounter", label: "This encounter" },
          { value: "any-on-file", label: "Any on file" },
        ],
      },
      { type: "number", key: "withinMonths", label: "Within months", min: 1, max: 1_200 },
      { type: "text", key: "label", label: "Optional advisory label" },
    ],
    createItem: () => ({
      id: `new-${crypto.randomUUID()}`,
      diagnosisKey: diagnoses.find((row) => row.active)?.stableKey ?? "",
      findingKey: findings.find((row) => row.active !== false)?.stableKey ?? "",
      label: "",
      satisfiedBy: "this-encounter",
      origin: "practice",
      active: true,
    }),
    validateItem: validateKeyFinding,
    label: (row) => row.label || findings.find((finding) => finding.stableKey === row.findingKey)?.display || row.findingKey,
    facts: (row) => [
      row.satisfiedBy === "this-encounter" ? "This encounter" : `Any on file${row.withinMonths ? ` · ${row.withinMonths} months` : ""}`,
    ],
    chips: (row) => [row.origin],
    groupBy: {
      label: "Diagnosis",
      value: (row) => diagnoses.find((diagnosis) => diagnosis.stableKey === row.diagnosisKey)?.display ?? row.diagnosisKey,
    },
  };
}

export function diagnosisMappingDescriptor(
  findings: FindingDefinition[],
  diagnoses: DiagnosisRow[],
  request: typeof postJson = postJson,
): CatalogDescriptor<MappingRow> {
  return {
    title: "Suggested diagnoses by finding",
    singularLabel: "suggestion mapping",
    adapter: mappingAdapter(findings, request),
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
      persistedFindingKey: undefined,
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

function diagnosisAdapter(
  onSaved: ((row: DiagnosisRow) => void) | undefined,
  request: typeof postJson,
): CatalogAdapter<DiagnosisRow> {
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
      const result = await request<{ diagnosis: Record<string, unknown> }>(path, body);
      const saved = diagnosisFromApi(result.diagnosis);
      onSaved?.(saved);
      return saved;
    },
    async deactivate(row) {
      const result = await request<{ diagnosis: Record<string, unknown> }>(
        `/clinical-graph/diagnosis-catalog/${encodeURIComponent(row.stableKey)}`,
        { active: false },
      );
      const saved = diagnosisFromApi(result.diagnosis);
      onSaved?.(saved);
      return saved;
    },
  };
}

function keyFindingAdapter(
  diagnoses: DiagnosisRow[],
  onSaved: ((row: DiagnosisRow) => void) | undefined,
  request: typeof postJson,
): CatalogAdapter<KeyFindingRow> {
  const currentByDiagnosis = new Map(diagnoses.map((diagnosis) => [diagnosis.stableKey, diagnosis]));
  let mutationQueue: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persist(diagnosis: DiagnosisRow, entries: DiagnosisRow["keyFindings"]): Promise<DiagnosisRow> {
    const result = await request<{ diagnosis: Record<string, unknown> }>(
      `/clinical-graph/diagnosis-catalog/${encodeURIComponent(diagnosis.stableKey)}`,
      { keyFindings: entries.map(keyFindingPayload) },
    );
    const saved = diagnosisFromApi(result.diagnosis);
    currentByDiagnosis.set(saved.stableKey, saved);
    onSaved?.(saved);
    return saved;
  }

  return {
    capabilities: { reorder: true, deactivate: true, presetSeed: false },
    list: () => [],
    async save(row) {
      if (row.persistedDiagnosisKey && (
        row.diagnosisKey !== row.persistedDiagnosisKey || row.findingKey !== row.persistedFindingKey
      )) {
        throw new Error("Changing the diagnosis or finding on an existing key finding isn't supported — deactivate it and create a new one.");
      }
      return serialize(async () => {
        const diagnosis = currentByDiagnosis.get(row.diagnosisKey);
        if (!diagnosis) throw new Error(`Diagnosis ${row.diagnosisKey} is no longer available.`);
        const entry = keyFindingEntry(row);
        const index = diagnosis.keyFindings.findIndex((candidate) => candidate.findingKey === row.findingKey);
        const entries = index === -1
          ? [...diagnosis.keyFindings, entry]
          : diagnosis.keyFindings.map((candidate) => candidate.findingKey === row.findingKey ? entry : candidate);
        const saved = await persist(diagnosis, entries);
        return keyFindingRows([saved]).find((candidate) => candidate.findingKey === row.findingKey)!;
      });
    },
    async deactivate(row) {
      return serialize(async () => {
        const diagnosis = currentByDiagnosis.get(row.diagnosisKey);
        if (!diagnosis) throw new Error(`Diagnosis ${row.diagnosisKey} is no longer available.`);
        const entries = diagnosis.keyFindings.map((entry) =>
          entry.findingKey === row.findingKey ? { ...entry, active: false } : entry
        );
        const saved = await persist(diagnosis, entries);
        return keyFindingRows([saved]).find((candidate) => candidate.findingKey === row.findingKey)!;
      });
    },
    async reorder(ids) {
      await serialize(async () => {
        const order = new Map(ids.map((id, index) => [id, index]));
        for (const diagnosis of currentByDiagnosis.values()) {
          if (diagnosis.keyFindings.length < 2) continue;
          const entries = [...diagnosis.keyFindings].sort((left, right) =>
            (order.get(keyFindingId(diagnosis.stableKey, left.findingKey)) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(keyFindingId(diagnosis.stableKey, right.findingKey)) ?? Number.MAX_SAFE_INTEGER)
          );
          if (entries.some((entry, index) => entry.findingKey !== diagnosis.keyFindings[index]?.findingKey)) {
            await persist(diagnosis, entries);
          }
        }
      });
    },
  };
}

function mappingAdapter(
  findings: FindingDefinition[],
  request: typeof postJson,
): CatalogAdapter<MappingRow> {
  return {
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    list: () => [],
    async save(row) {
      const isNew = row.id.startsWith("new-");
      const persistedFinding = isNew
        ? undefined
        : findings.find((finding) => finding.diagnosisCandidates.some((candidate) => candidate.id === row.id));
      const findingKey = isNew
        ? row.findingKey
        : row.persistedFindingKey ?? persistedFinding?.stableKey ?? row.findingKey;
      if (!isNew && row.findingKey !== findingKey) {
        throw new Error("Changing the finding for an existing mapping isn't supported — deactivate this mapping and create a new one.");
      }
      const body = {
        action: isNew ? "create-diagnosis-candidate" : "update-diagnosis-candidate",
        ...(!isNew ? { id: row.id } : {}),
        diagnosisKey: row.diagnosisKey,
        trigger: triggerFromRow(row),
        priority: row.priority,
      };
      const result = await request<{ candidate: FindingDefinition["diagnosisCandidates"][number] }>(
        `/clinical-graph/finding-definitions/${encodeURIComponent(findingKey)}`,
        body,
      );
      const finding = findings.find((candidate) => candidate.stableKey === findingKey);
      return mappingRow(finding?.display ?? row.findingDisplay, findingKey, result.candidate);
    },
    async deactivate(row) {
      const result = await request<{ candidate: FindingDefinition["diagnosisCandidates"][number] }>(
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
    keyFindings: Array.isArray(value.keyFindings)
      ? value.keyFindings.flatMap((entry) => {
          const row = record(entry);
          if (typeof row.findingKey !== "string") return [];
          return [{
            findingKey: row.findingKey,
            ...(typeof row.label === "string" ? { label: row.label } : {}),
            satisfiedBy: row.satisfiedBy === "any-on-file" ? "any-on-file" as const : "this-encounter" as const,
            ...(typeof row.withinMonths === "number" ? { withinMonths: row.withinMonths } : {}),
            origin: row.origin === "seed" ? "seed" as const : "practice" as const,
            active: row.active === true,
          }];
        })
      : [],
    active: value.active === true,
  };
}

function keyFindingRows(diagnoses: DiagnosisRow[]): KeyFindingRow[] {
  return diagnoses.flatMap((diagnosis) => diagnosis.keyFindings.map((entry) => ({
    id: keyFindingId(diagnosis.stableKey, entry.findingKey),
    diagnosisKey: diagnosis.stableKey,
    persistedDiagnosisKey: diagnosis.stableKey,
    findingKey: entry.findingKey,
    persistedFindingKey: entry.findingKey,
    label: entry.label ?? "",
    satisfiedBy: entry.satisfiedBy,
    withinMonths: entry.withinMonths,
    origin: entry.origin,
    active: entry.active,
  })));
}

function keyFindingId(diagnosisKey: string, findingKey: string): string {
  return `key-finding:${diagnosisKey}:${findingKey}`;
}

function keyFindingEntry(row: KeyFindingRow): DiagnosisRow["keyFindings"][number] {
  return {
    findingKey: row.findingKey,
    ...(row.label.trim() ? { label: row.label.trim() } : {}),
    satisfiedBy: row.satisfiedBy,
    ...(row.satisfiedBy === "any-on-file" && row.withinMonths !== undefined ? { withinMonths: row.withinMonths } : {}),
    origin: row.origin,
    active: row.active,
  };
}

function keyFindingPayload(entry: DiagnosisRow["keyFindings"][number]) {
  return {
    findingKey: entry.findingKey,
    ...(entry.label ? { label: entry.label } : {}),
    satisfiedBy: entry.satisfiedBy,
    ...(entry.withinMonths !== undefined ? { withinMonths: entry.withinMonths } : {}),
    active: entry.active,
  };
}

function validateKeyFinding(row: KeyFindingRow, rows: KeyFindingRow[]): void {
  if (row.withinMonths !== undefined && (!Number.isInteger(row.withinMonths) || row.satisfiedBy !== "any-on-file")) {
    throw new Error("Within months must be a whole number and is only available for Any on file.");
  }
  if (rows.some((candidate) =>
    candidate.id !== row.id && candidate.diagnosisKey === row.diagnosisKey && candidate.findingKey === row.findingKey
  )) {
    throw new Error("That finding is already configured for this diagnosis.");
  }
}

function upsertDiagnosis(rows: DiagnosisRow[], saved: DiagnosisRow): DiagnosisRow[] {
  const index = rows.findIndex((row) => row.stableKey === saved.stableKey);
  return index === -1
    ? [...rows, saved]
    : rows.map((row) => row.stableKey === saved.stableKey ? saved : row);
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
    persistedFindingKey: findingKey,
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
