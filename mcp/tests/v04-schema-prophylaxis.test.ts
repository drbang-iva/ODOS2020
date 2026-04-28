import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("v0.4a code avoids known hallucinated FHIR paths", async () => {
  const repoRoot = resolve(process.cwd(), "..");
  const files = [
    ...(await sourceFiles(resolve(repoRoot, "mcp/src"))),
    ...(await sourceFiles(resolve(repoRoot, "ui/src"))),
  ];
  const badDeviceField = new RegExp(["Device", "parameter"].join("\\."));
  const badObservationLink = new RegExp(["derived", "From"].join("") + ".*" + "Device");

  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.equal(badDeviceField.test(text), false, `${file} contains an invalid Device field path.`);
    assert.equal(
      badObservationLink.test(text),
      false,
      `${file} contains an invalid source link target.`,
    );
  }
});

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}
