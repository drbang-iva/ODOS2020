import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CodeSystem, Resource, StructureDefinition, ValueSet } from "@medplum/fhirtypes";
import { createMedplumClient } from "../mcp/src/fhir-client.js";

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

type CanonicalResource = StructureDefinition | CodeSystem | ValueSet;

async function installCanonicalResource(resource: CanonicalResource, file: string): Promise<void> {
  if (!isSupportedCanonicalResource(resource) || !resource.url) {
    throw new Error(
      `${file} is not a supported canonical resource with a canonical url.`,
    );
  }

  const existingBundle = await fhir.search<CanonicalResource>(resource.resourceType, {
    url: resource.url,
    _count: "1",
  });
  const existing = existingBundle.entry?.[0]?.resource;

  if (existing?.id) {
    if (sameSemanticResource(existing, resource)) {
      console.log(`unchanged ${resource.url} (${existing.id})`);
      return;
    }

    const updated = await fhir.update<CanonicalResource>(
      resource.resourceType,
      existing.id,
      { ...resource, id: existing.id },
    );
    console.log(`updated ${updated.url} (${updated.id})`);
    return;
  }

  const created = await fhir.create<CanonicalResource>(resource);
  console.log(`created ${created.url} (${created.id})`);
}

function isSupportedCanonicalResource(resource: Resource): resource is CanonicalResource {
  return (
    resource.resourceType === "StructureDefinition" ||
    resource.resourceType === "CodeSystem" ||
    resource.resourceType === "ValueSet"
  );
}

function sameSemanticResource(left: CanonicalResource, right: CanonicalResource): boolean {
  return stableStringify(stripServerFields(left)) === stableStringify(stripServerFields(right));
}

function stripServerFields(resource: CanonicalResource): unknown {
  const clone = structuredClone(resource) as Partial<CanonicalResource>;
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
