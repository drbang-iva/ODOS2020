import { existsSync, readFileSync, watch } from "node:fs";
import { resolve } from "node:path";
import {
  chooseMostRestrictiveRule,
  lookupThresholdRule,
  parseAgentOpsPolicyYaml,
  type AgentOpsActionLookupInput,
  type AgentOpsPolicyFile,
  type AgentOpsPolicyRule,
  type AgentOpsRuleResolution,
} from "./threshold-matrix.js";

export interface AgentOpsPolicyLoadResult {
  readonly rules: readonly AgentOpsPolicyRule[];
  readonly retentionYears: number;
  readonly loadedFiles: readonly string[];
  readonly collisions: readonly AgentOpsPolicyCollision[];
}

export interface AgentOpsPolicyCollision {
  readonly collision_key: string;
  readonly rule_ids: readonly string[];
  readonly chosen_rule_id: string;
  readonly detected_at: string;
}

export interface AgentOpsThresholdMatrixStore {
  load(): AgentOpsPolicyLoadResult;
  lookup(input: AgentOpsActionLookupInput): AgentOpsRuleResolution;
  startWatching(onReload: (result: AgentOpsPolicyLoadResult) => void): () => void;
}

export const DEFAULT_AGENTOPS_POLICY_PATHS = [
  "data/agentops-policies/defaults/generic.yaml",
  "data/agentops-policies/defaults/iris-starter.yaml",
] as const;

export function createAgentOpsThresholdMatrixStore(input: {
  readonly repoRoot: string;
  readonly practiceLocalPath?: string;
}): AgentOpsThresholdMatrixStore {
  let cache: AgentOpsPolicyLoadResult | undefined;
  const policyPaths = [
    ...DEFAULT_AGENTOPS_POLICY_PATHS.map((path) => resolve(input.repoRoot, path)),
    ...(input.practiceLocalPath ? [input.practiceLocalPath] : []),
  ];
  return {
    load() {
      cache = loadAgentOpsPolicyFiles(policyPaths);
      return cache;
    },
    lookup(action) {
      cache ??= loadAgentOpsPolicyFiles(policyPaths);
      return lookupThresholdRule(cache.rules, action);
    },
    startWatching(onReload) {
      const watchers = policyPaths
        .filter((path) => existsSync(path))
        .map((path) =>
          watch(path, { persistent: false }, () => {
            cache = loadAgentOpsPolicyFiles(policyPaths);
            onReload(cache);
          }),
        );
      return () => {
        for (const watcher of watchers) {
          watcher.close();
        }
      };
    },
  };
}

export function loadAgentOpsPolicyFiles(paths: readonly string[]): AgentOpsPolicyLoadResult {
  const files: AgentOpsPolicyFile[] = [];
  const loadedFiles: string[] = [];
  paths.forEach((path, index) => {
    if (!existsSync(path)) {
      return;
    }
    const parsed = parseAgentOpsPolicyYaml(readFileSync(path, "utf8"), path);
    files.push({
      ...parsed,
      policies: parsed.policies.map((rule) => ({
        ...rule,
        source_path: path,
        source_rank: index,
      })),
    });
    loadedFiles.push(path);
  });
  const rules = files.flatMap((file) => file.policies);
  const collisions = runtimePolicyCollisions(rules);
  const chosenCollisionRules = new Map<string, string>(
    collisions.map((collision) => [collision.collision_key, collision.chosen_rule_id]),
  );
  return {
    rules: rules.filter((rule) => {
      const key = runtimeCollisionKey(rule);
      const winner = chosenCollisionRules.get(key);
      return !winner || winner === rule.rule_id;
    }),
    retentionYears: Math.max(7, ...files.map((file) => file.retention.retention_years)),
    loadedFiles,
    collisions,
  };
}

export function runtimePolicyCollisions(
  rules: readonly AgentOpsPolicyRule[],
  now = new Date().toISOString(),
): AgentOpsPolicyCollision[] {
  const byKey = new Map<string, AgentOpsPolicyRule[]>();
  for (const rule of rules) {
    const key = runtimeCollisionKey(rule);
    const bucket = byKey.get(key) ?? [];
    bucket.push(rule);
    byKey.set(key, bucket);
  }
  return [...byKey.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .map(([collision_key, candidates]) => {
      const chosen = chooseMostRestrictiveRule(candidates);
      return {
        collision_key,
        rule_ids: candidates.map((rule) => rule.rule_id),
        chosen_rule_id: chosen.rule_id,
        detected_at: now,
      };
    });
}

function runtimeCollisionKey(rule: AgentOpsPolicyRule): string {
  return JSON.stringify({
    agent_scope: rule.agent_scope,
    composite_key: rule.composite_key,
    effective_from: rule.effective_from,
    source_rank: rule.source_rank ?? 0,
  });
}
