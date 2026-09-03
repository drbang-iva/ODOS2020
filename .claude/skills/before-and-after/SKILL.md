---
name: before-and-after
description: Add existing screenshots or screen recordings to a GitHub pull request as a before/after or preview block. Use when a PR needs visual media attached to its description. Browser navigation and capture use Playwright, not agent-browser.
---

# Add visual media to a PR

**Adapted from [`vercel-labs/before-and-after`](https://github.com/vercel-labs/before-and-after) (MIT).
The Capture section is rewritten for this repo — the upstream skill assumes Vercel's
`agent-browser` CLI, which is not available here. `Format` and `Publish` below are the
upstream `scripts/format.mjs` verbatim; that half has no `agent-browser` dependency at all.**

## Capture

Use Playwright (`mcp__playwright__*` tools, or `@playwright/test` directly against the
disposable local stack — never a real practice) to produce the screenshots or recordings.
This skill only owns the GitHub PR attachment workflow below; it does not prescribe how the
browser session is driven.

1. Bring up the change on the disposable stack, before and after state.
2. Save media under the repository with paths that contain no whitespace, for example:

   ```text
   captures/desktop-before.png
   captures/desktop-after.png
   captures/mobile-before.png
   captures/mobile-after.png
   ```

   The formatter supports PNG, JPEG, GIF, WebP, MP4, MOV, and WebM files. Use an `--after`
   file without a matching `--before` file for a net-new preview.

### Equal-height image pairs

GitHub vertically centers a shorter image inside a Markdown table cell. For full-page
before/after screenshots, make both files the same pixel height so their top edges align:
read `document.documentElement.scrollHeight` in both sessions, then append bottom-only space
to the shorter page until both scroll heights match before capturing. Never add space above
the page. For component or section comparisons, capture the same scoped region instead of
padding unrelated page content. Confirm the resulting files have equal pixel dimensions
before publishing.

## Format

Pass one `--before` and `--after` pair for each comparison. Repeat `--label` to identify
multiple pairs:

```bash
node .claude/skills/before-and-after/scripts/format.mjs \
  --before captures/desktop-before.png \
  --after captures/desktop-after.png \
  --before captures/mobile-before.png \
  --after captures/mobile-after.png \
  --label Desktop \
  --label Mobile \
  > /tmp/before-and-after.md
```

For an after-only preview:

```bash
node .claude/skills/before-and-after/scripts/format.mjs \
  --after captures/new-page.png \
  > /tmp/before-and-after.md
```

Add `--attribution "<name>"` to prefix the block with a `> Before/after by <name>` line when
the PR should credit who produced the evidence.

Images render in tables. Local videos initially render on their own lines so `gh --attach`
can upload them and expose their final attachment URLs. Before/after video tables use the
two-step workflow below because `gh --attach` does not rewrite local references inside
`<video src>` attributes.

## Place the evidence

Read the existing PR description before inserting a new marked block. Put visual evidence
near the top, after the short opening context, but before implementation-heavy sections such
as Details, Changes, Testing, or Notes.

Use this reading order inside the visual evidence:

1. Put the real before/after evidence that proves the PR first.
2. Put supplemental formats or alternate states after the primary evidence.
3. Label anything that demonstrates this skill rather than the PR itself as a demo, and state
   material limitations beside it.

Headings are semantic hints, not required names. Never invent or rewrite prose merely to
create an anchor, and never split a paragraph, list, table, code block, or other Markdown
structure. If no safe anchor is clear, append the block rather than risking damage. If a
marked block already exists, move or replace that whole block only; preserve every byte of
unrelated prose.

After publishing, open the rendered PR and confirm the primary evidence appears before
supplemental demos and before the implementation details.

## Publish

Preserve the existing PR description and replace only this skill's marked block:

```bash
PR=123
gh pr view "$PR" --json body --jq .body > /tmp/pr-body.md

node .claude/skills/before-and-after/scripts/format.mjs \
  --body-file /tmp/pr-body.md \
  --before captures/desktop-before.png \
  --after captures/desktop-after.png \
  > /tmp/pr-body-next.md

ATTACH_ARGS=()
while IFS= read -r file; do
  ATTACH_ARGS+=(--attach "$file")
done < <(
  node .claude/skills/before-and-after/scripts/format.mjs \
    --attach-list \
    --before captures/desktop-before.png \
    --after captures/desktop-after.png
)

gh pr edit "$PR" --body-file /tmp/pr-body-next.md "${ATTACH_ARGS[@]}"
```

Run the formatter and `gh` from the repo root. `gh --attach` uploads the local files to
GitHub and rewrites their matching local references in the PR body.

After publishing, fetch or open the PR description and confirm that no `./captures/...`
references remain inside the marked block and that the evidence appears in the intended
reading order.

### Publish a video table

Video comparisons are a first-class two-step publish operation:

1. Upload the local videos in a temporary PR comment using the normal own-line output and
   `gh pr comment --attach`.
2. Fetch that comment through `gh api` and collect the stable
   `https://github.com/user-attachments/assets/...` URLs in before/after order.
3. Generate the final HTML table from those URLs and replace the marked PR block:

   ```bash
   node .claude/skills/before-and-after/scripts/format.mjs \
     --body-file /tmp/pr-body.md \
     --before-video-url https://github.com/user-attachments/assets/BEFORE_ID \
     --after-video-url https://github.com/user-attachments/assets/AFTER_ID \
     --label "Desktop hero" \
     > /tmp/pr-body-next.md

   gh pr edit "$PR" --body-file /tmp/pr-body-next.md
   ```

4. Fetch the edited PR body before deleting the temporary comment. Confirm both final URLs
   are present and no local video paths remain, then delete the comment.
5. Open the rendered PR and confirm both `<video>` elements are inside the comparison table,
   reach a playable ready state, and show controls.

If URL extraction, formatting, or PR verification fails, keep the temporary comment so its
uploaded attachments remain recoverable and retry from the last successful phase. Use
own-line videos as the simple fallback.

Do not publish captures containing credentials, tokens, authenticated query parameters, or
PHI. Live-proof flows run against the disposable local stack only — never a real practice.

## Script contract

`scripts/format.mjs` is the only bundled script, vendored unmodified from upstream. It:

- formats existing local media;
- formats final GitHub video attachment URLs as HTML comparison tables;
- labels after-only media as `Preview`;
- emits the exact attachment path list;
- inserts or replaces `<!-- before-and-after:start/end -->` without changing other PR prose.

Its arguments version with this skill and are not a public library API.
