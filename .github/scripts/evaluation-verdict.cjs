const MARKER_PATTERN = /^Evaluated-by:\s*\S+/im;
const VERDICT_PATTERN =
  /^Evaluated-by:\s*(.+?)\s+(?:—|--|-)\s*(PASS|FAIL|BLOCKED|NEEDS-WORK)\b/im;

function labelName(label) {
  return typeof label === "string" ? label : label?.name;
}

function commentTime(comment) {
  const parsed = Date.parse(comment.created_at || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function decideEvaluation({ labels = [], comments = [] } = {}) {
  if (labels.some((label) => labelName(label)?.toLowerCase() === "evaluated")) {
    return { passed: true, reason: "label-override" };
  }

  const markerComments = comments
    .map((comment, index) => ({ comment, index }))
    .filter(({ comment }) => MARKER_PATTERN.test(comment.body || ""))
    .sort((left, right) =>
      commentTime(left.comment) - commentTime(right.comment) ||
      left.index - right.index
    );

  const latest = markerComments.at(-1)?.comment;
  if (!latest) {
    return { passed: false, reason: "no-marker" };
  }

  const verdictMatch = VERDICT_PATTERN.exec(latest.body || "");
  if (!verdictMatch) {
    return {
      passed: false,
      reason: "missing-verdict",
      latestCommentId: latest.id ?? null,
    };
  }

  const verdict = verdictMatch[2].toUpperCase();
  return {
    passed: verdict === "PASS",
    reason: verdict === "PASS" ? "pass" : "failing-verdict",
    verdict,
    latestCommentId: latest.id ?? null,
  };
}

module.exports = { decideEvaluation };
