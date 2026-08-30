import { randomUUID } from "node:crypto";
import type {
  Bundle,
  Claim,
  Communication,
  Extension,
  Provenance,
} from "@medplum/fhirtypes";
import type { OdosActorRole } from "../authz/odosAudit.js";

export const CLAIM_TOUCH_ACTION_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/claim-touch-action";
export const CLAIM_TOUCH_COUNT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/claim-touch-count";
export const CLAIM_LAST_TOUCHED_AT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/claim-last-touched-at";
export const CLAIM_LAST_TOUCHED_BY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/claim-last-touched-by";
export const CLAIM_REASON_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/claim-follow-up-reason";
export const CLAIM_REASON_RESOLUTION_PATH_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/claim-reason-resolution-path";

export const CLAIM_TOUCH_ACTIONS = [
  "note",
  "resubmission",
  "contact",
  "status-reason",
  "resolution",
] as const;

export type ClaimTouchAction = (typeof CLAIM_TOUCH_ACTIONS)[number];

export interface ClaimTouchPrincipal {
  kind: "human" | "system";
  actorReference: string;
  actorRole: OdosActorRole;
}

export interface ClaimReason {
  system: string;
  code: string;
  display: string;
  resolutionPath: string;
}

export interface ClaimTouchState {
  touchCount: number;
  lastTouchedAt?: string;
  lastTouchedBy?: string;
}

export interface ClaimReasonState {
  code: string | null;
  display: string | null;
  resolutionPath: string | null;
}

export interface ClaimWorkFacts {
  daysSinceBilled: number;
  agingBucket: string;
  touchCount: number;
  lastTouchedAt: string | null;
  lastTouchedBy: string | null;
  daysSinceTouched: number | null;
  untouchedRankingDays: number;
}

export class ClaimTouchPrincipalError extends Error {
  constructor() {
    super("Only an authenticated human practice principal may touch a claim.");
    this.name = "ClaimTouchPrincipalError";
  }
}

export function buildClaimTouchTransaction(input: {
  claim: Claim;
  principal: ClaimTouchPrincipal;
  action: ClaimTouchAction;
  at: string;
  detail?: string;
  reason?: ClaimReason;
}): Bundle {
  assertHumanPrincipal(input.principal);
  if (!input.claim.id) throw new Error("A persisted Claim id is required to record a touch.");
  assertDateTime(input.at, "Touch timestamp");
  if ((input.action === "note" || input.action === "contact") && !input.detail?.trim()) {
    throw new Error(`${input.action === "note" ? "Note" : "Contact"} detail is required.`);
  }
  if ((input.action === "status-reason" || input.action === "resolution") && !input.reason) {
    throw new Error(`${input.action} requires a typed claim reason.`);
  }

  const prior = claimTouchState(input.claim);
  const updatedClaim: Claim = {
    ...input.claim,
    extension: [
      ...(input.claim.extension ?? []).filter((extension) => !CLAIM_TOUCH_EXTENSION_URLS.has(extension.url)),
      { url: CLAIM_TOUCH_COUNT_EXTENSION_URL, valueUnsignedInt: prior.touchCount + 1 },
      { url: CLAIM_LAST_TOUCHED_AT_EXTENSION_URL, valueDateTime: input.at },
      { url: CLAIM_LAST_TOUCHED_BY_EXTENSION_URL, valueReference: { reference: input.principal.actorReference } },
      ...(input.reason ? reasonExtensions(input.reason) : currentReasonExtensions(input.claim.extension)),
    ],
  };
  const communication = communicationForTouch(input, updatedClaim);
  const communicationFullUrl = communication ? `urn:uuid:${randomUUID()}` : undefined;
  const provenance: Provenance = {
    resourceType: "Provenance",
    target: [{ reference: `Claim/${input.claim.id}` }],
    recorded: input.at,
    activity: {
      coding: [{
        system: CLAIM_TOUCH_ACTION_SYSTEM,
        code: input.action,
        display: touchActionDisplay(input.action),
      }],
    },
    agent: [{
      type: { text: input.principal.actorRole },
      who: { reference: input.principal.actorReference },
    }],
    ...(communicationFullUrl ? {
      entity: [{ role: "source", what: { reference: communicationFullUrl } }],
    } : {}),
  };

  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: updatedClaim,
        request: {
          method: "PUT",
          url: `Claim/${input.claim.id}`,
          ...(input.claim.meta?.versionId ? { ifMatch: `W/\"${input.claim.meta.versionId}\"` } : {}),
        },
      },
      ...(communication && communicationFullUrl ? [{
        fullUrl: communicationFullUrl,
        resource: communication,
        request: { method: "POST" as const, url: "Communication" },
      }] : []),
      {
        fullUrl: `urn:uuid:${randomUUID()}`,
        resource: provenance,
        request: { method: "POST", url: "Provenance" },
      },
    ],
  };
}

export function claimTouchState(claim: Claim): ClaimTouchState {
  const touchCount = extensionInteger(claim.extension, CLAIM_TOUCH_COUNT_EXTENSION_URL) ?? 0;
  const lastTouchedAt = extensionDateTime(claim.extension, CLAIM_LAST_TOUCHED_AT_EXTENSION_URL);
  const lastTouchedBy = extensionReference(claim.extension, CLAIM_LAST_TOUCHED_BY_EXTENSION_URL);
  if (!Number.isInteger(touchCount) || touchCount < 0) {
    throw new Error("Claim touch count must be a nonnegative whole number.");
  }
  if (touchCount === 0 && (lastTouchedAt || lastTouchedBy)) {
    throw new Error("A never-touched Claim cannot carry last-touch facts.");
  }
  if (touchCount > 0 && (!lastTouchedAt || !lastTouchedBy)) {
    throw new Error("A touched Claim requires both lastTouchedAt and lastTouchedBy.");
  }
  return {
    touchCount,
    ...(lastTouchedAt ? { lastTouchedAt } : {}),
    ...(lastTouchedBy ? { lastTouchedBy } : {}),
  };
}

export function claimReasonState(claim: Claim): ClaimReasonState {
  const concept = claim.extension?.find((extension) => extension.url === CLAIM_REASON_EXTENSION_URL)?.valueCodeableConcept;
  const coding = concept?.coding?.find((candidate) => candidate.code);
  return {
    code: coding?.code ?? null,
    display: coding?.display ?? concept?.text ?? null,
    resolutionPath: claim.extension?.find(
      (extension) => extension.url === CLAIM_REASON_RESOLUTION_PATH_EXTENSION_URL,
    )?.valueString ?? null,
  };
}

export function projectClaimWorkFacts(input: {
  billedAt: string;
  status: string;
  touchCount: number;
  lastTouchedAt?: string;
  lastTouchedBy?: string;
  at: string;
  thresholds: readonly [number, number, number];
}): ClaimWorkFacts {
  assertThresholds(input.thresholds);
  const daysSinceBilled = elapsedDays(input.billedAt, input.at);
  if (!Number.isInteger(input.touchCount) || input.touchCount < 0) {
    throw new Error("Claim touch count must be a nonnegative whole number.");
  }
  if (input.touchCount === 0 && (input.lastTouchedAt || input.lastTouchedBy)) {
    throw new Error("A never-touched Claim cannot carry last-touch facts.");
  }
  if (input.touchCount > 0 && (!input.lastTouchedAt || !input.lastTouchedBy)) {
    throw new Error("A touched Claim requires both lastTouchedAt and lastTouchedBy.");
  }
  const [first, second, third] = input.thresholds;
  return {
    daysSinceBilled,
    agingBucket: daysSinceBilled >= third
      ? `${third}+`
      : daysSinceBilled >= second
        ? `${second}-${third - 1}`
        : daysSinceBilled >= first ? `${first}-${second - 1}` : "current",
    touchCount: input.touchCount,
    lastTouchedAt: input.lastTouchedAt ?? null,
    lastTouchedBy: input.lastTouchedBy ?? null,
    daysSinceTouched: input.lastTouchedAt ? elapsedDays(input.lastTouchedAt, input.at) : null,
    untouchedRankingDays: input.touchCount === 0 ? daysSinceBilled : 0,
  };
}

function assertHumanPrincipal(principal: ClaimTouchPrincipal): void {
  if (
    principal.kind !== "human"
    || principal.actorRole === "system"
    || principal.actorRole === "autonomous-agent"
    || !/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(principal.actorReference)
  ) {
    throw new ClaimTouchPrincipalError();
  }
}

function communicationForTouch(
  input: Parameters<typeof buildClaimTouchTransaction>[0],
  claim: Claim,
): Communication | undefined {
  if (input.action !== "note" && input.action !== "contact") return undefined;
  return {
    resourceType: "Communication",
    status: "completed",
    category: [{ coding: [{ system: CLAIM_TOUCH_ACTION_SYSTEM, code: input.action }] }],
    subject: claim.patient,
    about: [{ reference: `Claim/${claim.id}` }],
    sent: input.at,
    sender: { reference: input.principal.actorReference },
    payload: [{ contentString: input.detail!.trim() }],
  };
}

function reasonExtensions(reason: ClaimReason): Extension[] {
  for (const [label, value] of [
    ["Reason system", reason.system],
    ["Reason code", reason.code],
    ["Reason display", reason.display],
    ["Resolution path", reason.resolutionPath],
  ] as const) {
    if (!value.trim()) throw new Error(`${label} is required.`);
  }
  return [
    {
      url: CLAIM_REASON_EXTENSION_URL,
      valueCodeableConcept: {
        coding: [{ system: reason.system, code: reason.code, display: reason.display }],
        text: reason.display,
      },
    },
    { url: CLAIM_REASON_RESOLUTION_PATH_EXTENSION_URL, valueString: reason.resolutionPath },
  ];
}

function currentReasonExtensions(extensions: readonly Extension[] | undefined): Extension[] {
  return (extensions ?? []).filter((extension) =>
    extension.url === CLAIM_REASON_EXTENSION_URL
    || extension.url === CLAIM_REASON_RESOLUTION_PATH_EXTENSION_URL
  );
}

function extensionInteger(extensions: readonly Extension[] | undefined, url: string): number | undefined {
  return extensions?.find((extension) => extension.url === url)?.valueUnsignedInt;
}

function extensionDateTime(extensions: readonly Extension[] | undefined, url: string): string | undefined {
  return extensions?.find((extension) => extension.url === url)?.valueDateTime;
}

function extensionReference(extensions: readonly Extension[] | undefined, url: string): string | undefined {
  return extensions?.find((extension) => extension.url === url)?.valueReference?.reference;
}

function elapsedDays(from: string, to: string): number {
  assertDateTime(from, "Date");
  assertDateTime(to, "Comparison date");
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000));
}

function assertDateTime(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid date-time.`);
}

function assertThresholds(thresholds: readonly [number, number, number]): void {
  if (
    thresholds.some((threshold) => !Number.isInteger(threshold) || threshold <= 0)
    || !(thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2])
  ) {
    throw new Error("Claim aging thresholds must be three ascending positive whole days.");
  }
}

function touchActionDisplay(action: ClaimTouchAction): string {
  if (action === "note") return "Claim note logged";
  if (action === "resubmission") return "Claim resubmitted";
  if (action === "contact") return "Claim contact logged";
  if (action === "status-reason") return "Claim status changed with typed reason";
  return "Claim hold or denial resolved";
}

const CLAIM_TOUCH_EXTENSION_URLS = new Set([
  CLAIM_TOUCH_COUNT_EXTENSION_URL,
  CLAIM_LAST_TOUCHED_AT_EXTENSION_URL,
  CLAIM_LAST_TOUCHED_BY_EXTENSION_URL,
  CLAIM_REASON_EXTENSION_URL,
  CLAIM_REASON_RESOLUTION_PATH_EXTENSION_URL,
]);
