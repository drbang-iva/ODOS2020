import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeForPublicEmission } from "../src/capability/capability-statement-synthesizer.js";

const PUBLIC_BASE_URL = "https://learn.example.com";

test("sanitizeForPublicEmission replaces internal scheme and authority while preserving the URL suffix", () => {
  const cases = [
    ["http://127.0.0.1:3333/authorize", "https://learn.example.com/authorize"],
    ["http://127.0.0.1:3333", "https://learn.example.com"],
    ["http://localhost:8104/token", "https://learn.example.com/token"],
    ["http://192.168.1.5:3333/.well-known/jwks.json", "https://learn.example.com/.well-known/jwks.json"],
    ["http://172.16.0.9:3333/metadata", "https://learn.example.com/metadata"],
    ["http://10.0.0.7:3333/metadata", "https://learn.example.com/metadata"],
    ["http://host.docker.internal:3333/token", "https://learn.example.com/token"],
    ["http://127.0.0.1:3333/authorize?aud=fhir#launch", "https://learn.example.com/authorize?aud=fhir#launch"],
  ] as const;

  for (const [value, expected] of cases) {
    assert.equal(sanitizeForPublicEmission(value, PUBLIC_BASE_URL), expected, value);
  }
});

test("sanitizeForPublicEmission appends the internal URL suffix after a public base path", () => {
  assert.equal(
    sanitizeForPublicEmission("http://127.0.0.1:3333/authorize", "https://example.com/odos"),
    "https://example.com/odos/authorize",
  );
});

test("sanitizeForPublicEmission leaves URLs already rooted at the public base unchanged", () => {
  assert.equal(
    sanitizeForPublicEmission("https://learn.example.com/authorize", PUBLIC_BASE_URL),
    "https://learn.example.com/authorize",
  );
});

test("sanitizeForPublicEmission preserves current non-URL redaction output", () => {
  const cases = [
    ["/var/lib/odos/cache", PUBLIC_BASE_URL],
    ["/etc/odos/config.json", PUBLIC_BASE_URL],
    ["/opt/odos/data/file", PUBLIC_BASE_URL],
    ["/home/odos/.config", PUBLIC_BASE_URL],
    ["postgres://user:pass@localhost:5432/db", PUBLIC_BASE_URL],
    ["postgresql://user:pass@db:5432/db", PUBLIC_BASE_URL],
    ["Device/agent-scribe.1", PUBLIC_BASE_URL],
    ["prefix /var/lib/odos/cache suffix", `prefix ${PUBLIC_BASE_URL} suffix`],
    ["prefix Device/agent-scribe.1 suffix", `prefix ${PUBLIC_BASE_URL} suffix`],
  ] as const;

  for (const [value, expected] of cases) {
    assert.equal(sanitizeForPublicEmission(value, PUBLIC_BASE_URL), expected, value);
  }
});
