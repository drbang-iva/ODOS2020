#!/usr/bin/env bash

# shellcheck disable=SC2154 # The caller owns repo_name, pr_number, and head_sha.

load_coderabbit_review_status() {
  local coderabbit_rows state commit_id submitted_at normalized_commit

  coderabbit_review_at_head=false
  coderabbit_head_state=""
  coderabbit_head_sha=""
  coderabbit_head_submitted_at=""
  coderabbit_last_sha=""
  coderabbit_last_submitted_at=""

  if ! coderabbit_rows="$(gh api --paginate "repos/$repo_name/pulls/$pr_number/reviews" \
    --jq '.[] | select((((.user.login // "") | ascii_downcase) == "coderabbitai[bot]") or (((.user.login // "") | ascii_downcase) == "coderabbitai")) | select((.submitted_at // "") != "") | [(.state // "UNKNOWN"), (.commit_id // ""), .submitted_at] | @tsv')"; then
    die "could not fetch CodeRabbit review submissions for PR #$pr_number"
  fi

  while IFS=$'\t' read -r state commit_id submitted_at; do
    [[ -n "$state" ]] || continue
    normalized_commit="$(printf '%s' "$commit_id" | tr '[:upper:]' '[:lower:]')"
    [[ "$normalized_commit" =~ ^[0-9a-f]{40}$ ]] \
      || die "CodeRabbit review submission has no reliable commit SHA for PR #$pr_number"
    [[ -n "$submitted_at" ]] \
      || die "CodeRabbit review submission has no reliable submitted-at timestamp for PR #$pr_number"

    if [[ -z "$coderabbit_last_submitted_at" || "$submitted_at" > "$coderabbit_last_submitted_at" ]]; then
      coderabbit_last_sha="$normalized_commit"
      coderabbit_last_submitted_at="$submitted_at"
    fi
    if [[ "$normalized_commit" == "$head_sha" ]] \
      && [[ -z "$coderabbit_head_submitted_at" || "$submitted_at" > "$coderabbit_head_submitted_at" ]]; then
      coderabbit_review_at_head=true
      coderabbit_head_state="$state"
      coderabbit_head_sha="$normalized_commit"
      coderabbit_head_submitted_at="$submitted_at"
    fi
  done <<<"$coderabbit_rows"
}

print_coderabbit_review_status() {
  if [[ "$coderabbit_review_at_head" == true ]]; then
    printf 'CodeRabbit review at this head: YES (submitted %s at %s)\n' \
      "$coderabbit_head_state" "${coderabbit_head_sha:0:8}"
  elif [[ -n "$coderabbit_last_sha" ]]; then
    printf 'CodeRabbit review at this head: NO — last review was at %s (STALE)\n' \
      "${coderabbit_last_sha:0:8}"
  else
    echo "CodeRabbit review at this head: NO — no CodeRabbit review on this PR"
  fi
}
