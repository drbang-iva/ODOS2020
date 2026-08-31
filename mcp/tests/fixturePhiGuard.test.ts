import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FIXTURES_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SYNTHETIC_NAMES = new Set(["ALEX", "EXAM", "EXAMPLEV"]);
const SYNTHETIC_TEN_DIGIT_VALUES = new Set(["0123456789", "1999999984"]);
const ENTITY_IDENTIFIER_LABELS = new Set([
  "Information Receiver",
  "Information Source",
  "Insured or Subscriber",
  "Other Payer",
  "Patient",
  "Payer",
  "Primary Care Provider",
  "Provider",
  "Subscriber",
]);

function fixtureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? fixtureFiles(path) : [path];
  });
}

function inspectX12(value: string, path: string, violations: string[]): void {
  for (const [segmentIndex, segment] of value.split("~").entries()) {
    const elements = segment.trim().split("*");
    const segmentPath = `${path}.segment[${segmentIndex}]`;
    if (elements[0] === "NM1") {
      for (const index of [3, 4]) {
        if (elements[index] && !SYNTHETIC_NAMES.has(elements[index]!)) {
          violations.push(`${segmentPath}.NM1[${index}]: non-synthetic name`);
        }
      }
    }
    if (elements[0] === "N3") {
      for (let index = 1; index < elements.length; index += 1) {
        if (elements[index] && elements[index] !== "EXAMPLEV") {
          violations.push(`${segmentPath}.N3[${index}]: non-synthetic address`);
        }
      }
    }
    if (elements[0] === "N4") {
      const expected = ["EXAMPLEV", "XX", "00000"];
      for (let index = 1; index <= 3; index += 1) {
        if (elements[index] && elements[index] !== expected[index - 1]) {
          violations.push(`${segmentPath}.N4[${index}]: non-synthetic address`);
        }
      }
    }
    if (elements[0] === "DMG" && elements[2] && elements[2] !== "19700101") {
      violations.push(`${segmentPath}.DMG[2]: non-synthetic birth date`);
    }
  }
}

function inspectJson(value: unknown, path: string, violations: string[], parentKey?: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectJson(entry, `${path}[${index}]`, violations, parentKey));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (typeof entry === "string") {
      if (key !== "name" && key.endsWith("Name") && !SYNTHETIC_NAMES.has(entry)) {
        violations.push(`${entryPath}: non-synthetic name`);
      }
      if (key === "entityIdentifier" && !ENTITY_IDENTIFIER_LABELS.has(entry) && !SYNTHETIC_NAMES.has(entry)) {
        violations.push(`${entryPath}: non-synthetic entity identifier`);
      }
      if (/^(?:subscriber)?memberId$/i.test(key) && entry !== "0123456789") {
        violations.push(`${entryPath}: non-synthetic member identifier`);
      }
      if (/^(?:dateOfBirth|birthDate|dob)$/i.test(key) && entry !== "19700101") {
        violations.push(`${entryPath}: non-synthetic birth date`);
      }
      if (/^address\d*$/i.test(key) && entry !== "EXAMPLEV") {
        violations.push(`${entryPath}: non-synthetic street address`);
      }
      if (parentKey === "address") {
        const expected = key === "postalCode" ? "00000" : key === "state" ? "XX" : "EXAMPLEV";
        if (entry !== expected) {
          violations.push(`${entryPath}: non-synthetic address component`);
        }
      }
      if (key === "x12") {
        inspectX12(entry, entryPath, violations);
      }
    }
    inspectJson(entry, entryPath, violations, key);
  }
}

function inspectTextNameAssignments(text: string, path: string, violations: string[]): void {
  for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9]*Name)\s*:\s*["'`]([^"'`\r\n]+)["'`]/g)) {
    const [, key, value] = match;
    if (key !== "name" && !SYNTHETIC_NAMES.has(value!)) {
      violations.push(`${path}@${match.index}: non-synthetic ${key}`);
    }
  }
}

test("fixture files contain only allowlisted synthetic identity values", () => {
  const violations: string[] = [];
  for (const file of fixtureFiles(FIXTURES_DIRECTORY)) {
    const fixturePath = relative(FIXTURES_DIRECTORY, file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?<!\d)\d{10}(?!\d)/g)) {
      if (!SYNTHETIC_TEN_DIGIT_VALUES.has(match[0])) {
        violations.push(`${fixturePath}@${match.index}: non-synthetic 10-digit value`);
      }
    }
    if (extname(file) === ".json") {
      inspectJson(JSON.parse(text), fixturePath, violations);
    } else {
      inspectTextNameAssignments(text, fixturePath, violations);
    }
  }
  assert.deepEqual(violations, []);
});
