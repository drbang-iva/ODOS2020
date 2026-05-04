import {
  AGENTOPS_EXCEPTION_CODES,
  AGENTOPS_VERDICTS,
  IMPACT_CLASSES,
  INITIATION_MODES,
  SPECIFIC_ACTIONS,
  THRESHOLD_CLASSES,
  type AgentOpsExceptionCode,
  type AgentOpsVerdict,
  type ClinicalBillingPatientFacingImpact,
  type InitiationMode,
  type SpecificAction,
  type ThresholdClass,
} from "./types.js";

export type EscalationTarget = "dual-verification" | "break-glass" | "staged-admin-review";

export interface AgentOpsCompositeKey {
  readonly tool_name: string;
  readonly target_resourceType: string;
  readonly specific_action: SpecificAction;
  readonly clinical_billing_patient_facing_impact: ClinicalBillingPatientFacingImpact;
  readonly initiation_mode: InitiationMode;
}

export interface AgentOpsOnViolation {
  readonly verdict: Exclude<AgentOpsVerdict, "allowed" | "confirmed">;
  readonly section_171_exception_code?: AgentOpsExceptionCode;
  readonly escalation_target?: EscalationTarget;
}

export interface AgentOpsPolicyRule {
  readonly rule_id: string;
  readonly rule_version: string;
  readonly composite_key: AgentOpsCompositeKey;
  readonly threshold_class: ThresholdClass;
  readonly agent_scope: "any-agent" | string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly rationale: string;
  readonly on_violation: AgentOpsOnViolation;
  readonly source_path?: string;
  readonly source_rank?: number;
}

export interface AgentOpsPolicyFile {
  readonly policies: AgentOpsPolicyRule[];
  readonly retention: {
    readonly retention_years: number;
  };
}

export interface AgentOpsActionLookupInput extends AgentOpsCompositeKey {
  readonly agent_uri: string;
  readonly at?: string;
}

export interface AgentOpsRuleResolution {
  readonly rule: AgentOpsPolicyRule;
  readonly implicitDefault: boolean;
}

export interface AgentOpsPolicyValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly rule_id?: string;
}

const DEFAULT_POLICY_RULE: AgentOpsPolicyRule = {
  rule_id: "agentops-implicit-high-confirmation-required",
  rule_version: "2026-05-04",
  composite_key: {
    tool_name: "*",
    target_resourceType: "*",
    specific_action: "execute",
    clinical_billing_patient_facing_impact: "mixed",
    initiation_mode: "user-initiated",
  },
  threshold_class: "HIGH",
  agent_scope: "any-agent",
  effective_from: "2026-05-04",
  effective_to: null,
  rationale: "Unknown AgentOps actions require human confirmation by default.",
  on_violation: {
    verdict: "confirmation-required",
  },
};

const VERDICT_RESTRICTION: Record<AgentOpsVerdict, number> = {
  allowed: 0,
  confirmed: 1,
  "confirmation-required": 2,
  escalated: 3,
  blocked: 4,
};

const THRESHOLD_RESTRICTION: Record<ThresholdClass, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function parseAgentOpsPolicyYaml(text: string, sourcePath = "agentops-policy.yaml"): AgentOpsPolicyFile {
  const policies: MutablePolicyRule[] = [];
  let current: MutablePolicyRule | undefined;
  let section: "composite_key" | "on_violation" | "retention" | undefined;
  let retentionYears = 7;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) {
      continue;
    }
    if (line.trim() === "policies:") {
      section = undefined;
      continue;
    }
    if (line.trim() === "retention:") {
      section = "retention";
      current = undefined;
      continue;
    }

    const item = /^  - ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (item) {
      current = {
        composite_key: {},
        on_violation: {},
      };
      policies.push(current);
      section = undefined;
      assignPolicyScalar(current, item[1]!, item[2]!, sourcePath);
      continue;
    }

    const policyScalar = /^    ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (policyScalar && current) {
      const key = policyScalar[1]!;
      const value = policyScalar[2]!;
      if (key === "composite_key" || key === "on_violation") {
        section = key;
        continue;
      }
      section = undefined;
      assignPolicyScalar(current, key, value, sourcePath);
      continue;
    }

    const nestedScalar = /^      ([A-Za-z_§][A-Za-z0-9_§]*):\s*(.*)$/.exec(line);
    if (nestedScalar && current && (section === "composite_key" || section === "on_violation")) {
      const rawKey = nestedScalar[1]!;
      const key = rawKey === "§171_exception_code" ? "section_171_exception_code" : rawKey;
      const value = parseScalar(nestedScalar[2]!);
      if (section === "composite_key") {
        (current.composite_key as Record<string, unknown>)[key] = value;
      } else {
        (current.on_violation as Record<string, unknown>)[key] = value;
      }
      continue;
    }

    const retentionScalar = /^  ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (retentionScalar && section === "retention") {
      if (retentionScalar[1] === "retention_years") {
        retentionYears = Number(parseScalar(retentionScalar[2]!));
      }
      continue;
    }

    throw new Error(`${sourcePath}: unsupported AgentOps policy YAML line: ${rawLine}`);
  }

  const typedPolicies = policies.map((policy) => finalizePolicy(policy, sourcePath));
  const result = {
    policies: typedPolicies,
    retention: {
      retention_years: retentionYears,
    },
  };
  const issues = validateAgentOpsPolicyFile(result);
  if (issues.length) {
    throw new Error(`${sourcePath}: ${issues.map((issue) => issue.message).join("; ")}`);
  }
  return result;
}

export function validateAgentOpsPolicyFile(file: AgentOpsPolicyFile): AgentOpsPolicyValidationIssue[] {
  const issues: AgentOpsPolicyValidationIssue[] = [];
  if (!Number.isInteger(file.retention.retention_years) || file.retention.retention_years < 7) {
    issues.push({
      code: "retention-years-invalid",
      message: "retention.retention_years must be an integer >= 7",
    });
  }
  const collisionKeys = new Map<string, string>();
  for (const rule of file.policies) {
    validateRule(rule, issues);
    const collisionKey = ruleCollisionKey(rule);
    const prior = collisionKeys.get(collisionKey);
    if (prior) {
      issues.push({
        code: "same-effective-from-collision",
        message: `rules ${prior} and ${rule.rule_id} have the same specificity and effective_from`,
        rule_id: rule.rule_id,
      });
    } else {
      collisionKeys.set(collisionKey, rule.rule_id);
    }
  }
  return issues;
}

export function lookupThresholdRule(
  rules: readonly AgentOpsPolicyRule[],
  input: AgentOpsActionLookupInput,
): AgentOpsRuleResolution {
  const at = Date.parse(input.at ?? new Date().toISOString());
  const matches = rules.filter((rule) => ruleMatches(rule, input, at));
  if (!matches.length) {
    return { rule: { ...DEFAULT_POLICY_RULE, composite_key: { ...DEFAULT_POLICY_RULE.composite_key, initiation_mode: input.initiation_mode } }, implicitDefault: true };
  }
  return { rule: [...matches].sort(compareRuleSpecificity)[0]!, implicitDefault: false };
}

export function chooseMostRestrictiveRule(rules: readonly AgentOpsPolicyRule[]): AgentOpsPolicyRule {
  if (!rules.length) {
    throw new Error("cannot choose a restrictive AgentOps rule from an empty rule set");
  }
  return [...rules].sort((a, b) => {
    const threshold = THRESHOLD_RESTRICTION[b.threshold_class] - THRESHOLD_RESTRICTION[a.threshold_class];
    if (threshold !== 0) return threshold;
    return VERDICT_RESTRICTION[b.on_violation.verdict] - VERDICT_RESTRICTION[a.on_violation.verdict];
  })[0]!;
}

function validateRule(rule: AgentOpsPolicyRule, issues: AgentOpsPolicyValidationIssue[]): void {
  const requiredStrings = [
    "rule_id",
    "rule_version",
    "agent_scope",
    "effective_from",
    "rationale",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof rule[field] !== "string" || !rule[field]) {
      issues.push({ code: "required-field", message: `${field} is required`, rule_id: rule.rule_id });
    }
  }
  if (!THRESHOLD_CLASSES.includes(rule.threshold_class)) {
    issues.push({ code: "threshold-class-invalid", message: "threshold_class is invalid", rule_id: rule.rule_id });
  }
  if (!rule.agent_scope.startsWith("https://osod.dev/agents/") && rule.agent_scope !== "any-agent") {
    issues.push({ code: "agent-scope-invalid", message: "agent_scope must be any-agent or an OSOD agent URI", rule_id: rule.rule_id });
  }
  if (Number.isNaN(Date.parse(rule.effective_from))) {
    issues.push({ code: "effective-from-invalid", message: "effective_from must be an ISO date", rule_id: rule.rule_id });
  }
  if (rule.effective_to !== null && Number.isNaN(Date.parse(rule.effective_to))) {
    issues.push({ code: "effective-to-invalid", message: "effective_to must be an ISO date or null", rule_id: rule.rule_id });
  }
  if (rule.effective_to !== null && Date.parse(rule.effective_from) > Date.parse(rule.effective_to)) {
    issues.push({ code: "effective-window-invalid", message: "effective_from must not be after effective_to", rule_id: rule.rule_id });
  }
  if (!SPECIFIC_ACTIONS.includes(rule.composite_key.specific_action)) {
    issues.push({ code: "specific-action-invalid", message: "specific_action is invalid", rule_id: rule.rule_id });
  }
  if (!IMPACT_CLASSES.includes(rule.composite_key.clinical_billing_patient_facing_impact)) {
    issues.push({ code: "impact-invalid", message: "clinical_billing_patient_facing_impact is invalid", rule_id: rule.rule_id });
  }
  if (!INITIATION_MODES.includes(rule.composite_key.initiation_mode)) {
    issues.push({ code: "initiation-mode-invalid", message: "initiation_mode is invalid", rule_id: rule.rule_id });
  }
  if (!AGENTOPS_VERDICTS.includes(rule.on_violation.verdict)) {
    issues.push({ code: "verdict-invalid", message: "on_violation.verdict is invalid", rule_id: rule.rule_id });
  }
  if (rule.on_violation.verdict === "blocked" && !rule.on_violation.section_171_exception_code) {
    issues.push({ code: "exception-required", message: "blocked rules require section_171_exception_code", rule_id: rule.rule_id });
  }
  if (
    rule.on_violation.section_171_exception_code &&
    !AGENTOPS_EXCEPTION_CODES.includes(rule.on_violation.section_171_exception_code)
  ) {
    issues.push({ code: "exception-invalid", message: "section_171_exception_code is invalid", rule_id: rule.rule_id });
  }
  if (rule.on_violation.verdict === "escalated" && !rule.on_violation.escalation_target) {
    issues.push({ code: "escalation-target-required", message: "escalated rules require escalation_target", rule_id: rule.rule_id });
  }
}

function ruleMatches(rule: AgentOpsPolicyRule, input: AgentOpsActionLookupInput, at: number): boolean {
  if (Date.parse(rule.effective_from) > at) return false;
  if (rule.effective_to !== null && Date.parse(rule.effective_to) < at) return false;
  if (rule.agent_scope !== "any-agent" && rule.agent_scope !== input.agent_uri) return false;
  return (
    globMatches(rule.composite_key.tool_name, input.tool_name) &&
    globMatches(rule.composite_key.target_resourceType, input.target_resourceType) &&
    rule.composite_key.specific_action === input.specific_action &&
    rule.composite_key.clinical_billing_patient_facing_impact === input.clinical_billing_patient_facing_impact &&
    rule.composite_key.initiation_mode === input.initiation_mode
  );
}

function compareRuleSpecificity(a: AgentOpsPolicyRule, b: AgentOpsPolicyRule): number {
  const specificity = ruleSpecificityScore(b) - ruleSpecificityScore(a);
  if (specificity !== 0) return specificity;
  const rank = (b.source_rank ?? 0) - (a.source_rank ?? 0);
  if (rank !== 0) return rank;
  return Date.parse(b.effective_from) - Date.parse(a.effective_from);
}

function ruleSpecificityScore(rule: AgentOpsPolicyRule): number {
  return [
    rule.agent_scope === "any-agent" ? 0 : 100,
    rule.composite_key.tool_name === "*" ? 0 : 10,
    rule.composite_key.target_resourceType === "*" ? 0 : 10,
  ].reduce((sum, value) => sum + value, 0);
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  return pattern === value;
}

function ruleCollisionKey(rule: AgentOpsPolicyRule): string {
  return JSON.stringify({
    agent_scope: rule.agent_scope,
    composite_key: rule.composite_key,
    effective_from: rule.effective_from,
    source_rank: rule.source_rank ?? 0,
  });
}

type MutablePolicyRule = Partial<Omit<AgentOpsPolicyRule, "composite_key" | "on_violation">> & {
  composite_key: Partial<AgentOpsCompositeKey>;
  on_violation: Partial<AgentOpsOnViolation>;
};

function assignPolicyScalar(policy: MutablePolicyRule, key: string, rawValue: string, sourcePath: string): void {
  const value = parseScalar(rawValue);
  if (key === "§171_exception_code") {
    (policy.on_violation as { section_171_exception_code?: AgentOpsExceptionCode }).section_171_exception_code =
      value as AgentOpsExceptionCode;
    return;
  }
  if (!["rule_id", "rule_version", "threshold_class", "agent_scope", "effective_from", "effective_to", "rationale"].includes(key)) {
    throw new Error(`${sourcePath}: unsupported AgentOps policy key ${key}`);
  }
  (policy as Record<string, unknown>)[key] = value;
}

function finalizePolicy(policy: MutablePolicyRule, sourcePath: string): AgentOpsPolicyRule {
  return {
    rule_id: requirePolicyString(policy.rule_id, "rule_id", sourcePath),
    rule_version: requirePolicyString(policy.rule_version, "rule_version", sourcePath),
    composite_key: {
      tool_name: requirePolicyString(policy.composite_key.tool_name, "composite_key.tool_name", sourcePath),
      target_resourceType: requirePolicyString(policy.composite_key.target_resourceType, "composite_key.target_resourceType", sourcePath),
      specific_action: requirePolicyString(policy.composite_key.specific_action, "composite_key.specific_action", sourcePath) as SpecificAction,
      clinical_billing_patient_facing_impact: requirePolicyString(
        policy.composite_key.clinical_billing_patient_facing_impact,
        "composite_key.clinical_billing_patient_facing_impact",
        sourcePath,
      ) as ClinicalBillingPatientFacingImpact,
      initiation_mode: requirePolicyString(policy.composite_key.initiation_mode, "composite_key.initiation_mode", sourcePath) as InitiationMode,
    },
    threshold_class: requirePolicyString(policy.threshold_class, "threshold_class", sourcePath) as ThresholdClass,
    agent_scope: requirePolicyString(policy.agent_scope, "agent_scope", sourcePath),
    effective_from: requirePolicyString(policy.effective_from, "effective_from", sourcePath),
    effective_to: policy.effective_to === undefined ? null : (policy.effective_to as string | null),
    rationale: requirePolicyString(policy.rationale, "rationale", sourcePath),
    on_violation: {
      verdict: requirePolicyString(policy.on_violation.verdict, "on_violation.verdict", sourcePath) as AgentOpsOnViolation["verdict"],
      section_171_exception_code: policy.on_violation.section_171_exception_code,
      escalation_target: policy.on_violation.escalation_target,
    },
    source_path: sourcePath,
    source_rank: policy.source_rank,
  };
}

function requirePolicyString(value: unknown, field: string, sourcePath: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${sourcePath}: ${field} is required`);
  }
  return value;
}

function parseScalar(rawValue: string): string | number | null {
  const trimmed = rawValue.trim();
  if (trimmed === "null") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
