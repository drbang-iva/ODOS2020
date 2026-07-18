import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Basic } from "@medplum/fhirtypes";
import {
  StatementMessagesSettingsReady,
  type StatementMessagesSettingsClient,
} from "../src/scenes/settings/StatementMessagesSettings";
import {
  buildStatementMessageConfigResource,
  parseStatementMessageConfig,
} from "../src/scenes/settings/statement-message-config";

function clientFixture() {
  const writes: Array<{ resource: Basic; sourceTag: string }> = [];
  const client = {
    async search() {
      return { resourceType: "Bundle" as const, type: "searchset" as const };
    },
    async searchUrl() {
      return { resourceType: "Bundle" as const, type: "searchset" as const };
    },
    async create<T extends Basic>(resource: T, sourceTag: string) {
      writes.push({ resource, sourceTag });
      return { ...resource, id: "created-message-config", meta: { versionId: "1" } } as T;
    },
    async update<T extends Basic>(resource: T, sourceTag: string) {
      writes.push({ resource, sourceTag });
      return resource;
    },
  };
  return { client: client as StatementMessagesSettingsClient, writes };
}

test("statement-message settings show two text areas, exact safety copy, and 320-character counters", () => {
  const fixture = clientFixture();
  const html = renderToStaticMarkup(
    <StatementMessagesSettingsReady
      config={{ statementFooterMessage: "Statement note", receiptFooterMessage: "Receipt note" }}
      canWrite
      client={fixture.client}
    />,
  );
  assert.match(html, /Statement footer message/);
  assert.match(html, /Receipt footer message/);
  assert.match(html, /14\/320/);
  assert.match(html, /12\/320/);
  assert.match(html, /This prints on every statement — keep it factual and free of patient-specific detail\./);
  assert.match(html, /This prints on every receipt — keep it factual and free of patient-specific detail\./);
  assert.equal((html.match(/maxLength="320"/g) ?? []).length, 2);
});

test("statement-message settings update the live counter and save both fields through the singleton Basic", async () => {
  const fixture = clientFixture();
  const resource = {
    ...buildStatementMessageConfigResource({ statementFooterMessage: "Old" }),
    id: "statement-message-config-1",
    meta: { versionId: "7" },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <StatementMessagesSettingsReady
        config={{ statementFooterMessage: "Old" }}
        resource={resource}
        canWrite
        client={fixture.client}
      />,
    );
  });

  const statementField = renderer.root.findAllByType("textarea").find((field) => field.props.id === "statement-footer-message")!;
  const receiptField = renderer.root.findAllByType("textarea").find((field) => field.props.id === "receipt-footer-message")!;
  await act(async () => {
    statementField.props.onChange({ target: { value: "New statement note" } });
    receiptField.props.onChange({ target: { value: "New receipt note" } });
  });
  const counters = renderer.root.findAllByProps({ "aria-live": "polite" }).map((span) => span.children.join(""));
  assert.deepEqual(counters, ["18/320", "16/320"]);

  await act(async () => {
    await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0]?.sourceTag, "statement-message-config");
  assert.equal(fixture.writes[0]?.resource.id, "statement-message-config-1");
  assert.deepEqual(fixture.writes[0]?.resource.meta, { versionId: "7" });
  assert.deepEqual(parseStatementMessageConfig(fixture.writes[0]!.resource), {
    statementFooterMessage: "New statement note",
    receiptFooterMessage: "New receipt note",
  });
  assert.match(renderer.root.findByProps({ role: "status" }).children.join(""), /messages saved/i);
  act(() => renderer.unmount());
});

test("statement-message settings are read-only without practice-admin access", () => {
  const fixture = clientFixture();
  const html = renderToStaticMarkup(
    <StatementMessagesSettingsReady config={{}} canWrite={false} client={fixture.client} />,
  );
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Save messages/);
  assert.match(html, /Practice-admin access is required/);
});
