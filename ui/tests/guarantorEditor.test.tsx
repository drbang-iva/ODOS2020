import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient, Person, RelatedPerson, Resource } from "@medplum/fhirtypes";
import { ResponsiblePartiesControl } from "../src/components/patient/ResponsiblePartiesControl";

function fixture(personCount: number) {
  const patient: Patient = { resourceType: "Patient", id: "sam", meta: { versionId: "3" }, name: [{ given: ["Sam"], family: "Synthetic" }] };
  const child: RelatedPerson = {
    resourceType: "RelatedPerson", id: "party-a", meta: { versionId: "4" }, patient: { reference: "Patient/sam" }, active: true,
    name: [{ given: ["Old"], family: "Guardian" }], telecom: [{ system: "phone", value: "864-555-0100" }], address: [{ line: ["Old street"] }],
    period: { start: "2020-01-01" }, extension: [
      { url: "https://odos.local/consentAuthority", valueBoolean: false },
      { url: "https://odos.local/primary", valueBoolean: true },
      { url: "https://odos.local/courtOrderNotes", valueString: "A sentinel" },
      { url: "https://example.test/unrelated", valueString: "preserve A" },
    ],
  };
  const parent: Person = { resourceType: "Person", id: "guarantor-a", meta: { versionId: "7" }, name: [{ given: ["New"], family: "Guardian" }], telecom: [{ system: "phone", value: "864-555-0101" }], address: [{ line: ["New street"] }], link: [{ target: { reference: "RelatedPerson/party-a" } }] };
  const decoy: Person = { ...structuredClone(parent), id: "decoy", link: [{ target: { reference: "RelatedPerson/elsewhere" } }] };
  const records = new Map<string, Resource>([patient, child, decoy, ...(personCount ? [parent] : []), ...(personCount > 1 ? [{ ...structuredClone(parent), id: "guarantor-b" }] : [])].map(resource => [`${resource.resourceType}/${resource.id}`, structuredClone(resource)]));
  const writes: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://synthetic.test");
    const path = url.pathname.replace("/fhir/R4/", "");
    const method = init?.method ?? "GET";
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(structuredClone(value)), { status, headers: { "Content-Type": "application/json" } });
    if (method !== "GET") {
      writes.push(`${method} ${path}`);
      if (method === "PUT") {
        const old = records.get(path);
        assert.equal(new Headers(init?.headers).get("If-Match"), `W/"${old?.meta?.versionId}"`);
        const next = { ...JSON.parse(String(init?.body)), meta: { versionId: String(Number(old?.meta?.versionId ?? 0) + 1) } };
        records.set(path, structuredClone(next));
        return json(next);
      }
      return json({}, 400);
    }
    if (path === "RelatedPerson") {
      assert.equal(url.searchParams.get("patient"), "Patient/sam");
      assert.equal(url.searchParams.has("relationship"), false);
      return json({ resourceType: "Bundle", type: "searchset", entry: [{ resource: records.get("RelatedPerson/party-a") }] });
    }
    if (path === "Person") {
      assert.equal(url.searchParams.get("link"), "RelatedPerson/party-a");
      return json({ resourceType: "Bundle", type: "searchset", entry: [...records.values()].filter(resource => resource.resourceType === "Person" && resource.link?.some(link => link.target.reference === url.searchParams.get("link"))).map(resource => ({ resource })) });
    }
    return records.has(path) ? json(records.get(path)) : json({}, 404);
  };
  return { fetcher, writes, records, patient };
}
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
async function withEditor(count: number, run: (renderer: ReactTestRenderer, data: ReturnType<typeof fixture>) => Promise<void>, prepare?: (data: ReturnType<typeof fixture>) => void) {
  const data = fixture(count);
  prepare?.(data);
  const original = globalThis.fetch;
  let renderer!: ReactTestRenderer;
  globalThis.fetch = data.fetcher;
  try {
    await act(async () => { renderer = create(<ResponsiblePartiesControl patientId="sam" />); });
    await run(renderer, data);
  } finally { act(() => renderer?.unmount()); globalThis.fetch = original; }
}

test("Q10: missing linked Person is read-only and direct save handler cannot create", async () => {
  await withEditor(0, async (renderer, data) => {
    assert.match(text(renderer), /no linked guarantor record|pre-migration/i);
    assert.equal(renderer.root.findAllByType("input").length, 0);
    const save = renderer.root.findAllByType("button").find(button => button.children.join("") === "Save guarantor")!;
    assert.equal(save.props.disabled, true);
    await act(async () => { await save.props.onClick(); });
    assert.deepEqual(data.writes, []);
    assert.deepEqual(await (await fetch("/fhir/R4/Patient/sam")).json(), data.patient);
  });
});

test("Q11: reopening a clean editor offers repair by patient name and converges", async () => {
  await withEditor(1, async (renderer, data) => {
    const save = renderer.root.findAllByType("button").find(button => button.children.join("") === "Save guarantor")!;
    assert.equal(save.props.disabled, true);
    const repair = renderer.root.findAllByType("button").find(button => button.children.join("").startsWith("Repair for"));
    assert.ok(repair, "mount-time classification must offer Repair with no form edit");
    assert.match(repair.children.join(""), /Sam Synthetic/);
    await act(async () => { await repair.props.onClick(); });
    assert.deepEqual(data.writes, ["PUT RelatedPerson/party-a"]);
    const child = await (await fetch("/fhir/R4/RelatedPerson/party-a")).json();
    const parent = await (await fetch("/fhir/R4/Person/guarantor-a")).json();
    assert.deepEqual(child.name, parent.name);
    assert.deepEqual(child.telecom, parent.telecom);
    assert.deepEqual(child.address, parent.address);
    assert.match(text(renderer), /verified/);
  });
});

test("Q12: multiple linked Persons refuse editing and identify both records", async () => {
  await withEditor(2, async (renderer, data) => {
    assert.match(text(renderer), /guarantor-a/);
    assert.match(text(renderer), /guarantor-b/);
    assert.equal(renderer.root.findAllByType("input").length, 0);
    const save = renderer.root.findAllByType("button").find(button => button.children.join("") === "Save guarantor")!;
    await act(async () => { await save.props.onClick(); });
    assert.deepEqual(data.writes, []);
    assert.equal((await (await fetch("/fhir/R4/Person/guarantor-a")).json()).meta.versionId, "7");
    assert.equal((await (await fetch("/fhir/R4/Person/guarantor-b")).json()).meta.versionId, "7");
  });
});


test("editing one name preserves every loaded contact and address entry without a Patient write", async () => {
  let expected: Person;
  await withEditor(1, async (renderer, data) => {
    const field = renderer.root.findAllByType("label").find(label => label.children[0] === "Family name 1")!.findByType("input");
    await act(async () => { field.props.onChange({ target: { value: "Corrected" } }); });
    const repair = renderer.root.findAllByType("button").find(button => button.children.join("").startsWith("Repair for"))!;
    assert.equal(repair.props.disabled, true);
    await act(async () => { await repair.props.onClick(); });
    assert.deepEqual(data.writes, [], "repair must not discard an unsaved draft even through a direct handler call");
    const save = renderer.root.findAllByType("button").find(button => button.children.join("") === "Save guarantor")!;
    await act(async () => { await save.props.onClick(); });
    const parent = await (await fetch("/fhir/R4/Person/guarantor-a")).json();
    const child = await (await fetch("/fhir/R4/RelatedPerson/party-a")).json();
    assert.deepEqual(parent.name, expected.name);
    assert.deepEqual(parent.telecom, expected.telecom);
    assert.deepEqual(parent.address, expected.address);
    assert.deepEqual(child.telecom, expected.telecom);
    assert.deepEqual(child.address, expected.address);
    assert.deepEqual(data.writes, ["PUT Person/guarantor-a", "PUT RelatedPerson/party-a"]);
    assert.deepEqual(await (await fetch("/fhir/R4/Patient/sam")).json(), data.patient);
  }, data => {
    const parent = data.records.get("Person/guarantor-a") as Person;
    parent.name!.push({ use: "old", given: ["Former", "Middle"], family: "Surname" });
    parent.telecom = [
      { system: "phone", use: "home", value: " (864) 555-0101 ext 2 ", rank: 2 },
      { system: "phone", use: "home", value: "864-555-0102", period: { end: "2020-01-01" } },
      { system: "email", value: "synthetic@example.test" },
      { system: "fax", value: "864-555-0103" },
    ];
    parent.address = [{ use: "home", line: ["Main street", "Suite 2"], country: "US", period: { start: "2020-01-01" } }, { use: "old", text: "Historic address", line: ["Old road"] }];
    expected = structuredClone(parent);
    expected.name![0].family = "Corrected";
  });
});


test("structured address edits clear stale display text only on the edited address", async () => {
  for (const [label, key, value] of [["Address 1 line 1", "line", "Corrected street"], ["City 1", "city", "Corrected city"], ["State 1", "state", "Corrected state"], ["Postal code 1", "postalCode", "12345"], ["Country 1", "country", "US"]]) {
  let untouched: NonNullable<Person["address"]>[number];
  await withEditor(1, async (renderer) => {
    const field = renderer.root.findAllByType("label").find(node => node.children[0] === label)!.findByType("input");
    await act(async () => { field.props.onChange({ target: { value } }); });
    const save = renderer.root.findAllByType("button").find(button => button.children.join("") === "Save guarantor")!;
    await act(async () => { await save.props.onClick(); });
    for (const reference of ["Person/guarantor-a", "RelatedPerson/party-a"]) {
      const resource = await (await fetch(`/fhir/R4/${reference}`)).json();
      assert.equal(resource.address[0].text, undefined);
      assert.deepEqual(resource.address[0][key], key === "line" ? [value, "Suite 2"] : value);
      assert.deepEqual(resource.address[1], untouched);
    }
  }, data => {
    const person = data.records.get("Person/guarantor-a") as Person;
    untouched = { use: "old", text: "Preserved historical address", line: ["Historical road"], city: "Previous city" };
    person.address = [{ text: "Old street, Synthetic city", line: ["Old street", "Suite 2"], city: "Synthetic city" }, structuredClone(untouched)];
  });
  }
});


test("clearing then replacing the first phone keeps the second phone in its original slot", async () => {
  await withEditor(1, async (renderer) => {
    const firstPhone = () => renderer.root.findAllByType("label").find(label => label.children[0] === "Phone 1 (home)")!.findByType("input");
    await act(async () => { firstPhone().props.onChange({ target: { value: "" } }); });
    await act(async () => { firstPhone().props.onChange({ target: { value: "864-555-0199" } }); });
    const save = renderer.root.findAllByType("button").find(button => button.children.join("") === "Save guarantor")!;
    await act(async () => { await save.props.onClick(); });
    for (const reference of ["Person/guarantor-a", "RelatedPerson/party-a"]) {
      const resource = await (await fetch(`/fhir/R4/${reference}`)).json();
      assert.deepEqual(resource.telecom, [{ system: "phone", use: "home", value: "864-555-0199", rank: 1 }, { system: "phone", use: "home", value: "864-555-0102", rank: 2 }, { system: "email" }]);
    }
  }, data => {
    const person = data.records.get("Person/guarantor-a") as Person;
    person.telecom = [{ system: "phone", use: "home", value: "864-555-0101", rank: 1 }, { system: "phone", use: "home", value: "864-555-0102", rank: 2 }, { system: "email" }];
  });
});

test("saving an intentionally blank phone removes only that contact and retains untouched valueless entries", async () => {
  await withEditor(1, async (renderer) => {
    const first = renderer.root.findAllByType("label").find(label => label.children[0] === "Phone 1 (home)")!.findByType("input");
    await act(async () => { first.props.onChange({ target: { value: "   " } }); });
    const save = renderer.root.findAllByType("button").find(button => button.children.join("") === "Save guarantor")!;
    await act(async () => { await save.props.onClick(); });
    for (const reference of ["Person/guarantor-a", "RelatedPerson/party-a"]) {
      const resource = await (await fetch(`/fhir/R4/${reference}`)).json();
      assert.deepEqual(resource.telecom, [{ system: "phone", use: "home", value: "864-555-0102", rank: 2 }, { system: "email" }]);
    }
  }, data => {
    const person = data.records.get("Person/guarantor-a") as Person;
    person.telecom = [{ system: "phone", use: "home", value: "864-555-0101", rank: 1 }, { system: "phone", use: "home", value: "864-555-0102", rank: 2 }, { system: "email" }];
  });
});


test("per-patient results distinguish rejected child writes from lost update responses", async () => {
  for (const scenario of [{ mode: "error", message: "update failed", classification: "mismatched" }, { mode: "lost", message: "update response not received", classification: "verified" }]) {
    await withEditor(1, async renderer => {
      const field = renderer.root.findAllByType("label").find(label => label.children[0] === "Family name 1")!.findByType("input");
      await act(async () => { field.props.onChange({ target: { value: "Changed" } }); });
      const save = renderer.root.findAllByType("button").find(button => button.children.join("") === "Save guarantor")!;
      await act(async () => { await save.props.onClick(); });
      const row = renderer.root.findAllByType("li").find(item => item.children.join("").includes("Sam Synthetic"))!;
      assert.ok(row.children.join("").includes(scenario.message), `Sam's result must say ${scenario.message}`);
      assert.ok(row.children.join("").includes(scenario.classification));
      const child = await (await fetch("/fhir/R4/RelatedPerson/party-a")).json();
      assert.equal(child.name[0].family, scenario.mode === "lost" ? "Changed" : "Guardian");
    }, data => {
      const original = data.fetcher;
      data.fetcher = async (input, init) => {
        if (String(input).includes("/RelatedPerson/party-a") && init?.method === "PUT") {
          if (scenario.mode === "error") return new Response(JSON.stringify({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "exception" }] }), { status: 500 });
          await original(input, init);
          throw new TypeError("Synthetic lost update response");
        }
        return original(input, init);
      };
    });
  }
});

test("F1e superseded save reloads automatically and one Repair converges", async () => {
  await withEditor(1, async (renderer, data) => {
    const field = renderer.root.findAllByType("label").find(label => label.children[0] === "Family name 1")!.findByType("input");
    await act(async () => { field.props.onChange({ target: { value: "Edited" } }); });
    await act(async () => { await renderer.root.findAllByType("button").find(b => b.children.join("") === "Save guarantor")!.props.onClick(); });
    assert.match(text(renderer), /newer edit.*landed/i);
    const repair = renderer.root.findAllByType("button").find(b => b.children.join("") === "Repair for Sam Synthetic");
    assert.ok(repair);
    assert.equal(repair.props.disabled, false);
    assert.equal((await (await fetch("/fhir/R4/RelatedPerson/party-a")).json()).name[0].family, "Edited");
    data.writes.length = 0;
    await act(async () => { await repair.props.onClick(); });
    assert.deepEqual(data.writes, ["PUT RelatedPerson/party-a"]);
    assert.equal((await (await fetch("/fhir/R4/RelatedPerson/party-a")).json()).name[0].family, "Third");
    assert.equal(renderer.root.findAllByType("button").filter(b => b.children.join("").startsWith("Repair for")).length, 0);
    assert.doesNotMatch(text(renderer), /repair/i);
  }, data => {
    const original = data.fetcher;
    let fired = false;
    data.fetcher = async (input, init) => {
      if (!fired && String(input).includes("/RelatedPerson/party-a") && init?.method === "PUT") {
        fired = true;
        const person = structuredClone(data.records.get("Person/guarantor-a")) as Person;
        person.name![0].family = "Third";
        person.meta = { versionId: String(Number(person.meta!.versionId) + 1) };
        data.records.set("Person/guarantor-a", person);
      }
      return original(input, init);
    };
  });
});
