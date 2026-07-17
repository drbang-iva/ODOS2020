import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabOrder } from "../src/fhir/opticalLabOrder.js";
import {
  isOcucoGatekeeperConfigured,
  ocucoGatekeeperConfigFromEnv,
} from "../src/integrations/ocuco-gatekeeper/config.js";
import {
  createOcucoGatekeeperClient,
  isInnovationsJobStatus,
  isLabzillaJobStatus,
} from "../src/integrations/ocuco-gatekeeper/ocucoGatekeeperClient.js";
import {
  labOrderCancellationToHashref,
  labOrderToHashref,
} from "../src/integrations/ocuco-gatekeeper/hashrefSerializer.js";
import { mapOcucoStatusToLabTransportState } from "../src/integrations/ocuco-gatekeeper/statusMapper.js";

const NOW = "2026-07-17T18:00:00.000Z";
const CONFIG = {
  baseUrl: "https://gatekeeper-staging.opticalonline.com/",
  jwtKey: "test-key",
  jwtSecret: "test-secret",
};

function order(): LabOrder {
  return {
    header: {
      orderId: "50481940",
      orderDate: "2026-07-17",
      lab: "BP Digital Labs",
      patientName: "Wanda Walkthrough",
      providerName: "Dr Example",
      trayNumber: "3254",
    },
    rx: {
      od: {
        sphere: 2.25,
        cylinder: -0.5,
        axis: 90,
        add: 2.5,
        distPd: 31.5,
        nearPd: 30,
        segHeight: 25,
        prisms: [
          { amount: 1.5, base: "in" },
          { amount: 0.5, base: "up" },
        ],
      },
      os: {
        sphere: 1,
        cylinder: -0.75,
        axis: 75,
        add: 2.5,
        distPd: 27,
        nearPd: 26,
        segHeight: 25,
      },
    },
    lensSpec: {
      jobType: "Uncut Lenses Only",
      lensDesign: "Comfort 2 DRX",
      lensMaterial: "Polycarbonate",
      treatments: ["Super AR"],
      commentsToLab: "Use verified frame measurements",
    },
    frameSource: 0,
    frame: {
      source: "stock",
      brand: "Acme",
      model: "Round 48",
      color: "Black",
      eye: "48",
      bridge: "21",
      temple: "145",
      a: "48.0",
      b: "42.0",
      ed: "52.0",
      dbl: "21.0",
      frameType: "standard",
    },
    frameTraceRef: "Binary/trace-reference-only",
  };
}

test("Ocuco config reads only the three documented env vars and gates blank values", () => {
  assert.deepEqual(ocucoGatekeeperConfigFromEnv({
    OCUCO_GATEKEEPER_BASE_URL: "https://gatekeeper.example",
    OCUCO_GATEKEEPER_JWT_KEY: "key",
    OCUCO_GATEKEEPER_JWT_SECRET: "secret",
    OCUCO_GATEKEEPER_HASH_ROUTING_KEY: "must-not-be-read",
  }), {
    baseUrl: "https://gatekeeper.example",
    jwtKey: "key",
    jwtSecret: "secret",
  });
  assert.equal(isOcucoGatekeeperConfigured(CONFIG), true);
  assert.equal(isOcucoGatekeeperConfigured({ ...CONFIG, jwtSecret: "  " }), false);
  assert.equal(isOcucoGatekeeperConfigured({}), false);
});

test("Hashref v2.5 serialization follows the PDF field table and documented item/prism examples", () => {
  const serialized = labOrderToHashref(order(), {
    labNumReceiver: "1231",
    custNumReceiver: "767",
  });
  const lines = serialized.split("\r\n");

  assert.deepEqual(lines.slice(0, 5), [
    "file_version:2.5",
    "start_order",
    "agent_name:odos",
    "agent_version:0.1.0",
    "lab_num:1231",
  ]);
  assert.ok(lines.includes("cust_num:767"));
  assert.ok(lines.includes("order_id:50481940"));
  assert.ok(lines.includes("customer_po_num:50481940"));
  assert.ok(lines.includes("patient_name:Wanda Walkthrough"));
  assert.ok(lines.includes("date_ordered:2026-07-17-12-00-00"));
  assert.ok(lines.includes("frame_status:LENSES ONLY"));
  assert.ok(lines.includes("frame_tracing:NO TRACE"));
  assert.ok(lines.includes("frame_mounting:STANDARD"));
  assert.ok(lines.includes("frame_edge:UNCUT"));
  assert.ok(lines.includes("x_lens_od_style_desc:Comfort 2 DRX"));
  assert.ok(lines.includes("x_lens_os_material_desc:Polycarbonate"));
  assert.ok(lines.includes("rx_eye:3"));
  assert.ok(lines.includes("rx_od_sphere:+2.25"));
  assert.ok(lines.includes("rx_od_cylinder:-0.50"));
  assert.ok(lines.includes("rx_od_prism:1.50"));
  assert.ok(lines.includes("rx_od_prism_dir:IN"));
  assert.ok(lines.includes("rx_od_prism2:0.50"));
  assert.ok(lines.includes("rx_od_prism2_dir:UP"));
  assert.ok(lines.includes("rx_os_prism:0.00"));
  assert.ok(lines.includes("rx_os_prism_dir:IN"));
  assert.ok(lines.includes("rx_os_prism2:0.00"));
  assert.ok(lines.includes("rx_os_prism2_dir:UP"));
  assert.ok(lines.includes("instructions:Use verified frame measurements"));
  assert.equal(lines.at(-1), "end_order");

  const itemStart = lines.indexOf("item_start");
  assert.deepEqual(lines.slice(itemStart, itemStart + 8), [
    "item_start",
    "sku:Super AR",
    "item_source:MISC",
    "item_description:Super AR",
    "item_quantity:1",
    "item_side:NONE",
    "item_part_rx:Y",
    "item_end",
  ]);
  assert.equal(serialized.includes("frame_source:"), false);
  assert.equal(serialized.includes("trace_file:"), false);
  assert.equal(serialized.includes("trace_value:"), false);
});

test("cancellation reuses the original order id and adds the documented cancel flag", () => {
  const serialized = labOrderCancellationToHashref(order(), {
    labNumReceiver: "1231",
    custNumReceiver: "767",
  }, "50481940");
  const lines = serialized.split("\r\n");
  assert.ok(lines.includes("order_id:50481940"));
  assert.ok(lines.includes("cancel:1"));
  assert.equal(lines.at(-1), "end_order");
});

test("Ocuco client uses the live documented JSON envelope, contract, and destructive status paths", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    { auth_token: "token-1", lab: { id: 1, webrx_lab_id: "1231" } },
    {
      message: {
        lab: {
          contractSending: [{
            hash_routing: "routing-key",
            webrx_lab_id_receiver: "1231",
            webrx_retailer_name_receiver: "767",
          }],
        },
      },
    },
    { message: { id: 581050, guid: "remote-guid", created_at: NOW, updated_at: NOW } },
    {
      job_status: [[{
        RxNumber: "",
        PoNumber: "50481940",
        OrderDate: "11/18/2021",
        StatusDate: "11/18/2021 13:43:00 PM",
        Status: "IN HOUSE COATING -ccsys",
      }]],
    },
  ];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = createOcucoGatekeeperClient({ fetchImpl, now: () => new Date(NOW) });

  const firstAuth = await client.authenticate(CONFIG);
  const secondAuth = await client.authenticate(CONFIG);
  assert.deepEqual(secondAuth, firstAuth);
  assert.deepEqual(firstAuth, {
    authToken: "token-1",
    expiresAt: "2026-07-18T18:00:00.000Z",
  });
  assert.equal(requests.length, 1);
  const authUrl = new URL(requests[0].url);
  assert.equal(authUrl.pathname, "/api/v2/auth_user");
  assert.equal(authUrl.searchParams.get("jwt_key"), "test-key");
  assert.equal(authUrl.searchParams.get("jwt_secret"), "test-secret");
  assert.equal(requests[0].init?.method, "POST");

  const contract = await client.getContract(firstAuth.authToken, CONFIG);
  assert.deepEqual(contract, {
    hashRoutingKey: "routing-key",
    labNumReceiver: "1231",
    custNumReceiver: "767",
  });
  assert.equal(new URL(requests[1].url).pathname, "/api/v2/operations/contract_available");
  assert.equal(new Headers(requests[1].init?.headers).get("Authorization"), "Bearer token-1");

  const hashrefBody = "file_version:2.5\r\nstart_order\r\nend_order";
  const pushed = await client.pushOrderToLab(firstAuth.authToken, {
    hashRoutingKey: contract.hashRoutingKey,
    hashrefBody,
  }, CONFIG);
  assert.equal(pushed.id, 581050);
  assert.equal(new URL(requests[2].url).pathname, "/api/v2/orders/push_order_to_lab");
  assert.equal(new Headers(requests[2].init?.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), {
    order: {
      hash_routing: "routing-key",
      rx_content: hashrefBody,
      tr_content: "",
    },
  });

  const statuses = await client.pullJobStatus(firstAuth.authToken, contract.hashRoutingKey, CONFIG);
  const pullUrl = new URL(requests[3].url);
  assert.equal(pullUrl.pathname, "/api/v2/status/pulling_job_status");
  assert.equal(pullUrl.searchParams.get("status[hash_routing]"), "routing-key");
  assert.deepEqual(statuses, {
    job_status: [[{
      RxNumber: "",
      PoNumber: "50481940",
      OrderDate: "11/18/2021",
      StatusDate: "11/18/2021 13:43:00 PM",
      Status: "IN HOUSE COATING -ccsys",
    }]],
  });
});

test("Ocuco contract parsing fails closed when a sending contract field is absent", async () => {
  const client = createOcucoGatekeeperClient({
    fetchImpl: async () => new Response(JSON.stringify({
      message: { lab: { contractSending: [{ hash_routing: "routing-key" }] } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(
    () => client.getContract("token", CONFIG),
    /missing.*webrx_lab_id_receiver|contract.*missing/i,
  );
});

test("Innovations and Labzilla status guards preserve their distinct documented shapes", () => {
  const innovations = {
    RxNumber: "2401",
    PoNumber: "2401",
    StatusDate: "2020-07-30T14:39:00%2B05:00",
    Status: "Order Entry",
    OrderID: "287030",
  };
  const labzilla = {
    RxNumber: "",
    PoNumber: "56",
    OrderDate: "11/18/2021",
    StatusDate: "11/18/2021 13:43:00 PM",
    Status: "IN HOUSE COATING -ccsys",
  };
  assert.equal(isInnovationsJobStatus(innovations), true);
  assert.equal(isLabzillaJobStatus(innovations), false);
  assert.equal(isInnovationsJobStatus(labzilla), false);
  assert.equal(isLabzillaJobStatus(labzilla), true);
});

test("documented Ocuco statuses map forward and unknown values preserve the current state", () => {
  assert.deepEqual(mapOcucoStatusToLabTransportState("Order Entry", "sent"), {
    state: "sent", unmapped: false, rawStatus: "Order Entry",
  });
  assert.equal(mapOcucoStatusToLabTransportState("Order received", "sent").state, "acknowledged");
  assert.equal(mapOcucoStatusToLabTransportState("Edged", "acknowledged").state, "in-production");
  assert.equal(mapOcucoStatusToLabTransportState("Edger1", "acknowledged").state, "in-production");
  assert.equal(mapOcucoStatusToLabTransportState("Final Inspection", "acknowledged").state, "in-production");
  assert.equal(mapOcucoStatusToLabTransportState("IN HOUSE COATING -ccsys", "acknowledged").state, "in-production");
  assert.equal(mapOcucoStatusToLabTransportState("Shipped UPS", "in-production").state, "shipped");
  assert.deepEqual(mapOcucoStatusToLabTransportState("Bench 7", "acknowledged"), {
    state: "acknowledged", unmapped: true, rawStatus: "Bench 7",
  });
});
