"use strict";

const MARKER_PATTERN = /^Evaluated-by:/im;
const VERDICT_PATTERN =
  /^Evaluated-by:\s*(.+?)\s+(?:—|--|-)\s*(PASS|FAIL|BLOCKED|NEEDS-WORK)\s*$/i;
const HEAD_SHA_PATTERN = /^Head-SHA:\s*([0-9a-f]{40})\s*$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
// Who is trusted, and why, is decided in performance-od/decisions/ — not restated here.
// Current: 2026-09-02-eval-gate-trusts-codex.md
const TRUSTED_MODEL_PATTERN =
  /^(?:Fable|(?:Claude\s+)?Opus|(?:GPT[-\s]?\d+(?:\.\d+)*\s+)?Codex)(?:\s+\d+(?:\.\d+)*)?(?:\s+\((?:Claude|GPT[-\s]?\d+(?:\.\d+)*)\))?$/i;
const FAILING_VERDICTS = new Set(["FAIL", "BLOCKED", "NEEDS-WORK"]);
const EXPECTED_FORM = [
  "Evaluated-by: Fable 5 — PASS   (also accepted: Opus, Codex)",
  "Head-SHA: <40-character PR head SHA>",
].join("\n");
const OVERRIDE_NOTE =
  "The 'evaluated' label is the deliberate operator override and bypasses marker and head-SHA checks.";

function createdAtMillis(comment) {
  const timestamp = Date.parse(comment.created_at || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeLogin(login) {
  return (login || "").trim().toLowerCase();
}

function markerLines(body) {
  return (body || "").split(/\r?\n/).filter((line) => /^Evaluated-by:/i.test(line));
}

function headShaLines(body) {
  return (body || "").split(/\r?\n/).filter((line) => /^Head-SHA:/i.test(line));
}

function failure(reason, message) {
  return { passed: false, reason, message };
}

function evaluateEvaluationGate({
  labels = [],
  comments = [],
  currentHeadSha = "",
} = {}) {
  if (labels.some((label) => (label.name || "").toLowerCase() === "evaluated")) {
    return {
      passed: true,
      reason: "label-override",
      message: [
        '"evaluated" label present — operator override passes the gate',
        "without marker or head-SHA enforcement.",
      ].join(" "),
    };
  }

  const normalizedHeadSha = currentHeadSha.trim().toLowerCase();
  if (!SHA_PATTERN.test(normalizedHeadSha)) {
    return failure(
      "invalid-gate-input",
      "EVALUATION GATE INPUT INVALID — the current PR head SHA could not be resolved.",
    );
  }

  const markerComments = comments
    .map((comment, index) => ({ comment, index }))
    .filter(({ comment }) => MARKER_PATTERN.test(comment.body || ""));

  if (markerComments.length === 0) {
    return failure(
      "no-marker",
      [
        "NOT EVALUATED — this PR has no independent model review marker yet.",
        `Expected the newest marker to use:\n${EXPECTED_FORM}`,
        "Author != evaluator remains a procedural expectation; CodeRabbit is only a first pass.",
        OVERRIDE_NOTE,
      ].join("\n"),
    );
  }

  const latestComment = markerComments.sort((left, right) =>
    createdAtMillis(left.comment) - createdAtMillis(right.comment) ||
    left.index - right.index
  )[markerComments.length - 1].comment;
  const evaluatorLogin = normalizeLogin(latestComment.user?.login);

  const evaluationLines = markerLines(latestComment.body);
  if (evaluationLines.length > 1) {
    return failure(
      "ambiguous-marker",
      [
        "EVALUATION MARKER AMBIGUOUS — the newest marker comment must contain exactly one 'Evaluated-by:' line.",
        `Expected:\n${EXPECTED_FORM}`,
        OVERRIDE_NOTE,
      ].join("\n"),
    );
  }

  const match = VERDICT_PATTERN.exec(evaluationLines[0]);
  if (!match) {
    return failure(
      "missing-verdict",
      [
        "EVALUATION VERDICT MISSING — the newest marker has no recognizable verdict token.",
        `Expected:\n${EXPECTED_FORM}`,
        "Recognized failing verdicts are FAIL, BLOCKED, and NEEDS-WORK.",
        OVERRIDE_NOTE,
      ].join("\n"),
    );
  }

  const evaluator = match[1].trim();
  if (!TRUSTED_MODEL_PATTERN.test(evaluator)) {
    return failure(
      "untrusted-model",
      [
        `UNTRUSTED EVALUATOR MODEL — '${evaluator}' is not an authorized Fable or Opus evaluator.`,
        `Expected:\n${EXPECTED_FORM}`,
        OVERRIDE_NOTE,
      ].join("\n"),
    );
  }

  const shaLines = headShaLines(latestComment.body);
  if (shaLines.length === 0) {
    return failure(
      "missing-head-sha",
      [
        "EVALUATION HEAD SHA MISSING — the newest marker must contain one Head-SHA line.",
        `Expected:\n${EXPECTED_FORM}`,
        OVERRIDE_NOTE,
      ].join("\n"),
    );
  }
  if (shaLines.length > 1) {
    return failure(
      "ambiguous-head-sha",
      "EVALUATION HEAD SHA AMBIGUOUS — the newest marker contains more than one Head-SHA line.",
    );
  }

  const shaMatch = HEAD_SHA_PATTERN.exec(shaLines[0]);
  if (!shaMatch) {
    return failure(
      "invalid-head-sha",
      "EVALUATION HEAD SHA INVALID — Head-SHA must contain one full 40-character commit SHA.",
    );
  }

  const evaluatedHeadSha = shaMatch[1].toLowerCase();
  if (evaluatedHeadSha !== normalizedHeadSha) {
    return {
      passed: false,
      reason: "stale-head-sha",
      evaluator,
      evaluatorLogin,
      evaluatedHeadSha,
      currentHeadSha: normalizedHeadSha,
      message: [
        [
          `STALE EVALUATION — ${evaluator} evaluated ${evaluatedHeadSha},`,
          `but the current PR head is ${normalizedHeadSha}.`,
        ].join(" "),
        "A new commit always requires a new independent verdict bound to that exact head.",
        OVERRIDE_NOTE,
      ].join("\n"),
    };
  }

  const verdict = match[2].toUpperCase();
  if (verdict === "PASS") {
    return {
      passed: true,
      reason: "passing-verdict",
      evaluator,
      evaluatorLogin,
      evaluatedHeadSha,
      verdict,
      message: [
        `newest evaluation marker is ${verdict} from ${evaluator}`,
        `via @${latestComment.user.login} for ${evaluatedHeadSha} — gate passes.`,
      ].join(" "),
    };
  }

  if (FAILING_VERDICTS.has(verdict)) {
    return {
      passed: false,
      reason: "failing-verdict",
      evaluator,
      evaluatorLogin,
      evaluatedHeadSha,
      verdict,
      message: [
        [
          `EVALUATION DID NOT PASS — the newest verdict is ${verdict}`,
          `from ${evaluator} for ${evaluatedHeadSha}.`,
        ].join(" "),
        `A later passing marker must use:\n${EXPECTED_FORM}`,
        OVERRIDE_NOTE,
      ].join("\n"),
    };
  }

  throw new Error(`Unhandled evaluation verdict: ${verdict}`);
}

module.exports = {
  evaluateEvaluationGate,
};
