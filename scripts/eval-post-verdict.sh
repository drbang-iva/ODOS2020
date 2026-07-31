#!/usr/bin/env bash
set -euo pipefail

# Evaluation is deliberately split in two: eval-worktree.sh proves an exact PR
# head; this script posts only the evaluator-supplied verdict and waits for the
# gate. Merge remains a separate, deliberate command and is never automated.

usage() {
  echo "Usage: scripts/eval-post-verdict.sh <PR#> <PASS|FAIL> <model> [--dry-run] [--ack-comments <N>] [--ack-pr-agent <N>]" >&2
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
ack_pr_agent=""
ack_pr_agent_set=false

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
    --ack-pr-agent)
      [[ "$ack_pr_agent_set" == false ]] || die "--ack-pr-agent may be specified only once"
      [[ $# -ge 2 ]] || die "--ack-pr-agent requires a non-negative integer"
      [[ "$2" =~ ^(0|[1-9][0-9]*)$ ]] || die "--ack-pr-agent must be a non-negative integer"
      ack_pr_agent="$2"
      ack_pr_agent_set=true
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
command -v jq >/dev/null 2>&1 || die "required command not found: jq"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

if ! pr_agent_review="$(gh api --paginate --slurp "repos/$repo_name/issues/$pr_number/comments?per_page=100" | jq -c '
  def clean_title:
    gsub("<[^>]*>"; "")
    | gsub("&nbsp;"; " ")
    | gsub("&amp;"; "&")
    | gsub("&lt;"; "<")
    | gsub("&gt;"; ">")
    | gsub("&#39;"; "\u0027")
    | gsub("&quot;"; "\"")
    | gsub("[[:space:]]+"; " ")
    | sub("^ "; "")
    | sub(" $"; "")
    | explode
    | map(select(. >= 32 and . != 127 and (. < 128 or . > 159)))
    | implode;
  [.[][] | select(
    (.user.login // "") == "github-actions[bot]"
    and ((.body // "") | startswith("## PR Reviewer Guide"))
  )]
  | sort_by(.updated_at, .id)
  | last as $review
  | if $review == null then
      {present: false, review_sha: "", findings: []}
    else
      ($review.body // "") as $body
      | {
          present: true,
          review_sha: (
            try (
              $body
              | capture("Review updated until commit[^\\n]*/commit/(?<sha>[0-9a-fA-F]{40})")
              | .sha
              | ascii_downcase
            ) catch ""
          ),
          findings: [
            $body
            | scan("<details><summary><a href=[\"\u0027](?<href>[^\"\u0027]*#diff[^\"\u0027]*)[\"\u0027][^>]*>(?<title>[\\s\\S]*?)</a>"; "g")
            | {href: .[0], title: (.[1] | clean_title)}
          ]
        }
    end
')"; then
  die "could not fetch or parse PR-Agent review for PR #$pr_number"
fi

pr_agent_present="$(printf '%s\n' "$pr_agent_review" | jq -r '.present')"
pr_agent_review_sha="$(printf '%s\n' "$pr_agent_review" | jq -r '.review_sha')"
pr_agent_findings=()
while IFS= read -r pr_agent_finding; do
  [[ -n "$pr_agent_finding" ]] || continue
  pr_agent_findings+=("$pr_agent_finding")
done < <(printf '%s\n' "$pr_agent_review" | jq -r '.findings[].title')
pr_agent_count="${#pr_agent_findings[@]}"

if [[ "$pr_agent_present" == "false" ]]; then
  echo "PR-Agent review: NOT FOUND"
  echo "  WARNING: PR-Agent did not review this head; --ack-pr-agent 0 is required to proceed."
else
  [[ "$pr_agent_review_sha" =~ ^[0-9a-f]{40}$ ]] \
    || die "could not parse PR-Agent's reviewed head SHA; re-run PR-Agent before evaluating"
  [[ "$pr_agent_review_sha" == "$head_sha" ]] \
    || die "PR-Agent review is stale: reviewed $pr_agent_review_sha, current head is $head_sha; push or re-run PR-Agent before evaluating"
  echo "PR-Agent review head: $pr_agent_review_sha (matches current head)"
  echo "PR-Agent findings: $pr_agent_count"
  if [[ "$pr_agent_count" -eq 0 ]]; then
    echo "  (none)"
  else
    for pr_agent_finding in "${pr_agent_findings[@]}"; do
      printf '  - %s\n' "$pr_agent_finding"
    done
  fi
fi

if [[ "$ack_pr_agent_set" == true && "$ack_pr_agent" -ne "$pr_agent_count" ]]; then
  die "--ack-pr-agent must equal the PR-Agent finding count: expected $pr_agent_count, received $ack_pr_agent; review and adjudicate the findings listed above"
fi
if [[ "$pr_agent_present" == "false" && "$ack_pr_agent_set" == false ]]; then
  die "--ack-pr-agent 0 is required because PR-Agent did not review this head"
fi

marker="Evaluated-by: $model — $verdict
Head-SHA: $head_sha"

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
if [[ "$pr_agent_count" -gt 0 && "$ack_pr_agent_set" == false ]]; then
  die "--ack-pr-agent $pr_agent_count is required before posting; review and adjudicate the $pr_agent_count PR-Agent finding(s) listed above"
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
