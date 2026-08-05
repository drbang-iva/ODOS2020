#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const packageUrl = new URL("./package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));

if (typeof packageJson.main !== "string" || packageJson.main.length === 0) {
  throw new Error("odos-mcp package.json must declare a main entrypoint");
}

await import(new URL(packageJson.main, packageUrl).href);
