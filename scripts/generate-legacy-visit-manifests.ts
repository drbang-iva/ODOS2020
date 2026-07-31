#!/usr/bin/env tsx
import { resolve } from "node:path";
import {
  generateVisitImportManifests,
  isDirectExecution,
  parseGeneratorCliArguments,
  resolveSetupStatePath,
  shellArgument,
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
  const parsed = parseGeneratorCliArguments(args, {
    required: [
      "--appointments",
      "--exams",
      "--patient-references",
      "--visit-type-map",
      "--output",
    ],
    optional: ["--setup-state"],
  });
  return {
    appointmentsExportPath: resolve(parsed["--appointments"]!),
    examsTsvPath: resolve(parsed["--exams"]!),
    patientReferencesPath: resolve(parsed["--patient-references"]!),
    visitTypeMapPath: resolve(parsed["--visit-type-map"]!),
    setupStatePath: resolveSetupStatePath(
      parsed["--setup-state"],
      environment,
    ),
    outputDirectory: resolve(parsed["--output"]!),
  };
}

if (isDirectExecution(import.meta.url, process.argv[1]!)) {
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
      `npm run import-legacy-bulk-m2b2 -- --bulk-manifest ${
        shellArgument(result.bulkManifestPath)
      }`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
