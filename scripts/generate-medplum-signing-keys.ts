#!/usr/bin/env tsx
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const force = process.argv.includes("--force");
const targets = [
  resolve(".odos/medplum-signing.env"),
  resolve(".odos/medplum-dr-drill-signing.env"),
];

for (const target of targets) {
  if (existsSync(target) && !force) {
    throw new Error(`${target} already exists. Use --force only for an intentional key rotation.`);
  }
}

for (const target of targets) {
  const passphrase = randomUUID();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase,
    },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(
    target,
    [
      `MEDPLUM_SIGNING_KEY_ID=odos-${randomUUID()}`,
      `MEDPLUM_SIGNING_KEY='${privateKey.trimEnd()}'`,
      `MEDPLUM_SIGNING_KEY_PASSPHRASE=${passphrase}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(target, 0o600);
}

console.log("Generated independent Medplum signing keys for the main and DR-drill stacks in .odos/.");
