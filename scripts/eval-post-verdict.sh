#!/usr/bin/env bash
set -euo pipefail

# Evaluation is deliberately split in two: eval-worktree.sh proves an exact PR
# head; this script posts only the evaluator-supplied verdict and waits for the
# gate. Merge remains a separate, deliberate command and is never automated.

usage() {
  echo "Usage: scripts/eval-post-verdict.sh <PR#> <PASS|FAIL> <model> [--dry-run] [--ack-comments <N>] [--ack-no-bot-review]" >&2
}

die() {
  echo "eval-post-verdict: $*" >&2
  exit 1
}

if [[ $# -lt 3 ]]; then
  usage
  exit 2
fi

pr_number="$1"
verdict="$2"
model="$3"
dry_run=false
ack_comments=""
ack_comments_set=false
ack_no_bot_review=false

[[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || die "PR number must be a positive integer"
[[ "$verdict" == "PASS" || "$verdict" == "FAIL" ]] || die "verdict must be exactly PASS or FAIL"
[[ "$model" != *$'\n'* && "$model" != *$'\r'* ]] || die "evaluator model must be one line"

shift 3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      [[ "$dry_run" == false ]] || die "--dry-run may be specified only once"
      dry_run=true
      shift
      ;;
    --ack-comments)
      [[ "$ack_comments_set" == false ]] || die "--ack-comments may be specified only once"
      [[ $# -ge 2 ]] || die "--ack-comments requires a non-negative integer"
      [[ "$2" =~ ^(0|[1-9][0-9]*)$ ]] || die "--ack-comments must be a non-negative integer"
      ack_comments="$2"
      ack_comments_set=true
      shift 2
      ;;
    --ack-no-bot-review)
      [[ "$ack_no_bot_review" == false ]] || die "--ack-no-bot-review may be specified only once"
      ack_no_bot_review=true
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

trusted_model_pattern='^(Fable|(Claude[[:space:]]+)?Opus)([[:space:]]+[0-9]+(\.[0-9]+)*)?([[:space:]]+\(Claude\))?$'
if ! printf '%s\n' "$model" | grep -Eiq "$trusted_model_pattern"; then
  die "evaluator model '$model' would be rejected by evaluation-verdict.cjs"
fi

command -v gh >/dev/null 2>&1 || die "required command not found: gh"
command -v git >/dev/null 2>&1 || die "required command not found: git"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/coderabbit-review-status.sh
source "$script_dir/lib/coderabbit-review-status.sh"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
repo_name="${GH_REPO:-$(cd "$repo_root" && gh repo view --json nameWithOwner --jq .nameWithOwner)}"
head_sha="$(gh pr view "$pr_number" --repo "$repo_name" --json headRefOid --jq .headRefOid)"
[[ "$head_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die "could not resolve a full head SHA for PR #$pr_number"
head_sha="$(printf '%s' "$head_sha" | tr '[:upper:]' '[:lower:]')"
expected_conclusion="success"
if [[ "$verdict" == "FAIL" ]]; then
  expected_conclusion="failure"
fi

evaluation_workflow_run_id() {
  gh api \
    "repos/$repo_name/actions/workflows/evaluation-gate.yml/runs?event=pull_request_target&head_sha=$head_sha&per_page=100" \
    --jq ".workflow_runs | map(select(any(.pull_requests[]?; .number == $pr_number))) | sort_by(.created_at) | last | .id // empty"
}

if ! inline_comment_rows="$(gh api --paginate "repos/$repo_name/pulls/$pr_number/comments" \
  --jq '.[] | [((.path // "?") | explode | map(select(. >= 32 and . != 127 and (. < 128 or . > 159))) | implode), ((.line // .original_line // "?") | tostring), (.user.login // "unknown"), (.commit_id // ""), ((((.body // "") | split("\n")[0]) // "") | explode | map(select(. >= 32 and . != 127 and (. < 128 or . > 159))) | implode)] | @tsv')"; then
  die "could not fetch inline review comments for PR #$pr_number"
fi

current_comments=()
if [[ -n "$inline_comment_rows" ]]; then
  while IFS=$'\t' read -r comment_path comment_line comment_author comment_commit_id comment_first_line; do
    [[ -n "$comment_path" ]] || continue
    normalized_comment_commit="$(printf '%s' "$comment_commit_id" | tr '[:upper:]' '[:lower:]')"
    [[ "$normalized_comment_commit" == "$head_sha" ]] || continue
    current_comments+=("$comment_path:$comment_line — $comment_author — ${comment_first_line:-(no comment body)}")
  done <<<"$inline_comment_rows"
fi
current_count="${#current_comments[@]}"

echo "Current-head inline review comments: $current_count"
if [[ "$current_count" -eq 0 ]]; then
  echo "  (none)"
else
  for current_comment in "${current_comments[@]}"; do
    printf '  - %s\n' "$current_comment"
  done
fi

load_coderabbit_review_status
print_coderabbit_review_status
# shellcheck disable=SC2154 # Assigned by load_coderabbit_review_status.
if [[ "$coderabbit_review_at_head" == true && "$ack_no_bot_review" == true ]]; then
  die "--ack-no-bot-review is invalid because CodeRabbit submitted $coderabbit_head_state at $head_sha; omit the flag"
fi
if [[ "$coderabbit_review_at_head" == false && "$ack_no_bot_review" == false ]]; then
  die "no CodeRabbit review exists at $head_sha; the green CodeRabbit check is not evidence of a review. Re-trigger with '@coderabbitai full review' and wait for it, or pass --ack-no-bot-review to record a deliberate decision to proceed without one."
fi

marker="Evaluated-by: $model — $verdict
Head-SHA: $head_sha"
if [[ "$ack_no_bot_review" == true ]]; then
  marker="$marker
Bot-review-at-head: NONE (acknowledged)"
fi

if [[ "$dry_run" == true ]]; then
  workflow_run_id="$(evaluation_workflow_run_id)"
  [[ "$workflow_run_id" =~ ^[1-9][0-9]*$ ]] \
    || die "could not find an evaluation-gate pull_request_target run for $head_sha"
  echo "Dry run only; no comment will be posted."
  echo "PR: #$pr_number ($repo_name)"
  printf '%s\n' "$marker"
  echo "Would wait for check-evaluation conclusion=$expected_conclusion."
  echo "Would then re-run evaluation-gate workflow run $workflow_run_id for $head_sha."
  if [[ "$verdict" == "PASS" ]]; then
    echo "Merge remains manual. Deliberate command:"
    echo "gh pr merge $pr_number --repo $repo_name --squash"
  else
    echo "FAIL verdict would be recorded; merge blocked as intended."
  fi
  exit 0
fi

if [[ "$current_count" -gt 0 && "$ack_comments_set" == false ]]; then
  die "--ack-comments $current_count is required before posting; review and adjudicate the $current_count current-head inline comment(s) listed above"
fi
if [[ "$ack_comments_set" == true && "$ack_comments" -ne "$current_count" ]]; then
  die "--ack-comments must equal the current-head inline comment count: expected $current_count, received $ack_comments; review and adjudicate the comments listed above"
fi

existing_check_ids="$(gh api "repos/$repo_name/commits/$head_sha/check-runs?check_name=check-evaluation&per_page=100" \
  --jq '.check_runs[] | select(.name == "check-evaluation") | .id')"

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
gate_confirmed=false
echo "Polling check-evaluation for conclusion=$expected_conclusion for up to ${timeout_seconds}s; other conclusions will not stop the poll."

while [[ $(date +%s) -lt "$deadline" ]]; do
  check_rows="$(gh api "repos/$repo_name/commits/$head_sha/check-runs?check_name=check-evaluation&per_page=100" \
    --jq '[.check_runs[] | select(.name == "check-evaluation")] | sort_by(.started_at)[] | [.id, .status, (.conclusion // ""), .html_url, .started_at] | @tsv' 2>/dev/null || true)"
  check_line=""
  while IFS=$'\t' read -r check_id check_status check_conclusion check_url check_started; do
    [[ -n "$check_id" ]] || continue
    if ! printf '%s\n' "$existing_check_ids" | grep -Fxq "$check_id"; then
      check_line="$check_status"$'\t'"$check_conclusion"$'\t'"$check_url"$'\t'"$check_started"
    fi
  done <<<"$check_rows"
  if [[ -n "$check_line" ]]; then
    IFS=$'\t' read -r check_status check_conclusion check_url check_started <<<"$check_line"
    latest_state="status=${check_status:-unknown} conclusion=${check_conclusion:-pending} started=${check_started:-unknown}"
    echo "check-evaluation: $latest_state"
    if [[ "$check_status" == "completed" && "$check_conclusion" == "$expected_conclusion" ]]; then
      gate_confirmed=true
      break
    fi
  else
    latest_state="check-evaluation not found yet"
    echo "check-evaluation: $latest_state"
  fi
  sleep "$poll_seconds"
done

if [[ "$gate_confirmed" != true ]]; then
  die "timed out after ${timeout_seconds}s waiting for check-evaluation conclusion=$expected_conclusion ($latest_state)"
fi

workflow_run_id="$(evaluation_workflow_run_id)"
[[ "$workflow_run_id" =~ ^[1-9][0-9]*$ ]] \
  || die "could not find an evaluation-gate pull_request_target run for $head_sha"
previous_attempt="$(gh api "repos/$repo_name/actions/runs/$workflow_run_id" --jq .run_attempt)"
[[ "$previous_attempt" =~ ^[1-9][0-9]*$ ]] \
  || die "could not resolve the current attempt for evaluation-gate workflow run $workflow_run_id"

echo "check-evaluation reached conclusion=$expected_conclusion for $head_sha."
echo "Re-running evaluation-gate workflow run $workflow_run_id for the PR head..."
gh run rerun "$workflow_run_id" --repo "$repo_name" \
  || die "failed to trigger rerun of evaluation-gate workflow run $workflow_run_id"

deadline=$(( $(date +%s) + timeout_seconds ))
latest_state="waiting for run attempt $(( previous_attempt + 1 ))"
while [[ $(date +%s) -lt "$deadline" ]]; do
  workflow_state="$(gh api "repos/$repo_name/actions/runs/$workflow_run_id" \
    --jq '[.run_attempt, .status, (.conclusion // "")] | @tsv' 2>/dev/null || true)"
  if [[ -n "$workflow_state" ]]; then
    IFS=$'\t' read -r workflow_attempt workflow_status workflow_conclusion <<<"$workflow_state"
    latest_state="attempt=${workflow_attempt:-unknown} status=${workflow_status:-unknown} conclusion=${workflow_conclusion:-pending}"
    echo "evaluation-gate: $latest_state"
    if [[ "$workflow_attempt" =~ ^[1-9][0-9]*$ ]] \
      && [[ "$workflow_attempt" -gt "$previous_attempt" ]] \
      && [[ "$workflow_status" == "completed" ]]; then
      job_state="$(gh api "repos/$repo_name/actions/runs/$workflow_run_id/jobs?filter=latest" \
        --jq '[.jobs[] | select(.name == "publish-evaluation-status")] | last | if . == null then empty else [.status, (.conclusion // "")] | @tsv end' \
        2>/dev/null || true)"
      if [[ -z "$job_state" ]]; then
        sleep "$poll_seconds"
        continue
      fi
      IFS=$'\t' read -r job_status job_conclusion <<<"$job_state"
      [[ "$job_status" == "completed" && "$job_conclusion" == "$expected_conclusion" ]] \
        || die "publish-evaluation-status finished unexpectedly (status=${job_status:-not found} conclusion=${job_conclusion:-unknown}; expected $expected_conclusion)"
      if [[ "$verdict" == "PASS" ]]; then
        echo "publish-evaluation-status is green for $head_sha."
        echo "Merge remains manual. Deliberate command:"
        echo "gh pr merge $pr_number --repo $repo_name --squash"
      else
        echo "FAIL verdict recorded; publish-evaluation-status confirms failure; merge blocked as intended."
      fi
      exit 0
    fi
  fi
  sleep "$poll_seconds"
done

die "timed out after ${timeout_seconds}s waiting for evaluation-gate workflow run $workflow_run_id to finish ($latest_state)"
