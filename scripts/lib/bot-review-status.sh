#!/usr/bin/env bash

# shellcheck disable=SC2154,SC2034 # The caller owns repo_name/pr_number/head_sha; the
# bot_review_* variables are set here and consumed by the sourcing script.

# Bot-review status for the evaluation gate.
#
# Recognises any configured review bot, not one vendor. CodeRabbit + PR-Agent are
# active. Greptile is not triggering; do not wait for it. Historical entries remain
# recognised. CodeRabbit review submissions are accepted via BOT_REVIEW_LOGINS;
# its commit status is not read by this helper. BOT_REVIEW_CHECKS matches check runs,
# not commit statuses. A vendor change must not turn --ack-no-bot-review into
# boilerplate while a recognised review sits on the PR unread.
#
# TWO SIGNALS, because one is not enough:
#
#   1. A review SUBMISSION at the head — strong evidence: the bot looked and had
#      something to say.
#   2. A completed CHECK RUN at the head from a known bot app — weaker but real: the bot
#      ran and finished. A bot with nothing to add posts no review, so absence of (1)
#      alone cannot distinguish "did not run" from "ran clean" for check-run bots.
#
# Either signal satisfies the gate. Neither means no supported signal at this head, and
# --ack-no-bot-review is then a deliberate, recorded decision rather than a rubber stamp.

# Review-submission logins, lowercased. Add a bot here when it is adopted.
BOT_REVIEW_LOGINS=(
  "greptile-apps[bot]"
  "greptile-apps"
  "coderabbitai[bot]"
  "coderabbitai"
)

# Check-run app slugs paired with a name fragment, so an unrelated check from a shared
# app (github-actions runs everything) cannot be mistaken for a bot review.
# Format: "<app-slug>|<lowercased name fragment>"
BOT_REVIEW_CHECKS=(
  "greptile-apps|greptile"
  "github-actions|pr-agent"
)

load_bot_review_status() {
  local rows state commit_id submitted_at normalized_commit login
  local jq_login_filter check_rows app name conclusion status entry frag slug

  bot_review_at_head=false
  bot_review_head_source=""
  bot_review_head_state=""
  bot_review_head_sha=""
  bot_review_head_submitted_at=""
  bot_review_last_sha=""
  bot_review_last_submitted_at=""
  bot_review_head_evidence=""

  # ---- Signal 1: review submissions -------------------------------------------------
  jq_login_filter="$(printf '"%s",' "${BOT_REVIEW_LOGINS[@]}")"
  jq_login_filter="[${jq_login_filter%,}]"

  if ! rows="$(gh api --paginate "repos/$repo_name/pulls/$pr_number/reviews" \
    --jq "$jq_login_filter as \$bots | .[] | select((((.user.login // \"\") | ascii_downcase)) as \$l | \$bots | index(\$l)) | select((.submitted_at // \"\") != \"\") | [(.state // \"UNKNOWN\"), (.commit_id // \"\"), .submitted_at, ((.user.login // \"\") | ascii_downcase)] | @tsv")"; then
    die "could not fetch bot review submissions for PR #$pr_number"
  fi

  while IFS=$'\t' read -r state commit_id submitted_at login; do
    [[ -n "$state" ]] || continue
    case "$state" in
      APPROVED|CHANGES_REQUESTED|COMMENTED) ;;
      DISMISSED) continue ;;
      *) die "bot review submission has unknown state '$state' for PR #$pr_number" ;;
    esac
    normalized_commit="$(printf '%s' "$commit_id" | tr '[:upper:]' '[:lower:]')"
    [[ "$normalized_commit" =~ ^[0-9a-f]{40}$ ]] \
      || die "bot review submission has no reliable commit SHA for PR #$pr_number"
    [[ -n "$submitted_at" ]] \
      || die "bot review submission has no reliable submitted-at timestamp for PR #$pr_number"

    if [[ -z "$bot_review_last_submitted_at" || "$submitted_at" > "$bot_review_last_submitted_at" ]]; then
      bot_review_last_sha="$normalized_commit"
      bot_review_last_submitted_at="$submitted_at"
    fi
    if [[ "$normalized_commit" == "$head_sha" ]] \
      && [[ -z "$bot_review_head_submitted_at" || "$submitted_at" > "$bot_review_head_submitted_at" ]]; then
      bot_review_at_head=true
      bot_review_head_source="$login"
      bot_review_head_state="$state"
      bot_review_head_sha="$normalized_commit"
      bot_review_head_submitted_at="$submitted_at"
      bot_review_head_evidence="review submission"
    fi
  done <<<"$rows"

  [[ "$bot_review_at_head" == true ]] && return 0

  # ---- Signal 2: completed check run at the head ------------------------------------
  if ! check_rows="$(gh api --paginate "repos/$repo_name/commits/$head_sha/check-runs" \
    --jq '.check_runs[] | [((.app.slug // "") | ascii_downcase), ((.name // "") | ascii_downcase), ((.status // "") | ascii_downcase), ((.conclusion // "") | ascii_downcase)] | @tsv' 2>/dev/null)"; then
    # A check-runs lookup failure is not fatal — signal 1 already ran. Leave the gate closed.
    echo "bot-review-status: warning: could not fetch check runs for PR #$pr_number; leaving the bot-review gate closed" >&2
    return 0
  fi

  while IFS=$'\t' read -r app name status conclusion; do
    [[ -n "$app" ]] || continue
    [[ "$status" == "completed" ]] || continue
    case "$conclusion" in
      success|neutral) ;;
      *) continue ;;
    esac
    for entry in "${BOT_REVIEW_CHECKS[@]}"; do
      slug="${entry%%|*}"
      frag="${entry##*|}"
      if [[ "$app" == "$slug" && "$name" == *"$frag"* ]]; then
        bot_review_at_head=true
        bot_review_head_source="$app ($name)"
        bot_review_head_state="$conclusion"
        bot_review_head_sha="$head_sha"
        bot_review_head_evidence="completed check run"
        return 0
      fi
    done
  done <<<"$check_rows"
}

print_bot_review_status() {
  if [[ "$bot_review_at_head" == true ]]; then
    printf 'Bot review at this head: YES — %s via %s (%s)\n' \
      "$bot_review_head_source" "$bot_review_head_evidence" "$bot_review_head_state"
  elif [[ -n "$bot_review_last_sha" ]]; then
    printf 'Bot review at this head: NO — last submission was at %s (STALE)\n' \
      "${bot_review_last_sha:0:8}"
  else
    echo "Bot review at this head: NO — no bot review on this PR"
  fi
}
