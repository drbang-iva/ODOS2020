---
name: before-and-after
description: Add existing screenshots or screen recordings to a GitHub pull request as a before/after or preview block. Use when a PR needs visual media attached to its description. Browser navigation and capture use Playwright, not agent-browser.
---

# Add visual media to a PR

**Adapted from [`vercel-labs/before-and-after`](https://github.com/vercel-labs/before-and-after)
under PolyForm Shield License 1.0.0.** The bundled `LICENSE` governs the vendored upstream
code and restricts competing use. `scripts/format.mjs` remains byte-identical to upstream
[`8306d34`](https://github.com/vercel-labs/before-and-after/blob/8306d34f459b6704e08e6adb5829fcddb0dc3557/skill/scripts/format.mjs).
Capture and publishing are adapted for ODOS. `scripts/pr-body.mjs` is the local companion
that preserves Markdown surrounding the marker region. Do not use the upstream formatter's
`--body-file` option: it normalizes whitespace outside its markers.

## Capture

Run from the repository root with Node 22 and Google Chrome installed. The browser library
is the existing **`playwright-core` development dependency in `ui/package.json`**; install the
locked UI development dependencies with `npm ci --prefix ui` if they are absent. This skill
does not need `@playwright/test`, an MCP browser server, or a new application dependency.
For a different Chromium executable, set `CHROME_EXECUTABLE` to its absolute path.

For actual PR evidence, serve the base revision and proposed revision from separate worktrees
on distinct, verified local ports (`--host 127.0.0.1 --port PORT --strictPort`). Use the same
synthetic data, route, UI state, and viewport in each. Point `BEFORE_URL` and `AFTER_URL` at
those pages and set `CAPTURE_READY` to a locator visible only when the target surface is ready.
Do not switch a running worktree's revision or reuse another agent's server. Any needed
synthetic login/navigation must finish before the readiness assertion and capture.

The following **runnable demo** uses two states of the existing ODOS chart-bar fixture. It
proves capture and formatting, not a before/after application change. Start its server in a
separate terminal (if port 15120 is occupied, choose a free port and change both URLs):

```bash
npm --prefix ui run dev -- --host 127.0.0.1 --port 15120 --strictPort
```

Then run this complete capture-and-format example in another terminal, from the same root:

```bash
export BEFORE_URL='http://127.0.0.1:15120/tests/fixtures/exam-chart-bar-responsive.html?worst=1'
export AFTER_URL='http://127.0.0.1:15120/tests/fixtures/exam-chart-bar-responsive.html'
export CAPTURE_READY='[data-testid="exam-chart-bar"]'
export CAPTURE_DIR="${CAPTURE_DIR:-captures}"

node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from './ui/node_modules/playwright-core/index.mjs';

const directory = process.env.CAPTURE_DIR;
assert.match(directory, /^[a-zA-Z0-9_./-]+$/);
const urls = [process.env.BEFORE_URL, process.env.AFTER_URL].map(value => new URL(value));
assert.ok(urls.every(url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
await mkdir(directory, { recursive: true });
const browser = await chromium.launch(process.env.CHROME_EXECUTABLE
  ? { executablePath: process.env.CHROME_EXECUTABLE }
  : { channel: 'chrome' });
try {
  for (const [index, state] of ['before', 'after'].entries()) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await page.goto(urls[index].href, { waitUntil: 'networkidle' });
      await page.locator(process.env.CAPTURE_READY).waitFor({ state: 'visible' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${directory}/desktop-${state}.png`, animations: 'disabled' });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const block = execFileSync(process.execPath, [
  '.claude/skills/before-and-after/scripts/format.mjs',
  '--before', `${directory}/desktop-before.png`,
  '--after', `${directory}/desktop-after.png`,
  '--label', 'Desktop',
], { encoding: 'utf8' });
await writeFile(`${directory}/block.md`, block);
console.log(`Captured two 1440x900 screenshots; formatted ${directory}/block.md`);
NODE
```

Inspect both screenshots before publishing. This example takes equal-size viewport captures.
For a component use `locator.screenshot`; for full-page captures follow the next section.
PNG, JPEG, GIF, WebP, MP4, MOV, and WebM are accepted by the formatter. An `--after` file
without a `--before` file creates a net-new preview.

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

Images render in tables. Local video markup is only an intermediate representation; the
video publishing path below uses existing GitHub attachment URLs.

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

## Publish with GitHub CLI 2.86.x

`gh 2.86.x` has no direct image-attachment flag on `pr edit` or `pr comment`. For screenshots,
use **commit-pinned image URLs** and publish ordinary Markdown with `--body-file`. The images
must be committed and pushed on the PR's task branch first. This stores synthetic evidence
in repository history; use small PNGs in a task-specific evidence directory, and never commit
credentials, tokens, authenticated query parameters, PHI, or real-practice captures.

For the capture example, review and commit only the two images (not `block.md`) on your task
branch, then push it. Set `REPO` and `PR` explicitly for the target PR. The code below verifies
that the local files match the committed bytes and that GitHub serves those exact bytes before
rewriting references. It changes only the generated block, never the existing PR description.
`CAPTURE_DIR` must still point to the directory used by the capture example.

```bash
export REPO="${REPO:-drbang-iva/ODOS2020}"
export PR="${PR:?Set PR to the target pull request number}"

node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const directory = process.env.CAPTURE_DIR;
const { localRef } = await import('./.claude/skills/before-and-after/scripts/format.mjs');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let block = readFileSync(`${directory}/block.md`, 'utf8');
for (const state of ['before', 'after']) {
  const path = `${directory}/desktop-${state}.png`;
  const local = readFileSync(path);
  assert.deepEqual(execFileSync('git', ['show', `${sha}:${path}`]), local);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://raw.githubusercontent.com/${process.env.REPO}/${sha}/${encodedPath}`;
  const response = await fetch(url);
  assert.ok(response.ok, `Pushed image unavailable: ${response.status} ${url}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), local);
  const reference = `](${localRef(path)})`;
  assert.ok(block.includes(reference), `Missing formatted reference: ${reference}`);
  block = block.replaceAll(reference, `](${url})`);
}
assert.ok(!block.includes('](./'), 'Unpublished local media reference remains');
writeFileSync(`${directory}/published-block.md`, block);
console.log(`Verified two pushed image URLs at ${sha}`);
NODE

gh pr comment "$PR" --repo "$REPO" --body-file "$CAPTURE_DIR/published-block.md"
```

For private repositories, raw URLs may not render for reviewers without repository access;
verify the rendered images as an intended reviewer. If unavailable, use GitHub's browser
attachment upload and its resulting asset URLs instead. Never put access tokens into URLs.

To insert the generated block into the PR description, use the companion **`pr-body.mjs`**:

```bash
gh pr view "$PR" --repo "$REPO" --json body > /tmp/before-after-pr.json
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('/tmp/before-after-body.md', JSON.parse(readFileSync('/tmp/before-after-pr.json', 'utf8')).body);
NODE
node .claude/skills/before-and-after/scripts/pr-body.mjs \
  /tmp/before-after-body.md "$CAPTURE_DIR/published-block.md" > /tmp/before-after-next.md

gh pr edit "$PR" --repo "$REPO" --body-file /tmp/before-after-next.md
```

When there is no existing block, the helper appends without removing any existing byte. To
place evidence higher, first choose a safe boundary as described above and insert an empty
start/end marker pair there; the helper then replaces only that pair. Fetch the PR body again
before publishing if anyone may have edited it, regenerate from that body, and verify the
rendered result afterward. Confirm both images load and there are no local media references.

### Existing video attachments

GitHub CLI 2.86.x cannot directly upload comment videos. Upload the recording through the
GitHub web comment editor, then copy the resulting `https://github.com/user-attachments/assets/...`
URLs. Keep that source comment. Pass the URLs to `format.mjs --before-video-url URL --after-video-url URL`
(or just `--after-video-url` for a preview), write the output to `published-block.md`, and use
`pr-body.mjs` and `gh pr edit --body-file` as above. Confirm the videos are playable in the
rendered PR. The PNG capture/publish example does not establish video-upload or playback proof.

## Script contract

- `scripts/format.mjs` is the unmodified upstream formatter: local image/video markup, preview
  labels, attachment-path lists, and final GitHub video URL tables. Its upstream body-replacement
  mode is deliberately bypassed because it normalizes surrounding whitespace.
- `scripts/pr-body.mjs` validates marker pairs using the upstream validator, then copies the
  original prefix and suffix exactly. It inserts or replaces only the marked region and refuses
  incomplete or duplicate markers. It takes an existing body file and a generated block file.

The local companion and these instructions are ODOS adaptations; they do not change the
upstream LICENSE or formatter. See [GitHub CLI comment documentation](https://cli.github.com/manual/gh_pr_comment)
and [Playwright screenshot documentation](https://playwright.dev/docs/api/class-page#page-screenshot).
