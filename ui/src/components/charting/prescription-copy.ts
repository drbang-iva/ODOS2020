export type PrescriptionEye = "OD" | "OS";

export interface GlassesHistoryRow {
  type: string;
  typeCode?: string;
  groupId?: string;
  date: string;
  encounterReference?: string;
  eye: PrescriptionEye;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
}

export interface SoftContactLensHistoryRow {
  date: string;
  encounterReference?: string;
  eye: PrescriptionEye;
  manufacturer?: string;
  product?: string;
  baseCurve?: number;
  diameter?: number;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  colorMfPower?: string;
  status?: string;
}

export interface PrescriptionHistoryResponse {
  glasses: GlassesHistoryRow[];
  softCl: SoftContactLensHistoryRow[];
  specialtyCl: unknown[];
}

export interface RefractionEyeDraft {
  sphere: string;
  cylinder: string;
  axis: string;
  add: string;
}

export interface RefractionBlockDraft {
  id: string;
  type: string;
  purpose: string;
  remarks: string;
  OD: RefractionEyeDraft;
  OS: RefractionEyeDraft;
}

export interface RefractionCopySource {
  id: string;
  label: string;
  eyes: Partial<Record<PrescriptionEye, Partial<Pick<RefractionEyeDraft, "sphere" | "cylinder" | "axis" | "add">>>>;
}

export interface SoftContactLensEyeDraft {
  manufacturer: string;
  product: string;
  baseCurve: string;
  diameter: string;
  sphere: string;
  cylinder: string;
  axis: string;
  add: string;
  colorMfPower: string;
}

export interface SoftContactLensDraft {
  OD: SoftContactLensEyeDraft;
  OS: SoftContactLensEyeDraft;
}

export interface SoftContactLensCopySource {
  id: string;
  label: string;
  eyes: Partial<Record<PrescriptionEye, Partial<Pick<
    SoftContactLensEyeDraft,
    "manufacturer" | "product" | "baseCurve" | "diameter" | "sphere" | "cylinder" | "axis" | "add" | "colorMfPower"
  >>>>;
}

const EYES: PrescriptionEye[] = ["OD", "OS"];
const REFRACTION_FIELDS = ["sphere", "cylinder", "axis", "add"] as const;
const SOFT_CL_STRING_FIELDS = ["manufacturer", "product", "colorMfPower"] as const;
const SOFT_CL_NUMBER_FIELDS = ["baseCurve", "diameter", "sphere", "cylinder", "axis", "add"] as const;

export function refractionCopySources<T extends RefractionBlockDraft>(
  blocks: T[],
  targetBlockId: string,
  history: PrescriptionHistoryResponse | null,
  encounterReference: string,
  typeLabels: Record<string, string>,
): RefractionCopySource[] {
  const encounterSources = blocks.flatMap((block) => {
    if (block.id === targetBlockId) return [];
    const eyes = refractionDraftEyes(block);
    if (!hasEyeValues(eyes)) return [];
    return [{
      id: `encounter:${block.id}`,
      label: `${typeLabels[block.type] ?? block.type} (current encounter)`,
      eyes,
    }];
  });
  if (!history) return encounterSources;

  const priorFinal = latestGroup(history.glasses.filter((row) =>
    row.typeCode === "FINAL_RX" && row.encounterReference !== encounterReference && hasRefractionHistoryValues(row)));
  const wearing = latestGroup(history.glasses.filter((row) =>
    row.typeCode === "WEARING_RX" && hasRefractionHistoryValues(row)));
  const currentAutoRows = history.glasses.filter((row) =>
    row.typeCode === "AUTO_REFRACTION" && row.encounterReference === encounterReference && hasRefractionHistoryValues(row));
  const autoRefraction = latestGroup(currentAutoRows.length
    ? currentAutoRows
    : history.glasses.filter((row) => row.typeCode === "AUTO_REFRACTION" && hasRefractionHistoryValues(row)));

  return [
    ...encounterSources,
    ...historyRefractionSource("prior-final-rx", "Prior visit Final/Rx", priorFinal),
    ...historyRefractionSource("wearing-rx", "Wearing Rx", wearing),
    ...historyRefractionSource("auto-refraction", "Auto-refraction", autoRefraction),
  ];
}

export function copyRefractionValues<T extends RefractionBlockDraft>(
  target: T,
  source: RefractionCopySource,
): T {
  return {
    ...target,
    OD: copyDefined(target.OD, source.eyes.OD, REFRACTION_FIELDS),
    OS: copyDefined(target.OS, source.eyes.OS, REFRACTION_FIELDS),
  } as T;
}

export function softContactLensCopySources(
  history: PrescriptionHistoryResponse | null,
  encounterReference: string,
): SoftContactLensCopySource[] {
  if (!history) return [];
  const prior = latestGroup(history.softCl.filter((row) =>
    row.encounterReference !== encounterReference && !row.status?.startsWith("order_trial") && hasSoftClHistoryValues(row)));
  const currentTrial = latestGroup(history.softCl.filter((row) =>
    row.encounterReference === encounterReference && row.status?.startsWith("order_trial") && hasSoftClHistoryValues(row)));
  return [
    ...historySoftClSource("prior-soft-cl", "Prior contact lens Rx", prior),
    ...historySoftClSource("current-trial-soft-cl", "Current trial lens", currentTrial),
  ];
}

export function copySoftContactLensValues<T extends SoftContactLensDraft>(
  target: T,
  source: SoftContactLensCopySource,
): T {
  const fields = [...SOFT_CL_STRING_FIELDS, ...SOFT_CL_NUMBER_FIELDS] as const;
  return {
    ...target,
    OD: copyDefined(target.OD, source.eyes.OD, fields),
    OS: copyDefined(target.OS, source.eyes.OS, fields),
  } as T;
}

function historyRefractionSource(
  id: string,
  label: string,
  rows: GlassesHistoryRow[],
): RefractionCopySource[] {
  if (rows.length === 0) return [];
  const eyes = Object.fromEntries(rows.flatMap((row) => {
    const values = definedEntries({
      sphere: power(row.sphere),
      cylinder: power(row.cylinder),
      axis: numberString(row.axis),
      add: power(row.add),
    });
    return Object.keys(values).length ? [[row.eye, values]] : [];
  }));
  return hasEyeValues(eyes) ? [{ id, label: `${label} · ${formatDate(rows[0]!.date)}`, eyes }] : [];
}

function historySoftClSource(
  id: string,
  label: string,
  rows: SoftContactLensHistoryRow[],
): SoftContactLensCopySource[] {
  if (rows.length === 0) return [];
  const eyes = Object.fromEntries(rows.flatMap((row) => {
    const values = definedEntries({
      manufacturer: row.manufacturer,
      product: row.product,
      baseCurve: numberString(row.baseCurve),
      diameter: numberString(row.diameter),
      sphere: power(row.sphere),
      cylinder: power(row.cylinder),
      axis: numberString(row.axis),
      add: power(row.add),
      colorMfPower: row.colorMfPower,
    });
    return Object.keys(values).length ? [[row.eye, values]] : [];
  }));
  return hasEyeValues(eyes) ? [{ id, label: `${label} · ${formatDate(rows[0]!.date)}`, eyes }] : [];
}

function refractionDraftEyes(block: RefractionBlockDraft): RefractionCopySource["eyes"] {
  return Object.fromEntries(EYES.flatMap((eye) => {
    const values = definedEntries(Object.fromEntries(REFRACTION_FIELDS.map((field) => [field, block[eye][field] || undefined])));
    return Object.keys(values).length ? [[eye, values]] : [];
  }));
}

function latestGroup<T extends { date: string; encounterReference?: string; groupId?: string; status?: string; typeCode?: string }>(rows: T[]): T[] {
  const sorted = [...rows].sort((left, right) => right.date.localeCompare(left.date));
  const first = sorted[0];
  if (!first) return [];
  return sorted.filter((row) => row.date === first.date
    && row.encounterReference === first.encounterReference
    && row.groupId === first.groupId
    && row.status === first.status
    && row.typeCode === first.typeCode);
}

function copyDefined<T extends object, K extends keyof T>(
  target: T,
  source: Partial<Pick<T, K>> | undefined,
  fields: readonly K[],
): T {
  if (!source) return target;
  const copied = Object.fromEntries(fields.flatMap((field) => source[field] === undefined ? [] : [[field, source[field]]]));
  return { ...target, ...copied };
}

function hasEyeValues(value: Partial<Record<PrescriptionEye, object>>): boolean {
  return EYES.some((eye) => Object.keys(value[eye] ?? {}).length > 0);
}

function hasRefractionHistoryValues(row: GlassesHistoryRow): boolean {
  return REFRACTION_FIELDS.some((field) => row[field] !== undefined);
}

function hasSoftClHistoryValues(row: SoftContactLensHistoryRow): boolean {
  return [...SOFT_CL_STRING_FIELDS, ...SOFT_CL_NUMBER_FIELDS].some((field) => row[field] !== undefined && row[field] !== "");
}

function definedEntries<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as Partial<T>;
}

function power(value: number | undefined): string | undefined {
  return value === undefined ? undefined : value.toFixed(2);
}

function numberString(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(date);
}
