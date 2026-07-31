#!/usr/bin/env tsx
import { resolve } from "node:path";
import {
  generatePatientImportManifests,
  isDirectExecution,
} from "./legacy-import-manifest-generator.js";

export function parsePatientManifestGeneratorArguments(args: readonly string[]): {
  readonly patientExportPath: string;
  readonly ehrPeoplePath: string;
  readonly outputDirectory: string;
} {
  return {
    patientExportPath: resolve(requiredArgument(args, "--patients")),
    ehrPeoplePath: resolve(requiredArgument(args, "--ehr-people")),
    outputDirectory: resolve(requiredArgument(args, "--output")),
  };
}

function requiredArgument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

if (isDirectExecution(import.meta.url, process.argv[1]!)) {
  try {
    const result = generatePatientImportManifests(
      parsePatientManifestGeneratorArguments(process.argv.slice(2)),
    );
    console.log(
      `Generated ${result.manifests.length} patient manifests with `
      + `${result.classifiedJunkRows} approved junk source rows.`,
    );
    for (const entry of result.manifests) {
      console.log(
        `npm run import-legacy-patient-m2a -- ${entry.importArguments.join(" ")}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
