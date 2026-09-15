#!/usr/bin/env tsx
// South Carolina seed, both primary sources accessed 2026-09-15 and agreeing on 18:
// S.C. Code §15-1-320(a): https://www.scstatehouse.gov/code/t15c001.php
// S.C. Const. art. XVII §14: https://www.scstatehouse.gov/scconstitution/A17.pdf
import { pathToFileURL } from "node:url";
import type { Basic } from "@medplum/fhirtypes";
import { createOperatorScriptFhirClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { buildAgeOfMajorityConfigResource, ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM, ODOS_AGE_OF_MAJORITY_CONFIG_CODE, resolveAgeOfMajorityYears } from "../mcp/src/clinic/age-of-majority-config.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

export async function seedAgeOfMajority(fhir: Pick<MedplumClient, "search" | "create">, options: { projectId: string; apply?: boolean }) {
  if (!options.projectId.trim()) throw new Error("A named project id is required.");
  const code = `${ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM}|${ODOS_AGE_OF_MAJORITY_CONFIG_CODE}`;
  const existing = await searchAll<Basic>(fhir, "Basic", { code, _project: options.projectId });
  if (existing.length > 1) throw new Error("Multiple age-of-majority singletons; resolve before seeding.");
  if (existing[0]) {
    resolveAgeOfMajorityYears(existing[0]);
    return { mode: options.apply ? "apply" : "dry-run", action: "unchanged", projectId: options.projectId };
  }
  if (options.apply) {
    const basic = buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 });
    basic.meta = { project: options.projectId };
    await fhir.create(basic, { "If-None-Exist": new URLSearchParams({ code }).toString() });
  }
  return { mode: options.apply ? "apply" : "dry-run", action: options.apply ? "seeded" : "would-seed", projectId: options.projectId };
}

async function runCli() {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf("--project");
  const projectId = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
  if (!projectId || args.some((arg, index) => arg !== "--apply" && index !== projectIndex && index !== projectIndex + 1)) throw new Error("Usage: tsx scripts/seed-age-of-majority.ts --project PROJECT_ID [--apply]");
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  assertLocalMedplumBaseUrl(baseUrl);
  if (!process.env.MEDPLUM_ACCESS_TOKEN) throw new Error("MEDPLUM_ACCESS_TOKEN is required for the named project.");
  const me = await fetch(`${baseUrl.replace(/\/$/, "")}/auth/me`, { headers: { Authorization: `Bearer ${process.env.MEDPLUM_ACCESS_TOKEN}` } });
  if (!me.ok || (await me.json() as { project?: { id?: string } }).project?.id !== projectId) throw new Error("Token active project does not match --project.");
  const fhir = createOperatorScriptFhirClient({ baseUrl, accessToken: process.env.MEDPLUM_ACCESS_TOKEN, reason: "Operator age-of-majority seed for a named project." });
  console.log(JSON.stringify(await seedAgeOfMajority(fhir, { projectId, apply: args.includes("--apply") }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Seed failed"); process.exitCode = 1; });
}
