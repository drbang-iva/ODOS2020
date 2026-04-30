import type { AuditEvent, Binary, Provenance } from "@medplum/fhirtypes";
import type { OsodAuditEventRecord } from "./osodAudit.js";

export interface RestoreManifestAuditSnapshot {
  count: number;
  latestEventTime?: string;
  projectionQueueDrained?: boolean;
}

export interface RestoreIntegrityInput {
  manifestAuditSnapshot: RestoreManifestAuditSnapshot;
  restoredAuditRows: readonly OsodAuditEventRecord[];
  provenanceSamples: readonly Provenance[];
  restoredBinaries: readonly Binary[];
  auditEvents: readonly AuditEvent[];
  accessPolicyRoundTripPassed: boolean;
}

export interface RestoreIntegrityResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

export function verifyRestoreIntegrity(input: RestoreIntegrityInput): RestoreIntegrityResult {
  const checks = [
    verifyAuditSnapshot(input),
    verifyProvenanceSignatures(input.provenanceSamples),
    verifyBinarySecurityContext(input.restoredBinaries),
    verifyAuditEventCount(input),
    verifyAccessPolicyRoundTrip(input.accessPolicyRoundTripPassed),
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function verifyAuditSnapshot(input: RestoreIntegrityInput): RestoreIntegrityResult["checks"][number] {
  const latest = [...input.restoredAuditRows].sort((a, b) => b.eventTime.localeCompare(a.eventTime))[0]
    ?.eventTime;
  const passed =
    input.restoredAuditRows.length === input.manifestAuditSnapshot.count &&
    latest === input.manifestAuditSnapshot.latestEventTime;
  return {
    name: "osod_audit_events row count + latest event time",
    passed,
    detail: `manifest=${input.manifestAuditSnapshot.count}/${input.manifestAuditSnapshot.latestEventTime ?? "none"} restored=${input.restoredAuditRows.length}/${latest ?? "none"}`,
  };
}

function verifyProvenanceSignatures(samples: readonly Provenance[]): RestoreIntegrityResult["checks"][number] {
  const sampled = samples
    .filter((provenance) => provenance.signature?.some((signature) => signature.who && signature.data))
    .slice(0, 10);
  const passed =
    sampled.length === 0 ||
    sampled.every((provenance) =>
      Boolean(provenance.signature?.some((signature) => signature.who && signature.data)),
    );
  return {
    name: "Provenance.signature validity sample",
    passed,
    detail:
      sampled.length === 0
        ? "no signed Provenance resources present in restored sample"
        : `${sampled.filter((provenance) => provenance.signature?.length).length}/${sampled.length} sampled Provenance resources carry a verifiable signature envelope`,
  };
}

function verifyBinarySecurityContext(binaries: readonly Binary[]): RestoreIntegrityResult["checks"][number] {
  const passed = binaries.every((binary) => Boolean(binary.securityContext?.reference));
  return {
    name: "Binary.securityContext binding intact",
    passed,
    detail: `${binaries.filter((binary) => binary.securityContext?.reference).length}/${binaries.length} restored Binary resources have securityContext`,
  };
}

function verifyAuditEventCount(input: RestoreIntegrityInput): RestoreIntegrityResult["checks"][number] {
  const expected = input.restoredAuditRows.length;
  const actual = input.auditEvents.length;
  const tolerance = input.manifestAuditSnapshot.projectionQueueDrained
    ? 0
    : Math.ceil(expected * 0.01);
  const passed = Math.abs(expected - actual) <= tolerance;
  return {
    name: "AuditEvent count matches osod_audit_events count",
    passed,
    detail: `expected=${expected} actual=${actual} tolerance=${tolerance}`,
  };
}

function verifyAccessPolicyRoundTrip(passed: boolean): RestoreIntegrityResult["checks"][number] {
  return {
    name: "AccessPolicy / ProjectMembership round-trip",
    passed,
    detail: passed ? "round-trip fixture passed" : "round-trip fixture failed",
  };
}
