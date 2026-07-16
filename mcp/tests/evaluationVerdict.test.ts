import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

type EvaluationDecision =
  | { passed: true; reason: "label-override" }
  | {
      passed: boolean;
      reason: "pass" | "failing-verdict";
      verdict: "PASS" | "FAIL" | "BLOCKED" | "NEEDS-WORK";
      latestCommentId: number | null;
    }
  | {
      passed: false;
      reason: "missing-verdict";
      latestCommentId: number | null;
    }
  | { passed: false; reason: "no-marker" };

type EvaluationInput = {
  labels?: Array<string | { name: string }>;
  comments?: Array<{
    id?: number;
    body?: string;
    created_at?: string;
  }>;
};

const require = createRequire(import.meta.url);
const { decideEvaluation } = require(
  "../../.github/scripts/evaluation-verdict.cjs",
) as {
  decideEvaluation(input?: EvaluationInput): EvaluationDecision;
};

function comment(
  id: number,
  body: string,
  createdAt: string,
): NonNullable<EvaluationInput["comments"]>[number] {
  return { id, body, created_at: createdAt };
}

test("explicit PASS marker with trailing prose passes", () => {
  assert.deepEqual(
    decideEvaluation({
      comments: [
        comment(
          1,
          "Evaluated-by: Opus 4.8 — PASS — reviewed, no blocking issues",
          "2026-07-16T12:00:00Z",
        ),
      ],
    }),
    { passed: true, reason: "pass", verdict: "PASS", latestCommentId: 1 },
  );
});

test("explicit FAIL marker fails", () => {
  assert.deepEqual(
    decideEvaluation({
      comments: [
        comment(
          2,
          "Evaluated-by: Fable 5 — FAIL — three blocking findings",
          "2026-07-16T12:00:00Z",
        ),
      ],
    }),
    {
      passed: false,
      reason: "failing-verdict",
      verdict: "FAIL",
      latestCommentId: 2,
    },
  );
});

test("BLOCKED and NEEDS-WORK markers are explicit failing verdicts", () => {
  for (const [index, verdict] of ["BLOCKED", "NEEDS-WORK"].entries()) {
    const id = 20 + index;
    assert.deepEqual(
      decideEvaluation({
        comments: [
          comment(
            id,
            `Evaluated-by: Fable 5 — ${verdict}`,
            "2026-07-16T12:00:00Z",
          ),
        ],
      }),
      {
        passed: false,
        reason: "failing-verdict",
        verdict,
        latestCommentId: id,
      },
    );
  }
});

test("later PASS supersedes an earlier FAIL regardless of input order", () => {
  assert.deepEqual(
    decideEvaluation({
      comments: [
        comment(
          4,
          "Evaluated-by: Opus 4.8 — PASS",
          "2026-07-16T13:00:00Z",
        ),
        comment(
          3,
          "Evaluated-by: Fable 5 — FAIL",
          "2026-07-16T12:00:00Z",
        ),
      ],
    }),
    { passed: true, reason: "pass", verdict: "PASS", latestCommentId: 4 },
  );
});

test("later FAIL blocks an earlier PASS regardless of input order", () => {
  assert.deepEqual(
    decideEvaluation({
      comments: [
        comment(
          6,
          "Evaluated-by: Fable 5 — FAIL",
          "2026-07-16T13:00:00Z",
        ),
        comment(
          5,
          "Evaluated-by: Opus 4.8 — PASS",
          "2026-07-16T12:00:00Z",
        ),
      ],
    }),
    {
      passed: false,
      reason: "failing-verdict",
      verdict: "FAIL",
      latestCommentId: 6,
    },
  );
});

test("marker without a verdict token fails as ambiguous", () => {
  assert.deepEqual(
    decideEvaluation({
      comments: [
        comment(7, "Evaluated-by: Someone", "2026-07-16T12:00:00Z"),
      ],
    }),
    { passed: false, reason: "missing-verdict", latestCommentId: 7 },
  );
});

test("no marker fails", () => {
  assert.deepEqual(
    decideEvaluation({
      comments: [
        comment(8, "Reviewed and approved.", "2026-07-16T12:00:00Z"),
      ],
    }),
    { passed: false, reason: "no-marker" },
  );
});

test("evaluated label passes without a marker", () => {
  assert.deepEqual(
    decideEvaluation({ labels: [{ name: "evaluated" }] }),
    { passed: true, reason: "label-override" },
  );
});

test("em dash, double hyphen, and single hyphen PASS separators are accepted", () => {
  for (const [index, separator] of ["—", "--", "-"].entries()) {
    const id = 10 + index;
    assert.deepEqual(
      decideEvaluation({
        comments: [
          comment(
            id,
            `Evaluated-by: Opus 4.8 ${separator} PASS`,
            "2026-07-16T12:00:00Z",
          ),
        ],
      }),
      { passed: true, reason: "pass", verdict: "PASS", latestCommentId: id },
    );
  }
});

test("lowercase pass token is accepted", () => {
  assert.deepEqual(
    decideEvaluation({
      comments: [
        comment(
          13,
          "Evaluated-by: Opus 4.8 — pass",
          "2026-07-16T12:00:00Z",
        ),
      ],
    }),
    { passed: true, reason: "pass", verdict: "PASS", latestCommentId: 13 },
  );
});
