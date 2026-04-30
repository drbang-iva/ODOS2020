#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface BackupDestinationReport {
  readonly destination: string;
  readonly writable: boolean;
  readonly encryption: {
    readonly status: "likely-encrypted" | "unknown";
    readonly detail: string;
  };
  readonly footprintBytes: number;
  readonly availableBytes: number;
  readonly warnings: readonly string[];
}

export interface VerifyBackupDestinationOptions {
  readonly destination: string;
  readonly platform?: NodeJS.Platform;
  readonly footprintBytes?: number;
  readonly commandRunner?: (command: string, args: readonly string[]) => string;
}

export function verifyBackupDestination(
  options: VerifyBackupDestinationOptions,
): BackupDestinationReport {
  const destination = resolve(options.destination);
  const warnings: string[] = [];
  if (!existsSync(destination)) {
    mkdirSync(destination, { recursive: true });
  }

  const writable = checkWritable(destination, warnings);
  const availableBytes = statfsSync(destination).bavail * statfsSync(destination).bsize;
  const footprintBytes = options.footprintBytes ?? currentLocalFootprintBytes();
  if (footprintBytes > 0 && availableBytes < footprintBytes * 2) {
    warnings.push(
      `Backup destination has less than 2x the current local data footprint (${footprintBytes} bytes).`,
    );
  }
  if (footprintBytes === 0) {
    warnings.push("Current Postgres/Redis/Binary footprint could not be measured from local bind mounts.");
  }

  const encryption = detectEncryption({
    destination,
    platform: options.platform ?? process.platform,
    commandRunner: options.commandRunner ?? runCommand,
  });
  if (encryption.status === "unknown") {
    warnings.push(encryption.detail);
  }

  return {
    destination,
    writable,
    encryption,
    footprintBytes,
    availableBytes,
    warnings,
  };
}

function checkWritable(destination: string, warnings: string[]): boolean {
  const probe = resolve(destination, `.osod-backup-write-test-${Date.now()}`);
  try {
    writeFileSync(probe, "ok\n");
    rmSync(probe);
    return true;
  } catch (error) {
    warnings.push(`Backup destination is not writable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function currentLocalFootprintBytes(): number {
  return ["postgres-data", "binary", "backup-dr-drill"]
    .map((path) => pathSizeBytes(resolve(process.cwd(), path)))
    .reduce((sum, value) => sum + value, 0);
}

function pathSizeBytes(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  try {
    const output = execFileSync("du", ["-sk", path], { encoding: "utf8" });
    const kib = Number(output.trim().split(/\s+/)[0]);
    return Number.isFinite(kib) ? kib * 1024 : 0;
  } catch {
    return 0;
  }
}

function detectEncryption(input: {
  destination: string;
  platform: NodeJS.Platform;
  commandRunner: (command: string, args: readonly string[]) => string;
}): BackupDestinationReport["encryption"] {
  if (input.platform === "linux") {
    return detectLinuxEncryption(input.destination, input.commandRunner);
  }
  if (input.platform === "darwin") {
    return detectMacEncryption(input.commandRunner);
  }
  if (input.platform === "win32") {
    return detectWindowsEncryption(input.commandRunner);
  }
  return {
    status: "unknown",
    detail: `No at-rest encryption heuristic is implemented for platform ${input.platform}.`,
  };
}

function detectLinuxEncryption(
  destination: string,
  commandRunner: (command: string, args: readonly string[]) => string,
): BackupDestinationReport["encryption"] {
  try {
    const source = commandRunner("findmnt", ["-no", "SOURCE", "--target", destination]).trim();
    if (source.includes("/dev/mapper/")) {
      return { status: "likely-encrypted", detail: `${source} is a mapped device; verify LUKS policy locally.` };
    }
    const name = basename(source);
    const status = commandRunner("cryptsetup", ["status", name]);
    if (/is active/i.test(status)) {
      return { status: "likely-encrypted", detail: `cryptsetup reports ${name} is active.` };
    }
  } catch {
    /* fall through to warning */
  }
  return {
    status: "unknown",
    detail: "Could not confirm LUKS encryption for this Linux backup destination.",
  };
}

function detectMacEncryption(
  commandRunner: (command: string, args: readonly string[]) => string,
): BackupDestinationReport["encryption"] {
  try {
    const output = commandRunner("diskutil", ["apfs", "list"]);
    if (/(?:Encrypted|FileVault):\s+Yes/i.test(output)) {
      return { status: "likely-encrypted", detail: "diskutil reports an encrypted APFS/FileVault volume." };
    }
  } catch {
    /* fall through to warning */
  }
  return {
    status: "unknown",
    detail: "Could not confirm FileVault/APFS encryption for this macOS backup destination.",
  };
}

function detectWindowsEncryption(
  commandRunner: (command: string, args: readonly string[]) => string,
): BackupDestinationReport["encryption"] {
  try {
    const output = commandRunner("manage-bde", ["-status"]);
    if (/Protection Status:\s+Protection On/i.test(output) || /Conversion Status:\s+Fully Encrypted/i.test(output)) {
      return { status: "likely-encrypted", detail: "manage-bde reports BitLocker protection/encryption." };
    }
  } catch {
    /* fall through to warning */
  }
  return {
    status: "unknown",
    detail: "Could not confirm BitLocker encryption for this Windows backup destination.",
  };
}

function runCommand(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const destination = process.argv[2] ?? process.env.OSOD_BACKUP_DIR;
  if (!destination) {
    console.error("Usage: npm run verify-backup-destination -- /path/to/backup-destination");
    process.exitCode = 1;
  } else {
    const report = verifyBackupDestination({ destination });
    console.log(JSON.stringify(report, null, 2));
    if (!report.writable) {
      process.exitCode = 1;
    }
  }
}
