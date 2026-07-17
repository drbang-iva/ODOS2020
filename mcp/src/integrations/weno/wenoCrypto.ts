import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

// The static zero IV is required by WENO's protocol, not an ODOS cryptographic design choice.
const WENO_IV = Buffer.alloc(16, 0);

export function encryptWenoPayload(payload: unknown, encryptionKey: string): string {
  const cipher = createCipheriv("aes-256-cbc", deriveKey(encryptionKey), WENO_IV);
  return Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

export function decryptWenoPayload(encrypted: string, encryptionKey: string): unknown {
  const decipher = createDecipheriv("aes-256-cbc", deriveKey(encryptionKey), WENO_IV);
  const decrypted = Buffer.concat([
    decipher.update(encrypted, "base64"),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(decrypted) as unknown;
}

function deriveKey(encryptionKey: string): Buffer {
  return createHash("sha256").update(encryptionKey, "utf8").digest();
}
