import assert from "node:assert/strict";
import { test } from "node:test";
import type { Person, RelatedPerson, Resource } from "@medplum/fhirtypes";
import { fhir } from "../src/lib/fhir";
import {
  loadGuarantor,
  saveGuarantor,
  repairGuarantor,
  verifyGuarantor,
} from "../src/lib/guarantor-editor";
import { resolveSmsNumber } from "../../mcp/src/comms/suppression-gate";
const old = {
  name: [{ given: ["Old"] }],
  telecom: [{ system: "phone" as const, value: "+15555550101" }],
  address: [{ line: ["Old street"] }],
};
const edited = {
  name: [{ given: ["New"] }],
  telecom: [{ system: "phone" as const, value: "+15555550102" }],
  address: [{ line: ["New street"] }],
};
const newest = { ...edited, name: [{ given: ["Newest"] }] };
function demographics(r: Person | RelatedPerson) {
  return { name: r.name, telecom: r.telecom, address: r.address };
}
class Store {
  data = new Map<string, Resource>();
  writes: string[] = [];
  hook?: (key: string, method: string) => void;
  failure?: (key: string, method: string) => string | undefined;
  constructor(reverse = false) {
    this.put({
      resourceType: "Person",
      id: "p",
      meta: { versionId: "1" },
      ...old,
      link: (reverse ? ["b", "a"] : ["a", "b"]).map((id) => ({
        target: { reference: `RelatedPerson/${id}` },
      })),
    });
    for (const [id, name] of [
      ["a", "Sam"],
      ["b", "Leo"],
      ["decoy", "Decoy"],
    ]) {
      this.put({
        resourceType: "Patient",
        id,
        meta: { versionId: "1" },
        name: [{ given: [name] }],
      });
      this.put({
        resourceType: "RelatedPerson",
        id,
        meta: { versionId: "1" },
        ...old,
        patient: { reference: `Patient/${id}` },
        active: true,
        period: { start: "2020-01-01", end: "2030-01-01" },
        relationship: [{ text: `role-${id}` }],
        extension: [
          { url: "urn:consentAuthority", valueBoolean: id === "a" },
          { url: "urn:primary", valueBoolean: id === "b" },
          { url: "urn:courtOrderNotes", valueString: `notes-${id}` },
          { url: "urn:unrelated", valueString: `sentinel-${id}` },
        ],
      });
    }
  }
  put(r: Resource) {
    this.data.set(`${r.resourceType}/${r.id}`, structuredClone(r));
  }
  get<T extends Resource>(key: string): T {
    return structuredClone(this.data.get(key)!) as T;
  }
  compete(key: string, values: object) {
    const r = this.get(key);
    this.put({
      ...r,
      ...values,
      meta: { versionId: String(Number(r.meta!.versionId) + 1) },
    } as Resource);
  }
  fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input), "http://local");
    const key = url.pathname.replace("/fhir/R4/", "");
    const method = init?.method ?? "GET";
    this.hook?.(key, method);
    const failure = this.failure?.(key, method);
    if (failure === "lost") throw new TypeError("lost response");
    if (failure === "error") return Response.json({}, { status: 503 });
    if (method !== "GET") {
      this.writes.push(`${method} ${key}`);
      const before = this.data.get(key);
      const expected = new Headers(init?.headers).get("If-Match");
      if (expected && expected !== `W/"${before?.meta?.versionId}"`)
        return Response.json({}, { status: 412 });
      const resource = JSON.parse(String(init?.body));
      resource.meta = {
        versionId: String(Number(before?.meta?.versionId ?? 0) + 1),
      };
      this.put(resource);
      if (failure === "land-lost") throw new TypeError("lost after commit");
      return Response.json(this.get(key));
    }
    if (key === "Person") {
      assert.ok(url.searchParams.has("link"));
      return Response.json({
        resourceType: "Bundle",
        type: "searchset",
        entry: [...this.data.values()]
          .filter(
            (r) =>
              r.resourceType === "Person" &&
              r.link?.some(
                (l) => l.target.reference === url.searchParams.get("link"),
              ),
          )
          .map((resource) => ({ resource: structuredClone(resource) })),
      });
    }
    return this.data.has(key)
      ? Response.json(this.get(key))
      : Response.json({}, { status: 404 });
  };
  async snapshot() {
    const loaded = await loadGuarantor("a");
    assert.equal(loaded.kind, "editable");
    if (loaded.kind !== "editable") throw Error();
    return loaded.snapshot;
  }
}
async function fixture(run: (s: Store) => Promise<void>, reverse = false) {
  const original = globalThis.fetch;
  const s = new Store(reverse);
  globalThis.fetch = s.fetch;
  try {
    await run(s);
  } finally {
    globalThis.fetch = original;
  }
}
async function fresh(id: string) {
  return fhir.read<RelatedPerson>("RelatedPerson", id);
}
test("Q1 Q2 Q3 Q4 Q7 persisted demographics SMS sentinels and precise write set", async () => {
  for (const reverse of [false, true])
    await fixture(async (s) => {
      const before = structuredClone([...s.data]);
      const result = await saveGuarantor(await s.snapshot(), edited);
      assert.equal(result.status, "saved");
      assert.deepEqual(
        demographics(await fhir.read<Person>("Person", "p")),
        edited,
      );
      for (const id of ["a", "b"]) {
        const r = await fresh(id);
        assert.deepEqual(demographics(r), edited);
        const original = before.find(
          ([key]) => key === `RelatedPerson/${id}`,
        )![1] as RelatedPerson;
        const { meta, name, telecom, address, ...rest } = r;
        const {
          meta: m,
          name: n,
          telecom: t,
          address: a,
          ...expected
        } = original;
        assert.deepEqual(rest, expected);
      }
      assert.equal(
        resolveSmsNumber(await fresh("a"), new Date("2026-09-13T12:00:00Z")),
        "+15555550102",
      );
      assert.deepEqual(
        await fresh("decoy"),
        before.find(([key]) => key === "RelatedPerson/decoy")![1],
      );
      assert.deepEqual(
        await fhir.read("Patient", "a"),
        before.find(([key]) => key === "Patient/a")![1],
      );
      assert.ok(!s.writes.some((w) => /Patient\//.test(w)));
      assert.equal(s.writes.length, 3);
    }, reverse);
});
test("Q5a Q6a preflight mismatch zero writes reload", async () => {
  for (const key of ["Person/p", "RelatedPerson/b"])
    await fixture(async (s) => {
      const snap = await s.snapshot();
      s.compete(key, { active: false });
      const r = await saveGuarantor(snap, edited);
      assert.equal(r.status, "not-saved");
      assert.match(r.message, /reload/i);
      assert.deepEqual(s.writes, []);
    });
});
test("Q5b parent stale after preflight prevents children", async () =>
  fixture(async (s) => {
    const snap = await s.snapshot();
    s.hook = (key, method) => {
      if (key === "Person/p" && method === "PUT") {
        s.hook = undefined;
        s.compete(key, newest);
      }
    };
    const r = await saveGuarantor(snap, edited);
    assert.equal(r.status, "not-saved");
    assert.deepEqual(s.writes, ["PUT Person/p"]);
    assert.deepEqual(
      demographics(await fhir.read<Person>("Person", "p")),
      newest,
    );
    assert.deepEqual(demographics(await fresh("a")), old);
  }));
test("Q6b Q8 late child conflict preserves competitor and labels correct patient", async () => {
  for (const failing of ["a", "b"])
    await fixture(async (s) => {
      const snap = await s.snapshot();
      s.hook = (key, method) => {
        if (key === `RelatedPerson/${failing}` && method === "PUT") {
          assert.deepEqual(demographics(s.get<Person>("Person/p")), edited);
          s.hook = undefined;
          s.compete(key, newest);
        }
      };
      const r = await saveGuarantor(snap, edited);
      assert.equal(r.status, "partial");
      for (const c of r.children) {
        assert.equal(c.patientName, c.relatedPersonId === "a" ? "Sam" : "Leo");
        assert.equal(
          c.classification,
          c.relatedPersonId === failing ? "mismatched" : "verified",
        );
        assert.equal(
          c.writeStatus,
          c.relatedPersonId === failing ? "conflict" : "updated",
        );
        assert.deepEqual(
          demographics(await fresh(c.relatedPersonId)),
          c.relatedPersonId === failing ? newest : edited,
        );
      }
    });
});
test("Q8 failed re-read and unresolved lost response are unknown", async () => {
  await fixture(async (s) => {
    const snap = await s.snapshot();
    s.failure = (key, method) =>
      key === "RelatedPerson/b" && method === "GET" && s.writes.length >= 3
        ? "error"
        : undefined;
    const r = await saveGuarantor(snap, edited);
    assert.equal(
      r.children.find((c) => c.relatedPersonId === "b")?.classification,
      "unknown",
    );
  });
  await fixture(async (s) => {
    const snap = await s.snapshot();
    s.failure = (key, method) =>
      key === "Person/p" && method === "PUT" ? "lost" : undefined;
    assert.equal((await saveGuarantor(snap, edited)).status, "unknown");
    assert.deepEqual(s.writes, []);
  });
});
test("lost parent response confirmed landed proceeds once", async () =>
  fixture(async (s) => {
    const snap = await s.snapshot();
    s.failure = (key, method) =>
      key === "Person/p" && method === "PUT" ? "land-lost" : undefined;
    assert.equal((await saveGuarantor(snap, edited)).status, "saved");
    assert.equal(s.writes.filter((w) => w === "PUT Person/p").length, 1);
  }));
test("Q9a converged repeat zero writes and unchanged versions", async () =>
  fixture(async (s) => {
    await saveGuarantor(await s.snapshot(), edited);
    const snap = await s.snapshot();
    const before = structuredClone([...s.data]);
    s.writes = [];
    assert.equal((await saveGuarantor(snap, edited)).status, "unchanged");
    assert.deepEqual(s.writes, []);
    assert.deepEqual([...s.data], before);
  }));
test("Q9b repair only failed child fresh ETag and second pass zero writes", async () =>
  fixture(async (s) => {
    const snap = await s.snapshot();
    s.hook = (key, method) => {
      if (key === "RelatedPerson/b" && method === "PUT") {
        assert.deepEqual(demographics(s.get<Person>("Person/p")), edited);
        s.hook = undefined;
        s.compete(key, { active: false });
      }
    };
    const partial = await saveGuarantor(snap, edited);
    assert.equal(partial.status, "partial");
    const p = await fhir.read("Person", "p");
    const a = await fresh("a");
    s.writes = [];
    const r = await repairGuarantor(partial.snapshot ?? snap);
    assert.equal(r.status, "saved");
    assert.deepEqual(s.writes, ["PUT RelatedPerson/b"]);
    assert.deepEqual(await fhir.read("Person", "p"), p);
    assert.deepEqual(await fresh("a"), a);
    assert.deepEqual(demographics(await fresh("b")), edited);
    assert.equal((await fresh("b")).active, false);
    s.writes = [];
    await repairGuarantor(r.snapshot!);
    assert.deepEqual(s.writes, []);
  }));
test("Q9c repair superseded generation uses newest values", async () =>
  fixture(async (s) => {
    const r = await saveGuarantor(await s.snapshot(), edited);
    s.compete("Person/p", newest);
    s.writes = [];
    const repaired = await repairGuarantor(r.snapshot!);
    assert.equal(repaired.status, "superseded");
    assert.ok(repaired.children.every(child => child.classification === "verified"));
    assert.match(repaired.message, /superseded/i);
    for (const id of ["a", "b"])
      assert.deepEqual(demographics(await fresh(id)), newest);
    assert.ok(!s.writes.includes("PUT Person/p"));
  }));
test("Q10 Q12 missing or many matches refuse direct save", async () => {
  for (const many of [false, true])
    await fixture(async (s) => {
      const snap = await s.snapshot();
      if (many) s.put({ ...s.get<Person>("Person/p"), id: "second" });
      else
        s.compete("Person/p", {
          link: [{ target: { reference: "RelatedPerson/decoy" } }],
        });
      const loaded = await loadGuarantor("a");
      assert.equal(loaded.kind, many ? "ambiguous" : "missing");
      if (loaded.kind !== "editable")
        assert.match(
          loaded.message,
          many ? /Person\/p.*Person\/second/ : /pre-migration/,
        );
      assert.equal((await saveGuarantor(snap, edited)).status, "not-saved");
      assert.deepEqual(s.writes, []);
    });
});
test("Q13 trailing parent catches torn verification", async () =>
  fixture(async (s) => {
    const snap = await s.snapshot();
    let lastChildRead = false;
    s.hook = (key, method) => {
      if (key === "RelatedPerson/b" && method === "GET") lastChildRead = true;
      if (key === "Person/p" && method === "GET" && lastChildRead) {
        s.hook = undefined;
        s.compete("Person/p", newest);
      }
    };
    const r = await verifyGuarantor(snap);
    assert.equal(r.status, "superseded");
    assert.ok(r.children.every((c) => c.classification === "superseded"));
  }));
test("Q2 fresh SMS resolver independently observes propagated phone", async () =>
  fixture(async (s) => {
    await saveGuarantor(await s.snapshot(), edited);
    assert.equal(
      resolveSmsNumber(await fresh("a"), new Date("2026-09-13T12:00:00Z")),
      "+15555550102",
    );
  }));
test("Q6a independently stale child preflight zero writes", async () =>
  fixture(async (s) => {
    const snap = await s.snapshot();
    s.compete("RelatedPerson/b", { active: false });
    await saveGuarantor(snap, edited);
    assert.deepEqual(s.writes, []);
  }));
test("Q10 directly supplied unlinked snapshot refuses create or update", async () =>
  fixture(async (s) => {
    s.compete("Person/p", {
      link: [{ target: { reference: "RelatedPerson/decoy" } }],
    });
    const load = await loadGuarantor("a");
    assert.equal(load.kind, "missing");
    const snap = {
      person: s.get<Person>("Person/p"),
      children: [{ resource: await fresh("a"), patientName: "Sam" }],
    };
    assert.equal((await saveGuarantor(snap, edited)).status, "not-saved");
    assert.deepEqual(s.writes, []);
  }));
test("Q8 child lost response and verification failure remain unknown", async () =>
  fixture(async (s) => {
    const snap = await s.snapshot();
    s.failure = (key, method) =>
      key === "RelatedPerson/b" && (method === "PUT" || s.writes.length >= 2)
        ? "lost"
        : undefined;
    const r = await saveGuarantor(snap, edited);
    const b = r.children.find((c) => c.relatedPersonId === "b");
    assert.equal(b?.writeStatus, "no-response");
    assert.equal(b?.classification, "unknown");
    assert.deepEqual(
      demographics(s.get<RelatedPerson>("RelatedPerson/b")),
      old,
    );
  }));

test("F1a repair fences generation after fresh child read", async () => fixture(async s => {
  s.compete("Person/p", edited);
  const snap = await s.snapshot();
  let reads = 0;
  s.hook = (key, method) => {
    if (key === "RelatedPerson/a" && method === "GET" && ++reads === 2) {
      s.hook = undefined;
      s.compete("Person/p", newest);
      s.compete("RelatedPerson/a", newest);
    }
  };
  const r = await repairGuarantor(snap);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(demographics(await fresh("a")), newest);
  assert.deepEqual(demographics(await fhir.read<Person>("Person", "p")), newest);
  assert.equal(r.status, "superseded");
}));

test("F1b repair fences moved ownership after fresh child read", async () => fixture(async s => {
  s.compete("Person/p", edited);
  const snap = await s.snapshot();
  let reads = 0;
  s.hook = (key, method) => {
    if (key === "RelatedPerson/a" && method === "GET" && ++reads === 2) {
      s.hook = undefined;
      s.compete("Person/p", { link: [{ target: { reference: "RelatedPerson/b" } }] });
      s.put({ resourceType: "Person", id: "d", meta: { versionId: "1" }, ...newest, link: [{ target: { reference: "RelatedPerson/a" } }] });
      s.compete("RelatedPerson/a", newest);
    }
  };
  const r = await repairGuarantor(snap);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(demographics(await fresh("a")), newest);
  const owners = await fhir.search<Person>("Person", { link: "RelatedPerson/a" });
  assert.deepEqual(owners.entry?.map(e => e.resource?.id), ["d"]);
  assert.equal(r.status, "superseded");
}));

test("F1c save stops Leo after competitor on Sam PUT", async () => fixture(async s => {
  const snap = await s.snapshot();
  s.hook = (key, method) => {
    if (key === "RelatedPerson/a" && method === "PUT") {
      s.hook = undefined;
      s.compete("Person/p", newest);
    }
  };
  const r = await saveGuarantor(snap, edited);
  assert.deepEqual(s.writes, ["PUT Person/p", "PUT RelatedPerson/a"]);
  assert.deepEqual(demographics(await fresh("a")), edited);
  assert.deepEqual(demographics(await fresh("b")), old);
  assert.deepEqual(demographics(await fhir.read<Person>("Person", "p")), newest);
  assert.equal(r.status, "superseded");
  assert.equal(r.children[0].writeStatus, "updated");
  assert.equal(r.children[1].writeStatus, "stopped");
  assert.equal(r.children[1].patientName, "Leo");
}));

test("F1d failed generation check stops child submission", async () => fixture(async s => {
  const snap = await s.snapshot();
  s.hook = (key, method) => {
    if (key === "RelatedPerson/a" && method === "PUT") {
      s.hook = undefined;
      s.compete("Person/p", newest);
      s.failure = (key, method) => {
        if (key === "Person/p" && method === "GET") {
          s.failure = undefined;
          return "error";
        }
      };
    }
  };
  const r = await saveGuarantor(snap, edited);
  assert.deepEqual(s.writes, ["PUT Person/p", "PUT RelatedPerson/a"]);
  assert.deepEqual(demographics(await fresh("b")), old);
  assert.equal(r.children[1].writeStatus, "no-response");
  assert.notEqual(r.status, "saved");
}));

test("F1e superseded message does not promise absent Repair", async () => fixture(async s => {
  const snap = await s.snapshot();
  s.compete("Person/p", newest);
  const r = await verifyGuarantor(snap);
  assert.equal(r.status, "superseded");
  assert.doesNotMatch(r.message, /repair/i);
}));

test("F1f dangling 410 and 404 are named but 403 stays unknown", async () => fixture(async s => {
  const transport = s.fetch;
  for (const status of [410, 404, 403]) {
    globalThis.fetch = async (input, init) => String(input).includes("/RelatedPerson/b") && (!init?.method || init.method === "GET")
      ? Response.json({}, { status }) : transport(input, init);
    const r = await loadGuarantor("a");
    assert.equal(r.kind, status === 403 ? "unknown" : "dangling");
    if (r.kind !== "editable" && status !== 403) {
      assert.deepEqual(r.personIds, ["p"]);
      assert.match(r.message, /Person\/p/);
      assert.match(r.message, /RelatedPerson\/b/);
      assert.match(r.message, /deleted or outside this practice.*Editing refused/);
    }
    assert.deepEqual(s.writes, []);
  }
}));

test("F1 moved generation stays superseded if trailing verification fails", async () => {
  for (const repair of [false, true]) await fixture(async s => {
    if (repair) s.compete("Person/p", edited);
    const snap = await s.snapshot();
    let childReads = 0;
    let moved = false;
    let checks = 0;
    s.hook = (key, method) => {
      if (!moved && key === "RelatedPerson/a" && (repair ? method === "GET" && ++childReads === 2 : method === "PUT")) {
        moved = true;
        s.compete("Person/p", newest);
      }
    };
    s.failure = (key, method) => moved && key === "Person/p" && method === "GET" && ++checks > 1 ? "error" : undefined;
    const r = repair ? await repairGuarantor(snap) : await saveGuarantor(snap, edited);
    assert.equal(r.status, "superseded");
    assert.deepEqual(s.writes, repair ? [] : ["PUT Person/p", "PUT RelatedPerson/a"]);
    assert.deepEqual(demographics(await fresh("b")), old);
  });
});
