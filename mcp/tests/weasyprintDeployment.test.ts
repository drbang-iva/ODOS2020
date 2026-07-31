import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
