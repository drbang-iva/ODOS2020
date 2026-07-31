#!/usr/bin/env tsx
import { resolve } from "node:path";
import {
  generateVisitImportManifests,
  resolveSetupStatePath,
} from "./legacy-import-manifest-generator.js";

export function parseVisitManifestGeneratorArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): {
  readonly appointmentsExportPath: string;
  readonly examsTsvPath: string;
  readonly patientReferencesPath: string;
  readonly visitTypeMapPath: string;
  readonly setupStatePath: string;
  readonly outputDirectory: string;
} {
  return {
    appointmentsExportPath: resolve(requiredArgument(args, "--appointments")),
    examsTsvPath: resolve(requiredArgument(args, "--exams")),
    patientReferencesPath: resolve(requiredArgument(args, "--patient-references")),
    visitTypeMapPath: resolve(requiredArgument(args, "--visit-type-map")),
    setupStatePath: resolveSetupStatePath(
      optionalArgument(args, "--setup-state"),
      environment,
    ),
    outputDirectory: resolve(requiredArgument(args, "--output")),
  };
}

function requiredArgument(args: readonly string[], name: string): string {
  const value = optionalArgument(args, name);
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function optionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = generateVisitImportManifests(
      parseVisitManifestGeneratorArguments(process.argv.slice(2)),
    );
    console.log(
      `Generated ${result.charts.length} visit manifests, appointment slices, and exam slices; `
      + `source appointments=${result.sourceAppointmentRows}, `
      + `target appointments=${result.targetAppointmentRows}, target exams=${result.targetExamRows}.`,
    );
    console.log(`Mapped target appt_type values: ${result.visitTypes.join(", ") || "(none)"}.`);
    console.log(
      `npm run import-legacy-bulk-m2b2 -- --bulk-manifest ${result.bulkManifestPath}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
