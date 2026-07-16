import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

type EvaluationDecision = {
  passed: boolean;
  reason: string;
  evaluator?: string;
  verdict?: string;
  message: string;
};

type EvaluationComment = {
  body: string;
  created_at: string;
};

const require = createRequire(import.meta.url);
const { evaluateEvaluationGate } = require(
  "../../.github/scripts/evaluation-verdict.cjs",
) as {
  evaluateEvaluationGate(input?: {
    labels?: Array<{ name: string }>;
    comments?: EvaluationComment[];
  }): EvaluationDecision;
};

function comment(body: string, createdAt: string): EvaluationComment {
  return { body, created_at: createdAt };
}

test("a PASS marker with trailing prose passes", () => {
  const decision = evaluateEvaluationGate({
    comments: [
      comment(
        "Evaluated-by: Opus 4.8 — PASS — reviewed with no blocking findings.",
        "2026-07-16T12:00:00Z",
      ),
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "passing-verdict");
  assert.equal(decision.evaluator, "Opus 4.8");
  assert.equal(decision.verdict, "PASS");
});

test("an explicit FAIL marker fails", () => {
  const decision = evaluateEvaluationGate({
    comments: [
      comment(
        "Evaluated-by: Fable 5 — FAIL — three blocking findings.",
        "2026-07-16T12:00:00Z",
      ),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "failing-verdict");
  assert.equal(decision.verdict, "FAIL");
});

test("a later PASS supersedes an earlier FAIL", () => {
  const decision = evaluateEvaluationGate({
    comments: [
      comment("Evaluated-by: Opus 4.8 — PASS", "2026-07-16T13:00:00Z"),
      comment("Evaluated-by: Fable 5 — FAIL", "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.evaluator, "Opus 4.8");
});

test("an earlier PASS cannot rescue a later FAIL", () => {
  const decision = evaluateEvaluationGate({
    comments: [
      comment("Evaluated-by: Fable 5 — FAIL", "2026-07-16T13:00:00Z"),
      comment("Evaluated-by: Opus 4.8 — PASS", "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "failing-verdict");
  assert.equal(decision.verdict, "FAIL");
  assert.equal(decision.evaluator, "Fable 5");
});

test("a marker without a verdict token is ambiguous and fails", () => {
  const decision = evaluateEvaluationGate({
    comments: [
      comment("Evaluated-by: Someone", "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "missing-verdict");
  assert.match(decision.message, /Evaluated-by: <Model> — PASS/);
});

test("no evaluation marker fails", () => {
  const decision = evaluateEvaluationGate({
    comments: [
      comment("Automated review complete.", "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "no-marker");
});

test("the evaluated label passes without a marker", () => {
  const decision = evaluateEvaluationGate({
    labels: [{ name: "evaluated" }],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "label-override");
});

test("em dash, double hyphen, and single hyphen separators pass", () => {
  for (const separator of ["—", "--", "-"]) {
    const decision = evaluateEvaluationGate({
      comments: [
        comment(
          `Evaluated-by: Opus 4.8 ${separator} PASS`,
          "2026-07-16T12:00:00Z",
        ),
      ],
    });

    assert.equal(decision.passed, true, `separator ${separator}`);
    assert.equal(decision.verdict, "PASS", `separator ${separator}`);
  }
});

test("a lowercase pass verdict passes", () => {
  const decision = evaluateEvaluationGate({
    comments: [
      comment("Evaluated-by: Opus 4.8 — pass", "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.verdict, "PASS");
});
