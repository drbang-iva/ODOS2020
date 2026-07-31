import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const REPOSITORY_ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = join(REPOSITORY_ROOT, "scripts", "eval-post-verdict.sh");
const HEAD_SHA = "1111111111111111111111111111111111111111";
const STALE_SHA = "2222222222222222222222222222222222222222";

test("the most recent PR-Agent guide is head-bound and enumerates its findings", () => {
  const result = runGate([
    reviewerGuide(STALE_SHA, ["Older first", "Older second"], "2026-07-31T00:00:00Z", 1),
    reviewerGuide(HEAD_SHA, ["Current &amp; actionable"], "2026-07-31T01:00:00Z", 2),
  ], ["123", "PASS", "Opus 5", "--dry-run"]);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`PR-Agent review head: ${HEAD_SHA} \\(matches current head\\)`));
  assert.match(result.output, /PR-Agent findings: 1/);
  assert.match(result.output, /  - Current & actionable/);
  assert.doesNotMatch(result.output, /Older first/);
});

test("a stale PR-Agent guide is rejected before a verdict can be posted", () => {
  const result = runGate([
    reviewerGuide(STALE_SHA, ["Stale finding"], "2026-07-31T01:00:00Z", 1),
  ], ["123", "PASS", "Opus 5", "--dry-run"]);

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    new RegExp(`PR-Agent review is stale: reviewed ${STALE_SHA}, current head is ${HEAD_SHA}`),
  );
});

test("a supplied PR-Agent acknowledgment must equal the finding count during dry-run", () => {
  const result = runGate([
    reviewerGuide(HEAD_SHA, ["First", "Second"], "2026-07-31T01:00:00Z", 1),
  ], ["123", "PASS", "Opus 5", "--dry-run", "--ack-pr-agent", "1"]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /PR-Agent findings: 2/);
  assert.match(result.output, /--ack-pr-agent must equal the PR-Agent finding count: expected 2, received 1/);
});

test("a non-dry verdict requires acknowledgment when PR-Agent found issues", () => {
  const result = runGate([
    reviewerGuide(HEAD_SHA, ["Needs adjudication"], "2026-07-31T01:00:00Z", 1),
  ], ["123", "PASS", "Opus 5"]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /--ack-pr-agent 1 is required before posting/);
  assert.doesNotMatch(result.output, /Posting evaluator-supplied marker/);
});

test("an absent PR-Agent guide warns and requires an explicit zero acknowledgment", () => {
  const rejected = runGate([], ["123", "PASS", "Opus 5", "--dry-run"]);
  assert.equal(rejected.status, 1, rejected.output);
  assert.match(rejected.output, /PR-Agent review: NOT FOUND/);
  assert.match(rejected.output, /WARNING: PR-Agent did not review this head/);
  assert.match(rejected.output, /--ack-pr-agent 0 is required because PR-Agent did not review this head/);

  const acknowledged = runGate(
    [],
    ["123", "PASS", "Opus 5", "--dry-run", "--ack-pr-agent", "0"],
  );
  assert.equal(acknowledged.status, 0, acknowledged.output);
  assert.match(acknowledged.output, /Dry run only; no comment will be posted/);
});

test("a current clean PR-Agent guide is distinct from an absent review", () => {
  const result = runGate([
    reviewerGuide(HEAD_SHA, [], "2026-07-31T01:00:00Z", 1),
  ], ["123", "PASS", "Opus 5", "--dry-run"]);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /PR-Agent findings: 0/);
  assert.match(result.output, /  \(none\)/);
  assert.doesNotMatch(result.output, /PR-Agent review: NOT FOUND/);
});

function reviewerGuide(
  sha: string,
  findingTitles: readonly string[],
  updatedAt: string,
  id: number,
) {
  const findings = findingTitles.map((title, index) => [
    `<details><summary><a href='https://github.com/drbang-iva/ODOS2020/pull/123/files#diff-${index}'>`,
    `<strong>${title}</strong></a>`,
    "Finding body.",
    "</summary></details>",
  ].join("\n")).join("\n");
  return {
    id,
    updated_at: updatedAt,
    user: { login: "github-actions[bot]" },
    body: [
      "## PR Reviewer Guide 🔍",
      "",
      `#### (Review updated until commit https://github.com/drbang-iva/ODOS2020/commit/${sha})`,
      "",
      findings,
    ].join("\n"),
  };
}

function runGate(
  issueComments: readonly ReturnType<typeof reviewerGuide>[],
  args: readonly string[],
) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "odos-eval-post-verdict-"));
  const binDir = join(fixtureRoot, "bin");
  const ghPath = join(binDir, "gh");
  mkdirSync(binDir);
  writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  printf '%s\\n' "$MOCK_HEAD_SHA"
  exit 0
fi
if [[ "$1" == "api" ]]; then
  for argument in "$@"; do
    case "$argument" in
      repos/*/pulls/*/comments)
        exit 0
        ;;
      repos/*/issues/*/comments\\?per_page=100)
        printf '%s\\n' "$MOCK_ISSUE_COMMENT_PAGES"
        exit 0
        ;;
      repos/*/actions/workflows/evaluation-gate.yml/runs*)
        printf '456\\n'
        exit 0
        ;;
    esac
  done
fi
printf 'unexpected mock gh invocation:' >&2
printf ' %q' "$@" >&2
printf '\\n' >&2
exit 90
`);
  chmodSync(ghPath, 0o755);
  try {
    const result = spawnSync("bash", [SCRIPT, ...args], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        GH_REPO: "drbang-iva/ODOS2020",
        MOCK_HEAD_SHA: HEAD_SHA,
        MOCK_ISSUE_COMMENT_PAGES: JSON.stringify([issueComments]),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
