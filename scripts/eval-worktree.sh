#!/usr/bin/env bash
set -uo pipefail

# Evaluation is deliberately split in two: this script prepares and verifies an
# exact-head worktree; eval-post-verdict.sh posts only the evaluator's deliberate
# verdict. Neither script merges, preserving the final human-in-the-loop step.
# This executes same-repository PR npm scripts on the host and is not an OS
# sandbox. Fork PRs are refused; evaluate untrusted code in a credential-free runner.

usage() {
  echo "Usage: scripts/eval-worktree.sh <PR#> [--keep]" >&2
}

die() {
  echo "eval-worktree: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

tap_value() {
  local key="$1"
  local log_path="$2"
  awk -v key="$key" '$1 == "#" && $2 == key { value=$3 } END { if (value != "") print value }' "$log_path"
}

step_detail() {
  local kind="$1"
  local log_path="$2"
  local status="$3"
  local tests pass fail skipped modules preflight

  case "$kind" in
    mcp-build)
      [[ "$status" -eq 0 ]] && echo "0 TypeScript errors" || echo "exit $status; see $log_path"
      ;;
    ui-build)
      modules="$(sed -nE 's/.*[[:space:]]([0-9]+) modules transformed.*/\1/p' "$log_path" | tail -n 1)"
      [[ "$status" -eq 0 ]] && echo "${modules:-unknown} modules transformed" || echo "exit $status; see $log_path"
      ;;
    mcp-test|ui-test)
      tests="$(tap_value tests "$log_path")"
      pass="$(tap_value pass "$log_path")"
      fail="$(tap_value fail "$log_path")"
      skipped="$(tap_value skipped "$log_path")"
      echo "${tests:-unknown} total; ${pass:-unknown} passed; ${fail:-unknown} failed; ${skipped:-unknown} skipped"
      ;;
    preflight)
      preflight="$(sed -nE 's/.*complete: ([0-9]+) warning\(s\), ([0-9]+) hard block\(s\).*/\1 warnings; \2 hard blocks/p' "$log_path" | tail -n 1)"
      echo "${preflight:-exit $status; see $log_path}"
      ;;
    *)
      echo "exit $status"
      ;;
  esac
}

run_step() {
  local label="$1"
  local kind="$2"
  local directory="$3"
  shift 3
  local slug log_path status result detail
  local -a pipeline_status
  slug="$(printf '%s' "$label" | tr '[:upper:] ' '[:lower:]-' | tr -cd '[:alnum:]-')"
  log_path="$log_dir/$slug.log"

  echo
  echo "==> $label"
  (cd "$directory" && "$@") 2>&1 | tee "$log_path"
  pipeline_status=("${PIPESTATUS[@]}")
  status="${pipeline_status[0]}"
  if [[ "${pipeline_status[1]}" -ne 0 ]]; then
    status="${pipeline_status[1]}"
  fi
  if [[ "$status" -eq 0 ]]; then
    result="PASS"
  else
    result="FAIL"
    overall_status=1
  fi
  detail="$(step_detail "$kind" "$log_path" "$status")"
  summary_labels+=("$label")
  summary_results+=("$result")
  summary_details+=("$detail")
}

print_review_feedback() {
  local inline_rows review_rows sorted_inline_rows thread_rows
  local thread_root_id path line author original_commit_id commit_id first_line
  local normalized_original_commit normalized_commit classification reanchor_note
  local thread_state marker location previous_location state
  local current_count=0
  local indeterminate_count=0
  local stale_count=0
  local total_count=0

  echo
  echo "Inline review comments"
  echo "----------------------"

  if inline_rows="$(gh api --paginate "repos/$repo_name/pulls/$pr_number/comments" \
    --jq '.[] | [((.in_reply_to_id // .id) | tostring), ((.path // "?") | explode | map(select(. >= 32 and . != 127 and (. < 128 or . > 159))) | implode), ((.line // .original_line // "?") | tostring), (.user.login // "unknown"), (.original_commit_id // "?"), (.commit_id // "?"), ((((.body // "") | split("\n")[0]) // "") | explode | map(select(. >= 32 and . != 127 and (. < 128 or . > 159))) | implode)] | @tsv')"; then
    if [[ -n "$inline_rows" ]]; then
      # GraphQL and jq variables are intentionally passed literally to gh.
      # shellcheck disable=SC2016
      if ! thread_rows="$(gh api graphql --paginate \
        -f owner="${repo_name%%/*}" \
        -f name="${repo_name#*/}" \
        -F number="$pr_number" \
        -f query='query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $endCursor) {
                nodes {
                  isResolved
                  comments(first: 1) { nodes { databaseId } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }' \
        --jq '.data.repository.pullRequest.reviewThreads.nodes[] as $thread | $thread.comments.nodes[] | [(.databaseId | tostring), ($thread.isResolved | tostring)] | @tsv')"; then
        thread_rows=""
        echo "Thread resolution unavailable; gh api GraphQL request failed."
      fi

      sorted_inline_rows="$(printf '%s\n' "$inline_rows" | LC_ALL=C sort -t $'\t' -k2,2 -k3,3n)"
      previous_location=""
      while IFS=$'\t' read -r thread_root_id path line author original_commit_id commit_id first_line; do
        [[ -n "$path" ]] || continue
        normalized_original_commit="$(printf '%s' "$original_commit_id" | tr '[:upper:]' '[:lower:]')"
        normalized_commit="$(printf '%s' "$commit_id" | tr '[:upper:]' '[:lower:]')"
        if [[ "$normalized_original_commit" =~ ^[0-9a-f]{40}$ ]]; then
          marker="${normalized_original_commit:0:7}"
          if [[ "$normalized_original_commit" == "$head_sha" ]]; then
            classification="CURRENT"
            current_count=$((current_count + 1))
          else
            classification="STALE"
            stale_count=$((stale_count + 1))
          fi
        else
          marker="unknown"
          classification="CURRENT (fail-closed: write-time provenance unavailable)"
          current_count=$((current_count + 1))
          indeterminate_count=$((indeterminate_count + 1))
        fi
        reanchor_note=""
        if [[ "$normalized_commit" =~ ^[0-9a-f]{40}$ && "$normalized_commit" != "$normalized_original_commit" ]]; then
          reanchor_note="; GitHub commit ${normalized_commit:0:7}"
        fi
        thread_state="$(awk -F $'\t' -v id="$thread_root_id" '$1 == id { print $2; exit }' <<<"$thread_rows")"
        [[ "$thread_state" == "true" || "$thread_state" == "false" ]] || thread_state="unknown"
        total_count=$((total_count + 1))
        location="$path:$line"
        if [[ "$location" != "$previous_location" ]]; then
          printf '%s\n' "$location"
          previous_location="$location"
        fi
        printf '  - %s — written %s %s%s — thread isResolved=%s — %s\n' \
          "$author" "$marker" "$classification" "$reanchor_note" "$thread_state" "${first_line:-(no comment body)}"
      done <<<"$sorted_inline_rows"
    fi

    if [[ "$total_count" -eq 0 ]]; then
      echo "Inline review comments: 0 at this head."
    else
      echo "Inline review comments by write-time provenance: $current_count current ($indeterminate_count provenance unavailable), $stale_count stale ($total_count total)."
    fi
  else
    echo "Inline review comments unavailable; gh api request failed."
  fi

  load_bot_review_status
  print_bot_review_status

  echo
  echo "Review submissions"
  if ! review_rows="$(gh api --paginate "repos/$repo_name/pulls/$pr_number/reviews" \
    --jq '.[] | [(.state // "UNKNOWN"), (.user.login // "unknown"), (.commit_id // ""), ((((.body // "") | split("\n")[0]) // "") | explode | map(select(. >= 32 and . != 127 and (. < 128 or . > 159))) | implode)] | @tsv')"; then
    echo "  Review submissions unavailable; gh api request failed."
    return 0
  fi
  if [[ -z "$review_rows" ]]; then
    echo "  (none)"
    return 0
  fi
  while IFS=$'\t' read -r state author commit_id first_line; do
    [[ -n "$state" ]] || continue
    normalized_commit="$(printf '%s' "$commit_id" | tr '[:upper:]' '[:lower:]')"
    marker=""
    [[ "$normalized_commit" == "$head_sha" ]] || marker=" STALE"
    printf '  - %s — %s — %s%s — %s\n' "$state" "$author" "${normalized_commit:0:7}" "$marker" "${first_line:-(no review body)}"
  done <<<"$review_rows"
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

pr_number="$1"
keep_worktree=false
if [[ ! "$pr_number" =~ ^[1-9][0-9]*$ ]]; then
  die "PR number must be a positive integer"
fi
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--keep" ]] || { usage; exit 2; }
  keep_worktree=true
fi

require_command gh
require_command git
require_command npm
require_command mktemp

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/bot-review-status.sh
source "$script_dir/lib/bot-review-status.sh"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
repo_name="${GH_REPO:-$(cd "$repo_root" && gh repo view --json nameWithOwner --jq .nameWithOwner)}"
pr_metadata="$(gh pr view "$pr_number" --repo "$repo_name" --json headRefName,headRefOid,isCrossRepository --jq '[.headRefName, .headRefOid, .isCrossRepository] | @tsv')"
IFS=$'\t' read -r head_branch head_sha is_cross_repository <<<"$pr_metadata"
[[ -n "$head_branch" ]] || die "could not resolve a source branch for PR #$pr_number"
[[ "$head_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die "could not resolve a full head SHA for PR #$pr_number"
[[ "$is_cross_repository" == "false" ]] || die "fork PRs are not executed on the host; use a credential-free isolated runner"
head_sha="$(printf '%s' "$head_sha" | tr '[:upper:]' '[:lower:]')"

if ! git -C "$repo_root" cat-file -e "${head_sha}^{commit}" 2>/dev/null; then
  echo "Fetching exact PR head $head_sha..."
  git -C "$repo_root" fetch --no-tags origin "pull/$pr_number/head" || die "could not fetch PR #$pr_number head"
  fetched_sha="$(git -C "$repo_root" rev-parse FETCH_HEAD)"
  [[ "$fetched_sha" == "$head_sha" ]] || die "PR head changed from $head_sha to $fetched_sha while fetching; rerun"
fi

worktree_parent="${ODOS_EVAL_WORKTREE_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$worktree_parent"
worktree_path="$(mktemp -d "$worktree_parent/odos-eval-pr${pr_number}-${head_sha:0:8}.XXXXXX")"
rmdir "$worktree_path"
worktree_created=false

# shellcheck disable=SC2317,SC2329 # Invoked by the EXIT, INT, and TERM traps below.
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$worktree_created" == true && "$keep_worktree" == false ]]; then
    echo
    echo "Removing evaluation worktree: $worktree_path"
    git -C "$repo_root" worktree remove --force -- "$worktree_path" || true
    git -C "$repo_root" worktree prune || true
  fi
  exit "$status"
}

if [[ "$keep_worktree" == false ]]; then
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi

git -C "$repo_root" worktree add --detach "$worktree_path" "$head_sha"
worktree_created=true
actual_sha="$(git -C "$worktree_path" rev-parse HEAD)"
[[ "$actual_sha" == "$head_sha" ]] || die "worktree HEAD $actual_sha does not match PR head $head_sha"
current_head_sha="$(gh pr view "$pr_number" --repo "$repo_name" --json headRefOid --jq .headRefOid | tr '[:upper:]' '[:lower:]')"
[[ "$current_head_sha" == "$head_sha" ]] || die "PR head changed from $head_sha to $current_head_sha while preparing the worktree; rerun"

echo "PR:        #$pr_number ($repo_name)"
echo "Head SHA:  $head_sha"
echo "Worktree:  $worktree_path"
echo "Mode:      $([[ "$keep_worktree" == true ]] && echo kept || echo cleanup-on-exit)"

log_dir="$worktree_path/.odos/eval-logs"
mkdir -p "$log_dir"
overall_status=0
summary_labels=()
summary_results=()
summary_details=()

run_step "Root dependency install" install "$worktree_path" npm ci --no-audit --no-fund
run_step "MCP dependency install" install "$worktree_path/mcp" npm ci --no-audit --no-fund
run_step "UI dependency install" install "$worktree_path/ui" npm ci --no-audit --no-fund
run_step "MCP build" mcp-build "$worktree_path/mcp" npm run build
run_step "MCP full test" mcp-test "$worktree_path/mcp" npm test
run_step "UI build" ui-build "$worktree_path/ui" env ODOS_BUILD_BRANCH="$head_branch" npm run build
run_step "UI full test" ui-test "$worktree_path/ui" npm test
run_step "Root preflight" preflight "$worktree_path" npm run preflight

current_head_sha="$(gh pr view "$pr_number" --repo "$repo_name" --json headRefOid --jq .headRefOid | tr '[:upper:]' '[:lower:]')"
summary_labels+=("PR head stability")
if [[ "$current_head_sha" == "$head_sha" ]]; then
  summary_results+=("PASS")
  summary_details+=("still $head_sha")
else
  summary_results+=("FAIL")
  summary_details+=("changed to $current_head_sha; rerun required")
  overall_status=1
fi

echo
echo "Evaluation gate summary"
echo "-----------------------"
for ((index = 0; index < ${#summary_labels[@]}; index++)); do
  printf '%-28s %-4s %s\n' "${summary_labels[$index]}" "${summary_results[$index]}" "${summary_details[$index]}"
done
print_review_feedback
echo
echo "Exact evaluated head: $head_sha"
if [[ "$keep_worktree" == true ]]; then
  echo "Worktree kept for manual review: $worktree_path"
  echo "Remove deliberately when finished: git -C '$repo_root' worktree remove --force -- '$worktree_path'"
else
  echo "Worktree used for this run: $worktree_path"
  echo "It will be removed on exit. Rerun with --keep for manual diff review or code inspection."
fi

exit "$overall_status"
