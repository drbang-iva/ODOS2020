import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ProtocolStagingList } from "../src/components/charting/ProtocolStagingList";
import type {
  ProtocolDefinition,
  ProtocolDraft,
  ProtocolLibraryResponse,
} from "../src/lib/protocol-authoring";
import { ProtocolBuilder } from "../src/scenes/ProtocolLibrary";

const draft: ProtocolDraft = {
  title: "Dry Eye — Stable",
  trigger: {
    kind: "diagnosis",
    dxKeys: ["H04.12*"],
    statusScope: ["stable"],
  },
  ownership: { ownerId: "Practitioner/example", sharing: "practice" },
  categories: ["Dry eye"],
  items: [
    {
      itemKey: "staining",
      itemType: "finding-seed",
      defaultSelected: true,
      lateralityMode: "inherit-dx",
      payload: { findingDefKey: "corneal-staining", mode: "promptOnly" },
    },
    {
      itemKey: "follow-up",
      itemType: "follow-up",
      defaultSelected: true,
      lateralityMode: "OU-always",
      payload: { interval: 3, unit: "months" },
    },
  ],
};

function protocol(overrides: Partial<ProtocolDefinition> = {}): ProtocolDefinition {
  return {
    ...draft,
    id: "dry-eye-stable",
    version: 1,
    status: "active",
    draft,
    authoring: {
      origin: "clinician",
      at: "2026-07-26T12:00:00.000Z",
      actor: "Practitioner/example",
    },
    audit: {
      createdBy: "Practitioner/example",
      createdAt: "2026-07-26T12:00:00.000Z",
    },
    ...overrides,
  };
}

const catalogs: ProtocolLibraryResponse["catalogs"] = {
  findingKeys: ["corneal-staining"],
  procedureKeys: ["office-visit"],
};

function documentStub() {
  return {
    documentElement: {
      dataset: { surface: "midnight", accent: "gold" },
      style: { setProperty() {} },
    },
  } as unknown as Document;
}

test("builder autosave survives immediate navigation and restores the saved draft", async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub() });

  let savedDraft: ProtocolDraft | undefined;
  globalThis.fetch = async (_input, init) => {
    savedDraft = JSON.parse(String(init?.body)) as ProtocolDraft;
    return new Response(JSON.stringify({
      protocol: protocol({ draft: savedDraft }),
      validation: [],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<ProtocolBuilder protocol={protocol()} catalogs={catalogs} onPublished={() => undefined} />);
    });
    const title = renderer.root.findAllByType("input").find((input) => input.props.value === draft.title);
    assert.ok(title);
    act(() => {
      title.props.onChange({ target: { value: "Dry Eye — Stable revised" } });
      renderer.unmount();
    });
    await act(async () => undefined);
    assert.equal(savedDraft?.title, "Dry Eye — Stable revised");

    await act(async () => {
      renderer = create(
        <ProtocolBuilder
          protocol={protocol({ draft: savedDraft })}
          catalogs={catalogs}
          onPublished={() => undefined}
        />,
      );
    });
    assert.ok(renderer.root.findAllByType("input").some((input) => input.props.value === "Dry Eye — Stable revised"));
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("builder preview and encounter staging use the same shared renderer", () => {
  const html = renderToStaticMarkup(
    <ProtocolStagingList
      items={draft.items}
      selections={{ staining: true, "follow-up": false }}
      preview
    />,
  );
  assert.match(html, /Corneal Staining/);
  assert.match(html, /Follow Up/);
  assert.match(html, /3 months/);
  assert.match(html, /checked=""/);
});

test("assessment protocol UI is diagnosis-generic and renders ranked multi-offer selection", () => {
  const source = readFileSync(new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /glaucoma/i);
  assert.match(source, /protocolDiagnoses\.map/);
  assert.match(source, /protocolOffers\.map/);
  assert.match(source, /selectedProtocolId/);
  assert.match(source, /type="radio"/);
  assert.doesNotMatch(source, /protocolId:\\s*"[^"]+"/);
});
