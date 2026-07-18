import type { OdosAuditEventRecord } from "../authz/odosAudit.js";
import {
  ocucoGatekeeperConfigFromEnv,
  type OcucoGatekeeperConfig,
} from "../integrations/ocuco-gatekeeper/config.js";
import {
  createOcucoGatekeeperClient,
  type OcucoGatekeeperClient,
} from "../integrations/ocuco-gatekeeper/ocucoGatekeeperClient.js";
import { createManualLabOrderAdapter, type LabOrderFhirClient } from "./adapters/manual-lab-order-adapter.js";
import { createOcucoGatekeeperLabOrderAdapter } from "./adapters/ocuco-gatekeeper-lab-order-adapter.js";
import type { LabOrderAdapter } from "./lab-order-adapter.js";

export type LabOrderVendorId = "manual" | "ocuco-gatekeeper";
export type AdapterRegistration = { vendor: LabOrderVendorId };
export type LabOrderAdapters = Partial<Record<LabOrderVendorId, LabOrderAdapter>>;

export interface LabOrderRoutingDefaults {
  vendor?: LabOrderVendorId;
}

export interface LabOrderDispatchDeps {
  now?: () => string;
  recordAudit?(row: OdosAuditEventRecord): Promise<void>;
  ocucoConfig?: OcucoGatekeeperConfig;
  ocucoClient?: OcucoGatekeeperClient;
}

export interface LabOrderDispatch {
  getAdapter(vendor: string, fhir: LabOrderFhirClient): LabOrderAdapter;
  vendors(): string[];
}

export function createLabOrderDispatch(
  registrations: AdapterRegistration[],
  deps: LabOrderDispatchDeps = {},
): LabOrderDispatch {
  const byVendor = new Map<LabOrderVendorId, AdapterRegistration>(
    registrations.map((registration) => [registration.vendor, registration]),
  );
  const ocucoConfig = deps.ocucoConfig ?? ocucoGatekeeperConfigFromEnv();
  const ocucoClient = deps.ocucoClient ?? createOcucoGatekeeperClient();

  return {
    vendors() {
      return [...byVendor.keys()];
    },

    getAdapter(vendor: string, fhir: LabOrderFhirClient): LabOrderAdapter {
      if (!isLabOrderVendorId(vendor)) {
        throw new Error(`Lab-order vendor "${vendor}" is not supported.`);
      }
      const registration = byVendor.get(vendor);
      if (!registration) {
        throw new Error(`Lab-order vendor "${vendor}" is not configured for this practice.`);
      }
      switch (registration.vendor) {
        case "manual":
          return createManualLabOrderAdapter(fhir, { now: deps.now, recordAudit: deps.recordAudit });
        case "ocuco-gatekeeper":
          return createOcucoGatekeeperLabOrderAdapter(
            fhir,
            ocucoConfig,
            ocucoClient,
            { now: deps.now, recordAudit: deps.recordAudit },
          );
      }
    },
  };
}

export function selectLabOrderAdapter(
  adapters: LabOrderAdapters,
  requested: LabOrderVendorId | undefined,
  defaults: LabOrderRoutingDefaults = {},
): LabOrderAdapter {
  const vendor = requested ?? defaults.vendor ?? "manual";
  const adapter = adapters[vendor];
  if (!adapter) {
    throw new Error(`Lab-order vendor "${vendor}" is not configured for this practice.`);
  }
  return adapter;
}

export function isLabOrderVendorId(value: unknown): value is LabOrderVendorId {
  return value === "manual" || value === "ocuco-gatekeeper";
}

export function labOrderRoutingFromEnv(
  env: Record<string, string | undefined>,
): Required<LabOrderRoutingDefaults> {
  const vendor = env.ODOS_LAB_ORDER_VENDOR_DEFAULT || "manual";
  if (!isLabOrderVendorId(vendor)) {
    throw new Error("ODOS lab-order vendor routing value must be manual or ocuco-gatekeeper.");
  }
  return { vendor };
}
