export function parseDiagnosisIdentifier(
  value: string | undefined,
  encounterId: string,
): { diagnosisKey?: string; laterality?: "OD" | "OS" | "OU" | "UNKNOWN" } {
  if (!value) return {};
  const parts = value.split("::");
  const laterality = diagnosisBucketLaterality(parts.at(-1));
  if (parts.length >= 3 && parts[0] === encounterId && laterality) {
    return { diagnosisKey: parts.slice(1, -1).join("::"), laterality };
  }
  if (parts.length >= 2 && laterality) {
    return { diagnosisKey: parts.slice(0, -1).join("::"), laterality };
  }
  return { diagnosisKey: value };
}

function diagnosisBucketLaterality(value: string | undefined): "OD" | "OS" | "OU" | "UNKNOWN" | undefined {
  if (value === "right") return "OD";
  if (value === "left") return "OS";
  if (value === "bilateral") return "OU";
  if (value === "unspecified" || value === "none") return "UNKNOWN";
  return undefined;
}
