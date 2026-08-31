import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const educationItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["video", "handout", "report", "page"]),
  audience: z.enum(["patient", "internal"]),
  dxCodes: z.array(z.string().regex(/^[A-Z][0-9A-Z]{1,2}(?:\.[0-9A-Z]{1,4})?$/)),
  channels: z.array(z.enum(["sms", "email", "print"])).min(1),
  laneHint: z.enum(["clinical", "retail"]),
  consentClass: z.enum(["transactional", "marketing"]),
  urls: z.object({
    web: z.string().url().optional(),
    email: z.string().url().optional(),
    print: z.string().url().optional(),
  }).strict(),
}).strict();

const educationCatalogManifestSchema = z.object({
  status: z.literal("seed-placeholder-only"),
  placeholderUrlHost: z.literal("education.invalid"),
  notice: z.string().trim().min(1),
  items: z.array(educationItemSchema).min(1),
}).strict().superRefine((manifest, context) => {
  const versions = new Set<string>();
  for (const [index, item] of manifest.items.entries()) {
    const versionKey = `${item.id}@${item.version}`;
    if (versions.has(versionKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index],
        message: `Duplicate catalog item ${item.id} version ${item.version}.`,
      });
    }
    versions.add(versionKey);
    addDuplicateIssue(item.dxCodes, ["items", index, "dxCodes"], "diagnosis code", context);
    addDuplicateIssue(item.channels, ["items", index, "channels"], "channel", context);

    const requiredUrlByChannel = { sms: "web", email: "email", print: "print" } as const;
    for (const channel of item.channels) {
      const requiredUrl = requiredUrlByChannel[channel];
      if (!item.urls[requiredUrl]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "urls", requiredUrl],
          message: `${channel} channel requires a ${requiredUrl} URL.`,
        });
      }
    }
    for (const [format, url] of Object.entries(item.urls)) {
      if (url && (new URL(url).protocol !== "https:" || new URL(url).hostname !== manifest.placeholderUrlHost)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "urls", format],
          message: `Seed URL must use the intentional https://${manifest.placeholderUrlHost} placeholder host.`,
        });
      }
    }
  }
});

const ledgerSourceSchema = z.object({
  id: z.string().min(1),
  publisher: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  accessed: z.string().date(),
  authority: z.literal("primary"),
}).strict();

const educationCatalogLedgerSchema = z.object({
  ledger: z.literal("patient-education-catalog"),
  status: z.literal("verified"),
  mandate: z.literal(14),
  accessDate: z.string().date(),
  sources: z.array(ledgerSourceSchema).min(2),
  diagnosisCodes: z.array(z.object({
    code: z.string().regex(/^[A-Z][0-9A-Z]{1,2}(?:\.[0-9A-Z]{1,4})?$/),
    display: z.string().min(1),
    sourceRefs: z.array(z.string().min(1)).min(2),
  }).strict()),
}).strict().superRefine((ledger, context) => {
  addDuplicateIssue(ledger.sources.map(({ id }) => id), ["sources"], "source id", context);
  addDuplicateIssue(ledger.diagnosisCodes.map(({ code }) => code), ["diagnosisCodes"], "diagnosis code", context);
  const sourceIds = new Set(ledger.sources.map(({ id }) => id));
  for (const [index, diagnosis] of ledger.diagnosisCodes.entries()) {
    if (new Set(diagnosis.sourceRefs).size < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["diagnosisCodes", index, "sourceRefs"],
        message: `${diagnosis.code} must cite at least two distinct primary sources.`,
      });
    }
    for (const sourceRef of diagnosis.sourceRefs) {
      if (!sourceIds.has(sourceRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["diagnosisCodes", index, "sourceRefs"],
          message: `${diagnosis.code} cites unknown source ${sourceRef}.`,
        });
      }
    }
  }
});

export type EducationContentItem = z.infer<typeof educationItemSchema>;
export type EducationCatalogManifest = z.infer<typeof educationCatalogManifestSchema>;
export type EducationCatalogLedger = z.infer<typeof educationCatalogLedgerSchema>;

export interface EducationCatalogReader {
  list(): readonly EducationContentItem[];
  get(id: string, version?: number): EducationContentItem | undefined;
}

export function createManifestEducationCatalogReader(
  manifestInput: unknown,
  ledgerInput: unknown,
): EducationCatalogReader {
  const manifest = parseManifest(manifestInput);
  const ledger = parseLedger(ledgerInput);
  const verifiedCodes = new Set(ledger.diagnosisCodes.map(({ code }) => code));
  for (const item of manifest.items) {
    for (const code of item.dxCodes) {
      if (!verifiedCodes.has(code)) {
        throw new Error(`Education catalog diagnosis code ${code} is absent from the verified JSON ledger.`);
      }
    }
  }

  const items = structuredClone(manifest.items);
  const versions = new Map<string, Map<number, EducationContentItem>>();
  for (const item of items) {
    const itemVersions = versions.get(item.id) ?? new Map<number, EducationContentItem>();
    itemVersions.set(item.version, item);
    versions.set(item.id, itemVersions);
  }

  return {
    list: () => structuredClone(items),
    get(id, version) {
      const itemVersions = versions.get(id);
      if (!itemVersions) return undefined;
      const selectedVersion = version ?? Math.max(...itemVersions.keys());
      const item = itemVersions.get(selectedVersion);
      return item ? structuredClone(item) : undefined;
    },
  };
}

export function loadManifestEducationCatalogReader(
  manifestPath: string,
  ledgerPath: string,
): EducationCatalogReader {
  return createManifestEducationCatalogReader(readJson(manifestPath), readJson(ledgerPath));
}

export function loadDefaultEducationCatalogReader(): EducationCatalogReader {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const dataDirectories = [
    resolve(moduleDirectory, "../../../data"),
    resolve(moduleDirectory, "../../../../../data"),
  ];
  const dataDirectory = dataDirectories.find((candidate) =>
    existsSync(resolve(candidate, "education-catalog.json"))) ?? dataDirectories[0];
  return loadManifestEducationCatalogReader(
    resolve(dataDirectory, "education-catalog.json"),
    resolve(dataDirectory, "code-bindings/patient-education-catalog-ledger.json"),
  );
}

function parseManifest(input: unknown): EducationCatalogManifest {
  const parsed = educationCatalogManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Education catalog manifest is invalid: ${parsed.error.issues.map(({ message }) => message).join(" ")}`);
  }
  return parsed.data;
}

function parseLedger(input: unknown): EducationCatalogLedger {
  const parsed = educationCatalogLedgerSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Education catalog JSON ledger is invalid: ${parsed.error.issues.map(({ message }) => message).join(" ")}`);
  }
  return parsed.data;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read education catalog JSON file ${path}.`, { cause: error });
  }
}

function addDuplicateIssue(
  values: readonly string[],
  path: Array<string | number>,
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message: `Duplicate ${label} ${value}.` });
    }
    seen.add(value);
  }
}
