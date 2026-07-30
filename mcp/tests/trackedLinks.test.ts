import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import {
  createInMemoryTrackedLinkStore,
  generateTrackedLink,
  registerTrackedLinkRoutes,
} from "../src/comms/tracked-links.js";

test("tracked link generation, click logging, and campaign-agnostic 302 redirect work together", async () => {
  const store = createInMemoryTrackedLinkStore();
  const generated = await generateTrackedLink({
    store,
    publicBaseUrl: "https://practice.example",
    targetUrl: "https://destination.example/review?synthetic=1",
    campaignId: "campaign-synthetic",
    messageId: "message-synthetic",
    generateToken: () => "synthetic-token",
    now: () => "2026-07-30T14:00:00.000Z",
  });
  assert.equal(generated.url, "https://practice.example/comms/r/synthetic-token");

  const app = express();
  registerTrackedLinkRoutes(app, {
    store,
    now: () => "2026-07-30T14:05:00.000Z",
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/comms/r/synthetic-token`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://destination.example/review?synthetic=1");
    assert.deepEqual(store.clicks(), [{
      token: "synthetic-token",
      campaignId: "campaign-synthetic",
      messageId: "message-synthetic",
      clickedAt: "2026-07-30T14:05:00.000Z",
    }]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("tracked links reject non-HTTPS public and destination URLs", async () => {
  const store = createInMemoryTrackedLinkStore();
  await assert.rejects(() => generateTrackedLink({
    store,
    publicBaseUrl: "http://practice.example",
    targetUrl: "https://destination.example",
    campaignId: "campaign-synthetic",
    messageId: "message-synthetic",
  }), /HTTPS/);
  await assert.rejects(() => generateTrackedLink({
    store,
    publicBaseUrl: "https://practice.example",
    targetUrl: "javascript:alert(1)",
    campaignId: "campaign-synthetic",
    messageId: "message-synthetic",
  }), /HTTPS/);
});
