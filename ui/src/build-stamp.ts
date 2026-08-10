export interface BuildStampVersion {
  sha: string;
  shortSha: string;
  branch: string;
  builtAt: string;
}

export interface DeployedVersion {
  sha: string;
  shortSha: string;
  checkedAt: string;
}

export interface BuildClassification {
  state: "current" | "stale" | "unknown";
  signal: "deployed-sha" | "build-age" | "unknown-sha";
}

const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const SHORT_SHA = /^[0-9a-f]{7,8}$/i;

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function parseDeployedVersion(value: unknown): DeployedVersion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sha !== "string" ||
    typeof candidate.shortSha !== "string" ||
    !FULL_SHA.test(candidate.sha) ||
    !SHORT_SHA.test(candidate.shortSha) ||
    !candidate.sha.toLowerCase().startsWith(candidate.shortSha.toLowerCase()) ||
    !isIsoDate(candidate.checkedAt)
  ) {
    return undefined;
  }

  return {
    sha: candidate.sha,
    shortSha: candidate.shortSha,
    checkedAt: candidate.checkedAt,
  };
}

export function classifyBuild(
  built: BuildStampVersion,
  deployed: DeployedVersion | undefined,
  now = new Date(),
  staleAfterMs = STALE_AFTER_MS,
): BuildClassification {
  if (built.sha === "unknown") return { state: "unknown", signal: "unknown-sha" };
  if (deployed) {
    return {
      state: deployed.sha.toLowerCase() === built.sha.toLowerCase() ? "current" : "stale",
      signal: "deployed-sha",
    };
  }

  return {
    state: now.getTime() - Date.parse(built.builtAt) > staleAfterMs ? "stale" : "current",
    signal: "build-age",
  };
}

export function relativeBuildTime(builtAt: string, now = new Date()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(builtAt)) / 1000));
  if (elapsedSeconds < 60) return "just now";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  return `${Math.floor(elapsedSeconds / 86400)}d ago`;
}

async function readDeployedVersion(fetcher: typeof fetch): Promise<DeployedVersion | undefined> {
  try {
    const response = await fetcher("/deployed.json", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return undefined;
    return parseDeployedVersion(await response.json());
  } catch {
    return undefined;
  }
}

export async function enhanceBuildStamp(
  root = document.getElementById("odos-build-stamp"),
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<void> {
  if (!root) return;

  const built: BuildStampVersion = {
    sha: root.dataset.buildSha || "unknown",
    shortSha: root.querySelector("code")?.textContent || "unknown",
    branch: "unknown",
    builtAt: root.dataset.builtAt || "",
  };
  const classification = classifyBuild(built, await readDeployedVersion(fetcher), now);
  const time = root.querySelector("time");
  const status = root.querySelector<HTMLElement>("[data-build-status]");

  if (time) time.textContent = relativeBuildTime(built.builtAt, now);
  root.className = `odos-build-stamp is-${classification.state}`;
  root.dataset.buildSignal = classification.signal;
  if (status) {
    status.hidden = false;
    status.textContent = classification.state.toUpperCase();
    status.title = `Build status from ${classification.signal}`;
  }
}
