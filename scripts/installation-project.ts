import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type InstallationProjectSource =
  | "--project"
  | "installation-state"
  | "MEDPLUM_PROJECT_ID"
  | "authenticated-session";

export interface InstallationProjectTarget {
  readonly projectId: string;
  readonly source: InstallationProjectSource;
  readonly statePath: string;
}

export function resolveInstallationProject(input: {
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  readonly requireExplicitProject?: boolean;
} = {}): InstallationProjectTarget {
  const target = resolveConfiguredInstallationProject(input);
  if (target) return target;
  const env = input.env ?? process.env;
  const statePath = installationStatePath(env, input.workingDirectory ?? process.cwd());
  throw new Error(
    `No Medplum project is configured. Run setup to create ${statePath}; MEDPLUM_PROJECT_ID is required `
    + "when installation state is absent, "
    + "or use --project <project-id> for intentional foreign-project work.",
  );
}

export function resolveConfiguredInstallationProject(input: {
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  readonly requireExplicitProject?: boolean;
} = {}): InstallationProjectTarget | undefined {
  const args = input.args ?? [];
  const env = input.env ?? process.env;
  const workingDirectory = input.workingDirectory ?? process.cwd();
  const statePath = installationStatePath(env, workingDirectory);
  const explicitProjectId = argumentValue(args, "--project")?.trim();
  const acknowledgedForeignProject = args.includes("--allow-foreign-project");
  const manifestExists = existsSync(statePath);
  const manifestProjectId = readJsonProjectId(statePath, ["projectId"]);
  const environmentProjectId = env.MEDPLUM_PROJECT_ID?.trim();

  if (acknowledgedForeignProject && !explicitProjectId) {
    throw new Error("--allow-foreign-project requires an explicit --project <project-id>.");
  }
  if (manifestExists && !manifestProjectId) {
    throw new Error(`Installation manifest ${statePath} does not contain a projectId; refusing to use another source.`);
  }
  if (input.requireExplicitProject && !explicitProjectId) {
    throw new Error(
      "This break-glass operation requires explicit --project <project-id>; installation state and MEDPLUM_PROJECT_ID are not accepted.",
    );
  }
  if (manifestProjectId && environmentProjectId && manifestProjectId !== environmentProjectId && !acknowledgedForeignProject) {
    throw new Error(
      `Project source conflict: installation-state is Project/${manifestProjectId}, `
      + `but MEDPLUM_PROJECT_ID is Project/${environmentProjectId}. Correct the stale source or use `
      + "an explicit --project <project-id> --allow-foreign-project for intentional foreign-project work.",
    );
  }
  if (explicitProjectId && manifestProjectId && explicitProjectId !== manifestProjectId && !acknowledgedForeignProject) {
    throw new Error(
      `Explicit Project/${explicitProjectId} differs from installation-state Project/${manifestProjectId}. `
      + "Intentional foreign-project work requires --allow-foreign-project.",
    );
  }
  if (explicitProjectId && environmentProjectId && explicitProjectId !== environmentProjectId && !acknowledgedForeignProject) {
    throw new Error(
      `Explicit Project/${explicitProjectId} differs from MEDPLUM_PROJECT_ID Project/${environmentProjectId}. `
      + "Intentional foreign-project work requires --allow-foreign-project.",
    );
  }

  const projectId = explicitProjectId || manifestProjectId || environmentProjectId;
  if (!projectId) return undefined;
  const source: InstallationProjectSource = explicitProjectId
    ? "--project"
    : manifestProjectId
      ? "installation-state"
      : "MEDPLUM_PROJECT_ID";
  if (!acknowledgedForeignProject) {
    assertDerivedProjectState(projectId, statePath);
  }
  return { projectId, source, statePath };
}

export function formatInstallationProjectTarget(target: Pick<InstallationProjectTarget, "projectId" | "source">): string {
  const source = target.source === "authenticated-session"
    ? "authenticated-session (resolved post-auth)"
    : target.source;
  return `Target: Project/${target.projectId} (source: ${source})`;
}

export function assertObservedProjectMatchesTarget(
  targetProjectId: string,
  observedProjectId: string,
  observedLabel: string,
): void {
  if (observedProjectId !== targetProjectId) {
    throw new Error(
      `${observedLabel} is Project/${observedProjectId}, but the configured target is Project/${targetProjectId}; refusing cross-project operation.`,
    );
  }
}

function installationStatePath(env: NodeJS.ProcessEnv, workingDirectory: string): string {
  if (env.ODOS_SETUP_STATE_PATH?.trim()) return resolve(env.ODOS_SETUP_STATE_PATH.trim());
  const localPath = resolve(workingDirectory, ".odos-setup-state.json");
  if (existsSync(localPath) || basename(workingDirectory) !== "mcp") return localPath;
  return resolve(workingDirectory, "..", ".odos-setup-state.json");
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function readJsonProjectId(path: string, keys: readonly string[]): string | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read installation project state ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function assertDerivedProjectState(projectId: string, statePath: string): void {
  const root = dirname(statePath);
  const derived: Array<{ label: string; path: string; projectId?: string }> = [
    {
      label: "operator credentials",
      path: join(root, ".odos", "operator.env"),
      projectId: readEnvProjectId(join(root, ".odos", "operator.env"), "ODOS_OPERATOR_PROJECT_ID"),
    },
    {
      label: "operator identity state",
      path: join(root, ".odos", "operator-identity.json"),
      projectId: readJsonProjectId(join(root, ".odos", "operator-identity.json"), ["projectId"]),
    },
    {
      label: "migration state",
      path: join(root, ".odos", "migration-importer-state.json"),
      projectId: readJsonProjectId(join(root, ".odos", "migration-importer-state.json"), ["practiceProjectId", "projectId"]),
    },
    {
      label: "migration credentials",
      path: join(root, ".odos", "migration-importer.env"),
      projectId: readEnvProjectId(join(root, ".odos", "migration-importer.env"), "ODOS_PRACTICE_PROJECT_ID"),
    },
  ];
  for (const item of derived) {
    if (item.projectId && item.projectId !== projectId) {
      throw new Error(
        `${item.label} at ${item.path} names Project/${item.projectId}, `
        + `but the configured installation target is Project/${projectId}. Invalidate or recreate stale derived state before continuing.`,
      );
    }
  }
}

function readEnvProjectId(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${key}=`));
  const value = line?.slice(key.length + 1).trim();
  return value || undefined;
}
