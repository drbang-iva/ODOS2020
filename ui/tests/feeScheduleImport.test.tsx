import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import {
  procedureFeeImportApi,
  type FeeImportCommitResult,
  type FeeImportInspection,
  type FeeImportPreview,
  type FeeImportProposal,
  type ProcedureFeeImportApi,
} from "../src/lib/procedure-fee-import";
import { FeeScheduleImport } from "../src/scenes/settings/FeeScheduleImport";
import { FeeScheduleSettings } from "../src/scenes/settings/FeeScheduleSettings";

function proposal(overrides: Partial<FeeImportProposal> = {}): FeeImportProposal {
  return {
    proposalId: "fee-import-row-2",
    sourceRows: [2],
    decision: "create",
    display: "Synthetic service",
    category: "procedure",
    routing: "insurance-billable",
    active: true,
    matchRanking: [],
    flags: [],
    reasons: [],
    ...overrides,
  };
}

test("fee import client sends inspect propose and commit only to server-mediated endpoints", async () => {
  // Sending import writes anywhere except the two approved server endpoints must make this test red.
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body)) as { action?: string };
    if (body.action === "inspect") {
      return Response.json({ headers: ["Name"], rowCount: 1, suggestedMapping: { display: "Name" } });
    }
    if (body.action === "propose") {
      return Response.json({ proposals: [proposal()], matchOptions: [], counts: { create: 1, match: 0, skip: 0, flagged: 0 } });
    }
    return Response.json({ outcomes: [{ proposalId: "fee-import-row-2", status: "created", message: "Created." }], counts: { created: 1, matched: 0, skipped: 0, failed: 0 } });
  };
  const api = procedureFeeImportApi(fetchImpl);
  await api.inspect("Name\nSynthetic service\n");
  await api.propose("Name\nSynthetic service\n", { display: "Name" });
  await api.commit([proposal()]);

  assert.deepEqual(requests.map((request) => request.url), [
    "/clinical-graph/fee-schedule/import/preview",
    "/clinical-graph/fee-schedule/import/preview",
    "/clinical-graph/fee-schedule/import/commit",
  ]);
  assert.equal(requests.every((request) => request.init?.method === "POST"), true);
  assert.deepEqual(requests.map((request) => JSON.parse(String(request.init?.body))), [
    { action: "inspect", csvText: "Name\nSynthetic service\n" },
    { action: "propose", csvText: "Name\nSynthetic service\n", mapping: { display: "Name" } },
    { proposals: [proposal()] },
  ]);
  assert.equal(requests.every((request) =>
    new Headers(request.init?.headers).get("Content-Type") === "application/json"
  ), true);
});

test("fee import client surfaces safe server errors without echoing the CSV", async () => {
  // Concatenating the request payload into client errors must expose this cell and make the test red.
  const secretCell = "SYNTHETIC-SECRET-PRICE-CELL";
  const api = procedureFeeImportApi(async () => Response.json({
    error: "CSV could not be parsed with strict quoting and column counts.",
  }, { status: 400 }));
  await assert.rejects(
    () => api.inspect(`Name,Fee\nSynthetic,${secretCell}\n`),
    (error: unknown) => error instanceof Error &&
      error.message === "CSV could not be parsed with strict quoting and column counts." &&
      !error.message.includes(secretCell),
  );
});

function memoryApi(input: {
  inspection?: FeeImportInspection;
  preview?: FeeImportPreview;
  commit?: FeeImportCommitResult;
} = {}): ProcedureFeeImportApi & {
  inspectCalls: string[];
  proposeCalls: Array<{ csvText: string; mapping: Record<string, string | undefined> }>;
  commitCalls: FeeImportProposal[][];
} {
  const api = {
    inspectCalls: [] as string[],
    proposeCalls: [] as Array<{ csvText: string; mapping: Record<string, string | undefined> }>,
    commitCalls: [] as FeeImportProposal[][],
    async inspect(csvText: string) {
      api.inspectCalls.push(csvText);
      return input.inspection ?? {
        headers: ["Service", "Group", "Code", "Fee", "Route"],
        rowCount: 1,
        suggestedMapping: {
          display: "Service",
          category: "Group",
          billingCode: "Code",
          price: "Fee",
          routing: "Route",
        },
      };
    },
    async propose(csvText: string, mapping: Record<string, string | undefined>) {
      api.proposeCalls.push({ csvText, mapping });
      return input.preview ?? reviewPreview();
    },
    async commit(proposals: FeeImportProposal[]) {
      api.commitCalls.push(structuredClone(proposals));
      return input.commit ?? {
        outcomes: proposals.map((row) => ({
          proposalId: row.proposalId,
          status: row.decision === "skip" ? "skipped" as const : "created" as const,
          message: row.decision === "skip" ? "Skipped." : "Created.",
        })),
        counts: { created: 1, matched: 0, skipped: 1, failed: 0 },
      };
    },
  };
  return api;
}

function reviewPreview(): FeeImportPreview {
  return {
    proposals: [
      proposal({
        proposalId: "create-row",
        suggestedMatchProcedureConceptKey: "refraction",
        matchRanking: [
          { procedureConceptKey: "refraction", score: 0.5 },
          { procedureConceptKey: "practice-service", score: 0 },
        ],
        flags: [{ class: "active-column-unmapped", message: "Active column must be mapped." }],
      }),
      proposal({
        proposalId: "seed-row",
        sourceRows: [3],
        decision: "match",
        matchProcedureConceptKey: "refraction",
        matchSeeded: true,
        display: "Refraction",
        category: "refraction",
        routing: "self-pay",
      }),
      proposal({
        proposalId: "skip-row",
        sourceRows: [4],
        decision: "skip",
        display: "Synthetic scheduling slot",
        routing: "scheduling-only",
        category: undefined,
        reasons: ["Scheduling-only rows create no fee definition."],
      }),
    ],
    matchOptions: [
      { procedureConceptKey: "refraction", display: "Refraction", category: "refraction", seeded: true },
      { procedureConceptKey: "practice-service", display: "Practice service", category: "procedure", seeded: false },
    ],
    counts: { create: 1, match: 1, skip: 1, flagged: 1 },
  };
}

async function inspectAndReview(renderer: ReturnType<typeof create>): Promise<void> {
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Fee import CSV text" }).props.onChange({
      currentTarget: { value: "Service,Group\nSynthetic,Procedure\n" },
    });
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Inspect fee import CSV" }).props.onClick();
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Build fee import review" }).props.onClick();
  });
}

test("fee import upload and paste both inspect before mapping and make no commit", async () => {
  // Calling commit before the explicit review action must make this test red.
  const api = memoryApi();
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Fee import CSV text" }).props.onChange({
      currentTarget: { value: "Pasted,CSV\nSynthetic,One\n" },
    });
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Inspect fee import CSV" }).props.onClick();
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Fee import CSV file" }).props.onChange({
      currentTarget: { files: [{ text: async () => "Uploaded,CSV\nSynthetic,Two\n" }] },
    });
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Inspect fee import CSV" }).props.onClick();
  });
  assert.deepEqual(api.inspectCalls, [
    "Pasted,CSV\nSynthetic,One\n",
    "Uploaded,CSV\nSynthetic,Two\n",
  ]);
  assert.equal(api.commitCalls.length, 0);
});

test("mapping suggestions are visible operator-overridable and missing display blocks proposal", async () => {
  // Hard-coding server suggestions or allowing proposal without display must make this test red.
  const api = memoryApi();
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Fee import CSV text" }).props.onChange({ currentTarget: { value: "csv" } });
  });
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Inspect fee import CSV" }).props.onClick();
  });
  const display = renderer.root.findByProps({ "aria-label": "Map display column" });
  assert.equal(display.props.value, "Service");
  await act(async () => display.props.onChange({ currentTarget: { value: "Code" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Map display column" }).props.onChange({
    currentTarget: { value: "" },
  }));
  assert.equal(renderer.root.findByProps({ "aria-label": "Build fee import review" }).props.disabled, true);
  assert.match(JSON.stringify(renderer.toJSON()), /Choose a display column/);
  await act(async () => renderer.root.findByProps({ "aria-label": "Map display column" }).props.onChange({
    currentTarget: { value: "Code" },
  }));
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Build fee import review" }).props.onClick();
  });
  assert.equal(api.proposeCalls[0]?.mapping.display, "Code");
});

test("review renders create match skip flagged counts and every mutable field", async () => {
  // Hiding server flags or any reviewed create field must make this test red.
  const renderer = create(<FeeScheduleImport api={memoryApi()} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);
  const html = JSON.stringify(renderer.toJSON());
  assert.equal(renderer.root.findAllByType("p").some((node) =>
    node.children.join("") === "1 create · 1 match · 1 skip · 1 flagged"
  ), true);
  assert.match(html, /Active column must be mapped/);
  for (const label of ["Display", "Category", "Billing code", "Modifier", "Price", "Routing", "Decision"]) {
    assert.ok(renderer.root.findAllByProps({ "aria-label": `${label} for create-row` }).length > 0, label);
  }
  assert.ok(renderer.root.findAllByProps({ "aria-label": "Match target for seed-row" }).length > 0);
});

test("bulk routing changes exactly selected eligible rows and abandon still writes nothing", async () => {
  // Applying bulk routing to an unselected, skipped, or scheduling-only row must change one of these controls.
  const api = memoryApi();
  const preview = reviewPreview();
  preview.proposals[0]!.routing = undefined;
  preview.proposals[0]!.flags.push({ class: "routing-required", message: "Routing must be reviewed before commit." });
  preview.proposals[1]!.routing = "insurance-billable";
  api.propose = async () => preview;
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);

  await act(async () => renderer.root.findByProps({ "aria-label": "Select fee row create-row" }).props.onChange({
    currentTarget: { checked: true },
  }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Select fee row skip-row" }).props.onChange({
    currentTarget: { checked: true },
  }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Bulk routing value" }).props.onChange({
    currentTarget: { value: "self-pay" },
  }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Bulk set routing for selected" }).props.onClick());

  assert.equal(renderer.root.findByProps({ "aria-label": "Routing for create-row" }).props.value, "self-pay");
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Routing must be reviewed before commit/);
  assert.equal(renderer.root.findByProps({ "aria-label": "Routing for seed-row" }).props.value, "insurance-billable");
  assert.equal(renderer.root.findByProps({ "aria-label": "Routing for skip-row" }).props.value, "scheduling-only");
  assert.equal(api.commitCalls.length, 0);
  await act(async () => renderer.root.findByProps({ "aria-label": "Abandon fee import review" }).props.onClick());
  assert.equal(api.commitCalls.length, 0);
});

test("global and filtered selection target the visible review rows", async () => {
  // Ignoring the active filter or omitting global selection must leave the wrong row checkbox state.
  const renderer = create(<FeeScheduleImport api={memoryApi()} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);

  await act(async () => renderer.root.findByProps({ "aria-label": "Fee import review filter" }).props.onChange({
    currentTarget: { value: "create" },
  }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Select all filtered fee rows" }).props.onClick());
  assert.equal(renderer.root.findByProps({ "aria-label": "Select fee row create-row" }).props.checked, true);
  await act(async () => renderer.root.findByProps({ "aria-label": "Fee import review filter" }).props.onChange({
    currentTarget: { value: "all" },
  }));
  assert.equal(renderer.root.findByProps({ "aria-label": "Select fee row seed-row" }).props.checked, false);
  assert.equal(renderer.root.findByProps({ "aria-label": "Select fee row skip-row" }).props.checked, false);

  await act(async () => renderer.root.findByProps({ "aria-label": "Select all fee import rows" }).props.onChange({
    currentTarget: { checked: true },
  }));
  assert.equal(renderer.root.findByProps({ "aria-label": "Select fee row create-row" }).props.checked, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "Select fee row seed-row" }).props.checked, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "Select fee row skip-row" }).props.checked, true);
});

test("clinical preset selects exactly non-skip clinical rows and records insurance routing", async () => {
  // Including a skipped or scheduling-only row, or missing an eligible category, must fail this exact selection matrix.
  const api = memoryApi();
  const preview = reviewPreview();
  preview.proposals[0]!.routing = undefined;
  preview.proposals[1]!.routing = "self-pay";
  preview.proposals.push(
    proposal({ proposalId: "exam-row", sourceRows: [5], category: "exam", routing: undefined }),
    proposal({ proposalId: "cl-row", sourceRows: [6], category: "cl-fitting", routing: "self-pay" }),
    proposal({
      proposalId: "stale-scheduling-row",
      sourceRows: [7],
      category: "procedure",
      decision: "create",
      routing: "scheduling-only",
    }),
  );
  api.propose = async () => preview;
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);

  await act(async () => renderer.root.findByProps({
    "aria-label": "Set all clinical rows to insurance-billable",
  }).props.onClick());

  for (const proposalId of ["create-row", "seed-row", "exam-row", "cl-row"]) {
    assert.equal(renderer.root.findByProps({ "aria-label": `Select fee row ${proposalId}` }).props.checked, true);
    assert.equal(renderer.root.findByProps({ "aria-label": `Routing for ${proposalId}` }).props.value, "insurance-billable");
  }
  assert.equal(renderer.root.findByProps({ "aria-label": "Select fee row skip-row" }).props.checked, false);
  assert.equal(renderer.root.findByProps({ "aria-label": "Select fee row stale-scheduling-row" }).props.checked, false);
  assert.equal(renderer.root.findByProps({ "aria-label": "Routing for skip-row" }).props.value, "scheduling-only");
  assert.equal(renderer.root.findByProps({ "aria-label": "Routing for stale-scheduling-row" }).props.value, "scheduling-only");
  assert.equal(api.commitCalls.length, 0);
});

test("a seeded suggestion never changes create until the operator accepts it", async () => {
  // Auto-applying the top suggestion must make the initial decision assertion red.
  const renderer = create(<FeeScheduleImport api={memoryApi()} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);

  assert.equal(renderer.root.findByProps({ "aria-label": "Decision for create-row" }).props.value, "create");
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Match target for create-row" }).length, 0);
  const suggestion = renderer.root.findByProps({
    "aria-label": "Match create-row to suggested Refraction",
  });
  assert.match(suggestion.children.join(""), /Resembles seeded concept Refraction/);

  await act(async () => suggestion.props.onClick());

  assert.equal(renderer.root.findByProps({ "aria-label": "Decision for create-row" }).props.value, "match");
  const target = renderer.root.findByProps({ "aria-label": "Match target for create-row" });
  assert.equal(target.props.value, "refraction");
  assert.deepEqual(
    target.findAllByType("option").slice(1).map((option) => option.props.value),
    ["refraction", "practice-service"],
  );
});

test("reviewed corrections clear resolved flags but preserve source-history warnings", async () => {
  // Retaining a warning after its reviewed field changes, or dropping laterality history, must fail this matrix.
  const api = memoryApi();
  const preview = reviewPreview();
  preview.proposals = [
    proposal({
      proposalId: "suggestion-row",
      category: "exam",
      suggestedMatchProcedureConceptKey: "refraction",
      matchRanking: [{ procedureConceptKey: "refraction", score: 0.5 }],
      flags: [
        { class: "seeded-concept-uncoded", message: "Seed remains uncoded." },
        { class: "category-required", message: "Category requires review." },
        { class: "concept-key-conflict", message: "Concept key conflicts." },
      ],
    }),
    proposal({
      proposalId: "edited-row",
      category: undefined,
      flags: [
        { class: "invalid-active-code-name", message: "Invalid active name." },
        { class: "zero-price-contradiction", message: "Zero-price contradiction." },
        { class: "obsolete-or-superseded", message: "Obsolete display." },
        { class: "category-required", message: "Category requires review." },
        { class: "active-column-unmapped", message: "Active column unmapped." },
        { class: "laterality-dropped", message: "Laterality was dropped." },
        { class: "invalid-price", message: "Price is invalid." },
        { class: "invalid-source-boolean", message: "Source boolean is invalid." },
        { class: "concept-key-conflict", message: "Concept key conflicts." },
      ],
    }),
  ];
  api.propose = async () => preview;
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);

  await act(async () => renderer.root.findByProps({
    "aria-label": "Match suggestion-row to suggested Refraction",
  }).props.onClick());
  const suggestionText = renderer.root.findByProps({ "data-proposal-id": "suggestion-row" })
    .findAllByType("p").flatMap((node) => node.children).join(" ");
  assert.doesNotMatch(suggestionText, /Seed remains uncoded|Category requires review|Concept key conflicts/);

  await act(async () => renderer.root.findByProps({ "aria-label": "Display for edited-row" }).props.onChange({
    currentTarget: { value: "Still obsolete service" },
  }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Category for edited-row" }).props.onChange({
    currentTarget: { value: "procedure" },
  }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Price for edited-row" }).props.onChange({
    currentTarget: { value: "12.34" },
  }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Active for edited-row" }).props.onChange({
    currentTarget: { checked: false },
  }));
  const editedJson = renderer.root.findByProps({ "data-proposal-id": "edited-row" })
    .findAllByType("p").flatMap((node) => node.children).join(" ");
  assert.doesNotMatch(
    editedJson,
    /Invalid active name|Category requires review|Active column unmapped|Price is invalid|Source boolean is invalid/,
  );
  for (const message of ["Zero-price contradiction", "Obsolete display", "Concept key conflicts", "Laterality was dropped"]) {
    assert.match(editedJson, new RegExp(message));
  }

  await act(async () => renderer.root.findByProps({ "aria-label": "Display for edited-row" }).props.onChange({
    currentTarget: { value: "Reviewed display" },
  }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Price for edited-row" }).props.onChange({
    currentTarget: { value: "0" },
  }));
  const correctedJson = renderer.root.findByProps({ "data-proposal-id": "edited-row" })
    .findAllByType("p").flatMap((node) => node.children).join(" ");
  assert.doesNotMatch(correctedJson, /Zero-price contradiction|Obsolete display/);
  assert.match(correctedJson, /Concept key conflicts/);
  assert.match(correctedJson, /Laterality was dropped/);
});

test("review controls use the shared high-contrast settings styles", async () => {
  // Omitting scheduler-input or scheduler-button reproduces unreadable light controls on the dark settings surface.
  const renderer = create(<FeeScheduleImport api={memoryApi()} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);
  const reviewControls = renderer.root.findAll((node) =>
    typeof node.props["aria-label"] === "string" &&
    / for (?:create-row|seed-row|skip-row)$/.test(node.props["aria-label"])
  );
  assert.equal(reviewControls.filter((node) =>
    node.type === "select" || (node.type === "input" && node.props.type !== "checkbox")
  ).every((node) =>
    String(node.props.className ?? "").includes("scheduler-input")
  ), true);
  for (const label of ["Commit reviewed fee import", "Abandon fee import review"]) {
    assert.match(renderer.root.findByProps({ "aria-label": label }).props.className ?? "", /scheduler-button/);
  }
});

test("review price rejects over-precision and exponent input without changing the proposed cents", async () => {
  // Coercing arbitrary Number syntax or rounding beyond two decimals must silently change money.
  const api = memoryApi();
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);
  const price = renderer.root.findByProps({ "aria-label": "Price for create-row" });

  for (const invalid of ["1.999", "1e2"]) {
    await act(async () => price.props.onChange({ currentTarget: { value: invalid } }));
    assert.equal(renderer.root.findByProps({ "aria-label": "Price for create-row" }).props.value, invalid);
    assert.match(JSON.stringify(renderer.toJSON()), /at most two decimal places/i);
    assert.equal(renderer.root.findByProps({ "aria-label": "Commit reviewed fee import" }).props.disabled, true);
  }

  await act(async () => renderer.root.findByProps({ "aria-label": "Price for create-row" }).props.onChange({
    currentTarget: { value: "1.99" },
  }));
  assert.equal(renderer.root.findByProps({ "aria-label": "Commit reviewed fee import" }).props.disabled, false);
  await act(async () => renderer.root.findByProps({ "aria-label": "Commit reviewed fee import" }).props.onClick());
  assert.equal(api.commitCalls[0]?.find((row) => row.proposalId === "create-row")?.priceCents, 199);
});

test("clearing a populated review price removes proposed cents", async () => {
  const api = memoryApi();
  const originalPropose = api.propose;
  api.propose = async (csvText, mapping) => {
    const result = await originalPropose(csvText, mapping);
    result.proposals[0]!.priceCents = 1234;
    return result;
  };
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);
  const price = renderer.root.findByProps({ "aria-label": "Price for create-row" });
  assert.equal(price.props.value, "12.34");
  await act(async () => price.props.onChange({ currentTarget: { value: "" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Commit reviewed fee import" }).props.onClick());
  assert.equal(api.commitCalls[0]?.find((row) => row.proposalId === "create-row")?.priceCents, undefined);
});

test("seeded match inherits read-only display and category while practice match stays editable", async () => {
  // Rendering editable seeded identity or failing to enable practice identity must make this test red.
  const renderer = create(<FeeScheduleImport api={memoryApi()} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Display for seed-row" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Category for seed-row" }).length, 0);
  const target = renderer.root.findByProps({ "aria-label": "Match target for seed-row" });
  await act(async () => target.props.onChange({ currentTarget: { value: "practice-service" } }));
  assert.equal(renderer.root.findByProps({ "aria-label": "Display for seed-row" }).props.value, "Practice service");
  assert.equal(renderer.root.findByProps({ "aria-label": "Category for seed-row" }).props.value, "procedure");
});

test("recorded-only modifier and routing warning is visible", async () => {
  const renderer = create(<FeeScheduleImport api={memoryApi()} onCommitted={() => undefined} />);
  assert.match(JSON.stringify(renderer.toJSON()), /Modifier and routing are recorded only in this version/);
  assert.match(JSON.stringify(renderer.toJSON()), /Side comes from each charge/);
});

test("abandon review clears transient state without a commit request", async () => {
  // Any mutation call from abandon must make this test red.
  const api = memoryApi();
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);
  await act(async () => renderer.root.findByProps({ "aria-label": "Abandon fee import review" }).props.onClick());
  assert.equal(api.commitCalls.length, 0);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Commit reviewed fee import" }).length, 0);
  assert.ok(renderer.root.findByProps({ "aria-label": "Fee import CSV text" }));
});

test("one explicit commit renders mixed created matched skipped and failed row outcomes", async () => {
  // Collapsing the batch into one generic result must hide per-row status and make this test red.
  const api = memoryApi({
    commit: {
      outcomes: [
        { proposalId: "create-row", status: "created", message: "Created row." },
        { proposalId: "seed-row", status: "matched", message: "Matched row." },
        { proposalId: "skip-row", status: "skipped", message: "Skipped row." },
        { proposalId: "failed-row", status: "failed", message: "Failed row." },
      ],
      counts: { created: 1, matched: 1, skipped: 1, failed: 1 },
    },
  });
  const preview = reviewPreview();
  preview.proposals.push(proposal({ proposalId: "failed-row", sourceRows: [5], display: "Synthetic failing row" }));
  api.propose = async () => preview;
  const renderer = create(<FeeScheduleImport api={api} onCommitted={() => undefined} />);
  await inspectAndReview(renderer);
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": "Commit reviewed fee import" }).props.onClick();
  });
  assert.equal(api.commitCalls.length, 1);
  const html = JSON.stringify(renderer.toJSON());
  for (const text of ["created", "matched", "skipped", "failed", "Created row", "Matched row", "Skipped row", "Failed row"]) {
    assert.match(html, new RegExp(text, "i"));
  }
});

test("read-only fee settings render no import upload or commit controls", () => {
  const renderer = create(<FeeScheduleSettings canWrite={false} />);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Fee import CSV file" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Commit reviewed fee import" }).length, 0);
});
