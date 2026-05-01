#!/usr/bin/env tsx
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);

if (args[0] === "certs" && args[1] === "generate") {
  const out = valueAfter("--out");
  const purpose = valueAfter("--purpose") ?? "general";
  const force = args.includes("--force");
  if (!out) {
    fail("Usage: osod certs generate --purpose smart-signing --out <private-key.pem> [--force]");
  }
  const path = resolve(out);
  if (existsSync(path) && !force) {
    fail(`Refusing to overwrite existing key: ${path}`);
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`Generated ${purpose} private key at ${path}`);
  process.exit(0);
}

fail("Usage: osod certs generate --purpose smart-signing --out <private-key.pem> [--force]");

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
