import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("practice deployment pins a local WeasyPrint sidecar with a loud health dependency", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const dockerfile = readFileSync(
    new URL("../../docker/weasyprint.Dockerfile", import.meta.url),
    "utf8",
  );

  assert.match(compose, /\n  weasyprint:\n/);
  assert.match(compose, /dockerfile: docker\/weasyprint\.Dockerfile/);
  assert.match(compose, /ODOS_WEASYPRINT_URL: http:\/\/weasyprint:8788/);
  assert.match(compose, /weasyprint:\n\s+condition: service_healthy/);
  assert.match(compose, /127\.0\.0\.1:8788:8788/);
  assert.match(dockerfile, /WeasyPrint==69\.0/);
  assert.match(dockerfile, /fonts-noto-core/);
  assert.match(dockerfile, /mcp\/dist\/mcp\/src\/correspondence\/render-server\.js/);
  assert.doesNotMatch(compose.match(/\n  weasyprint:[\s\S]*?(?=\n  [a-z]|\nvolumes:)/)?.[0] ?? "", /odos-egress/);
});

test("practice deployment installs MCP native dependencies inside Alpine", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const dependencyService =
    compose.match(/\n  odos-core-deps:[\s\S]*?(?=\n  [a-z]|\nvolumes:)/)?.[0] ?? "";
  const coreService =
    compose.match(/\n  odos-core:[\s\S]*?(?=\n  [a-z]|\nvolumes:)/)?.[0] ?? "";

  assert.match(dependencyService, /image: node:22-alpine/);
  assert.match(
    dependencyService,
    /command: \["npm", "ci", "--omit=dev", "--include=optional", "--no-audit", "--no-fund"\]/,
  );
  assert.match(
    dependencyService,
    /odos-mcp-node-modules:\/workspace\/mcp\/node_modules/,
  );
  assert.match(coreService, /odos-core-deps:\n\s+condition: service_completed_successfully/);
  assert.match(
    coreService,
    /odos-mcp-node-modules:\/workspace\/mcp\/node_modules:ro/,
  );
  assert.match(compose, /\n  odos-mcp-node-modules:\n/);
});

test("MCP package, CLI, and Compose derive one mutable entrypoint", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    bin: { "odos-mcp": string };
    main: string;
    scripts: { start: string };
  };
  const launcherUrl = new URL("../launcher.mjs", import.meta.url);
  const launcher = readFileSync(launcherUrl, "utf8");

  assert.match(packageJson.main, /^\.\/dist\/.+\/index\.js$/);
  assert.equal(packageJson.scripts.start, "node .");
  assert.equal(packageJson.bin["odos-mcp"], "./launcher.mjs");
  assert.match(compose, /command: \["npm", "--prefix", "mcp", "run", "start"\]/);
  assert.doesNotMatch(compose, /mcp\/dist\/mcp\/src\/index\.js/);
  assert.doesNotMatch(launcher, /dist\/mcp\/src\/index\.js/);

  const fixture = mkdtempSync(join(tmpdir(), "odos-mcp-entrypoint-"));
  try {
    copyFileSync(launcherUrl, join(fixture, "launcher.mjs"));
    mkdirSync(join(fixture, "dist", "layout-a"), { recursive: true });
    mkdirSync(join(fixture, "dist", "layout-b"), { recursive: true });
    writeFileSync(join(fixture, "dist", "layout-a", "index.js"), 'console.log("layout-a");\n');
    writeFileSync(join(fixture, "dist", "layout-b", "index.js"), 'console.log("layout-b");\n');

    const runBoth = (main: string): readonly string[] => {
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module", main }));
      return [
        execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim(),
        execFileSync(process.execPath, [join(fixture, "launcher.mjs")], { encoding: "utf8" }).trim(),
      ];
    };

    assert.deepEqual(runBoth("./dist/layout-a/index.js"), ["layout-a", "layout-a"]);
    assert.deepEqual(runBoth("./dist/layout-b/index.js"), ["layout-b", "layout-b"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
