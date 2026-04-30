import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyBackupDestination } from "../../scripts/verify-backup-destination.ts";

test("v0.5d backup destination helper verifies writability, free space, and advisory encryption signal", () => {
  const dir = mkdtempSync(join(tmpdir(), "osod-backup-destination-"));
  try {
    const report = verifyBackupDestination({
      destination: dir,
      platform: "linux",
      footprintBytes: 1,
      commandRunner(command) {
        if (command === "findmnt") {
          return "/dev/mapper/osod-backup\n";
        }
        if (command === "cryptsetup") {
          return "/dev/mapper/osod-backup is active.\n";
        }
        return "";
      },
    });

    assert.equal(report.writable, true);
    assert.equal(report.encryption.status, "likely-encrypted");
    assert.equal(report.warnings.some((warning) => /not writable/i.test(warning)), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
