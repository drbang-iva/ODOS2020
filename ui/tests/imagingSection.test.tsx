import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  ImagingSection,
  formatBytes,
  groupImagingRows,
  imagingContentType,
  type ImagingSummary,
} from "../src/components/charting/ImagingSection";
import { SpineNav } from "../src/components/charting/SpineNav";

test("imaging section renders chart/visit scope, native capture, and all supported categories", () => {
  const html = renderToStaticMarkup(
    <ImagingSection
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );

  assert.match(html, /All chart imaging/);
  assert.match(html, /This visit/);
  assert.match(html, /Capture or import imaging/);
  assert.match(html, /Drop a scan or image here/);
  assert.match(html, /15 MB max/);
  assert.match(html, /type="file"/);
  assert.match(html, /\.pdf,\.bmp,\.heic,\.heif,\.jpg,\.jpeg,\.png,\.tif,\.tiff,\.webp/);
  assert.match(html, /Visual field printout/);
  assert.match(html, /Fundus photo/);
  assert.match(html, /Anterior slit-lamp photo/);
  assert.match(html, /OCT/);
  assert.match(html, /Biometry/);
  assert.match(html, /Referral scan/);
  assert.match(html, /Outside record/);
  assert.match(html, /Interpretation \(optional\)/);
  assert.match(html, /Creates a preliminary DiagnosticReport linked to the uploaded Media/);
  assert.match(html, /Upload to chart/);
  assert.match(html, /disabled=""/);
});

test("OCT rows group by structure then occurrence date and keep unclassified scans visible", () => {
  const rows: ImagingSummary[] = [
    image("macula-new", "2026-07-15T15:00:00Z", "Macula"),
    image("unclassified", "2026-07-14T15:00:00Z"),
    image("macula-old", "2026-06-10T15:00:00Z", "Macula"),
  ];

  const oct = groupImagingRows(rows)[0];

  assert.equal(oct?.category, "oct");
  assert.deepEqual(oct?.structures.map((group) => group.label), ["Macula", "Unclassified OCT"]);
  assert.deepEqual(oct?.structures[0]?.dates.map((group) => group.date), [
    "2026-07-15",
    "2026-06-10",
  ]);
  assert.deepEqual(oct?.structures[1]?.dates[0]?.images.map((row) => row.id), ["unclassified"]);
});

test("imaging groups use the local calendar date rather than the UTC date", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const oct = groupImagingRows([
      image("local-evening", "2026-07-15T01:00:00.000Z", "Macula"),
    ])[0];
    assert.equal(oct?.structures[0]?.dates[0]?.date, "2026-07-14");
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("a stale patient imaging request cannot overwrite the newly selected patient's images", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("Patient%2Fp1")) return first;
    return imagingResponse([image("patient-two", "2026-07-15T15:00:00Z", "Macula")]);
  };
  let renderer!: ReactTestRenderer;
  try {
    act(() => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
    });
    await act(async () => {
      renderer.update(
        <ImagingSection
          patientReference="Patient/p2"
          encounterReference="Encounter/e2"
          onSaved={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    assert.match(JSON.stringify(renderer.toJSON()), /patient-two/);

    await act(async () => {
      resolveFirst(imagingResponse([image("patient-one-stale", "2026-07-16T15:00:00Z", "Macula")]));
      await Promise.resolve();
    });
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /patient-two/);
    assert.doesNotMatch(rendered, /patient-one-stale/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("switching to encounter scope drops the late all-chart response", async () => {
  const originalFetch = globalThis.fetch;
  let resolvePatient!: (response: Response) => void;
  const patientResponse = new Promise<Response>((resolve) => { resolvePatient = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    return url.includes("patient=")
      ? patientResponse
      : imagingResponse([image("encounter-current", "2026-07-15T15:00:00Z", "Macula")]);
  };
  let renderer!: ReactTestRenderer;
  try {
    act(() => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
    });
    const visitScope = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "This visit");
    assert.ok(visitScope);
    await act(async () => {
      visitScope.props.onClick();
      await Promise.resolve();
    });
    assert.match(JSON.stringify(renderer.toJSON()), /encounter-current/);

    await act(async () => {
      resolvePatient(imagingResponse([image("patient-scope-stale", "2026-07-16T15:00:00Z", "Macula")]));
      await Promise.resolve();
    });
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /encounter-current/);
    assert.doesNotMatch(rendered, /patient-scope-stale/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a successful upload still reports onSaved when the history refresh fails", async () => {
  const originalFetch = globalThis.fetch;
  let getCalls = 0;
  let saved = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ mediaReference: "Media/uploaded" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    getCalls += 1;
    return getCalls === 1
      ? imagingResponse([])
      : new Response(JSON.stringify({ error: "refresh unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => { saved += 1; }}
        />,
      );
      await Promise.resolve();
    });
    const file = new File(["scan"], "scan.png", { type: "image/png" });
    const input = renderer.root.findByProps({ "aria-label": "Choose imaging file" });
    act(() => input.props.onChange({ target: { files: [file] } }));
    const upload = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Upload to chart");
    assert.ok(upload);
    await act(async () => upload.props.onClick());
    assert.equal(saved, 1);
    assert.match(JSON.stringify(renderer.toJSON()), /Imaging saved\. Refresh the chart/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("inline PDFs are opened through a revocable blob URL", async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = () => "blob:imaging-pdf";
  URL.revokeObjectURL = (value) => { revoked.push(value); };
  globalThis.fetch = async () => imagingResponse([{
    ...image("inline-pdf", "2026-07-15T15:00:00Z", undefined, "data:application/pdf;base64,cGRm"),
    category: "outside-record",
    contentType: "application/pdf",
  }]);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    const attachment = renderer.root.findByType("a");
    assert.equal(attachment.props.href, "blob:imaging-pdf");
    assert.equal(String(attachment.props.href).startsWith("data:"), false);
  } finally {
    act(() => renderer?.unmount());
    assert.deepEqual(revoked, ["blob:imaging-pdf"]);
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    globalThis.fetch = originalFetch;
  }
});

test("unsupported inline attachment data fails soft within its tile", async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  let blobCreations = 0;
  URL.createObjectURL = () => {
    blobCreations += 1;
    return "blob:unexpected";
  };
  globalThis.fetch = async () => imagingResponse([{
    ...image(
      "parameterized-inline",
      "2026-07-15T15:00:00Z",
      undefined,
      "data:application/pdf;charset=utf-8;base64,cGRm",
    ),
    category: "outside-record",
    contentType: "application/pdf",
  }]);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    assert.equal(blobCreations, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /Attachment unavailable.*Metadata remains in the chart/);
  } finally {
    renderer?.unmount();
    URL.createObjectURL = originalCreateObjectUrl;
    globalThis.fetch = originalFetch;
  }
});

test("OCT refinement moves focus into the form and restores the trigger after cancel", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => imagingResponse([
    image("oct-focus", "2026-07-15T15:00:00Z", "Macula"),
  ]);
  let inputFocuses = 0;
  let triggerFocuses = 0;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
        {
          createNodeMock: (element) =>
            element.props["aria-label"] === "OCT structure"
              ? { focus: () => { inputFocuses += 1; } }
              : element.props["data-refine-image-id"] === "oct-focus"
                ? { focus: () => { triggerFocuses += 1; } }
                : element.props["data-imaging-id"] === "oct-focus"
                  ? { focus: () => undefined }
              : {},
        },
      );
      await Promise.resolve();
    });
    const refine = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Refine structure");
    assert.ok(refine);
    await act(async () => {
      refine.props.onClick();
      await Promise.resolve();
    });
    assert.equal(inputFocuses, 1);

    const cancel = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Cancel");
    assert.ok(cancel);
    await act(async () => {
      cancel.props.onClick();
      await Promise.resolve();
    });
    assert.equal(triggerFocuses, 1);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("successful OCT refinement restores focus to the trigger from the updated tile", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/clinical-graph/imaging/oct-save-focus/structure")) {
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({
        image: image("oct-save-focus", "2026-07-15T15:00:00Z", "RNFL"),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return imagingResponse([
      image("oct-save-focus", "2026-07-15T15:00:00Z", "Macula"),
    ]);
  };
  let inputFocuses = 0;
  let triggerMounts = 0;
  let focusedTriggerMount = 0;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
        {
          createNodeMock: (element) => {
            if (element.props["aria-label"] === "OCT structure") {
              return { focus: () => { inputFocuses += 1; } };
            }
            if (element.props["data-refine-image-id"] === "oct-save-focus") {
              triggerMounts += 1;
              const mount = triggerMounts;
              return { focus: () => { focusedTriggerMount = mount; } };
            }
            if (element.props["data-imaging-id"] === "oct-save-focus") {
              return { focus: () => undefined };
            }
            return {};
          },
        },
      );
      await Promise.resolve();
    });
    const refine = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Refine structure");
    assert.ok(refine);
    await act(async () => {
      refine.props.onClick();
      await Promise.resolve();
    });
    assert.equal(inputFocuses, 1);

    const structure = renderer.root.findByProps({ "aria-label": "OCT structure" });
    act(() => structure.props.onClick());
    const opticNerve = renderer.root.findAllByType("button")
      .find((button) => button.props.role === "option" && button.children.join("") === "Optic nerve");
    assert.ok(opticNerve);
    act(() => opticNerve.props.onClick());
    const save = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Save refinement");
    assert.ok(save);
    const triggerMountsBeforeSave = triggerMounts;
    await act(async () => {
      await save.props.onClick();
      await Promise.resolve();
    });
    assert.ok(focusedTriggerMount > triggerMountsBeforeSave);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("an expired image URL is refreshed once, then becomes a broken state with metadata preserved", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [
    "https://storage.test/oct-1/1?Expires=1&Signature=expired",
    "https://storage.test/oct-1/1?Expires=60&Signature=refreshed",
  ];
  let calls = 0;
  globalThis.fetch = async () => {
    const contentUrl = urls[Math.min(calls, urls.length - 1)]!;
    calls += 1;
    return new Response(JSON.stringify({
      images: [image("oct-1", "2026-07-15T15:00:00Z", "Macula", contentUrl)],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    let tileImage = renderer.root.findByType("img");
    assert.match(tileImage.props.src, /Signature=expired/);

    await act(async () => {
      await tileImage.props.onError();
      await Promise.resolve();
    });
    tileImage = renderer.root.findByType("img");
    assert.match(tileImage.props.src, /Signature=refreshed/);

    await act(async () => tileImage.props.onError());
    assert.equal(renderer.root.findAllByType("img").length, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /Image unavailable\. Metadata remains in the chart/);
    assert.match(JSON.stringify(renderer.toJSON()), /oct-1\.png/);
    assert.equal(calls, 2);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("Imaging is its own top-level spine group after Ocular Health and before Assessment and Plan", () => {
  const html = renderToStaticMarkup(<SpineNav active="imaging" statuses={{}} onSelect={() => undefined} />);
  const ocularHealthIndex = html.indexOf("OCULAR HEALTH");
  const imagingIndex = html.indexOf("IMAGING");
  const assessmentIndex = html.indexOf("ASSESSMENT &amp; PLAN");

  assert.ok(ocularHealthIndex >= 0);
  assert.ok(imagingIndex >= 0);
  assert.ok(assessmentIndex >= 0);
  assert.ok(ocularHealthIndex < imagingIndex);
  assert.ok(imagingIndex < assessmentIndex);
  assert.match(html, /Manual imaging/);
});

test("manual imaging accepts only the server-supported file types", () => {
  assert.equal(imagingContentType({ name: "field.pdf", type: "" }), "application/pdf");
  assert.equal(imagingContentType({ name: "fundus.jpeg", type: "" }), "image/jpeg");
  assert.equal(imagingContentType({ name: "outside-record.exe", type: "" }), undefined);
  assert.equal(imagingContentType({ name: "renamed.jpg", type: "application/octet-stream" }), undefined);
});

test("manual imaging file sizes are shown in chart-friendly units", () => {
  assert.equal(formatBytes(800), "800 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
});

function image(id: string, date: string, structure?: string, contentUrl = `https://storage.test/${id}`): ImagingSummary {
  return {
    id,
    mediaReference: `Media/${id}`,
    category: "oct",
    ...(structure ? { structure } : {}),
    date,
    title: `${id}.png`,
    contentType: "image/png",
    contentUrl,
    contentState: "available",
  };
}

function imagingResponse(images: ImagingSummary[]): Response {
  return new Response(JSON.stringify({ images }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
