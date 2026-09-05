import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Patient, Provenance, Resource } from "@medplum/fhirtypes";
import { createMedplumClient } from "../src/fhir-client.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";
import {
  FhirSearchLimitError,
  FhirSearchPageLimitError,
  searchAll,
  searchBounded,
} from "../src/fhir-search.js";

test("MCP searchAll follows every next link and defaults the page size to 100", async () => {
  let params: Record<string, string> | undefined;
  const client = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>(_resourceType: T["resourceType"], input?: Record<string, string>) => {
      params = input;
      return page<T>([patient("patient-1")], "/fhir/R4/Patient?_getpages=2");
    },
    searchUrl: async <T extends Resource>(url: string) => {
      assert.equal(url, "/fhir/R4/Patient?_getpages=2");
      return page<T>([patient("patient-2")]);
    },
  };

  const resources = await searchAll<Patient>(client, "Patient");

  assert.deepEqual(resources.map((resource) => resource.id), ["patient-1", "patient-2"]);
  assert.equal(params?._count, "100");
});

test("MCP searchAll collects more than 100 Provenance rows through a validated next path", async () => {
  const baseUrl = "http://localhost:8103/";
  const firstPage = Array.from({ length: 100 }, (_, index) => provenance(`provenance-${index}`));
  const secondPage = Array.from({ length: 50 }, (_, index) => provenance(`provenance-${index + 100}`));
  const nextPath = "/fhir/R4/Provenance?_count=100&_offset=100&_sort=recorded";
  const client = {
    baseUrl,
    search: async <T extends Resource>() => page<T>(firstPage, `${baseUrl}fhir/R4/Provenance?_count=100&_offset=100&_sort=recorded`),
    searchUrl: async <T extends Resource>(url: string) => {
      assert.equal(url, nextPath);
      return page<T>(secondPage);
    },
  };

  const resources = await searchAll<Provenance>(client, "Provenance", {}, { maxRows: 200 });

  assert.equal(resources.length, 150);
  assert.equal(resources[0]?.id, "provenance-0");
  assert.equal(resources[149]?.id, "provenance-149");
});

test("MCP searchAll rejects a malformed Medplum next link without surfacing TypeError", async () => {
  const client = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>() => page<T>(
      [provenance("provenance-0")],
      "http://localhost:8103fhir/R4/Provenance?_count=100&_offset=100&_sort=recorded",
    ),
    searchUrl: async <T extends Resource>(url: string) => {
      new URL(url, "http://localhost:8103/fhir/R4/Provenance");
      return page<T>([]);
    },
  };

  await assert.rejects(
    searchAll<Provenance>(client, "Provenance"),
    (error: unknown) => error instanceof Error
      && !(error instanceof TypeError)
      && error.message === "FHIR Provenance next link is invalid.",
  );
});

test("MCP searchAll rejects a next link from a different origin", async () => {
  const client = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>() => page<T>(
      [patient("patient-1")],
      "https://foreign.example/fhir/R4/Patient?_page=2",
    ),
    searchUrl: async <T extends Resource>() => page<T>([patient("patient-2")]),
  };

  await assert.rejects(
    searchAll<Patient>(client, "Patient"),
    (error: unknown) => error instanceof Error
      && error.message === "FHIR Patient next link is invalid.",
  );
});

test("MCP searchAll honors a per-call row cap without returning a partial result", async () => {
  const client = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>() => page<T>(
      [patient("patient-1"), patient("patient-2")],
      "/fhir/R4/Patient?_page=2",
    ),
    searchUrl: async <T extends Resource>() => page<T>([patient("patient-3")]),
  };

  await assert.rejects(
    searchAll<Patient>(client, "Patient", {}, { maxRows: 2 }),
    (error: unknown) => error instanceof FhirSearchLimitError
      && error.status === 409
      && error.maxRows === 2
      && error.message === "FHIR Patient query exceeded 2 rows; no partial result was returned. Read 3 rows across 2 pages.",
  );
});

test("MCP searchAll fails when a returned next link cannot be followed", async () => {
  const client = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>() => page<T>([patient("patient-1")], "/next"),
  };

  await assert.rejects(
    searchAll<Patient>(client, "Patient"),
    /returned a next link for Patient, but the client cannot fetch it/,
  );

  await assert.rejects(
    searchAll<Patient>({
      baseUrl: "http://localhost:8103/",
      search: async <T extends Resource>() => ({
        ...page<T>([patient("patient-1")]),
        link: [{ relation: "next" }],
      }),
      searchUrl: async <T extends Resource>() => page<T>([]),
    }, "Patient"),
    /next link for Patient without a URL/,
  );
});

test("MCP bounded search enforces explicit page and row caps without partial results", async () => {
  let pageCalls = 0;
  const pagedClient = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>() => page<T>([patient("patient-1")], "/fhir/R4/Patient?_page=2"),
    searchUrl: async <T extends Resource>() => {
      pageCalls += 1;
      return page<T>([patient(`patient-${pageCalls + 1}`)], `/fhir/R4/Patient?_page=${pageCalls + 2}`);
    },
  };
  await assert.rejects(
    searchBounded<Patient>(pagedClient, "Patient", { _count: "1000" }, { maxPages: 5, maxRows: 5_000 }),
    (error: unknown) => error instanceof FhirSearchPageLimitError
      && error.maxPages === 5
      && error.message === "FHIR Patient query exceeded 5 pages; no partial result was returned.",
  );
  assert.equal(pageCalls, 4);

  await assert.rejects(
    searchBounded<Patient>({
      baseUrl: "http://localhost:8103/",
      search: async <T extends Resource>() => page<T>(Array.from({ length: 5_001 }, (_, index) => patient(`patient-${index}`))),
    }, "Patient", { _count: "1000" }, { maxPages: 5, maxRows: 5_000 }),
    (error: unknown) => error instanceof FhirSearchLimitError && error.maxRows === 5_000,
  );
});

test("MCP Medplum client follows same-endpoint next links and rejects cross-origin links", async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/fhir+json");
    res.end(JSON.stringify(req.url?.includes("_getpages=2")
      ? page<Patient>([patient("patient-2")])
      : page<Patient>([patient("patient-1")], "?_getpages=2")));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const client = createMedplumClient({
      baseUrl: `http://127.0.0.1:${port}`,
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    const resources = await searchAll<Patient>(client, "Patient");
    assert.deepEqual(resources.map((resource) => resource.id), ["patient-1", "patient-2"]);
    await assert.rejects(
      client.searchUrl!("https://example.com/fhir/R4/Patient?_getpages=3", "Patient"),
      /must stay within the configured FHIR endpoint/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function patient(id: string): Patient {
  return { resourceType: "Patient", id };
}

function provenance(id: string): Provenance {
  return {
    resourceType: "Provenance",
    id,
    target: [{ reference: "Encounter/encounter-1" }],
    recorded: "2026-08-25T12:00:00.000Z",
    agent: [{ who: { reference: "Practitioner/practitioner-1" } }],
  };
}

function page<T extends Resource>(resources: Resource[], nextUrl?: string): Bundle<T> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.map((resource) => ({ resource: resource as T })),
    ...(nextUrl ? { link: [{ relation: "next", url: nextUrl }] } : {}),
  };
}

test("MCP searchAll bounds empty-page streams with a counted page failure", async () => {
  let pages = 0;
  const client = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>() => page<T>([], "/fhir/R4/Patient?_page=1"),
    searchUrl: async <T extends Resource>() => {
      pages += 1;
      return page<T>([], `/fhir/R4/Patient?_page=${pages + 1}`);
    },
  };
  await assert.rejects(searchAll<Patient>(client, "Patient", {}, { maxRows: 5000, maxPages: 3 }),
    (error: unknown) => error instanceof FhirSearchPageLimitError && error.maxPages === 3 && /3 pages/.test(error.message));
  assert.equal(pages, 2);
});
