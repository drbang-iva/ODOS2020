import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { readBuildVersion } from "../build-provenance";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production build emits public provenance and a static stamp outside the React root", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "odos-build-stamp-"));

  try {
    await build({ root: UI_ROOT, build: { outDir, emptyOutDir: true } });

    const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: UI_ROOT,
      encoding: "utf8",
    }).trim();
    const expectedBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: UI_ROOT,
      encoding: "utf8",
    }).trim() || "unknown";
    const version = JSON.parse(await readFile(path.join(outDir, "version.json"), "utf8"));
    assert.equal(version.sha, expectedSha);
    assert.equal(version.shortSha, expectedSha.slice(0, 7));
    assert.equal(version.branch, expectedBranch);
    assert.equal(new Date(version.builtAt).toISOString(), version.builtAt);

    const html = await readFile(path.join(outDir, "index.html"), "utf8");
    const rootEnd = html.indexOf("</div>", html.indexOf('id="root"'));
    const stampStart = html.indexOf('id="odos-build-stamp"');
    assert.ok(stampStart > rootEnd, "the no-JS stamp must remain outside React's root");
    assert.match(html, new RegExp(expectedSha.slice(0, 7)));
    assert.match(html, /Built <time datetime="[^"]+">[^<]+<\/time>/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("git failure leaves literal unknown provenance without losing the build timestamp", async () => {
  const outsideGit = await mkdtemp(path.join(tmpdir(), "odos-no-git-"));
  try {
    const builtAt = new Date("2026-08-10T18:00:00.000Z");
    assert.deepEqual(readBuildVersion(outsideGit, builtAt), {
      sha: "unknown",
      shortSha: "unknown",
      branch: "unknown",
      builtAt: builtAt.toISOString(),
    });
  } finally {
    await rm(outsideGit, { recursive: true, force: true });
  }
});

test("detached CI checkout keeps its source branch provenance", async () => {
  const detachedRepo = await mkdtemp(path.join(tmpdir(), "odos-detached-git-"));
  const previousHeadRef = process.env.GITHUB_HEAD_REF;
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: detachedRepo });
    execFileSync("git", ["-c", "user.name=ODOS Test", "-c", "user.email=test@odos.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: detachedRepo });
    execFileSync("git", ["checkout", "--quiet", "--detach"], { cwd: detachedRepo });
    process.env.GITHUB_HEAD_REF = "drbang-iva/build-stamp";

    assert.equal(readBuildVersion(detachedRepo).branch, "drbang-iva/build-stamp");
  } finally {
    if (previousHeadRef === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = previousHeadRef;
    await rm(detachedRepo, { recursive: true, force: true });
  }
});
