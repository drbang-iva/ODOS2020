import assert from "node:assert/strict";
import { test } from "node:test";
import React, { useState } from "react";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  procedureFeeScheduleAdapter,
  type ProcedureFeeScheduleItem,
} from "../src/lib/procedure-fee-schedule";
import { feeScheduleDescriptor } from "../src/scenes/settings/FeeScheduleSettings";
import { VisitCodeSelector } from "../src/components/charting/VisitCodeSelector";
import * as visitCodeModule from "../src/components/charting/VisitCodeSelector";
import { EncounterHeader, MdmProblemsAxis } from "../src/components/charting/EncounterHeader";
import { computeMdmHint } from "../src/lib/clinical-view-model";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";
import type {
  VisitChargeApi,
  VisitChargeResponse,
  VisitProcedureFamily,
} from "../src/lib/clinical-graph-client";

const ROUTINE_ITEM: ProcedureFeeScheduleItem = {
  id: "routine-vision-exam-new",
  procedureConceptKey: "routine-vision-exam-new",
  display: "Routine vision exam — new patient",
  active: true,
  billingCode: "S0620",
  version: "1",
};

test("fee settings round-trip the optional billing code while allowing practice concept creation", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (!init?.method) return Response.json({ items: [ROUTINE_ITEM] });
    return Response.json({ item: { ...ROUTINE_ITEM, version: "2" } });
  };
  const adapter = procedureFeeScheduleAdapter(fetchImpl);
  assert.deepEqual(await adapter.list(), [ROUTINE_ITEM]);
  assert.equal((await adapter.save(ROUTINE_ITEM)).billingCode, "S0620");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    action: "save",
    billingCode: "S0620",
    priceCents: null,
    active: true,
  });

  const descriptor = feeScheduleDescriptor(adapter);
  assert.notEqual(descriptor.canCreate, false);
  assert.deepEqual(descriptor.fields, [
    { type: "text", key: "billingCode", label: "Billing code" },
    { type: "text", key: "modifier", label: "Modifier (recorded only)" },
    {
      type: "select",
      key: "routing",
      label: "Routing (recorded only)",
      options: [
        { value: "insurance-billable", label: "Insurance billable" },
        { value: "self-pay", label: "Self-pay" },
      ],
    },
    { type: "currency", key: "priceCents", label: "Fee", min: 0 },
  ]);
  assert.deepEqual(descriptor.facts?.(ROUTINE_ITEM), ["S0620", "Unpriced", "Version 1"]);
  assert.match(descriptor.listGrammar?.searchText?.(ROUTINE_ITEM) ?? "", /S0620/);
  const uncoded = { ...ROUTINE_ITEM, procedureConceptKey: "refraction", display: "Refraction" };
  delete uncoded.billingCode;
  assert.equal(descriptor.facts?.(uncoded).includes("S0620"), false);
});

test("the passive selector starts blank, selects, and clears without another workflow surface", async () => {
  const mutations: unknown[] = [];
  const families: Array<VisitProcedureFamily | null | undefined> = [];
  const options = visitOptions();
  let selectedProcedureConceptKey: string | undefined;
  const api: VisitChargeApi = {
    async read() {
      return {
        options,
        diagnoses: [],
        ...(selectedProcedureConceptKey
          ? {
              selectedProcedureConceptKey,
              procedureFamily: "vision-plan" as const,
              proposal: {
                id: "manual-visit-code:enc-1",
                procedureConceptKey: selectedProcedureConceptKey,
                dxPointers: [],
                state: "accepted" as const,
              },
            }
          : {}),
      };
    },
    async save(_encounterId, change) {
      mutations.push(change);
      const procedureConceptKey = change.procedureConceptKey;
      selectedProcedureConceptKey = procedureConceptKey ?? undefined;
      return {
        options,
        diagnoses: [],
        ...(procedureConceptKey ? { selectedProcedureConceptKey: procedureConceptKey } : {}),
        ...(procedureConceptKey ? { procedureFamily: "vision-plan" as const } : {}),
      };
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitCodeSelector encounterId="enc-1" api={api} onProcedureFamilyChange={(family) => families.push(family)} />,
    );
    await Promise.resolve();
  });
  let select = renderer.root.findByProps({ "aria-label": "Visit billing code" });
  assert.equal(select.props.value, "");
  const renderedOptions = select.findAllByType("option");
  assert.equal(renderedOptions.length, 13);
  assert.equal(renderedOptions.some((option) => option.children.join("").includes("Refraction")), false);
  assert.equal(renderedOptions.some((option) =>
    option.children.join("") === "Routine vision exam — new patient — S0620"
  ), true);
  assert.equal(renderedOptions.some((option) =>
    option.children.join("") === "Comprehensive eye exam — new patient"
  ), true);
  assert.equal(renderer.root.findAll((node) => node.props.role === "dialog").length, 0);
  assert.equal(renderer.root.findAllByType("button").length, 0);

  await act(async () => {
    await select.props.onChange({ target: { value: "routine-vision-exam-new" } });
  });
  select = renderer.root.findByProps({ "aria-label": "Visit billing code" });
  assert.equal(select.props.value, "routine-vision-exam-new");
  await act(async () => {
    await select.props.onChange({ target: { value: "" } });
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "Visit billing code" }).props.value, "");
  assert.deepEqual(mutations, [
    { procedureConceptKey: "routine-vision-exam-new" },
    { procedureConceptKey: null },
  ]);
  assert.equal(families.at(-1), null);
  act(() => renderer.unmount());
});

test("visit diagnosis selection is visible, editable, clearable, and warns on an empty pointer", async () => {
  const mutations: unknown[] = [];
  let pointer: string | undefined;
  const api: VisitChargeApi = {
    async read() {
      return {
        options: visitOptions(),
        diagnoses: [
          { reference: "Condition/principal", display: "Principal diagnosis", rank: 1 },
          { reference: "Condition/secondary", display: "Secondary diagnosis", rank: 2 },
        ],
        selectedProcedureConceptKey: "office-visit-new-low",
        procedureFamily: "em",
        proposal: {
          id: "manual-visit-code:enc-diagnosis",
          procedureConceptKey: "office-visit-new-low",
          dxPointers: pointer ? [pointer] : [],
          state: "accepted",
        },
      };
    },
    async save(_encounterId, change) {
      mutations.push(change);
      pointer = change.dxPointer ?? undefined;
      return {
        procedureFamily: "em",
        proposal: {
          id: "manual-visit-code:enc-diagnosis",
          procedureConceptKey: "office-visit-new-low",
          dxPointers: pointer ? [pointer] : [],
          state: "accepted",
        },
      };
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<VisitCodeSelector encounterId="enc-diagnosis" api={api} />);
    await Promise.resolve();
  });
  let diagnosisSelect = renderer.root.findByProps({ "aria-label": "Visit billing diagnosis" });
  assert.equal(diagnosisSelect.props.value, "");
  assert.match(renderer.root.findByProps({ "data-testid": "visit-code-diagnosis-warning" }).children.join(""), /will not be included in a claim/i);

  await act(async () => {
    await diagnosisSelect.props.onChange({ target: { value: "Condition/secondary" } });
  });
  diagnosisSelect = renderer.root.findByProps({ "aria-label": "Visit billing diagnosis" });
  assert.equal(diagnosisSelect.props.value, "Condition/secondary");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "visit-code-diagnosis-warning" }).length, 0);

  await act(async () => {
    await diagnosisSelect.props.onChange({ target: { value: "" } });
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "Visit billing diagnosis" }).props.value, "");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "visit-code-diagnosis-warning" }).length, 1);
  assert.deepEqual(mutations, [
    { dxPointer: "Condition/secondary" },
    { dxPointer: null },
  ]);
  act(() => renderer.unmount());
});

test("the visit selector reports the stored broken pointer without clearing or re-deriving it", async () => {
  const response: VisitChargeResponse = {
    options: visitOptions(),
    diagnoses: [{ reference: "Condition/current", display: "Current diagnosis", rank: 1 }],
    selectedProcedureConceptKey: "office-visit-new-low",
    procedureFamily: "em",
    proposal: {
      id: "manual-visit-code:enc-broken",
      procedureConceptKey: "office-visit-new-low",
      dxPointers: ["Condition/retracted"],
      state: "accepted",
    },
  };
  const reported: Array<VisitChargeResponse | undefined> = [];
  let saveCalls = 0;
  const api: VisitChargeApi = {
    async read() { return response; },
    async save() {
      saveCalls += 1;
      throw new Error("broken links must not be rewritten automatically");
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitCodeSelector
        encounterId="enc-broken"
        api={api}
        onVisitChargeChange={(state: VisitChargeResponse | undefined) => reported.push(state)}
      />,
    );
    await Promise.resolve();
  });
  assert.deepEqual(reported.at(-1)?.proposal?.dxPointers, ["Condition/retracted"]);
  assert.equal(saveCalls, 0);
  assert.deepEqual(response.proposal?.dxPointers, ["Condition/retracted"]);
  act(() => renderer.unmount());
});

test("the visit selector rereads diagnosis inventory before a later link edit", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget() as Window,
  });
  const options = visitOptions();
  const initial: VisitChargeResponse = {
    options,
    diagnoses: [{ reference: "Condition/old", display: "Old diagnosis", rank: 1 }],
    selectedProcedureConceptKey: "office-visit-new-low",
    procedureFamily: "em",
    proposal: {
      id: "manual-visit-code:enc-refresh",
      procedureConceptKey: "office-visit-new-low",
      dxPointers: ["Condition/old"],
      state: "accepted",
    },
  };
  const refreshed: VisitChargeResponse = {
    ...initial,
    diagnoses: [{ reference: "Condition/new", display: "New diagnosis", rank: 1 }],
  };
  const reported: Array<VisitChargeResponse | undefined> = [];
  let reads = 0;
  let saved = false;
  const api: VisitChargeApi = {
    async read() {
      reads += 1;
      return reads === 1
        ? initial
        : saved
          ? {
              ...refreshed,
              proposal: { ...refreshed.proposal!, dxPointers: ["Condition/new"] },
            }
          : refreshed;
    },
    async save() {
      saved = true;
      return {
        ...refreshed,
        proposal: {
          ...refreshed.proposal!,
          dxPointers: ["Condition/new"],
        },
      };
    },
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <VisitCodeSelector
          encounterId="enc-refresh"
          api={api}
          onVisitChargeChange={(state) => reported.push(state)}
        />,
      );
      await Promise.resolve();
    });

    window.dispatchEvent(new CustomEvent("odos:encounter-diagnosis-updated", {
      detail: { encounterReference: "Encounter/enc-refresh" },
    }));
    await act(async () => { await Promise.resolve(); });
    assert.equal(reads, 2);

    const diagnosis = renderer.root.findByProps({ "aria-label": "Visit billing diagnosis" });
    await act(async () => diagnosis.props.onChange({ target: { value: "Condition/new" } }));
    assert.deepEqual(reported.at(-1)?.diagnoses, refreshed.diagnoses);
    assert.deepEqual(reported.at(-1)?.proposal?.dxPointers, ["Condition/new"]);
  } finally {
    if (renderer) act(() => renderer.unmount());
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: Window }).window;
  }
});

test("an in-flight Visit save cannot overwrite a newer diagnosis refresh", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget() as Window,
  });
  const options = visitOptions();
  const initial: VisitChargeResponse = {
    options,
    diagnoses: [{ reference: "Condition/old", display: "Old diagnosis", rank: 1 }],
    selectedProcedureConceptKey: "office-visit-new-low",
    procedureFamily: "em",
    proposal: {
      id: "manual-visit-code:enc-race",
      procedureConceptKey: "office-visit-new-low",
      dxPointers: ["Condition/old"],
      state: "accepted",
    },
  };
  const refreshed: VisitChargeResponse = {
    ...initial,
    diagnoses: [{ reference: "Condition/new", display: "New diagnosis", rank: 1 }],
  };
  let resolveSave!: (response: Partial<VisitChargeResponse>) => void;
  const saveResponse = new Promise<Partial<VisitChargeResponse>>((resolve) => {
    resolveSave = resolve;
  });
  const reported: Array<VisitChargeResponse | undefined> = [];
  let reads = 0;
  let saveCommitted = false;
  const api: VisitChargeApi = {
    async read() {
      reads += 1;
      return reads === 1
        ? initial
        : saveCommitted
          ? {
              ...refreshed,
              proposal: { ...refreshed.proposal!, dxPointers: ["Condition/new"] },
            }
          : refreshed;
    },
    async save() { return saveResponse; },
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <VisitCodeSelector
          encounterId="enc-race"
          api={api}
          onVisitChargeChange={(state) => reported.push(state)}
        />,
      );
      await Promise.resolve();
    });

    const diagnosis = renderer.root.findByProps({ "aria-label": "Visit billing diagnosis" });
    let save!: Promise<void>;
    act(() => {
      save = diagnosis.props.onChange({ target: { value: "Condition/new" } });
    });
    window.dispatchEvent(new CustomEvent("odos:encounter-diagnosis-updated", {
      detail: { encounterReference: "Encounter/enc-race" },
    }));
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(reported.at(-1)?.diagnoses, refreshed.diagnoses);

    saveCommitted = true;
    resolveSave({
      procedureFamily: "em",
      proposal: {
        ...initial.proposal!,
        dxPointers: ["Condition/new"],
      },
    });
    await act(async () => { await save; });
    assert.deepEqual(reported.at(-1)?.diagnoses, refreshed.diagnoses);
    assert.deepEqual(reported.at(-1)?.proposal?.dxPointers, ["Condition/new"]);
  } finally {
    if (renderer) act(() => renderer.unmount());
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: Window }).window;
  }
});

test("a pre-save Visit reread cannot overwrite the authoritative post-save state", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget() as Window,
  });
  const initial: VisitChargeResponse = {
    options: visitOptions(),
    diagnoses: [{ reference: "Condition/one", display: "Diagnosis one", rank: 1 }],
    selectedProcedureConceptKey: "office-visit-new-low",
    procedureFamily: "em",
    proposal: {
      id: "manual-visit-code:enc-inverse-race",
      procedureConceptKey: "office-visit-new-low",
      dxPointers: ["Condition/one"],
      state: "accepted",
    },
  };
  const final: VisitChargeResponse = {
    ...initial,
    selectedProcedureConceptKey: "routine-vision-exam-new",
    procedureFamily: "vision-plan",
    proposal: {
      ...initial.proposal!,
      procedureConceptKey: "routine-vision-exam-new",
    },
  };
  let resolveStaleRead!: (response: VisitChargeResponse) => void;
  const staleRead = new Promise<VisitChargeResponse>((resolve) => {
    resolveStaleRead = resolve;
  });
  const reported: Array<VisitChargeResponse | undefined> = [];
  let reads = 0;
  const api: VisitChargeApi = {
    async read() {
      reads += 1;
      if (reads === 1) return initial;
      if (reads === 2) return staleRead;
      return final;
    },
    async save() {
      return {
        procedureFamily: "vision-plan",
        proposal: final.proposal,
      };
    },
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <VisitCodeSelector
          encounterId="enc-inverse-race"
          api={api}
          onVisitChargeChange={(state) => reported.push(state)}
        />,
      );
      await Promise.resolve();
    });

    const procedure = renderer.root.findByProps({ "aria-label": "Visit billing code" });
    window.dispatchEvent(new CustomEvent("odos:encounter-diagnosis-updated", {
      detail: { encounterReference: "Encounter/enc-inverse-race" },
    }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => procedure.props.onChange({ target: { value: "routine-vision-exam-new" } }));
    assert.equal(reads, 3);
    assert.equal(reported.at(-1)?.selectedProcedureConceptKey, "routine-vision-exam-new");

    resolveStaleRead(initial);
    await act(async () => { await Promise.resolve(); });
    assert.equal(reported.at(-1)?.selectedProcedureConceptKey, "routine-vision-exam-new");
    assert.equal(reported.at(-1)?.proposal?.procedureConceptKey, "routine-vision-exam-new");
  } finally {
    if (renderer) act(() => renderer.unmount());
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: Window }).window;
  }
});

test("switching encounters clears an in-flight Visit saving state", async () => {
  const response: VisitChargeResponse = {
    options: visitOptions(),
    diagnoses: [],
  };
  let resolveSave!: (response: Partial<VisitChargeResponse>) => void;
  const pendingSave = new Promise<Partial<VisitChargeResponse>>((resolve) => {
    resolveSave = resolve;
  });
  const api: VisitChargeApi = {
    async read() { return response; },
    async save() { return pendingSave; },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<VisitCodeSelector encounterId="enc-saving-first" api={api} />);
    await Promise.resolve();
  });
  const firstProcedure = renderer.root.findByProps({ "aria-label": "Visit billing code" });
  let save!: Promise<void>;
  act(() => {
    save = firstProcedure.props.onChange({ target: { value: "routine-vision-exam-new" } });
  });
  assert.equal(renderer.root.findAllByType("span").filter((node) => textContent(node) === "Saving…").length, 1);

  await act(async () => {
    renderer.update(<VisitCodeSelector encounterId="enc-saving-second" api={api} />);
    await Promise.resolve();
  });
  assert.equal(renderer.root.findAllByType("span").filter((node) => textContent(node) === "Saving…").length, 0);
  assert.equal(renderer.root.findByProps({ "aria-label": "Visit billing code" }).props.disabled, false);

  resolveSave({});
  await act(async () => { await save; });
  act(() => renderer.unmount());
});

test("the Visit chip renders none, linked-code, empty-link, and named broken-link states", async () => {
  const cases: Array<{
    label: string;
    response: VisitChargeResponse;
    expected: RegExp;
    integrity?: "empty" | "broken";
  }> = [
    {
      label: "none",
      response: { options: visitOptions(), diagnoses: [] },
      expected: /Visit — none/,
    },
    {
      label: "linked verified code",
      response: {
        options: visitOptions(),
        diagnoses: [{ reference: "Condition/myopia", display: "Myopia" }],
        selectedProcedureConceptKey: "routine-vision-exam-new",
        procedureFamily: "vision-plan",
        proposal: {
          id: "manual-visit-code:enc-chip",
          procedureConceptKey: "routine-vision-exam-new",
          dxPointers: ["Condition/myopia"],
          state: "accepted",
        },
      },
      expected: /S0620.*linked diagnosis.*Myopia/,
    },
    {
      label: "empty link with display-label fallback",
      response: {
        options: visitOptions(),
        diagnoses: [],
        selectedProcedureConceptKey: "comprehensive-exam-established",
        procedureFamily: "eye-code",
        proposal: {
          id: "manual-visit-code:enc-chip",
          procedureConceptKey: "comprehensive-exam-established",
          dxPointers: [],
          state: "accepted",
        },
      },
      expected: /Comprehensive eye exam — established patient.*◇.*no diagnosis linked/,
      integrity: "empty",
    },
    {
      label: "broken link",
      response: {
        options: visitOptions(),
        diagnoses: [{ reference: "Condition/current", display: "Current diagnosis" }],
        selectedProcedureConceptKey: "office-visit-new-low",
        procedureFamily: "em",
        proposal: {
          id: "manual-visit-code:enc-chip",
          procedureConceptKey: "office-visit-new-low",
          dxPointers: ["Condition/retracted"],
          state: "accepted",
        },
      },
      expected: /Office visit — new, low complexity.*◇.*broken linked diagnosis.*Keratoconjunctivitis sicca/,
      integrity: "broken",
    },
  ];

  for (const item of cases) {
    await testVisitChipState(item.label, item.response, item.expected, item.integrity);
  }
});

test("selector read failure stays local and non-blocking", async () => {
  const api: VisitChargeApi = {
    async read() { throw new Error("Synthetic visit charge read failure"); },
    async save() { throw new Error("not reached"); },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<VisitCodeSelector encounterId="enc-error" api={api} />);
    await Promise.resolve();
  });
  assert.match(renderer.root.findByProps({ "data-testid": "visit-code-error" }).children.join(""), /Synthetic visit charge read failure/);
  assert.equal(renderer.root.findAllByType("button").length, 0);
  act(() => renderer.unmount());
});

test("selector clears its visit family before loading a different encounter", async () => {
  const families: Array<VisitProcedureFamily | null | undefined> = [];
  let resolveSecond!: (response: VisitChargeResponse) => void;
  const second = new Promise<VisitChargeResponse>((resolve) => { resolveSecond = resolve; });
  const api: VisitChargeApi = {
    async read(encounterId) {
      return encounterId === "enc-first"
        ? {
            options: visitOptions(),
            diagnoses: [],
            selectedProcedureConceptKey: "office-visit-new-low",
            procedureFamily: "em",
          }
        : second;
    },
    async save() { throw new Error("not reached"); },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VisitCodeSelector
        encounterId="enc-first"
        api={api}
        onProcedureFamilyChange={(family) => families.push(family)}
      />,
    );
    await Promise.resolve();
  });
  assert.equal(families.at(-1), "em");

  act(() => {
    renderer.update(
      <VisitCodeSelector
        encounterId="enc-second"
        api={api}
        onProcedureFamilyChange={(family) => families.push(family)}
      />,
    );
  });
  assert.equal(families.at(-1), undefined);
  assert.equal(renderer.root.findByProps({ "aria-label": "Visit billing code" }).props.value, "");

  await act(async () => {
    resolveSecond({
      options: visitOptions(),
      diagnoses: [],
      selectedProcedureConceptKey: "comprehensive-exam-new",
      procedureFamily: "eye-code",
    });
    await second;
  });
  assert.equal(families.at(-1), "eye-code");
  act(() => renderer.unmount());
});

const MDM_ENCOUNTER: Encounter = {
  resourceType: "Encounter",
  id: "enc-mdm",
  status: "in-progress",
  class: { code: "AMB" },
  diagnosis: [{ condition: { reference: "Condition/one" }, rank: 1 }],
};
const MDM_HINT = computeMdmHint({ encounter: MDM_ENCOUNTER });

function VisitMdmHarness({ api }: { api: VisitChargeApi }) {
  const [family, setFamily] = useState<VisitProcedureFamily | null>();
  return (
    <>
      <VisitCodeSelector encounterId="enc-mdm" api={api} onProcedureFamilyChange={setFamily} />
      <MdmProblemsAxis mdmHint={MDM_HINT} procedureFamily={family} />
    </>
  );
}

function mdmApi(response: VisitChargeResponse | Promise<VisitChargeResponse>): VisitChargeApi {
  return {
    async read() { return response; },
    async save() { throw new Error("not reached"); },
  };
}

async function mdmStripCount(response: VisitChargeResponse | Promise<VisitChargeResponse>): Promise<number> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<VisitMdmHarness api={mdmApi(response)} />);
    await Promise.resolve();
  });
  const count = renderer.root.findAllByProps({ "data-testid": "mdm-hint-counter" }).length;
  act(() => renderer.unmount());
  return count;
}

test("MDM renders for an E/M visit key without changing the existing computation", async () => {
  assert.deepEqual(MDM_HINT, {
    status: "blocked",
    reason: "problem status unset on 1 diagnosis",
    missingProblemStatusCount: 1,
    counts: {
      minimalSelfLimited: 0,
      stableChronic: 0,
      chronicExacerbationProgression: 0,
      chronicSevereExacerbation: 0,
      acuteUncomplicated: 0,
      acuteComplicatedOrSystemic: 0,
      undiagnosedNewProblemUncertainPrognosis: 0,
      threatToLifeOrBodilyFunction: 0,
    },
    sourceDiagnosisCount: 1,
  });
  assert.equal(await mdmStripCount({
    options: visitOptions(),
    diagnoses: [],
    selectedProcedureConceptKey: "office-visit-new-low",
    procedureFamily: "em",
  }), 1);
});

test("one UI helper classifies visit families from the selected concept key", () => {
  const classify = (visitCodeModule as unknown as {
    visitProcedureFamilyForConceptKey?: (key: string | undefined) => VisitProcedureFamily | undefined;
  }).visitProcedureFamilyForConceptKey;
  assert.equal(typeof classify, "function", "the selected-key classifier must be exported from one UI module");
  assert.equal(classify!("office-visit-new-low"), "em");
  assert.equal(classify!("comprehensive-exam-established"), "eye-code");
  assert.equal(classify!("intermediate-exam-new"), "eye-code");
  assert.equal(classify!("routine-vision-exam-new"), "vision-plan");
  assert.equal(classify!(undefined), undefined);
});

test("the MDM fact frame is visibly nonbinding and never uses Blocked as user copy", () => {
  const renderer = create(<MdmProblemsAxis mdmHint={MDM_HINT} procedureFamily="em" />);
  const copy = textContent(renderer.root);
  assert.doesNotMatch(copy, /Blocked/i);
  assert.match(copy, /clinician-entered problem-status facts/i);
  assert.match(copy, /neither selects nor validates the visit code/i);
  act(() => renderer.unmount());
});

test("MDM is absent for a comprehensive eye-code visit key", async () => {
  assert.equal(await mdmStripCount({
    options: visitOptions(),
    diagnoses: [],
    selectedProcedureConceptKey: "comprehensive-exam-new",
    procedureFamily: "eye-code",
  }), 0);
});

test("MDM is absent for an intermediate eye-code visit key", async () => {
  assert.equal(await mdmStripCount({
    options: visitOptions(),
    diagnoses: [],
    selectedProcedureConceptKey: "intermediate-exam-established",
    procedureFamily: "eye-code",
  }), 0);
});

test("MDM is absent for a routine vision-plan visit key", async () => {
  assert.equal(await mdmStripCount({
    options: visitOptions(),
    diagnoses: [],
    selectedProcedureConceptKey: "routine-vision-exam-new",
    procedureFamily: "vision-plan",
  }), 0);
});

test("MDM is absent when no visit key is selected", async () => {
  assert.equal(await mdmStripCount({ options: visitOptions(), diagnoses: [] }), 0);
});

test("MDM is absent while the visit family is not yet known", async () => {
  assert.equal(await mdmStripCount(new Promise<VisitChargeResponse>(() => undefined)), 0);
});

test("EncounterHeader wires visit family to MDM and suppresses it across an encounter switch", async () => {
  const originalRead = fhir.read;
  fhir.read = (async (resourceType: string, id: string) => {
    assert.equal(resourceType, "Encounter");
    return {
      ...MDM_ENCOUNTER,
      id,
      subject: { reference: "Patient/patient-1" },
    };
  }) as typeof fhir.read;
  const patient = { resourceType: "Patient" as const, id: "patient-1", name: [{ text: "Test Patient" }] };
  const header = (encounterId: string) => (
    <RoleProvider>
      <EncounterHeader patient={patient} encounterId={encounterId} />
    </RoleProvider>
  );
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(header("enc-first"));
      await Promise.resolve();
      await Promise.resolve();
    });
    let selector = renderer.root.findByType(VisitCodeSelector);
    act(() => selector.props.onProcedureFamilyChange("eye-code"));
    assert.equal(renderer.root.findAllByProps({ "data-testid": "mdm-hint-counter" }).length, 0);
    act(() => selector.props.onProcedureFamilyChange("em"));
    assert.equal(renderer.root.findAllByProps({ "data-testid": "mdm-hint-counter" }).length, 1);

    renderer.update(header("enc-second"));
    assert.equal(renderer.root.findAllByProps({ "data-testid": "mdm-hint-counter" }).length, 0);
    await act(async () => { await Promise.resolve(); });
    selector = renderer.root.findByType(VisitCodeSelector);
    assert.equal(selector.props.encounterId, "enc-second");
    assert.equal(renderer.root.findAllByProps({ "data-testid": "mdm-hint-counter" }).length, 0);
  } finally {
    if (renderer) act(() => renderer.unmount());
    fhir.read = originalRead;
  }
});

function visitOptions(): VisitChargeResponse["options"] {
  return [
    { procedureConceptKey: "comprehensive-exam-new", display: "Comprehensive eye exam — new patient" },
    { procedureConceptKey: "comprehensive-exam-established", display: "Comprehensive eye exam — established patient" },
    { procedureConceptKey: "intermediate-exam-new", display: "Intermediate eye exam — new patient" },
    { procedureConceptKey: "intermediate-exam-established", display: "Intermediate eye exam — established patient" },
    { procedureConceptKey: "office-visit-new-straightforward", display: "Office visit — new, straightforward" },
    { procedureConceptKey: "office-visit-new-low", display: "Office visit — new, low complexity" },
    { procedureConceptKey: "office-visit-new-moderate", display: "Office visit — new, moderate complexity" },
    { procedureConceptKey: "office-visit-established-straightforward", display: "Office visit — established, straightforward" },
    { procedureConceptKey: "office-visit-established-low", display: "Office visit — established, low complexity" },
    { procedureConceptKey: "office-visit-established-moderate", display: "Office visit — established, moderate complexity" },
    { procedureConceptKey: "routine-vision-exam-new", display: "Routine vision exam — new patient", billingCode: "S0620" },
    { procedureConceptKey: "routine-vision-exam-established", display: "Routine vision exam — established", billingCode: "S0621" },
  ];
}

async function testVisitChipState(
  label: string,
  response: VisitChargeResponse,
  expected: RegExp,
  integrity?: "empty" | "broken",
): Promise<void> {
  const originalRead = fhir.read;
  fhir.read = (async (resourceType: string, id: string) => {
    if (resourceType === "Encounter") {
      return {
        resourceType: "Encounter",
        id,
        status: "in-progress",
        class: { code: "AMB" },
        subject: { reference: "Patient/patient-1" },
      } as Encounter;
    }
    assert.equal(resourceType, "Condition");
    assert.equal(id, "retracted");
    return {
      resourceType: "Condition",
      id,
      subject: { reference: "Patient/patient-1" },
      clinicalStatus: { coding: [{ code: "inactive" }] },
      verificationStatus: { coding: [{ code: "entered-in-error" }] },
      code: { text: "Keratoconjunctivitis sicca" },
    } as Condition;
  }) as typeof fhir.read;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <RoleProvider>
          <EncounterHeader
            patient={{ resourceType: "Patient", id: "patient-1", name: [{ text: `Test ${label}` }] }}
            encounterId="enc-chip"
          />
        </RoleProvider>,
      );
      await Promise.resolve();
    });
    const selector = renderer.root.findByType(VisitCodeSelector);
    assert.equal(typeof selector.props.onVisitChargeChange, "function");
    await act(async () => {
      selector.props.onVisitChargeChange(response);
      await Promise.resolve();
      await Promise.resolve();
    });
    const chips = renderer.root.findAllByProps({ "data-testid": "visit-chip" });
    assert.equal(chips.length, 1);
    const chip = chips[0]!;
    assert.match(textContent(chip), expected);
    const markers = chip.findAll((node) => node.props["data-billing-integrity"] !== undefined);
    assert.equal(markers.length, integrity ? 1 : 0);
    if (integrity) {
      assert.equal(markers[0]!.props["data-billing-integrity"], integrity);
      assert.doesNotMatch(String(markers[0]!.props.className), /amber|gold|emerald|red/);
    }
  } finally {
    if (renderer) act(() => renderer.unmount());
    fhir.read = originalRead;
  }
}

function textContent(node: { children: Array<string | { children: unknown[] }> }): string {
  return node.children.map((child) =>
    typeof child === "string" ? child : textContent(child as { children: Array<string | { children: unknown[] }> })
  ).join("");
}
