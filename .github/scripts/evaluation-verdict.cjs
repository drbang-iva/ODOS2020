"use strict";

const MARKER_PATTERN = /^Evaluated-by:\s*\S+/im;
const VERDICT_PATTERN =
  /^Evaluated-by:\s*(.+?)\s+(?:—|--|-)\s*(PASS|FAIL|BLOCKED|NEEDS-WORK)\b/im;
const FAILING_VERDICTS = new Set(["FAIL", "BLOCKED", "NEEDS-WORK"]);
const EXPECTED_FORM = "Evaluated-by: <Model> — PASS";
const OVERRIDE_NOTE = "The 'evaluated' label is the deliberate operator override.";

function createdAtMillis(comment) {
  const timestamp = Date.parse(comment.created_at || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function evaluateEvaluationGate({ labels = [], comments = [] } = {}) {
  if (labels.some((label) => (label.name || "").toLowerCase() === "evaluated")) {
    return {
      passed: true,
      reason: "label-override",
      message: '"evaluated" label present — operator override passes the gate.',
    };
  }

  const markerComments = comments
    .map((comment, index) => ({ comment, index }))
    .filter(({ comment }) => MARKER_PATTERN.test(comment.body || ""))
    .sort((left, right) =>
      createdAtMillis(left.comment) - createdAtMillis(right.comment) ||
      left.index - right.index
    );

  if (markerComments.length === 0) {
    return {
      passed: false,
      reason: "no-marker",
      message: [
        "NOT EVALUATED — this PR has no independent model review marker yet.",
        `Expected the newest marker to use '${EXPECTED_FORM}'.`,
        "Author ≠ evaluator; CodeRabbit is only a first pass.",
        OVERRIDE_NOTE,
      ].join("\n"),
    };
  }

  const latestComment = markerComments[markerComments.length - 1].comment;
  const match = VERDICT_PATTERN.exec(latestComment.body || "");
  if (!match) {
    return {
      passed: false,
      reason: "missing-verdict",
      message: [
        "EVALUATION VERDICT MISSING — the newest 'Evaluated-by:' marker has no recognizable verdict token.",
        `Expected '${EXPECTED_FORM}' (also accepts '-- PASS' or '- PASS').`,
        "Recognized failing verdicts are FAIL, BLOCKED, and NEEDS-WORK.",
        OVERRIDE_NOTE,
      ].join("\n"),
    };
  }

  const evaluator = match[1].trim();
  const verdict = match[2].toUpperCase();
  if (verdict === "PASS") {
    return {
      passed: true,
      reason: "passing-verdict",
      evaluator,
      verdict,
      message: `newest evaluation marker is ${verdict} from ${evaluator} — gate passes.`,
    };
  }

  if (FAILING_VERDICTS.has(verdict)) {
    return {
      passed: false,
      reason: "failing-verdict",
      evaluator,
      verdict,
      message: [
        `EVALUATION DID NOT PASS — the newest marker verdict is ${verdict} from ${evaluator}.`,
        `A later independent pass must use '${EXPECTED_FORM}'.`,
        OVERRIDE_NOTE,
      ].join("\n"),
    };
  }

  throw new Error(`Unhandled evaluation verdict: ${verdict}`);
}

module.exports = {
  evaluateEvaluationGate,
};
