import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  findShippedCptLiterals,
  scanShippedCptLiterals,
  type ShippedCptAllowance,
} from "../../scripts/shipped-cpt-guard.js";

const FIVE_DIGIT_MUTATION = ["9", "8", "7", "6", "5"].join("");
const CATEGORY_MUTATION = ["1", "2", "3", "4", "F"].join("");

test("standalone procedure-shaped strings report their token and source line", () => {
  const findings = findShippedCptLiterals([{
    path: "mcp/src/clinical-graph/synthetic-seed.ts",
    text: `export const seed = { billingCode: "${FIVE_DIGIT_MUTATION}" };\n`,
  }]);
  assert.deepEqual(findings, [{
    path: "mcp/src/clinical-graph/synthetic-seed.ts",
    line: 1,
    token: FIVE_DIGIT_MUTATION,
  }]);

  assert.deepEqual(findShippedCptLiterals([{
    path: "ui/src/synthetic.ts",
    text: `// prohibited ${CATEGORY_MUTATION}\n`,
  }]), [{ path: "ui/src/synthetic.ts", line: 1, token: CATEGORY_MUTATION }]);
});

test("lexical classification ignores program numbers, URLs, pixels, and hyphenated terminology", () => {
  const text = [
    `const port = ${FIVE_DIGIT_MUTATION};`,
    `const pixels = ${FIVE_DIGIT_MUTATION};`,
    `const url = "https://example.test/article/${FIVE_DIGIT_MUTATION}";`,
    `const terminology = "${FIVE_DIGIT_MUTATION}-6";`,
    `const css = "${FIVE_DIGIT_MUTATION}px";`,
    `const year = "2026";`,
  ].join("\n");
  assert.deepEqual(findShippedCptLiterals([{ path: "ui/src/synthetic.ts", text }]), []);
});

test("an allowance is exact to one file and token", () => {
  const allowances: readonly ShippedCptAllowance[] = [{
    path: "mcp/src/allowed.ts",
    token: FIVE_DIGIT_MUTATION,
    reason: "Synthetic non-procedure protocol identifier.",
  }];
  const findings = findShippedCptLiterals([
    { path: "mcp/src/allowed.ts", text: `const value = "${FIVE_DIGIT_MUTATION}";` },
    { path: "mcp/src/rejected.ts", text: `const value = "${FIVE_DIGIT_MUTATION}";` },
  ], allowances);
  assert.deepEqual(findings, [{
    path: "mcp/src/rejected.ts",
    line: 1,
    token: FIVE_DIGIT_MUTATION,
  }]);
});

test("the shipped MCP, UI, and data trees contain no unallowed CPT-shaped literal", () => {
  assert.deepEqual(scanShippedCptLiterals(resolve(import.meta.dirname, "../..")), []);
});
