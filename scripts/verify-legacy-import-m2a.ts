#!/usr/bin/env tsx
import type { Bundle, Patient } from "@medplum/fhirtypes";
import {
  cliArgument,
  ordinarySessionContext,
  referenceId,
  requireEnv,
} from "./legacy-import-m2a-cli.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export interface M2aReachabilityInput {
  readonly baseUrl: string;
  readonly clinicianToken: string;
  readonly frontDeskToken: string;
  readonly clinicianProfileReference: string;
  readonly frontDeskProfileReference: string;
  readonly patientReference: string;
  readonly encounterReference: string;
  readonly mediaReference: string;
  readonly coverageReference: string;
  readonly observationReference: string;
  readonly request?: typeof fetch;
}

export interface M2aReachabilityResult {
  readonly transcript: readonly string[];
}

export class ReachabilityVerificationError extends Error {
  constructor(
    message: string,
    readonly transcript: readonly string[],
  ) {
    super(message);
    this.name = "ReachabilityVerificationError";
  }
}

export async function verifyImporterProjectMembershipDenied(input: {
  readonly baseUrl: string;
  readonly importerToken: string;
  readonly request?: typeof fetch;
}): Promise<403> {
  assertLocalMedplumBaseUrl(input.baseUrl);
  const response = await (input.request ?? fetch)(
    `${input.baseUrl}/fhir/R4/ProjectMembership?_count=1`,
    {
      headers: { Authorization: `Bearer ${input.importerToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status !== 403) {
    throw new Error(
      `Importer ProjectMembership search returned ${response.status}; expected 403.`,
    );
  }
  return 403;
}

export async function verifyLegacyImportM2aReachability(
  input: M2aReachabilityInput,
): Promise<M2aReachabilityResult> {
  assertLocalMedplumBaseUrl(input.baseUrl);
  const request = input.request ?? fetch;
  const patientId = referenceId(input.patientReference, "Patient");
  const encounterId = referenceId(input.encounterReference, "Encounter");
  const mediaId = referenceId(input.mediaReference, "Media");
  const coverageId = referenceId(input.coverageReference, "Coverage");
  const observationId = referenceId(input.observationReference, "Observation");

  const clinician = await ordinarySessionContext(
    request,
    input.baseUrl,
    input.clinicianToken,
    "provider",
  );
  const frontDesk = await ordinarySessionContext(
    request,
    input.baseUrl,
    input.frontDeskToken,
    "staff",
  );
  if (clinician.projectId !== frontDesk.projectId) {
    throw new Error("Clinician and front-desk tokens must target the same practice project.");
  }
  if (!clinician.profileReference) {
    throw new Error("clinician token has no staff profile reference.");
  }
  if (!frontDesk.profileReference) {
    throw new Error("front-desk token has no staff profile reference.");
  }
  if (clinician.profileReference !== input.clinicianProfileReference) {
    throw new Error("Clinician token does not match the expected Practitioner profile.");
  }
  if (frontDesk.profileReference !== input.frontDeskProfileReference) {
    throw new Error("Front-desk token does not match the expected Practitioner profile.");
  }

  const transcript: string[] = [];
  await expectSearch(
    request,
    input.baseUrl,
    input.clinicianToken,
    patientId,
    "clinician patient_search",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Patient", patientId),
    input.clinicianToken,
    200,
    "clinician patient_read",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Encounter", encounterId),
    input.clinicianToken,
    200,
    "clinician encounter_read",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Media", mediaId),
    input.clinicianToken,
    200,
    "clinician media_read",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Observation", observationId),
    input.clinicianToken,
    200,
    "clinician observation_read",
    transcript,
  );

  await expectSearch(
    request,
    input.baseUrl,
    input.frontDeskToken,
    patientId,
    "front_desk patient_search",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Patient", patientId),
    input.frontDeskToken,
    200,
    "front_desk patient_read",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Coverage", coverageId),
    input.frontDeskToken,
    200,
    "front_desk coverage_read",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Encounter", encounterId),
    input.frontDeskToken,
    200,
    "front_desk encounter_read",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Media", mediaId),
    input.frontDeskToken,
    200,
    "front_desk media_read",
    transcript,
  );
  await expectStatus(
    request,
    resourceUrl(input.baseUrl, "Observation", observationId),
    input.frontDeskToken,
    200,
    "front_desk observation_read",
    transcript,
  );
  return { transcript };
}

async function expectSearch(
  request: typeof fetch,
  baseUrl: string,
  token: string,
  patientId: string,
  label: string,
  transcript: string[],
): Promise<void> {
  const response = await request(
    `${baseUrl}/fhir/R4/Patient?_id=${encodeURIComponent(patientId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/fhir+json",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  let matchCount = 0;
  if (response.status === 200) {
    const bundle = (await response.json()) as Bundle<Patient>;
    matchCount = (bundle.entry ?? []).filter(
      (entry) => entry.resource?.id === patientId,
    ).length;
  }
  transcript.push(`${label} status=${response.status} matches=${matchCount}`);
  if (response.status !== 200 || matchCount !== 1) {
    throw new ReachabilityVerificationError(
      `${label} expected status 200 with one exact Patient; `
      + `received ${response.status} with ${matchCount}.`,
      [...transcript],
    );
  }
}

async function expectStatus(
  request: typeof fetch,
  url: string,
  token: string,
  expected: number,
  label: string,
  transcript: string[],
): Promise<void> {
  const response = await request(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/fhir+json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  transcript.push(`${label} status=${response.status}`);
  if (response.status !== expected) {
    throw new ReachabilityVerificationError(
      `${label} expected ${expected}; received ${response.status}.`,
      [...transcript],
    );
  }
}

function resourceUrl(baseUrl: string, resourceType: string, id: string): string {
  return `${baseUrl}/fhir/R4/${resourceType}/${id}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2);
    const result = await verifyLegacyImportM2aReachability({
      baseUrl: (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      clinicianToken: requireEnv("ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN"),
      frontDeskToken: requireEnv("ODOS_ACCEPTANCE_FRONT_DESK_ACCESS_TOKEN"),
      clinicianProfileReference: cliArgument(args, "--clinician-profile"),
      frontDeskProfileReference: cliArgument(args, "--front-desk-profile"),
      patientReference: cliArgument(args, "--patient"),
      encounterReference: cliArgument(args, "--encounter"),
      mediaReference: cliArgument(args, "--media"),
      coverageReference: cliArgument(args, "--coverage"),
      observationReference: cliArgument(args, "--observation"),
    });
    console.log(result.transcript.join("\n"));
    console.log("LEGACY_IMPORT_M2A_REACHABILITY PASS");
  } catch (error) {
    if (error instanceof ReachabilityVerificationError && error.transcript.length > 0) {
      console.error(error.transcript.join("\n"));
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
