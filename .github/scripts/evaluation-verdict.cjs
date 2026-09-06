"use strict";

const MARKER_PATTERN = /^Evaluated-by:/im;
const VERDICT_PATTERN =
  /^Evaluated-by:\s*(.+?)\s+(?:—|--|-)\s*(PASS|FAIL|BLOCKED|NEEDS-WORK|OVERRIDE)\s*$/i;
const HEAD_SHA_PATTERN = /^Head-SHA:\s*([0-9a-f]{40})\s*$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
// Who is trusted, and why, is decided in performance-od/decisions/ — not restated here.
// Current: 2026-09-02-eval-gate-trusts-codex.md
const TRUSTED_MODEL_PATTERN =
  /^(?:(?:Fable|(?:Claude\s+)?Opus|(?:GPT[-\s]?\d+(?:\.\d+)*\s+)?Codex)(?:\s+\d+(?:\.\d+)*)?(?:\s+\((?:Claude|GPT[-\s]?\d+(?:\.\d+)*)\))?|Codex \(GPT-5\.6-sol\)|Astra)$/i;
const FAILING_VERDICTS = new Set(["FAIL", "BLOCKED", "NEEDS-WORK"]);
const EXPECTED_FORM = [
  "Evaluated-by: Fable 5 — PASS   (also accepted: Opus, Codex, Codex (gpt-5.6-sol))",
  "Head-SHA: <40-character PR head SHA>",
].join("\n");
const EXPECTED_OVERRIDE_FORM = [
  "Evaluated-by: <authorizing operator name> — OVERRIDE",
  "Head-SHA: <40-character current PR head SHA>",
  "Override-Reason: <nonempty reason for the authorized bypass>",
].join("\n");
const OVERRIDE_NOTE =
  "The 'evaluated' label alone never passes; an operator override also requires a named OVERRIDE marker, a nonempty Override-Reason, and the exact current Head-SHA in the same comment.";

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

function isTrustedEvaluator(model) {
  return TRUSTED_MODEL_PATTERN.test(model.trim());
}

function evaluateEvaluationGate({
  labels = [],
  comments = [],
  currentHeadSha = "",
} = {}) {
  const hasOverrideLabel = labels.some(
    (label) => (label.name || "").toLowerCase() === "evaluated",
  );
  const expectedForm = hasOverrideLabel
    ? `${EXPECTED_FORM}\nFor an operator-authorized override:\n${EXPECTED_OVERRIDE_FORM}`
    : EXPECTED_FORM;

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
    if (hasOverrideLabel) {
      return failure(
        "missing-override-marker",
        [
          "OVERRIDE MARKER MISSING — the 'evaluated' label is present without an 'Evaluated-by: <authorizing operator name> — OVERRIDE' marker line.",
          `Expected in one comment:\n${EXPECTED_OVERRIDE_FORM}`,
        ].join("\n"),
      );
    }
    return failure(
      "no-marker",
      [
        "NOT EVALUATED — this PR has no independent model review marker yet.",
        `Expected the newest marker to use:\n${EXPECTED_FORM}`,
        "Author != evaluator remains a procedural expectation; review bots are only a first pass.",
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
        `Expected:\n${expectedForm}`,
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
        `Expected:\n${expectedForm}`,
        "Recognized failing verdicts are FAIL, BLOCKED, and NEEDS-WORK.",
        OVERRIDE_NOTE,
      ].join("\n"),
    );
  }

  const evaluator = match[1].trim();
  const verdict = match[2].toUpperCase();
  const isOverride = verdict === "OVERRIDE";
  const markerKind = isOverride ? "OVERRIDE" : "EVALUATION";
  let overrideReason;
  if (isOverride) {
    // The typed name is an authorization record, not authentication. Agents and the
    // operator share a GitHub account, so a login check cannot distinguish them.
    if (!evaluator) {
      return failure(
        "missing-override-authorizer",
        `OVERRIDE AUTHORIZER NAME MISSING — Evaluated-by must name who authorized the bypass.\nExpected:\n${EXPECTED_OVERRIDE_FORM}`,
      );
    }
    if (!hasOverrideLabel) {
      return failure(
        "missing-override-label",
        `OVERRIDE LABEL MISSING — the 'evaluated' label is missing; an OVERRIDE comment alone does not pass.\nExpected with that label:\n${EXPECTED_OVERRIDE_FORM}`,
      );
    }
    const reasonLines = (latestComment.body || "").split(/\r?\n/)
      .filter((line) => /^Override-Reason:/i.test(line));
    if (reasonLines.length > 1) {
      return failure(
        "ambiguous-override-reason",
        `OVERRIDE REASON AMBIGUOUS — the newest marker contains more than one Override-Reason line.\nExpected:\n${EXPECTED_OVERRIDE_FORM}`,
      );
    }
    overrideReason = reasonLines[0]?.slice("Override-Reason:".length).trim();
    if (!overrideReason) {
      return failure(
        "missing-override-reason",
        `OVERRIDE REASON MISSING — the newest marker must contain a nonempty Override-Reason line.\nExpected:\n${EXPECTED_OVERRIDE_FORM}`,
      );
    }
  } else if (!isTrustedEvaluator(evaluator)) {
    return failure(
      "untrusted-model",
      [
        `UNTRUSTED EVALUATOR MODEL — '${evaluator}' is not a recognized Fable, Opus, or Codex signature.`,
        `Expected:\n${expectedForm}`,
        OVERRIDE_NOTE,
      ].join("\n"),
    );
  }

  const shaLines = headShaLines(latestComment.body);
  if (shaLines.length === 0) {
    return failure(
      "missing-head-sha",
      [
        `${markerKind} HEAD SHA MISSING — the newest marker must contain one Head-SHA line.`,
        `Expected:\n${isOverride ? EXPECTED_OVERRIDE_FORM : expectedForm}`,
        OVERRIDE_NOTE,
      ].join("\n"),
    );
  }
  if (shaLines.length > 1) {
    return failure(
      "ambiguous-head-sha",
      `${markerKind} HEAD SHA AMBIGUOUS — the newest marker contains more than one Head-SHA line.\nExpected:\n${isOverride ? EXPECTED_OVERRIDE_FORM : expectedForm}`,
    );
  }

  const shaMatch = HEAD_SHA_PATTERN.exec(shaLines[0]);
  if (!shaMatch) {
    return failure(
      "invalid-head-sha",
      `${markerKind} HEAD SHA INVALID — Head-SHA must contain one full 40-character commit SHA.\nExpected:\n${isOverride ? EXPECTED_OVERRIDE_FORM : expectedForm}`,
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
        isOverride
          ? `STALE OVERRIDE — Head-SHA ${evaluatedHeadSha} does not match the current PR head ${normalizedHeadSha}.`
          : [
            `STALE EVALUATION — ${evaluator} evaluated ${evaluatedHeadSha},`,
            `but the current PR head is ${normalizedHeadSha}.`,
          ].join(" "),
        isOverride
          ? `A new head requires new operator authorization bound to that exact head.\nExpected:\n${EXPECTED_OVERRIDE_FORM}`
          : "A new commit always requires a new independent verdict bound to that exact head.",
        OVERRIDE_NOTE,
      ].join("\n"),
    };
  }

  if (isOverride) {
    return {
      passed: true,
      reason: "label-override",
      authorizedBy: evaluator,
      overrideReason,
      evaluatedHeadSha,
      verdict,
      message: `Operator override recorded from ${evaluator} for ${evaluatedHeadSha}: ${overrideReason} — 'evaluated' label present; gate passes without an independent passing verdict.`,
    };
  }

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
        `A later marker must use:\n${expectedForm}`,
        OVERRIDE_NOTE,
      ].join("\n"),
    };
  }

  throw new Error(`Unhandled evaluation verdict: ${verdict}`);
}

module.exports = {
  evaluateEvaluationGate,
  isTrustedEvaluator,
};
