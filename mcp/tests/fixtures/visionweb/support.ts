import type { LabOrder } from "../../../src/fhir/opticalLabOrder.js";
export const env = {
  VISIONWEB_SOAP_URL: "https://services.visionwebqa.com/FileUpload.asmx",
  VISIONWEB_TOKEN_URL: "https://auth.example/token",
  VISIONWEB_API_BASE_URL: "https://api.example",
  VISIONWEB_CLIENT_ID: "CLIENT-SENTINEL-5d0", VISIONWEB_CLIENT_SECRET: "SECRET-SENTINEL-4c1",
  VISIONWEB_REF_ID: "RODEMO", VISIONWEB_USERNAME: "USER-SENTINEL-2b7", VISIONWEB_PASSWORD: "PW-SENTINEL-9f3",
  VISIONWEB_LAB_ACCOUNTS: JSON.stringify({ Demo: { supplierId: "9992", billAccount: "demo-bill", shipAccount: "demo-ship" } }),
};

export function order(): LabOrder {
  return { header: { orderId: "TEST-ORDER", orderDate: "2026-09-26", lab: "Demo", patientName: "ALEX" },
    rx: { od: { sphere: 1.125, cylinder: -0.5, axis: 80, distPd: 30, nearPd: 29, add: 1.25, segHeight: 20,
      prisms: [{ amount: 1.5, base: "in" }, { amount: 0.5, base: "up" }] }, os: { sphere: 0, distPd: 31 } },
    lensSpec: { jobType: "Uncut", lensDesign: "SV", lensMaterial: "TEST-MATERIAL", treatments: ["T1", "T2", "T3"], specialInstructions: "Test", commentsToLab: "Only" },
    frameSource: 0, frame: { source: "stock", frameType: "METAL", a: "50", b: "35", dbl: "21", ed: "52", eye: "50", temple: "135", brand: "Test", model: "Model", color: "Black" } };
}
