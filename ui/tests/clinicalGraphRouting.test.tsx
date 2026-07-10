import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const UI_ROOT = join(process.cwd(), "src");

test("Vite proxies relative clinical-graph requests to the MCP server", () => {
  const config = readFileSync(join(process.cwd(), "vite.config.ts"), "utf8");
  assert.match(config, /"\/clinical-graph": \{ target: "http:\/\/localhost:3333", changeOrigin: true \}/);
});

test("every clinicalGraphApiBase helper uses Vite's literal MCP environment access", () => {
  const sources = sourceFiles(UI_ROOT)
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter(({ source }) => source.includes("function clinicalGraphApiBase"));

  assert.equal(sources.length, 13);
  for (const { path, source } of sources) {
    const helper = source.match(/function clinicalGraphApiBase\(\): string \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(helper, /import\.meta\.env\.VITE_OSOD_MCP_BASE_URL/, path);
    assert.doesNotMatch(helper, /const meta = import\.meta|VITE_MCP_URL/, path);
  }
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
