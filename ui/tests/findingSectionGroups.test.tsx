import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { WearingSection } from "../src/components/charting/WearingSection";
import { SpineNav } from "../src/components/charting/SpineNav";
import { OdosSelect } from "../src/components/inputs/OdosSelect";
import { FindingSectionGroupsSettings } from "../src/components/settings/FindingSectionGroupsSettings";
import {
  filterDefinitionsForSectionGroups,
  type FindingSectionGroup,
} from "../src/lib/finding-section-groups";
import { CONCURRENT_EDIT_MESSAGE, fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";
import { EncounterCharting } from "../src/scenes/EncounterCharting";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const GROUP: FindingSectionGroup = {
  id: "group-1",
  groupKey: "dry-eye-workup",
  label: "Dry eye workup",
  sectionKeyPrefixes: ["custom:zz-test-"],
  active: true,
};

const SPECIALTY_WORKUP_GROUP: FindingSectionGroup = {
  id: "finding-section-group-dry-eye-workup",
  groupKey: "dry-eye-workup",
  label: "Dry Eye Workup",
  sectionKeyPrefixes: ["dry-eye:"],
  active: true,
};

test("ungrouped definitions remain visible for every category while grouped definitions require an effective group", () => {
  const definitions = [
    { stableKey: "entrance:pupils", sectionKey: "entrance:pupils", active: true },
    { stableKey: "custom:ordinary", sectionKey: "custom:ordinary", active: true },
    { stableKey: "custom:zz-test-marker", sectionKey: "custom:zz-test-marker", active: true },
  ];

  for (const effectiveGroupKeys of [[], ["unrelated"], ["dry-eye-workup"]]) {
    const visible = filterDefinitionsForSectionGroups(definitions, [GROUP], effectiveGroupKeys);
    assert.ok(visible.some((definition) => definition.stableKey === "entrance:pupils"));
    assert.ok(visible.some((definition) => definition.stableKey === "custom:ordinary"));
  }
  assert.deepEqual(
    filterDefinitionsForSectionGroups(definitions, [GROUP], [])
      .map((definition) => definition.stableKey),
    ["entrance:pupils", "custom:ordinary"],
  );
  assert.deepEqual(
    filterDefinitionsForSectionGroups(definitions, [GROUP], ["dry-eye-workup"])
      .map((definition) => definition.stableKey),
    ["entrance:pupils", "custom:ordinary", "custom:zz-test-marker"],
  );
  assert.deepEqual(
    filterDefinitionsForSectionGroups(definitions, [{ ...GROUP, active: false }], [])
      .map((definition) => definition.stableKey),
    ["entrance:pupils", "custom:ordinary"],
  );
});

test("a pulled-in group renders its battery while an encounter without pull-in leaves it absent", async () => {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  const originalDocument = globalThis.document;
  const definitions = [
    {
      stableKey: "entrance:pupils",
      sectionKey: "entrance:pupils",
      display: "Pupils",
      active: true,
      perEye: true,
      customFields: [],
    },
    {
      stableKey: "ocular-health:anterior:tear-film",
      sectionKey: "ocular-health:anterior:tear-film",
      display: "Tear Film",
      active: true,
      perEye: true,
      customFields: [],
    },
    ...[
      ["dry-eye:symptoms", "Symptoms"],
      ["dry-eye:tear-volume", "Tear Volume"],
      ["dry-eye:markers", "Tear Film Markers"],
      ["dry-eye:gland-structure", "Gland Structure"],
      ["dry-eye:gland-function", "Gland Function"],
      ["dry-eye:conjunctival-staining", "Surface Staining"],
      ["dry-eye:staging", "Staging & Subtype"],
    ].map(([stableKey, display]) => ({
      stableKey,
      sectionKey: stableKey,
      display,
      active: true,
      perEye: stableKey !== "dry-eye:symptoms" && stableKey !== "dry-eye:staging",
      customFields: [],
    })),
  ];
  fhir.read = (async (_resourceType: string, id: string) => ({
    resourceType: "Encounter",
    id,
    status: "in-progress",
    class: { code: "AMB" },
  })) as typeof fhir.read;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/exam-scope")) return jsonResponse({ examScope: "comprehensive", canWrite: true });
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({ canWrite: false, definitions });
    }
    if (url.includes("/clinical-graph/finding-section-groups")) {
      const dryEye = url.includes("encounter-dry-eye");
      return jsonResponse({
        canWrite: false,
        canPullIn: true,
        groups: [SPECIALTY_WORKUP_GROUP],
        overrideGroupKeys: dryEye ? ["dry-eye-workup"] : [],
        pulledInGroupKeys: dryEye ? ["dry-eye-workup"] : [],
        effectiveGroupKeys: dryEye ? ["dry-eye-workup"] : [],
      });
    }
    if (url.includes("/clinical-graph/eye-growth/visibility")) {
      return jsonResponse({ defaultVisible: false });
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Document,
  });
  let dryEyeRenderer!: ReactTestRenderer;
  let comprehensiveRenderer!: ReactTestRenderer;
  try {
    await act(async () => {
      dryEyeRenderer = create(
        <RoleProvider>
          <EncounterCharting
            patient={{ resourceType: "Patient", id: "patient-1" }}
            encounterId="encounter-dry-eye"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    assert.deepEqual(
      dryEyeRenderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("dry-eye:"))
        .map((section: { id: string }) => section.id),
      [
        "dry-eye:symptoms",
        "dry-eye:tear-stability",
        "dry-eye:tear-volume",
        "dry-eye:markers",
        "dry-eye:gland-structure",
        "dry-eye:gland-function",
        "dry-eye:conjunctival-staining",
        "dry-eye:staging",
      ],
    );
    assert.equal(dryEyeRenderer.root.findAllByProps({ "data-testid": "section-visibility-context" }).length, 0);
    await act(async () => {
      comprehensiveRenderer = create(
        <RoleProvider>
          <EncounterCharting
            patient={{ resourceType: "Patient", id: "patient-1" }}
            encounterId="encounter-comprehensive"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    assert.equal(
      comprehensiveRenderer.root.findByType(SpineNav).props.customSections
        .some((section: { id: string }) => section.id.startsWith("dry-eye:")),
      false,
    );
    assert.ok(
      comprehensiveRenderer.root.findByType(SpineNav).findAllByType("span")
        .some((span) => span.children.includes("Pupils")),
    );
    assert.deepEqual(
      filterDefinitionsForSectionGroups(definitions, [SPECIALTY_WORKUP_GROUP], [])
        .filter((definition) => definition.stableKey === "entrance:pupils")
        .map((definition) => definition.stableKey),
      ["entrance:pupils"],
    );
  } finally {
    dryEyeRenderer?.unmount();
    comprehensiveRenderer?.unmount();
    fhir.read = originalRead;
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});

test("EncounterCharting pulls a group into only the current encounter and renders it without reloading", async () => {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  const originalDocument = globalThis.document;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  fhir.read = (async () => ({
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
  })) as typeof fhir.read;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/exam-scope")) return jsonResponse({ examScope: "comprehensive", canWrite: true });
    requests.push({ url, init });
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({
        canWrite: false,
        definitions: [
          {
            stableKey: "custom:ordinary",
            sectionKey: "custom:ordinary",
            display: "Ordinary section",
            active: true,
          },
          {
            stableKey: "custom:zz-test-marker",
            sectionKey: "custom:zz-test-marker",
            display: "ZZ test marker",
            active: true,
          },
        ],
      });
    }
    if (url.includes("/clinical-graph/finding-section-groups")) {
      return jsonResponse({
        canWrite: false,
        canPullIn: true,
        groups: [GROUP],
        overrideGroupKeys: [],
        pulledInGroupKeys: [],
        effectiveGroupKeys: [],
      });
    }
    if (url.includes("/clinical-graph/encounters/encounter-1/section-groups")) {
      const action = JSON.parse(String(init?.body)).action as "add" | "remove";
      return jsonResponse({
        override: {
          encounterId: "encounter-1",
          groupKeys: action === "add" ? ["dry-eye-workup"] : [],
        },
      });
    }
    if (url.includes("/clinical-graph/eye-growth/visibility")) {
      return jsonResponse({ defaultVisible: false });
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Document,
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <RoleProvider>
          <EncounterCharting
            patient={{ resourceType: "Patient", id: "patient-1" }}
            encounterId="encounter-1"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    assert.deepEqual(
      renderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("custom:"))
        .map((section: { id: string }) => section.id),
      ["custom:ordinary"],
    );

    await act(async () => {
      renderer.root.find((node) =>
        node.type === OdosSelect && node.props.ariaLabel === "Add section group"
      ).props.onChange("dry-eye-workup");
      await flushEffects();
    });

    assert.deepEqual(
      renderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("custom:"))
        .map((section: { id: string }) => section.id),
      ["custom:ordinary", "custom:zz-test-marker"],
    );
    const mutations = requests.filter((request) =>
      request.url.includes("/clinical-graph/encounters/encounter-1/section-groups")
    );
    assert.equal(mutations[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(mutations[0]?.init?.body)), {
      action: "add",
      groupKey: "dry-eye-workup",
    });

    await act(async () => {
      renderer.root.findAllByType("button")
        .find((button) => button.children.join("") === "Remove Dry eye workup")!
        .props.onClick();
      await flushEffects();
    });

    assert.deepEqual(
      renderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("custom:"))
        .map((section: { id: string }) => section.id),
      ["custom:ordinary"],
    );
    const removeMutation = requests.filter((request) =>
      request.url.includes("/clinical-graph/encounters/encounter-1/section-groups")
    )[1];
    assert.deepEqual(JSON.parse(String(removeMutation?.init?.body)), {
      action: "remove",
      groupKey: "dry-eye-workup",
    });
  } finally {
    renderer?.unmount();
    fhir.read = originalRead;
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});

test("EncounterCharting fails open when the section-group catalog returns 500", async () => {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  fhir.read = (async () => ({
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
  })) as typeof fhir.read;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/exam-scope")) return jsonResponse({ examScope: "comprehensive", canWrite: true });
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({
        canWrite: false,
        definitions: [{
          stableKey: "custom:zz-test-marker",
          sectionKey: "custom:zz-test-marker",
          display: "ZZ test marker",
          active: true,
        }],
      });
    }
    if (url.includes("/clinical-graph/finding-section-groups")) {
      return jsonResponse({ error: "Synthetic catalog failure" }, 500);
    }
    if (url.includes("/clinical-graph/eye-growth/visibility")) {
      return jsonResponse({ defaultVisible: false });
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <RoleProvider>
          <EncounterCharting
            patient={{ resourceType: "Patient", id: "patient-1" }}
            encounterId="encounter-1"
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });

    assert.deepEqual(
      renderer.root.findByType(SpineNav).props.customSections
        .filter((section: { id: string }) => section.id.startsWith("custom:"))
        .map((section: { id: string }) => section.id),
      ["custom:zz-test-marker"],
    );
    assert.equal(
      renderer.root.findByProps({ role: "alert" }).children.join(""),
      "Section-group visibility could not be loaded.",
    );
    assert.ok(
      renderer.root.findByType(SpineNav).findAllByType("span")
        .some((span) => span.children.includes("Pupils")),
    );
  } finally {
    renderer?.unmount();
    fhir.read = originalRead;
    globalThis.fetch = originalFetch;
  }
});

test("S1b G6 settings creates edits and deactivates without category controls", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let groups: FindingSectionGroup[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/exam-scope")) return jsonResponse({ examScope: "comprehensive", canWrite: true });
    requests.push({ url, init });
    if (init?.method === "POST") {
      groups = [{ ...GROUP, ...groups[0], ...JSON.parse(String(init.body)) }];
      return jsonResponse({ group: groups[0] }, 201);
    }
    return jsonResponse({
      canWrite: true,
      groups,
    });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<FindingSectionGroupsSettings />);
      await flushEffects();
    });
    await act(async () => {
      renderer.root.findAllByType("button")
        .find((button) => button.children.join("").includes("Create group"))!
        .props.onClick();
    });
    const dialog = renderer.root.findByProps({ role: "dialog" });
    assert.equal(dialog.props["aria-modal"], "true");
    assert.equal(dialog.props["aria-labelledby"], "section-group-editor-title");
    const textInputs = renderer.root.findAllByType("input").filter(
      (input) => input.props.type !== "checkbox",
    );
    await act(async () => {
      textInputs[0]!.props.onChange({ target: { value: "dry-eye-workup" } });
    });
    await act(async () => {
      renderer.root.findAllByType("input")
        .filter((input) => input.props.type !== "checkbox")[1]!
        .props.onChange({ target: { value: "Dry eye workup" } });
    });
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({
        target: { value: "custom:zz-test-" },
      });
    });
    assert.equal(renderer.root.findAllByType("fieldset").length, 0);
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
      await flushEffects();
    });

    const mutation = requests.find((request) => request.init?.method === "POST");
    assert.ok(mutation);
    assert.deepEqual(JSON.parse(String(mutation.init?.body)), {
      groupKey: "dry-eye-workup",
      expectedVersion: null,
      label: "Dry eye workup",
      sectionKeyPrefixes: ["custom:zz-test-"],
      active: true,
    });
    await act(async () => { renderer.root.findAllByType("button").find(b => b.children.join("") === "Edit")!.props.onClick(); });
    assert.equal(renderer.root.findAllByType("fieldset").length, 0);
    await act(async () => { renderer.root.findAllByType("input").filter(i => i.props.type !== "checkbox")[1].props.onChange({ target: { value: "Edited workup" } }); });
    await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); await flushEffects(); });
    assert.equal(groups[0].label, "Edited workup");
    await act(async () => { renderer.root.findAllByType("button").find(b => b.children.join("") === "Deactivate")!.props.onClick(); await flushEffects(); });
    assert.equal(groups[0].active, false);
    for (const request of requests.filter(r => r.init?.method === "POST")) assert.equal("defaultForVisitTypeCategories" in JSON.parse(String(request.init!.body)), false);
    assert.equal(JSON.stringify(renderer.toJSON()).includes("No defaults"), false);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("section-group settings dialog closes on Escape", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({
    canWrite: true,
    groups: [],
  })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<FindingSectionGroupsSettings />);
      await flushEffects();
    });
    await act(async () => {
      renderer.root.findAllByType("button")
        .find((button) => button.children.join("").includes("Create group"))!
        .props.onClick();
    });
    const dialog = renderer.root.findByProps({ role: "dialog" });
    await act(async () => {
      dialog.props.onKeyDown({
        key: "Escape",
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    });
    assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("S1 G4 a pinned inactive group still exposes its definitions",()=>{
  const definitions=[{sectionKey:"custom:zz-test-marker",active:true}];
  assert.deepEqual(filterDefinitionsForSectionGroups(definitions,[{...GROUP,active:false}],[],[GROUP.groupKey]),definitions);
  assert.deepEqual(filterDefinitionsForSectionGroups(definitions,[{...GROUP,active:false}],[],[]),[]);
});

for (const race of [false,true]) test(`S1 G7 ${race ? "409 race refetches pins and preserves specific message" : "pin replaces remove control and survives removing a different group"}`,async()=>{
  const originalFetch=globalThis.fetch,originalRead=fhir.read,originalDocument=globalThis.document;
  const other={...GROUP,groupKey:"empty-group",label:"Empty group",sectionKeyPrefixes:["custom:empty"]};
  let catalogReads=0;
  fhir.read=(async()=>({resourceType:"Encounter",id:"encounter-1",status:"in-progress",class:{code:"AMB"}})) as typeof fhir.read;
  globalThis.fetch=(async(input,init)=>{
    const url=String(input);
    if (url.endsWith("/exam-scope")) return jsonResponse({ examScope: "comprehensive", canWrite: true });
    if(url.includes('/finding-definitions'))return jsonResponse({canWrite:false,definitions:[
      {stableKey:"custom:zz-test-marker",sectionKey:"custom:zz-test-marker",display:"Pinned section",active:true},
      {stableKey:"custom:empty",sectionKey:"custom:empty",display:"Empty section",active:true},
    ]});
    if(url.includes('/finding-section-groups')){
      catalogReads++;
      const pinned=!race||catalogReads>1;
      return jsonResponse({canWrite:false,canPullIn:true,groups:[GROUP,other],
        overrideGroupKeys:race?[GROUP.groupKey]:[other.groupKey],pulledInGroupKeys:race?[GROUP.groupKey]:[other.groupKey],
        contentPinnedGroupKeys:pinned?[GROUP.groupKey]:[],effectiveGroupKeys:[GROUP.groupKey,other.groupKey]});
    }
    if(url.endsWith('/section-groups')&&init?.method==='POST')return race?jsonResponse({code:"section-group-has-content",sectionKeys:["custom:zz-test-marker"]},409):jsonResponse({override:{groupKeys:[]}});
    return jsonResponse({resourceType:"Bundle",type:"searchset",entry:[]});
  }) as typeof fetch;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(){},removeEventListener(){}}});
  let renderer!:ReactTestRenderer;
  try{
    await act(async()=>{renderer=create(<RoleProvider><EncounterCharting patient={{resourceType:"Patient",id:"patient-1"}} encounterId="encounter-1"/></RoleProvider>);await flushEffects();await flushEffects();});
    const buttons=()=>renderer.root.findAllByType('button');
    if(!race){
      assert.equal(buttons().some(b=>b.children.join('')==='Remove Dry eye workup'),false);
      assert.ok(renderer.root.findAllByType('span').some(s=>s.children.join('')==='Has findings this visit'));
    }
    await act(async()=>{buttons().find(b=>b.children.join('')===(race?'Remove Dry eye workup':'Remove Empty group'))!.props.onClick();await flushEffects();await flushEffects();});
    assert.ok(renderer.root.findByType(SpineNav).props.customSections.some((s:{id:string})=>s.id==='custom:zz-test-marker'));
    assert.equal(buttons().some(b=>b.children.join('')==='Remove Dry eye workup'),false);
    assert.ok(renderer.root.findAllByType('span').some(s=>s.children.join('')==='Has findings this visit'));
    const selectors=renderer.root.findAll(node=>node.type===OdosSelect&&node.props.ariaLabel==='Add section group');
    assert.ok(selectors.every(select=>!select.props.options.some((option:{value:string})=>option.value===GROUP.groupKey)), 'a pinned group stays effective and is never offered for pull-in again');
    if(race){
      assert.equal(catalogReads,2);
      assert.equal(renderer.root.findByProps({role:'alert'}).children.join(''),'This section has findings from this visit and stays on the chart.');
    }else assert.equal(renderer.root.findByType(SpineNav).props.customSections.some((s:{id:string})=>s.id==='custom:empty'),false);
  }finally{renderer?.unmount();globalThis.fetch=originalFetch;fhir.read=originalRead;Object.defineProperty(globalThis,'document',{configurable:true,value:originalDocument});}
});

for (const staleFailure of [false, true]) test(`S1 catalog freshness ignores older ${staleFailure ? "failure" : "success"} after a newer save refresh`, async () => {
  const originalFetch = globalThis.fetch, originalRead = fhir.read, originalDocument = globalThis.document;
  const pending: Array<(response: Response) => void> = [];
  const catalog = (pinned: boolean) => ({ canWrite: false, canPullIn: true, groups: [GROUP],
    overrideGroupKeys: [],  effectiveGroupKeys: pinned ? [GROUP.groupKey] : [], contentPinnedGroupKeys: pinned ? [GROUP.groupKey] : [] });
  let reads = 0;
  fhir.read = (async () => ({ resourceType: "Encounter", id: "encounter-1", status: "in-progress", class: { code: "AMB" } })) as typeof fhir.read;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/exam-scope")) return jsonResponse({ examScope: "comprehensive", canWrite: true });
    if (url.includes("/wearing/definition")) return jsonResponse({ definition: { fields: {} } });
    if (url.includes("/finding-definitions")) return jsonResponse({ canWrite: false, definitions: [
      { stableKey: "custom:zz-test-marker", sectionKey: "custom:zz-test-marker", display: "Pinned section", active: true },
    ] });
    if (url.includes("/finding-section-groups")) {
      if (++reads === 1) return jsonResponse(catalog(false));
      return new Promise<Response>(resolve => pending.push(resolve));
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<RoleProvider><EncounterCharting patient={{ resourceType: "Patient", id: "patient-1" }} encounterId="encounter-1" /></RoleProvider>); await flushEffects(); await flushEffects(); });
    await act(async () => { renderer.root.findByType(SpineNav).props.onSelect("wearing"); await flushEffects(); });
    await act(async () => { renderer.root.findByType(WearingSection).props.onSaved("saved"); await flushEffects(); });
    await act(async () => { renderer.root.findByType(WearingSection).props.onSaved("saved"); await flushEffects(); });
    assert.equal(pending.length, 2);
    await act(async () => { pending[1](jsonResponse(catalog(true))); await flushEffects(); });
    await act(async () => { pending[0](staleFailure ? jsonResponse({ error: "stale failure" }, 500) : jsonResponse(catalog(false))); await flushEffects(); });
    assert.ok(renderer.root.findAllByType("span").some(s => s.children.join("") === "Has findings this visit"));
    assert.ok(renderer.root.findByType(SpineNav).props.customSections.some((s: { id: string }) => s.id === "custom:zz-test-marker"));
    assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0);
  } finally { renderer?.unmount(); globalThis.fetch = originalFetch; fhir.read = originalRead; Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument }); }
});

for (const action of ["edit", "deactivate"] as const) test(`G1 Settings ${action} sends its loaded version and displays the shared conflict message`, async () => {
  const originalFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      sent = JSON.parse(String(init.body));
      return jsonResponse({ code: "concurrent-edit", error: "Server conflict" }, 409);
    }
    return jsonResponse({ canWrite: true, groups: [{ ...GROUP, versionId: "7" }] });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<FindingSectionGroupsSettings />); await flushEffects(); });
    await act(async () => {
      renderer.root.findAllByType("button").find(b => b.children.join("") === (action === "edit" ? "Edit" : "Deactivate"))!.props.onClick();
      await flushEffects();
    });
    if (action === "edit") await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); await flushEffects(); });
    assert.equal(sent?.expectedVersion, "7");
    const alert = renderer.root.findByProps({ role: "alert" });
    assert.equal(alert.children.join(""), CONCURRENT_EDIT_MESSAGE);
    if (action === "edit") assert.equal(renderer.root.findByType("form").findByProps({ role: "alert" }), alert);
    if (action === "edit") await act(async () => { renderer.root.findAllByType("button").find(b => b.children.join("") === "Cancel")!.props.onClick(); });
    await act(async () => {
      renderer.root.findAllByType("button").find(b => action === "edit" ? b.children.join("").includes("Create group") : b.children.join("") === "Edit")!.props.onClick();
    });
    assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0, "a newly opened editor does not inherit the previous operation's error");
  } finally { renderer?.unmount(); globalThis.fetch = originalFetch; }
});
