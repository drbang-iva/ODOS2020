import type { AgentOpsExceptionCode, AgentOpsVerdict, SpecificAction, ThresholdClass } from "./types.js";

export interface AgentOpsExceptionMappingInput {
  readonly rule_id: string;
  readonly threshold_class: ThresholdClass;
  readonly verdict: AgentOpsVerdict;
  readonly target_resourceType: string;
  readonly specific_action: SpecificAction;
  readonly tool_name: string;
  readonly configured_exception_code?: AgentOpsExceptionCode;
}

export interface AgentOpsExceptionDescriptor {
  readonly code: AgentOpsExceptionCode;
  readonly section: string;
  readonly title: string;
  readonly httpStatus: number;
  readonly externalMaskCode?: AgentOpsExceptionCode;
}

export const AGENTOPS_EXCEPTION_DESCRIPTORS: Record<AgentOpsExceptionCode, AgentOpsExceptionDescriptor> = {
  PreventingHarm: {
    code: "PreventingHarm",
    section: "171.201",
    title: "Preventing Harm Exception",
    httpStatus: 403,
  },
  Privacy: {
    code: "Privacy",
    section: "171.202",
    title: "Privacy Exception",
    httpStatus: 403,
  },
  Security: {
    code: "Security",
    section: "171.203",
    title: "Security Exception",
    httpStatus: 403,
  },
  Infeasibility: {
    code: "Infeasibility",
    section: "171.204",
    title: "Infeasibility Exception",
    httpStatus: 403,
  },
  HealthITPerformance: {
    code: "HealthITPerformance",
    section: "171.205",
    title: "Health IT Performance Exception",
    httpStatus: 429,
  },
  ProtectingCareAccess: {
    code: "ProtectingCareAccess",
    section: "171.206",
    title: "Protecting Care Access Exception",
    httpStatus: 403,
    externalMaskCode: "Privacy",
  },
  ContentAndManner: {
    code: "ContentAndManner",
    section: "171.301",
    title: "Content and Manner Exception",
    httpStatus: 403,
  },
  Fees: {
    code: "Fees",
    section: "171.302",
    title: "Fees Exception",
    httpStatus: 403,
  },
  Licensing: {
    code: "Licensing",
    section: "171.303",
    title: "Licensing Exception",
    httpStatus: 403,
  },
  TEFCAManner: {
    code: "TEFCAManner",
    section: "171.403",
    title: "TEFCA Manner Exception",
    httpStatus: 406,
  },
};

export function mapAgentOpsException(
  input: AgentOpsExceptionMappingInput,
): AgentOpsExceptionDescriptor | undefined {
  if (input.configured_exception_code) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS[input.configured_exception_code];
  }
  if (input.verdict !== "blocked") {
    return undefined;
  }
  if (/raw-image-byte-to-llm|image.*llm|llm.*image/i.test(input.tool_name)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.PreventingHarm;
  }
  if (/cross-tenant|tenant.*read/i.test(input.rule_id)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.Privacy;
  }
  if (/token|signature|tamper/i.test(input.rule_id)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.Security;
  }
  if (/rate-limit|high-frequency/i.test(input.rule_id)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.HealthITPerformance;
  }
  if (/unsupported|not-supported/i.test(input.rule_id)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.Infeasibility;
  }
  if (/initiation-mode|manner|format/i.test(input.rule_id)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.ContentAndManner;
  }
  if (/baa|license|licensing/i.test(input.rule_id)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.Licensing;
  }
  if (/billing|fee/i.test(input.rule_id)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.Fees;
  }
  if (/tefca|qhin/i.test(input.rule_id)) {
    return AGENTOPS_EXCEPTION_DESCRIPTORS.TEFCAManner;
  }
  return undefined;
}

export function externalExceptionDescriptor(
  descriptor: AgentOpsExceptionDescriptor,
): AgentOpsExceptionDescriptor {
  return descriptor.externalMaskCode
    ? AGENTOPS_EXCEPTION_DESCRIPTORS[descriptor.externalMaskCode]
    : descriptor;
}

export function exceptionTypeUri(descriptor: AgentOpsExceptionDescriptor): string {
  return `https://osod.dev/fhir/exception/${descriptor.section}`;
}
