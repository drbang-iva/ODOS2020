import { randomUUID } from "node:crypto";
import type { Device, Provenance } from "@medplum/fhirtypes";
import {
  AGENT_IDENTITY_EXTENSION_URL,
  AIAST_CODE_SYSTEM,
  MODEL_IDENTITY_EXTENSION_URL,
  type InitiationMode,
  type ThresholdClass,
} from "./types.js";

export interface AgentModelRegistrationInput {
  readonly modelUri: string;
  readonly vendorName: string;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly vendorBaaEligible: boolean;
  readonly mcpBaaCarveOut?: boolean;
  readonly modelFingerprint?: string;
}

export interface AgentRegistrationInput {
  readonly agentUri: string;
  readonly agentLogicalName: string;
  readonly agentRole: string;
  readonly agentRiskClass: ThresholdClass;
  readonly initiationModeCapabilities: readonly InitiationMode[];
  readonly vendorBaaStatus: string;
  readonly manufacturer?: string;
  readonly deploymentDistinctIdentifier: string;
  readonly model: AgentModelRegistrationInput;
  readonly adminReviewStatus: "pending" | "approved";
  readonly adminBaaConfirmation?: boolean;
  readonly declaresThirdPartyMcpRouting?: boolean;
  readonly resourceQuotas?: {
    readonly memoryMb?: number;
    readonly cpuShares?: number;
  };
}

export interface AgentRegistrationResult {
  readonly status: "pending-review" | "registered";
  readonly agentDevice?: Device;
  readonly modelDevice?: Device;
  readonly provenance?: Provenance;
}

export class InMemoryAgentOpsDeviceRegistry {
  readonly devices = new Map<string, Device>();
  readonly provenance = new Map<string, Provenance>();

  register(input: AgentRegistrationInput, now = new Date().toISOString()): AgentRegistrationResult {
    assertAgentRegistrationAllowed(input);
    if (input.adminReviewStatus !== "approved") {
      return { status: "pending-review" };
    }
    const modelDevice = buildModelDevice(input.model);
    const agentDevice = buildAgentDevice(input);
    const provenance = buildAgentRegistrationProvenance(agentDevice, now);
    this.devices.set(input.model.modelUri, modelDevice);
    this.devices.set(input.agentUri, agentDevice);
    this.provenance.set(provenance.id!, provenance);
    return {
      status: "registered",
      agentDevice,
      modelDevice,
      provenance,
    };
  }

  getDevice(uri: string): Device | undefined {
    return this.devices.get(uri);
  }
}

export function assertAgentRegistrationAllowed(input: AgentRegistrationInput): void {
  if (!input.model.vendorBaaEligible && !input.adminBaaConfirmation) {
    throw new Error("AgentOps registration blocked: vendor BAA eligibility requires practice admin attestation.");
  }
  if (/anthropic/i.test(input.model.vendorName) && input.declaresThirdPartyMcpRouting) {
    throw new Error("AgentOps registration blocked: Anthropic MCP routing to a third-party data sink is not BAA-covered.");
  }
  if (!input.initiationModeCapabilities.length) {
    throw new Error("AgentOps registration blocked: initiation_mode_capabilities is required.");
  }
}

export function buildAgentDevice(input: AgentRegistrationInput): Device {
  return {
    resourceType: "Device",
    id: idFromUri(input.agentUri),
    identifier: [{ system: "https://osod.dev/agents", value: input.agentUri }],
    manufacturer: input.manufacturer ?? "OSOD development team",
    distinctIdentifier: input.deploymentDistinctIdentifier,
    parent: { reference: `Device/${idFromUri(input.model.modelUri)}` },
    extension: [
      {
        url: AGENT_IDENTITY_EXTENSION_URL,
        extension: [
          valueStringExtension("agent_logical_name", input.agentLogicalName),
          valueStringExtension("agent_role", input.agentRole),
          valueStringExtension("agent_risk_class", input.agentRiskClass),
          {
            url: "initiation_mode_capabilities",
            extension: input.initiationModeCapabilities.map((mode) => valueStringExtension("mode", mode)),
          },
          valueStringExtension("vendor_baa_status", input.vendorBaaStatus),
          ...(input.resourceQuotas
            ? [
                {
                  url: "resource_quotas",
                  extension: [
                    ...(input.resourceQuotas.memoryMb
                      ? [valueIntegerExtension("memory_mb", input.resourceQuotas.memoryMb)]
                      : []),
                    ...(input.resourceQuotas.cpuShares
                      ? [valueIntegerExtension("cpu_shares", input.resourceQuotas.cpuShares)]
                      : []),
                  ],
                },
              ]
            : []),
        ],
      },
    ],
    property: agentDsiSourceAttributeProperties(),
  };
}

export function buildModelDevice(input: AgentModelRegistrationInput): Device {
  return {
    resourceType: "Device",
    id: idFromUri(input.modelUri),
    identifier: [{ system: "https://osod.dev/models", value: input.modelUri }],
    manufacturer: input.vendorName,
    modelNumber: input.modelName,
    distinctIdentifier: input.modelFingerprint,
    version: [
      {
        type: {
          text: "model-version",
        },
        value: input.modelVersion,
      },
    ],
    extension: [
      {
        url: MODEL_IDENTITY_EXTENSION_URL,
        extension: [
          valueStringExtension("vendor_name", input.vendorName),
          valueBooleanExtension("vendor_baa_eligible", input.vendorBaaEligible),
          valueBooleanExtension("mcp_baa_carve_out", input.mcpBaaCarveOut ?? false),
        ],
      },
    ],
  };
}

export function buildAgentRegistrationProvenance(agentDevice: Device, recorded: string): Provenance {
  const id = `agentops-register-${agentDevice.id ?? randomUUID()}`;
  return {
    resourceType: "Provenance",
    id,
    target: [{ reference: `Device/${agentDevice.id}` }],
    recorded,
    policy: ["https://osod.dev/fhir/Policy/agentops-agent-registry"],
    activity: {
      coding: [
        {
          system: "https://osod.dev/fhir/CodeSystem/registry-activity",
          code: "register",
          display: "register",
        },
      ],
    },
    agent: [
      {
        who: { reference: "Device/osod-instance" },
      },
    ],
  };
}

export function idFromUri(uri: string): string {
  const last = uri.split("/").filter(Boolean).at(-1);
  if (!last) {
    throw new Error(`AgentOps URI cannot be converted to a FHIR id: ${uri}`);
  }
  return last.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
}

export function isAgentDevice(resource: Device): boolean {
  return Boolean(resource.extension?.some((extension) => extension.url === AGENT_IDENTITY_EXTENSION_URL));
}

export function hasPredictiveDsiSourceAttributes(device: Device | undefined): boolean {
  if (!device) return false;
  const propertyCodes = new Set(
    (device.property ?? []).map((property) => property.type?.coding?.[0]?.code ?? property.type?.text),
  );
  return [
    "dsi-validity",
    "dsi-fairness",
    "dsi-intelligibility",
    "dsi-governance",
  ].every((code) => propertyCodes.has(code));
}

function agentDsiSourceAttributeProperties(): NonNullable<Device["property"]> {
  return [
    dsiProperty("dsi-validity", "Training demographics and validation data sources are recorded in the agent review packet."),
    dsiProperty("dsi-fairness", "Intended use, user, outcome, and performance metrics are recorded in the agent review packet."),
    dsiProperty("dsi-intelligibility", "Risk identification, mitigation, and monitoring are recorded in the agent review packet."),
    dsiProperty("dsi-governance", "Developer identity, funding source, and evidence basis are recorded in the agent review packet."),
  ];
}

function dsiProperty(code: string, display: string): NonNullable<Device["property"]>[number] {
  return {
    type: {
      coding: [{ system: `${AIAST_CODE_SYSTEM}/osod-dsi-source-attributes`, code, display }],
      text: code,
    },
    valueCode: [{ text: display }],
  };
}

function valueStringExtension(url: string, valueString: string) {
  return { url, valueString };
}

function valueBooleanExtension(url: string, valueBoolean: boolean) {
  return { url, valueBoolean };
}

function valueIntegerExtension(url: string, valueInteger: number) {
  return { url, valueInteger };
}
