import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  PROCEDURE_FEE_CATEGORIES,
  ProcedureFeeConceptConflictError,
  ProcedureFeeScheduleInputError,
  type ProcedureFeeCategory,
  type ProcedureFeeScheduleFhir,
  type ProcedureFeeScheduleItem,
  createProcedureFeeScheduleItem,
  isSeededProcedureFeeConceptKey,
  listProcedureFeeScheduleSnapshot,
  procedureConceptKeyFromDisplay,
  saveProcedureFeeScheduleItem,
} from "./procedure-fee-schedule.js";

export const FEE_IMPORT_ROUTINGS = ["insurance-billable", "self-pay", "scheduling-only"] as const;
export type FeeImportRouting = (typeof FEE_IMPORT_ROUTINGS)[number];
export type FeeImportDecision = "match" | "create" | "skip";
export type FeeImportFlagClass =
  | "invalid-active-code-name"
  | "zero-price-contradiction"
  | "obsolete-or-superseded"
  | "category-required"
  | "routing-required"
  | "active-column-unmapped"
  | "laterality-dropped"
  | "invalid-price"
  | "invalid-source-boolean"
  | "concept-key-conflict";

export interface FeeImportColumnMapping {
  display?: string;
  category?: string;
  billingCode?: string;
  modifier?: string;
  price?: string;
  routing?: string;
  active?: string;
  zeroPrice?: string;
}

export interface FeeImportFlag {
  class: FeeImportFlagClass;
  message: string;
}

export interface FeeImportProposal {
  proposalId: string;
  sourceRows: number[];
  originalCode?: string;
  decision: FeeImportDecision;
  matchProcedureConceptKey?: string;
  matchSeeded?: boolean;
  display: string;
  category?: ProcedureFeeCategory;
  billingCode?: string;
  modifier?: string;
  priceCents?: number;
  routing?: FeeImportRouting;
  active: boolean;
  flags: FeeImportFlag[];
  reasons: string[];
}

export interface FeeImportMatchOption {
  procedureConceptKey: string;
  display: string;
  category?: ProcedureFeeCategory;
  seeded: boolean;
}

export interface FeeImportInspection {
  headers: string[];
  rowCount: number;
  suggestedMapping: FeeImportColumnMapping;
}

export interface FeeImportPreview {
  proposals: FeeImportProposal[];
  matchOptions: FeeImportMatchOption[];
  counts: { create: number; match: number; skip: number; flagged: number };
}

export interface FeeImportCommitOutcome {
  proposalId: string;
  status: "created" | "matched" | "skipped" | "failed";
  procedureConceptKey?: string;
  message: string;
}

export interface FeeImportCommitResult {
  outcomes: FeeImportCommitOutcome[];
  counts: { created: number; matched: number; skipped: number; failed: number };
}

export class ProcedureFeeImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcedureFeeImportInputError";
  }
}

interface ParsedFeeCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

interface WorkingProposal extends FeeImportProposal {
  displayMeaning: string;
  hadLaterality: boolean;
}

const commitProposalSchema = z.object({
  proposalId: z.string().trim().min(1).max(200),
  sourceRows: z.array(z.number().int().positive()).min(1),
  originalCode: z.string().optional(),
  decision: z.enum(["match", "create", "skip"]),
  matchProcedureConceptKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional(),
  matchSeeded: z.boolean().optional(),
  display: z.string().max(200),
  category: z.enum(PROCEDURE_FEE_CATEGORIES).optional(),
  billingCode: z.string().max(20).optional(),
  modifier: z.string().max(10).optional(),
  priceCents: z.number().int().nonnegative().optional(),
  routing: z.enum(FEE_IMPORT_ROUTINGS).optional(),
  active: z.boolean(),
  flags: z.array(z.object({
    class: z.enum([
      "invalid-active-code-name",
      "zero-price-contradiction",
      "obsolete-or-superseded",
      "category-required",
      "routing-required",
      "active-column-unmapped",
      "laterality-dropped",
      "invalid-price",
      "invalid-source-boolean",
      "concept-key-conflict",
    ]),
    message: z.string(),
  }).strict()),
  reasons: z.array(z.string()),
}).strict();

const HEADER_ALIASES: Record<keyof FeeImportColumnMapping, readonly string[]> = {
  display: ["display", "name", "description", "service", "procedure", "offering", "title", "label"],
  category: ["category", "group", "type", "bucket"],
  billingCode: ["billing code", "procedure code", "service code", "charge code", "code", "token"],
  modifier: ["modifier", "mod"],
  price: ["price", "fee", "amount", "charge"],
  routing: ["routing", "route", "purpose"],
  active: ["active", "status", "state"],
  zeroPrice: ["zero price", "zero fee", "zero amount", "zero", "no charge"],
};

export function inspectProcedureFeeCsv(csvText: string): FeeImportInspection {
  const parsed = parseFeeCsv(csvText);
  return {
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    suggestedMapping: suggestMapping(parsed.headers),
  };
}

export function proposeProcedureFeeImport(input: {
  csvText: string;
  mapping: FeeImportColumnMapping;
  existing: readonly ProcedureFeeScheduleItem[];
}): FeeImportPreview {
  const parsed = parseFeeCsv(input.csvText);
  assertMapping(input.mapping, parsed.headers);
  if (!input.mapping.display) {
    throw new ProcedureFeeImportInputError("A display column mapping is required before building review.");
  }
  const blankDisplayRows = parsed.rows.flatMap((row, index) =>
    normalizeDisplay(row[input.mapping.display!]) ? [] : [index + 2]
  );
  if (blankDisplayRows.length) {
    throw new ProcedureFeeImportInputError(
      `A display value is required at CSV row${blankDisplayRows.length === 1 ? "" : "s"} ${blankDisplayRows.join(", ")}.`,
    );
  }

  const existingByKey = new Map(input.existing.map((item) => [item.procedureConceptKey, item]));
  const activeColumnAvailable = parsed.headers.some(isActiveHeader);
  let proposals = parsed.rows.map((row, index) => buildProposal({
    row,
    sourceRow: index + 2,
    mapping: input.mapping,
    existingByKey,
    activeColumnUnmapped: activeColumnAvailable && !input.mapping.active,
  }));
  proposals = collapseLateralityRows(proposals);
  proposals = collapseDuplicateRows(proposals);
  markConceptKeyConflicts(proposals);

  const publicProposals = proposals.map(({ displayMeaning: _displayMeaning, hadLaterality: _hadLaterality, ...proposal }) => ({
    ...proposal,
    proposalId: proposalId(proposal.sourceRows),
  }));
  return {
    proposals: publicProposals,
    matchOptions: input.existing.map((item) => ({
      procedureConceptKey: item.procedureConceptKey,
      display: item.display,
      category: item.category,
      seeded: isSeededProcedureFeeConceptKey(item.procedureConceptKey),
    })),
    counts: {
      create: publicProposals.filter((row) => row.decision === "create").length,
      match: publicProposals.filter((row) => row.decision === "match").length,
      skip: publicProposals.filter((row) => row.decision === "skip").length,
      flagged: publicProposals.filter((row) => row.flags.length > 0).length,
    },
  };
}

export async function commitProcedureFeeImport(
  fhir: ProcedureFeeScheduleFhir,
  proposals: readonly unknown[],
): Promise<FeeImportCommitResult> {
  const outcomes: FeeImportCommitOutcome[] = [];
  const createdKeys = new Set<string>();
  for (const raw of proposals) {
    const parsed = commitProposalSchema.safeParse(raw);
    if (!parsed.success) {
      outcomes.push({
        proposalId: safeProposalId(raw),
        status: "failed",
        message: parsed.error.issues[0]?.message ?? "Reviewed fee row is invalid.",
      });
      continue;
    }
    const proposal = parsed.data;
    if (proposal.decision === "skip" || proposal.routing === "scheduling-only") {
      outcomes.push({
        proposalId: proposal.proposalId,
        status: "skipped",
        message: proposal.routing === "scheduling-only"
          ? "Scheduling-only rows create no fee definition."
          : "Skipped by operator review.",
      });
      continue;
    }
    try {
      if (!proposal.routing) throw new ProcedureFeeImportInputError("Routing is required before commit.");
      const snapshot = await listProcedureFeeScheduleSnapshot(fhir);
      const target = resolveCommitTarget(proposal, snapshot);
      if (target) {
        if (proposal.decision === "create" && createdKeys.has(target.procedureConceptKey)) {
          throw new ProcedureFeeImportInputError(
            "A create row conflicts with a concept created earlier in this batch; review an explicit match target.",
          );
        }
        const seeded = isSeededProcedureFeeConceptKey(target.procedureConceptKey);
        if (!seeded) assertEditableIdentity(proposal);
        const item = await saveProcedureFeeScheduleItem(fhir, {
          procedureConceptKey: target.procedureConceptKey,
          ...(!seeded ? { display: proposal.display, category: proposal.category } : {}),
          billingCode: proposal.billingCode ?? null,
          modifier: proposal.modifier ?? null,
          priceCents: proposal.priceCents ?? null,
          routing: proposal.routing,
          active: proposal.active,
        });
        outcomes.push({
          proposalId: proposal.proposalId,
          status: "matched",
          procedureConceptKey: item.procedureConceptKey,
          message: "Matched and saved to the existing fee concept.",
        });
      } else {
        assertEditableIdentity(proposal);
        const item = await createProcedureFeeScheduleItem(fhir, {
          display: proposal.display,
          category: proposal.category,
          billingCode: proposal.billingCode ?? null,
          modifier: proposal.modifier ?? null,
          priceCents: proposal.priceCents ?? null,
          routing: proposal.routing,
          active: proposal.active,
        });
        outcomes.push({
          proposalId: proposal.proposalId,
          status: "created",
          procedureConceptKey: item.procedureConceptKey,
          message: "Created a new fee concept.",
        });
        createdKeys.add(item.procedureConceptKey);
      }
    } catch (error) {
      outcomes.push({
        proposalId: proposal.proposalId,
        status: "failed",
        message: safeCommitMessage(error),
      });
    }
  }
  return {
    outcomes,
    counts: {
      created: outcomes.filter((outcome) => outcome.status === "created").length,
      matched: outcomes.filter((outcome) => outcome.status === "matched").length,
      skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
      failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    },
  };
}

function resolveCommitTarget(
  proposal: z.infer<typeof commitProposalSchema>,
  snapshot: readonly ProcedureFeeScheduleItem[],
): ProcedureFeeScheduleItem | undefined {
  if (proposal.decision === "match") {
    if (!proposal.matchProcedureConceptKey) {
      throw new ProcedureFeeImportInputError("A match target is required before commit.");
    }
    const target = snapshot.find((item) =>
      item.procedureConceptKey === proposal.matchProcedureConceptKey
    );
    if (!target) throw new ProcedureFeeImportInputError("The reviewed match target no longer exists.");
    return target;
  }
  const display = proposal.display.trim();
  if (!display) throw new ProcedureFeeImportInputError("Display is required before commit.");
  const generatedKey = procedureConceptKeyFromDisplay(display);
  return snapshot.find((item) => item.procedureConceptKey === generatedKey);
}

function assertEditableIdentity(proposal: z.infer<typeof commitProposalSchema>): void {
  if (!proposal.display.trim()) throw new ProcedureFeeImportInputError("Display is required before commit.");
  procedureConceptKeyFromDisplay(proposal.display);
  if (!proposal.category) throw new ProcedureFeeImportInputError("Category is required before commit.");
}

function safeCommitMessage(error: unknown): string {
  if (error instanceof ProcedureFeeImportInputError ||
    error instanceof ProcedureFeeScheduleInputError ||
    error instanceof ProcedureFeeConceptConflictError) {
    return error.message;
  }
  if (error instanceof Error && /^(Modifier|Billing code|Procedure fee|Procedure display name)/.test(error.message)) {
    return error.message;
  }
  return "Fee schedule row could not be committed.";
}

function safeProposalId(raw: unknown): string {
  if (raw && typeof raw === "object" && "proposalId" in raw &&
    typeof raw.proposalId === "string" && raw.proposalId.length <= 200) {
    return raw.proposalId;
  }
  return "invalid-proposal";
}

function parseFeeCsv(csvText: string): ParsedFeeCsv {
  let headers: string[] = [];
  try {
    const rows = parse(csvText, {
      bom: true,
      columns: (incoming: string[]) => {
        headers = incoming.map((header) => header.trim());
        assertUniqueNonblankHeaders(headers);
        return headers;
      },
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    if (headers.length === 0 || rows.length === 0) {
      throw new ProcedureFeeImportInputError("CSV must contain a header and at least one data row.");
    }
    return { headers, rows };
  } catch (error) {
    if (error instanceof ProcedureFeeImportInputError) throw error;
    throw new ProcedureFeeImportInputError(
      "CSV could not be parsed with strict quoting and column counts.",
    );
  }
}

function assertUniqueNonblankHeaders(headers: readonly string[]): void {
  const seen = new Set<string>();
  for (const header of headers) {
    if (!header) throw new ProcedureFeeImportInputError("CSV headers must not be blank.");
    const identity = normalizeHeader(header);
    if (seen.has(identity)) throw new ProcedureFeeImportInputError("Duplicate CSV header names are not allowed.");
    seen.add(identity);
  }
}

function suggestMapping(headers: readonly string[]): FeeImportColumnMapping {
  const mapping: FeeImportColumnMapping = {};
  const used = new Set<string>();
  for (const field of Object.keys(HEADER_ALIASES) as Array<keyof FeeImportColumnMapping>) {
    const ranked = headers
      .filter((header) => !used.has(header))
      .map((header) => ({ header, score: headerScore(header, HEADER_ALIASES[field]) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || headers.indexOf(left.header) - headers.indexOf(right.header));
    if (ranked[0]) {
      mapping[field] = ranked[0].header;
      used.add(ranked[0].header);
    }
  }
  return mapping;
}

function headerScore(header: string, aliases: readonly string[]): number {
  const normalized = normalizeHeader(header);
  const words = new Set(normalized.split(" "));
  return Math.max(0, ...aliases.map((alias) => {
    if (normalized === alias) return 100 + alias.length;
    if (normalized.includes(alias)) return 60 + alias.length;
    const aliasWords = alias.split(" ");
    return aliasWords.every((word) => words.has(word)) ? 40 + alias.length : 0;
  }));
}

function normalizeHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isActiveHeader(header: string): boolean {
  const normalized = normalizeHeader(header);
  return normalized.split(" ").some((word) => word === "active" || word === "status") ||
    normalized === "state" || normalized.startsWith("state ");
}

function assertMapping(mapping: FeeImportColumnMapping, headers: readonly string[]): void {
  const actual = new Set(headers);
  for (const [field, header] of Object.entries(mapping)) {
    if (header !== undefined && !actual.has(header)) {
      throw new ProcedureFeeImportInputError(`The ${field} mapping must name an actual CSV header.`);
    }
  }
}

function buildProposal(input: {
  row: Record<string, string>;
  sourceRow: number;
  mapping: FeeImportColumnMapping;
  existingByKey: ReadonlyMap<string, ProcedureFeeScheduleItem>;
  activeColumnUnmapped: boolean;
}): WorkingProposal {
  const display = normalizeDisplay(mapped(input.row, input.mapping.display));
  const rawCode = mapped(input.row, input.mapping.billingCode).trim();
  const compound = normalizeCompoundCode(rawCode);
  const mappedModifier = mapped(input.row, input.mapping.modifier).trim().toUpperCase();
  const modifierLaterality = fixedLaterality(mappedModifier);
  const hadLaterality = compound.laterality !== undefined || modifierLaterality !== undefined;
  const modifier = modifierLaterality ? undefined : mappedModifier || undefined;
  const price = parsePrice(mapped(input.row, input.mapping.price), input.mapping.price !== undefined);
  const category = parseCategory(mapped(input.row, input.mapping.category));
  const routing = parseRouting(mapped(input.row, input.mapping.routing));
  const activeCheck = input.mapping.active
    ? parseBoolean(mapped(input.row, input.mapping.active))
    : { value: true, invalid: false };
  const zeroCheck = input.mapping.zeroPrice
    ? parseBoolean(mapped(input.row, input.mapping.zeroPrice))
    : { value: undefined, invalid: false };
  const key = procedureConceptKeyFromDisplay(display);
  const match = input.existingByKey.get(key);
  const matchSeeded = match ? isSeededProcedureFeeConceptKey(key) : false;
  const flags: FeeImportFlag[] = [];
  const reasons: string[] = [];

  if (hadLaterality) {
    addFlag(flags, "laterality-dropped", compound.laterality === "50"
      ? "Final .50 was treated as a laterality heuristic and dropped; side comes from the charge. Review before commit."
      : "Laterality was dropped; side comes from the charge.");
  }
  if (input.activeColumnUnmapped) {
    addFlag(flags, "active-column-unmapped", "An active or status column exists but is not mapped; active must be reviewed.");
  }
  if (activeCheck.invalid || zeroCheck.invalid) {
    addFlag(flags, "invalid-source-boolean", "A mapped active or zero-price value was not recognized.");
  }
  if (price.invalid) addFlag(flags, "invalid-price", "Price must be a nonnegative whole number of cents.");
  if (activeCheck.value === true && declaresInvalidCode(display)) {
    addFlag(flags, "invalid-active-code-name", "The source says active while the display declares an invalid code or service.");
  }
  if (zeroCheck.value === true && price.cents !== undefined && price.cents !== 0) {
    addFlag(flags, "zero-price-contradiction", "The zero-price indicator conflicts with a nonzero price.");
  }
  if (/\b(obsolete|superseded)\b/i.test(display)) {
    addFlag(flags, "obsolete-or-superseded", "The display declares this row obsolete or superseded.");
  }
  let decision: FeeImportDecision = match ? "match" : "create";
  if (routing === "scheduling-only") {
    decision = "skip";
    reasons.push("Scheduling-only rows create no fee definition.");
  } else if (/\brgp\b.*\bbifocal\b|\bbifocal\b.*\brgp\b/i.test(display)) {
    decision = "skip";
    reasons.push("RGP bifocal tier excluded by the migration ruling.");
  }
  if (!category && !matchSeeded && decision !== "skip") {
    addFlag(flags, "category-required", "Category is required for create and practice-created match rows.");
  }
  if (!routing && decision !== "skip") {
    addFlag(flags, "routing-required", "Routing must be reviewed before commit.");
  }

  return {
    proposalId: proposalId([input.sourceRow]),
    sourceRows: [input.sourceRow],
    ...(rawCode ? { originalCode: rawCode } : {}),
    decision,
    ...(match ? { matchProcedureConceptKey: key, matchSeeded } : {}),
    display: matchSeeded ? match!.display : display,
    ...(matchSeeded && match?.category ? { category: match.category } : category ? { category } : {}),
    ...(compound.billingCode ? { billingCode: compound.billingCode } : {}),
    ...(modifier ? { modifier } : {}),
    ...(price.cents !== undefined ? { priceCents: price.cents } : {}),
    ...(routing ? { routing } : {}),
    active: activeCheck.value ?? true,
    flags,
    reasons,
    displayMeaning: displayMeaning(display),
    hadLaterality,
  };
}

function normalizeCompoundCode(value: string): { billingCode?: string; laterality?: "RT" | "LT" | "50" } {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return {};
  const fixed = normalized.match(/^(.*)\.(RT|LT|50)$/);
  if (fixed?.[1] && fixed[2]) return { billingCode: fixed[1], laterality: fixed[2] as "RT" | "LT" | "50" };
  const tier = normalized.match(/^(.*)\.([0-9]+)$/);
  return tier?.[1] ? { billingCode: tier[1] } : { billingCode: normalized };
}

function fixedLaterality(value: string): "RT" | "LT" | "50" | undefined {
  return value === "RT" || value === "LT" || value === "50" ? value : undefined;
}

function parsePrice(value: string, mappedColumn: boolean): { cents?: number; invalid: boolean } {
  const raw = value.trim();
  if (!mappedColumn || !raw) return { invalid: false };
  const parenthesized = /^\(.*\)$/.test(raw);
  const normalized = raw.replace(/[,$\s]/g, "").replace(/^\((.*)\)$/, "$1");
  if (parenthesized || !/^\+?\d+(?:\.\d+)?$/.test(normalized)) return { invalid: true };
  const amount = Number(normalized);
  const scaled = amount * 100;
  const cents = Math.round(scaled);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 0.000001) {
    return { invalid: true };
  }
  return { cents, invalid: false };
}

function parseCategory(value: string): ProcedureFeeCategory | undefined {
  const normalized = normalizeHeader(value);
  const aliases: Record<ProcedureFeeCategory, readonly string[]> = {
    exam: ["exam", "examination", "visit"],
    refraction: ["refraction", "refractive"],
    "cl-fitting": ["cl fitting", "contact lens fitting", "contact lens"],
    procedure: ["procedure", "testing", "test", "treatment"],
  };
  return PROCEDURE_FEE_CATEGORIES.find((category) =>
    aliases[category].includes(normalized)
  );
}

function parseRouting(value: string): FeeImportRouting | undefined {
  const normalized = normalizeHeader(value);
  if (["insurance", "insured", "insurance billable", "billable"].includes(normalized)) {
    return "insurance-billable";
  }
  if (["self pay", "selfpay", "cash", "patient pay"].includes(normalized)) return "self-pay";
  if (["scheduling", "scheduling only", "schedule only", "appointment"].includes(normalized)) {
    return "scheduling-only";
  }
  return undefined;
}

function parseBoolean(value: string): { value?: boolean; invalid: boolean } {
  const normalized = normalizeHeader(value);
  if (["true", "yes", "y", "1", "active"].includes(normalized)) return { value: true, invalid: false };
  if (["false", "no", "n", "0", "inactive", "retired"].includes(normalized)) return { value: false, invalid: false };
  return normalized ? { invalid: true } : { invalid: false };
}

function declaresInvalidCode(display: string): boolean {
  return /\binvalid\b.*\b(code|service|procedure)\b|\b(code|service|procedure)\b.*\binvalid\b/i.test(display);
}

function collapseLateralityRows(proposals: WorkingProposal[]): WorkingProposal[] {
  return collapseRows(proposals, (proposal) => proposal.hadLaterality
    ? [proposal.billingCode, proposal.displayMeaning, proposal.category, proposal.priceCents,
      proposal.routing, proposal.active, proposal.modifier].join("|")
    : undefined, "laterality");
}

function collapseDuplicateRows(proposals: WorkingProposal[]): WorkingProposal[] {
  return collapseRows(proposals, (proposal) => [proposal.billingCode, proposal.displayMeaning,
    proposal.priceCents, proposal.modifier].join("|"), "duplicate");
}

function collapseRows(
  proposals: WorkingProposal[],
  identity: (proposal: WorkingProposal) => string | undefined,
  kind: "laterality" | "duplicate",
): WorkingProposal[] {
  const byIdentity = new Map<string, WorkingProposal>();
  const output: WorkingProposal[] = [];
  for (const proposal of proposals) {
    const key = identity(proposal);
    const existing = key ? byIdentity.get(key) : undefined;
    if (!key || !existing) {
      output.push(proposal);
      if (key) byIdentity.set(key, proposal);
      continue;
    }
    existing.sourceRows = [...new Set([...existing.sourceRows, ...proposal.sourceRows])].sort((a, b) => a - b);
    existing.flags = mergeFlags(existing.flags, proposal.flags);
    existing.reasons = [...new Set([...existing.reasons, ...proposal.reasons])];
    if (kind === "laterality") {
      existing.reasons.push("Laterality rows collapsed; side comes from the charge.");
    } else {
      existing.reasons.push("Duplicate source row collapsed after normalized display, code, and price matched.");
    }
  }
  return output;
}

function markConceptKeyConflicts(proposals: WorkingProposal[]): void {
  const byKey = new Map<string, WorkingProposal[]>();
  for (const proposal of proposals) {
    if (proposal.decision === "skip") continue;
    const key = procedureConceptKeyFromDisplay(proposal.display);
    byKey.set(key, [...(byKey.get(key) ?? []), proposal]);
  }
  for (const rows of byKey.values()) {
    if (rows.length < 2) continue;
    for (const row of rows) {
      addFlag(row.flags, "concept-key-conflict", "Multiple non-collapsible proposals generate the same concept key.");
    }
  }
}

function mergeFlags(left: FeeImportFlag[], right: FeeImportFlag[]): FeeImportFlag[] {
  const byClass = new Map<FeeImportFlagClass, FeeImportFlag>();
  for (const flag of [...left, ...right]) byClass.set(flag.class, flag);
  return [...byClass.values()];
}

function addFlag(flags: FeeImportFlag[], flagClass: FeeImportFlagClass, message: string): void {
  if (!flags.some((flag) => flag.class === flagClass)) flags.push({ class: flagClass, message });
}

function mapped(row: Record<string, string>, header: string | undefined): string {
  return header ? row[header] ?? "" : "";
}

function normalizeDisplay(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function displayMeaning(value: string): string {
  return procedureConceptKeyFromDisplay(value.replace(/(?:\s+|[-–—])(RT|LT|50|right|left|bilateral)$/i, ""));
}

function proposalId(sourceRows: readonly number[]): string {
  return `fee-import-row-${sourceRows.join("-")}`;
}
