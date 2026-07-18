#!/usr/bin/env bash
set -euo pipefail

# Evaluation is deliberately split in two: eval-worktree.sh proves an exact PR
# head; this script posts only the evaluator-supplied verdict and waits for the
# gate. Merge remains a separate, deliberate command and is never automated.

usage() {
  echo "Usage: scripts/eval-post-verdict.sh <PR#> <PASS|FAIL> <model> [--dry-run]" >&2
}

die() {
  echo "eval-post-verdict: $*" >&2
  exit 1
}

if [[ $# -lt 3 || $# -gt 4 ]]; then
  usage
  exit 2
fi

pr_number="$1"
verdict="$2"
model="$3"
dry_run=false

[[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || die "PR number must be a positive integer"
[[ "$verdict" == "PASS" || "$verdict" == "FAIL" ]] || die "verdict must be exactly PASS or FAIL"
if [[ $# -eq 4 ]]; then
  [[ "$4" == "--dry-run" ]] || { usage; exit 2; }
  dry_run=true
fi
[[ "$model" != *$'\n'* && "$model" != *$'\r'* ]] || die "evaluator model must be one line"

trusted_model_pattern='^(Fable|(Claude[[:space:]]+)?Opus)([[:space:]]+[0-9]+(\.[0-9]+)*)?([[:space:]]+\(Claude\))?$'
if ! printf '%s\n' "$model" | grep -Eiq "$trusted_model_pattern"; then
  die "evaluator model '$model' would be rejected by evaluation-verdict.cjs"
fi

command -v gh >/dev/null 2>&1 || die "required command not found: gh"
command -v git >/dev/null 2>&1 || die "required command not found: git"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
repo_name="${GH_REPO:-$(cd "$repo_root" && gh repo view --json nameWithOwner --jq .nameWithOwner)}"
head_sha="$(gh pr view "$pr_number" --repo "$repo_name" --json headRefOid --jq .headRefOid)"
[[ "$head_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die "could not resolve a full head SHA for PR #$pr_number"
head_sha="$(printf '%s' "$head_sha" | tr '[:upper:]' '[:lower:]')"

marker="Evaluated-by: $model — $verdict
Head-SHA: $head_sha"

if [[ "$dry_run" == true ]]; then
  echo "Dry run only; no comment will be posted."
  echo "PR: #$pr_number ($repo_name)"
  printf '%s\n' "$marker"
  exit 0
fi

echo "Posting evaluator-supplied marker for PR #$pr_number at $head_sha..."
gh pr comment "$pr_number" --repo "$repo_name" --body "$marker"

current_head_sha="$(gh pr view "$pr_number" --repo "$repo_name" --json headRefOid --jq .headRefOid | tr '[:upper:]' '[:lower:]')"
if [[ "$current_head_sha" != "$head_sha" ]]; then
  die "PR head changed to $current_head_sha while posting; the marker for $head_sha is stale"
fi

timeout_seconds="${ODOS_EVAL_POLL_TIMEOUT_SECONDS:-180}"
poll_seconds="${ODOS_EVAL_POLL_INTERVAL_SECONDS:-10}"
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || die "ODOS_EVAL_POLL_TIMEOUT_SECONDS must be a positive integer"
[[ "$poll_seconds" =~ ^[1-9][0-9]*$ ]] || die "ODOS_EVAL_POLL_INTERVAL_SECONDS must be a positive integer"

deadline=$(( $(date +%s) + timeout_seconds ))
latest_state="not found"
echo "Polling check-evaluation for up to ${timeout_seconds}s; existing failures are expected and will not stop the poll."

while [[ $(date +%s) -lt "$deadline" ]]; do
  check_line="$(gh api "repos/$repo_name/commits/$head_sha/check-runs?check_name=check-evaluation&per_page=100" \
    --jq '[.check_runs[] | select(.name == "check-evaluation")] | sort_by(.started_at) | last | if . == null then [] else [.status, (.conclusion // ""), .html_url, .started_at] end | @tsv' 2>/dev/null || true)"
  if [[ -n "$check_line" ]]; then
    IFS=$'\t' read -r check_status check_conclusion check_url check_started <<<"$check_line"
    latest_state="status=${check_status:-unknown} conclusion=${check_conclusion:-pending} started=${check_started:-unknown}"
    echo "check-evaluation: $latest_state"
    if [[ "$check_status" == "completed" && "$check_conclusion" == "success" ]]; then
      echo "Independent evaluation gate passed for $head_sha."
      echo "Merge remains manual. Deliberate command:"
      echo "gh pr merge $pr_number --repo $repo_name --merge"
      exit 0
    fi
  else
    latest_state="check-evaluation not found yet"
    echo "check-evaluation: $latest_state"
  fi
  sleep "$poll_seconds"
done

die "timed out after ${timeout_seconds}s waiting for check-evaluation to pass ($latest_state)"
