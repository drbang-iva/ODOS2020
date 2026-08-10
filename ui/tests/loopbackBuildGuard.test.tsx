import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, resolveConfig, type Plugin } from "vite";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function emittedAssets(files: Record<string, string>): Plugin {
  return {
    name: "test-emitted-assets",
    generateBundle() {
      for (const [fileName, source] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}

async function buildWith(files: Record<string, string>): Promise<void> {
  const outDir = await mkdtemp(path.join(tmpdir(), "odos-loopback-guard-"));
  try {
    await build({
      root: UI_ROOT,
      logLevel: "silent",
      plugins: [emittedAssets(files)],
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

test("production build rejects loopback URLs from every emitted asset type", async () => {
  await assert.rejects(
    buildWith({
      "broken-localhost.css": '.status { mask: url("http://localhost:5173/icon.svg"); }',
      "broken.css": '.status { background: url("https://127.0.0.1:3333/status"); }',
      "broken.json": JSON.stringify({ api: "http://[::1]:8103/fhir/R4" }),
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /broken-localhost\.css.*http:\/\/localhost:5173\/icon\.svg/s);
      assert.match(message, /broken\.css.*https:\/\/127\.0\.0\.1:3333\/status/s);
      assert.match(message, /broken\.json.*http:\/\/\[::1\]:8103\/fhir\/R4/s);
      return true;
    },
  );
});

test("production build allows non-loopback absolute URLs", async () => {
  await buildWith({
    "external.css": '.status { background: url("https://cdn.example.com/status.svg"); }',
    "external.json": JSON.stringify({ api: "https://api.example.com/fhir/R4" }),
  });
});

test("loopback guard is excluded from Vite dev and included in production builds", async () => {
  const serveConfig = await resolveConfig({ root: UI_ROOT }, "serve");
  const buildConfig = await resolveConfig({ root: UI_ROOT }, "build");

  assert.equal(serveConfig.plugins.some((plugin) => plugin.name === "odos-loopback-build-guard"), false);
  assert.equal(buildConfig.plugins.some((plugin) => plugin.name === "odos-loopback-build-guard"), true);
});
