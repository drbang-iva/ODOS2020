import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CodeSystem,
  ConceptMap,
  DeviceDefinition,
  Resource,
  SearchParameter,
  StructureDefinition,
  Substance,
  ValueSet,
} from "@medplum/fhirtypes";
import { createMedplumClient } from "../mcp/src/fhir-client.js";
import {
  OSOD_DEVICE_DEFINITION_IDENTIFIER_SYSTEM,
  OSOD_SUBSTANCE_IDENTIFIER_SYSTEM,
  buildConceptMap,
  buildV04CanonicalResources,
  buildV04DeviceDefinitionSeeds,
  buildV04SubstanceSeeds,
  type ConceptMapMappingInput,
} from "../mcp/src/fhir/contactLens.js";

loadRepoEnv();

const BASE_URL = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const EMAIL = process.env.MEDPLUM_ADMIN_EMAIL;
const PASSWORD = process.env.MEDPLUM_ADMIN_PASSWORD;
const ACCESS_TOKEN = process.env.MEDPLUM_ACCESS_TOKEN;

if (!ACCESS_TOKEN && (!EMAIL || !PASSWORD)) {
  throw new Error("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required when MEDPLUM_ACCESS_TOKEN is not set.");
}

const fhir = createMedplumClient({ baseUrl: BASE_URL, accessToken: ACCESS_TOKEN });

if (!ACCESS_TOKEN) {
  await fhir.login(EMAIL!, PASSWORD!);
}

const profilesDir = resolve(process.cwd(), "data/profiles");
const profileFiles = (await readdir(profilesDir))
  .filter((name) => name.endsWith(".json"))
  .sort();

for (const file of profileFiles) {
  await installCanonicalResource(
    JSON.parse(await readFile(resolve(profilesDir, file), "utf8")) as CanonicalResource,
    file,
  );
}

for (const resource of buildV04CanonicalResources()) {
  await installCanonicalResource(resource, resource.url ?? resource.name ?? resource.resourceType);
}

const terminologyDir = resolve(process.cwd(), "data/terminology");
if (existsSync(terminologyDir)) {
  const terminologyFiles = (await readdir(terminologyDir))
    .filter((name) => name.endsWith(".json"))
    .sort();

  for (const file of terminologyFiles) {
    await installCanonicalResource(
      JSON.parse(await readFile(resolve(terminologyDir, file), "utf8")) as CanonicalResource,
      file,
    );
  }
}

const labMappingsDir = resolve(process.cwd(), "data/contact-lens-lab-mappings");
if (existsSync(labMappingsDir)) {
  const labMappingFiles = (await readdir(labMappingsDir))
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();

  for (const file of labMappingFiles) {
    const mapping = parseLabMappingYaml(
      await readFile(resolve(labMappingsDir, file), "utf8"),
      file,
    );
    await installCanonicalResource(buildConceptMap(mapping), file);
  }
}

for (const resource of buildV04DeviceDefinitionSeeds()) {
  await installIdentifiedResource(
    resource,
    OSOD_DEVICE_DEFINITION_IDENTIFIER_SYSTEM,
    resource.identifier?.[0]?.value,
  );
}

for (const resource of buildV04SubstanceSeeds()) {
  await installIdentifiedResource(
    resource,
    OSOD_SUBSTANCE_IDENTIFIER_SYSTEM,
    resource.identifier?.[0]?.value,
  );
}

type CanonicalResource =
  | StructureDefinition
  | CodeSystem
  | ValueSet
  | ConceptMap
  | SearchParameter;

type IdentifiedSeedResource = DeviceDefinition | Substance;

async function installCanonicalResource(resource: CanonicalResource, file: string): Promise<void> {
  if (!isSupportedCanonicalResource(resource) || !resource.url) {
    throw new Error(
      `${file} is not a supported canonical resource with a canonical url.`,
    );
  }
  const installResource = await hydrateStructureDefinitionSnapshot(resource);

  const existingBundle = await fhir.search<CanonicalResource>(installResource.resourceType, {
    url: installResource.url,
    _count: "1",
  });
  const existing = existingBundle.entry?.[0]?.resource;

  if (existing?.id) {
    if (sameSemanticResource(existing, installResource)) {
      console.log(`unchanged ${installResource.url} (${existing.id})`);
      return;
    }

    const updated = await fhir.update<CanonicalResource>(
      installResource.resourceType,
      existing.id,
      { ...installResource, id: existing.id },
    );
    console.log(`updated ${updated.url} (${updated.id})`);
    return;
  }

  const created = await fhir.create<CanonicalResource>(installResource);
  console.log(`created ${created.url} (${created.id})`);
}

async function hydrateStructureDefinitionSnapshot<T extends CanonicalResource>(
  resource: T,
): Promise<T> {
  if (resource.resourceType !== "StructureDefinition") {
    return resource;
  }

  const baseDefinition =
    resource.baseDefinition?.startsWith("https://osod.dev/fhir/StructureDefinition/")
      ? `http://hl7.org/fhir/StructureDefinition/${resource.type}`
      : resource.baseDefinition;
  if (!baseDefinition) {
    return resource;
  }

  const baseBundle = await fhir.search<StructureDefinition>("StructureDefinition", {
    url: baseDefinition,
    _count: "1",
  });
  const base = baseBundle.entry?.[0]?.resource;
  if (!base?.snapshot?.element?.length) {
    return resource;
  }

  return {
    ...resource,
    snapshot: structuredClone(base.snapshot),
  };
}

function isSupportedCanonicalResource(resource: Resource): resource is CanonicalResource {
  return (
    resource.resourceType === "StructureDefinition" ||
    resource.resourceType === "CodeSystem" ||
    resource.resourceType === "ValueSet" ||
    resource.resourceType === "ConceptMap" ||
    resource.resourceType === "SearchParameter"
  );
}

async function installIdentifiedResource(
  resource: IdentifiedSeedResource,
  identifierSystem: string,
  identifierValue: string | undefined,
): Promise<void> {
  if (!identifierValue) {
    throw new Error(`${resource.resourceType} seed is missing ${identifierSystem} identifier.`);
  }

  const existingBundle = await fhir.search<IdentifiedSeedResource>(resource.resourceType, {
    identifier: `${identifierSystem}|${identifierValue}`,
    _count: "1",
  });
  const existing = existingBundle.entry?.[0]?.resource;

  if (existing?.id) {
    if (sameSemanticResource(existing, resource)) {
      console.log(`unchanged ${resource.resourceType}/${identifierValue} (${existing.id})`);
      return;
    }

    const updated = await fhir.update<IdentifiedSeedResource>(
      resource.resourceType,
      existing.id,
      { ...resource, id: existing.id },
    );
    console.log(`updated ${updated.resourceType}/${identifierValue} (${updated.id})`);
    return;
  }

  const created = await fhir.create<IdentifiedSeedResource>(resource);
  console.log(`created ${created.resourceType}/${identifierValue} (${created.id})`);
}

function sameSemanticResource(left: Resource, right: Resource): boolean {
  return stableStringify(stripServerFields(left)) === stableStringify(stripServerFields(right));
}

function stripServerFields(resource: Resource): unknown {
  const clone = structuredClone(resource) as Partial<Resource>;
  delete clone.id;
  delete clone.meta;
  return clone;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function loadRepoEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }

    process.env[match[1]] = stripEnvQuotes(match[2].trim());
  }
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

interface LabMappingInput {
  labCode: string;
  labDisplay: string;
  targetUri: string;
  organizationReference?: string;
  mappings: ConceptMapMappingInput[];
}

function parseLabMappingYaml(text: string, file: string): LabMappingInput {
  const scalars: Record<string, string> = {};
  const mappings: ConceptMapMappingInput[] = [];
  let current: Record<string, string> | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) {
      continue;
    }
    if (withoutComment.trim() === "mappings:") {
      continue;
    }

    const itemMatch = /^  - ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(withoutComment);
    if (itemMatch) {
      current = {};
      mappings.push(current as unknown as ConceptMapMappingInput);
      current[itemMatch[1]] = unquoteYaml(itemMatch[2]);
      continue;
    }

    const nestedMatch = /^    ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(withoutComment);
    if (nestedMatch && current) {
      current[nestedMatch[1]] = unquoteYaml(nestedMatch[2]);
      continue;
    }

    const scalarMatch = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(withoutComment);
    if (scalarMatch) {
      scalars[scalarMatch[1]] = unquoteYaml(scalarMatch[2]);
      continue;
    }

    throw new Error(`${file}: unsupported YAML line: ${rawLine}`);
  }

  const labCode = scalars.lab_code;
  const labDisplay = scalars.lab_display;
  const targetUri = scalars.target_uri;
  if (!labCode || !labDisplay || !targetUri) {
    throw new Error(`${file}: lab_code, lab_display, and target_uri are required.`);
  }

  return {
    labCode,
    labDisplay,
    targetUri,
    organizationReference: scalars.organization_reference,
    mappings: mappings.map((mapping) => ({
      sourceCode: mapping.sourceCode ?? (mapping as Record<string, string>).source,
      sourceDisplay: mapping.sourceDisplay ?? (mapping as Record<string, string>).source_display,
      targetCode: mapping.targetCode ?? (mapping as Record<string, string>).target,
      targetDisplay: mapping.targetDisplay ?? (mapping as Record<string, string>).target_display,
      equivalence: mapping.equivalence,
    })),
  };
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
