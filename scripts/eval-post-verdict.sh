#!/usr/bin/env bash
set -euo pipefail

# Evaluation is deliberately split in two: eval-worktree.sh proves an exact PR
# head; this script posts only the evaluator-supplied verdict and waits for the
# gate. Merge remains a separate, deliberate command and is never automated.

usage() {
  echo "Usage: scripts/eval-post-verdict.sh <PR#> <PASS|FAIL> <model> [--dry-run] [--ack-comments <N>]" >&2
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
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
repo_name="${GH_REPO:-$(cd "$repo_root" && gh repo view --json nameWithOwner --jq .nameWithOwner)}"
head_sha="$(gh pr view "$pr_number" --repo "$repo_name" --json headRefOid --jq .headRefOid)"
[[ "$head_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die "could not resolve a full head SHA for PR #$pr_number"
head_sha="$(printf '%s' "$head_sha" | tr '[:upper:]' '[:lower:]')"

if ! inline_comment_rows="$(gh api --paginate "repos/$repo_name/pulls/$pr_number/comments" \
  --jq '.[] | [(.path // "?"), ((.line // .original_line // "?") | tostring), (.user.login // "unknown"), (.commit_id // ""), ((((.body // "") | split("\n")[0]) // "") | explode | map(select(. >= 32 and . != 127 and (. < 128 or . > 159))) | implode)] | @tsv')"; then
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

marker="Evaluated-by: $model — $verdict
Head-SHA: $head_sha"

if [[ "$dry_run" == true ]]; then
  echo "Dry run only; no comment will be posted."
  echo "PR: #$pr_number ($repo_name)"
  printf '%s\n' "$marker"
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
echo "Polling check-evaluation for up to ${timeout_seconds}s; existing failures are expected and will not stop the poll."

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
