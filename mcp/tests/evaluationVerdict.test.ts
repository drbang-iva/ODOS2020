import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

type EvaluationDecision = {
  passed: boolean;
  reason: string;
  evaluator?: string;
  evaluatorLogin?: string;
  evaluatedHeadSha?: string;
  currentHeadSha?: string;
  verdict?: string;
  message: string;
};

type EvaluationComment = {
  body: string;
  created_at: string;
  user: { login: string };
};

type EvaluationInput = {
  labels?: Array<{ name: string }>;
  comments?: EvaluationComment[];
  currentHeadSha?: string;
};

const CURRENT_HEAD = "a".repeat(40);
const PREVIOUS_HEAD = "b".repeat(40);
const TRUSTED_LOGIN = "odos-evaluator[bot]";
const require = createRequire(import.meta.url);
const { evaluateEvaluationGate } = require(
  "../../.github/scripts/evaluation-verdict.cjs",
) as {
  evaluateEvaluationGate(input?: EvaluationInput): EvaluationDecision;
};

function comment(
  body: string,
  createdAt = "2026-07-16T12:00:00Z",
  login = TRUSTED_LOGIN,
): EvaluationComment {
  return { body, created_at: createdAt, user: { login } };
}

function marker(
  evaluator: string,
  verdict: string,
  headSha = CURRENT_HEAD,
): string {
  return `Evaluated-by: ${evaluator} — ${verdict}\nHead-SHA: ${headSha}`;
}

function evaluate(input: EvaluationInput = {}): EvaluationDecision {
  return evaluateEvaluationGate({
    currentHeadSha: CURRENT_HEAD,
    ...input,
  });
}

test("a trusted Fable PASS bound to the current head passes", () => {
  const decision = evaluate({
    comments: [comment(marker("Fable 5", "PASS"))],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "passing-verdict");
  assert.equal(decision.evaluator, "Fable 5");
  assert.equal(decision.evaluatorLogin, TRUSTED_LOGIN);
  assert.equal(decision.evaluatedHeadSha, CURRENT_HEAD);
  assert.equal(decision.verdict, "PASS");
});

test("an explicit FAIL bound to the current head fails", () => {
  const decision = evaluate({
    comments: [comment(marker("Opus 4.8", "FAIL"))],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "failing-verdict");
  assert.equal(decision.verdict, "FAIL");
});

test("a later trusted PASS supersedes an earlier trusted FAIL", () => {
  const decision = evaluate({
    comments: [
      comment(marker("Fable 5", "PASS"), "2026-07-16T13:00:00Z"),
      comment(marker("Opus 4.8", "FAIL"), "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.evaluator, "Fable 5");
});

test("an earlier trusted PASS cannot rescue a later trusted FAIL", () => {
  const decision = evaluate({
    comments: [
      comment(marker("Fable 5", "FAIL"), "2026-07-16T13:00:00Z"),
      comment(marker("Opus 4.8", "PASS"), "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "failing-verdict");
  assert.equal(decision.evaluator, "Fable 5");
});

test("a PASS for an earlier head is stale after a new commit", () => {
  const decision = evaluate({
    comments: [comment(marker("Opus 4.8", "PASS", PREVIOUS_HEAD))],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "stale-head-sha");
  assert.equal(decision.evaluatedHeadSha, PREVIOUS_HEAD);
  assert.equal(decision.currentHeadSha, CURRENT_HEAD);
});

test("a marker without a head SHA fails", () => {
  const decision = evaluate({
    comments: [comment("Evaluated-by: Fable 5 — PASS")],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "missing-head-sha");
});

test("a marker with a short head SHA fails", () => {
  const decision = evaluate({
    comments: [comment("Evaluated-by: Fable 5 — PASS\nHead-SHA: abc123")],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "invalid-head-sha");
});

test("duplicate evaluator or head lines fail as ambiguous", () => {
  const duplicateEvaluator = evaluate({
    comments: [
      comment(
        `${marker("Fable 5", "PASS")}\nEvaluated-by: Opus 4.8 — FAIL`,
      ),
    ],
  });
  const duplicateHead = evaluate({
    comments: [
      comment(`${marker("Fable 5", "PASS")}\nHead-SHA: ${CURRENT_HEAD}`),
    ],
  });

  assert.equal(duplicateEvaluator.reason, "ambiguous-marker");
  assert.equal(duplicateHead.reason, "ambiguous-head-sha");
});

test("a marker without a verdict token fails", () => {
  const decision = evaluate({
    comments: [comment(`Evaluated-by: Fable 5\nHead-SHA: ${CURRENT_HEAD}`)],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "missing-verdict");
});

test("trailing or contradictory verdict content fails", () => {
  for (const trailing of ["PASS FAIL", "PASS — later changed to FAIL"]) {
    const decision = evaluate({
      comments: [
        comment(`Evaluated-by: Fable 5 — ${trailing}\nHead-SHA: ${CURRENT_HEAD}`),
      ],
    });

    assert.equal(decision.passed, false, trailing);
    assert.equal(decision.reason, "missing-verdict", trailing);
  }
});

test("a non-Fable-or-Opus model cannot issue the final verdict", () => {
  const decision = evaluate({
    comments: [comment(marker("Codex", "PASS"))],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "untrusted-model");
});

test("a marker posted under the PR author's login now passes", () => {
  const decision = evaluate({
    comments: [comment(marker("Fable 5", "PASS"), undefined, "pr-author")],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "passing-verdict");
  assert.equal(decision.evaluatorLogin, "pr-author");
});

test("no evaluation marker fails", () => {
  const decision = evaluate({
    comments: [comment("Automated review complete.")],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "no-marker");
});

test("the evaluated label remains an explicit operator override", () => {
  const decision = evaluateEvaluationGate({
    labels: [{ name: "evaluated" }],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "label-override");
});

test("em dash, double hyphen, and single hyphen separators pass", () => {
  for (const separator of ["—", "--", "-"]) {
    const decision = evaluate({
      comments: [
        comment(
          `Evaluated-by: Opus 4.8 ${separator} PASS\nHead-SHA: ${CURRENT_HEAD}`,
        ),
      ],
    });

    assert.equal(decision.passed, true, `separator ${separator}`);
  }
});

test("case normalization applies to verdicts, SHAs, and logins", () => {
  const decision = evaluate({
    comments: [
      comment(
        `Evaluated-by: opus 4.8 — pass\nHead-SHA: ${CURRENT_HEAD.toUpperCase()}`,
        undefined,
        "ODOS-EVALUATOR[BOT]",
      ),
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.verdict, "PASS");
});

test("an invalid head SHA fails closed", () => {
  const invalidHead = evaluate({
    currentHeadSha: "abc123",
    comments: [comment(marker("Fable 5", "PASS"))],
  });

  assert.equal(invalidHead.reason, "invalid-gate-input");
});
