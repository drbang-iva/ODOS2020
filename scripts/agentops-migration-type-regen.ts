#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const mcpRoot = resolve(repoRoot, "mcp");
const viteCache = resolve(repoRoot, "node_modules/.vite");

run("npm", ["--prefix", "mcp", "run", "build"]);
if (existsSync(viteCache)) {
  rmSync(viteCache, { recursive: true, force: true });
}
assertNoAgentOpsVerdictLegacyString();
console.log("AgentOps migration type-regeneration chain completed.");

function run(command: string, args: readonly string[]): void {
  execFileSync(command, [...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function assertNoAgentOpsVerdictLegacyString(): void {
  let output = "";
  try {
    output = execFileSync("rg", ["verdict.*rejected|'rejected'|\"rejected\"", "src/agentops"], {
      cwd: mcpRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return;
    }
    throw error;
  }
  if (output.trim()) {
    throw new Error("AgentOps verdict code paths must normalize legacy denial language to verdict=blocked.");
  }
}
