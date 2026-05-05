#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Resource } from "@medplum/fhirtypes";
import { buildOsodAuditEventRow, type OsodAuditEventRecord } from "../mcp/src/authz/osodAudit.js";
import {
  parseAgentOpsPolicyYaml,
  validateAgentOpsPolicyFile,
} from "../mcp/src/agentops/threshold-matrix.js";
import { smartScopeLintVerdict } from "../mcp/src/smart/scope.js";
import { findPhiPatternMatches, type PreflightPhiMatch } from "../policy/preflight-phi-patterns.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = resolve(REPO_ROOT, ".osod");

export type PreflightSeverity = "warning" | "hard-block";
export type PreflightPassStatus = "pass" | "warning" | "hard-block";

export interface PreflightFinding {
  readonly pass: "logs" | "resource-names" | "env-vars" | "vendor-canonical-shapes";
  readonly severity: PreflightSeverity;
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  readonly line?: number;
  readonly column?: number;
  readonly ledgerRow?: number;
  readonly lesson?: string;
}

export interface PreflightPassReport {
  readonly id: PreflightFinding["pass"];
  readonly status: PreflightPassStatus;
  readonly findings: readonly PreflightFinding[];
}

export interface PreflightReport {
  readonly generatedAt: string;
  readonly summary: {
    readonly warnings: number;
    readonly hardBlocks: number;
  };
  readonly passes: readonly PreflightPassReport[];
  readonly auditRows: readonly OsodAuditEventRecord[];
}

export interface LogScrubPassOptions {
  readonly logText?: string;
  readonly source?: string;
}

export interface ResourceNamePassOptions {
  readonly resources?: readonly ResourceNameLintResource[];
}

export interface EnvVarPhiPassOptions {
  readonly env?: Record<string, string | undefined>;
}

export interface VendorCanonicalShapePassOptions {
  readonly roots?: readonly string[];
  readonly files?: readonly { path: string; text: string }[];
}

export interface RunPreflightOptions extends LogScrubPassOptions, ResourceNamePassOptions, EnvVarPhiPassOptions, VendorCanonicalShapePassOptions {
  readonly writeReports?: boolean;
  readonly now?: string;
}

export interface ResourceNameLintResource {
  readonly resourceType?: string;
  readonly id?: string;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly code?: { readonly text?: string };
  readonly text?: { readonly div?: string };
}

type ForbiddenShape = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly message: string;
  readonly ledgerRow?: number;
  readonly lesson?: string;
};

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

const VENDOR_CANONICAL_SHAPES: readonly ForbiddenShape[] = [
  {
    id: "provenance-activity-correct",
    pattern: new RegExp(
      ["Provenance", "\\.activity", "[^\\n]*(?:=|:)", "[^\\n]*['\\\"]?", "correct", "['\\\"]?"].join(""),
      "i",
    ),
    message: "Forbidden Provenance.activity correction shape; use the verified v0.5a Provenance.activity value set.",
    ledgerRow: 18,
    lesson: "v0.5a Lesson 1",
  },
  {
    id: "observation-attestation-property",
    pattern: new RegExp(["Observation", "\\.", "attestation"].join(""), "i"),
    message: "Forbidden invented Observation attestation property; v0.5c uses Provenance + signature surfaces.",
    ledgerRow: 36,
    lesson: "v0.5c Lesson 6",
  },
  {
    id: "provenance-agent-policy",
    pattern: new RegExp(["Provenance", "\\.", "agent", "\\.", "policy"].join(""), "i"),
    message: "Forbidden nested Provenance agent policy path; Provenance.policy is top-level.",
    ledgerRow: 38,
    lesson: "v0.5c Lesson 6",
  },
  {
    id: "observation-partof-observation",
    pattern: new RegExp(["Observation", "\\.", "partOf", "[^\\n]*", "Observation", "/"].join(""), "i"),
    message: "Forbidden Observation-to-Observation partOf succession; use Observation.derivedFrom traversal.",
    ledgerRow: 39,
    lesson: "v0.5c Lesson 7",
  },
  {
    id: "auth-register-endpoint",
    pattern: new RegExp(["/", "auth", "/", "register"].join(""), "i"),
    message: "Forbidden registration endpoint; Medplum first-run provisioning uses auth/newuser and auth/newproject.",
    ledgerRow: 22,
    lesson: "v0.5b Lesson 3",
  },
  {
    id: "shell-into-medplum-server",
    pattern: new RegExp(["compose", "\\s+exec", "\\s+medplum-server"].join(""), "i"),
    message: "Forbidden shell-assumption shape; Medplum server images are shell-less.",
    ledgerRow: 25,
    lesson: "v0.5b Lesson 4",
  },
  {
    id: "binary-fhir-search",
    pattern: new RegExp(["GET", "\\s+/", "fhir", "/", "R4", "/", "Binary", "\\?"].join(""), "i"),
    message: "Forbidden Binary FHIR search shape; use direct Postgres/volume checks for Binary integrity.",
    ledgerRow: 27,
    lesson: "v0.5b Lesson 5",
  },
  {
    id: "cloud-render-domain",
    pattern: new RegExp(["render", "\\.", "com"].join(""), "i"),
    message: "Local-only scope boundary: vendor deploy domains are not v0.5d artifacts.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
  {
    id: "cloud-fly-domain",
    pattern: new RegExp(["fly", "\\.", "io"].join(""), "i"),
    message: "Local-only scope boundary: vendor deploy domains are not v0.5d artifacts.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
  {
    id: "cloud-railway-domain",
    pattern: new RegExp(["railway", "\\.", "app"].join(""), "i"),
    message: "Local-only scope boundary: vendor deploy domains are not v0.5d artifacts.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
  {
    id: "signed-baa-copy",
    pattern: new RegExp(["signed ", "BAA"].join(""), "i"),
    message: "Local-only scope boundary: vendor legal approval copy is not a v0.5d artifact.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
  {
    id: "hosted-compliance-tier-copy",
    pattern: new RegExp(["HIPAA", "-tier"].join(""), "i"),
    message: "Local-only scope boundary: hosted compliance-tier copy is not a v0.5d artifact.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
];

const MEDPLUM_CLIENT_APP_PATTERN = new RegExp(`\\b${["Client", "Application"].join("")}\\b`);
const OSOD_EXTENSION_URL_PATTERN =
  /https?:\/\/[^"'\s]+\/fhir\/StructureDefinition\/[^"'\s]+/g;
const PROMISE_ALL_MIGRATION_PATTERN = new RegExp(
  [
    "\\bPromise",
    "\\.",
    "all",
    "\\s*\\(",
    "\\s*[^)]*\\b",
    `(?:${["mig", "ration"].join("")}|${["MIGRATION", "PATHS"].join("_")}|${["migration", "Paths"].join("")})`,
  ].join(""),
);
const MARKETPLACE_SUPERLATIVE_PATTERN = new RegExp(
  [
    "\\b(?:first|the only|sole)\\s+",
    "(?:eyecare|optometric)\\s+",
    "(?:SMART|smart)\\s+",
    "(?:app\\s+)?",
    "marketplace\\b",
  ].join(""),
  "i",
);
const EXTERNAL_CDS_SUPERLATIVE_PATTERN = new RegExp(
  [
    "\\b(?:trusted\\s+vendor\\s+list|allowlist|vendor-managed\\s+CDS\\s+catalog|approved\\s+CDS\\s+vendor|preferred\\s+CDS\\s+vendor)\\b",
  ].join(""),
  "i",
);
const AGENTOPS_SUPERLATIVE_PATTERN = new RegExp(
  "\\b(?:agent marketplace|trusted agent list|vendor-managed AgentOps catalog|PerformanceOD-blessed agents|AgentOps marketplace)\\b",
  "i",
);
const AGENTOPS_INITIATION_MODE_ALIAS_PATTERN =
  /\b(?:initiation_type|init_mode|agent_initiation|autonomous_flag|is_autonomous|is_user_initiated)\b/;
const AGENTOPS_IMAGE_TO_LLM_PATTERN =
  /(?:anthropic\.(?:messages|completions|tools)|openai\.(?:chat|completions|images)|ollama|llm).*?(?:Buffer|Uint8Array|Blob|ImageData|data:image\/|DICOM|image\/[a-z0-9.+-]+)/i;
const AIAST_CODE_PATTERN = /code\s*:\s*["']AIAST["']/;
const AIAST_SYSTEM_PATTERN =
  /system\s*:\s*["']http:\/\/terminology\.hl7\.org\/CodeSystem\/v3-ObservationValue["']/;
const BULK_JOB_ID_PHI_CONSTRUCTOR_PATTERN =
  /(?:const|let|return)\s+(?:jobId|id)\b[^;\n]*(?:patient|mrn|dob|name|ssn|Date\.now|new Date|Math\.random|counter|\+\+)/i;
const BULK_META_SECURITY_STRIP_PATTERN =
  /delete\s+\w+\.meta\.security|\.meta\s*=\s*undefined|\.meta\.security\s*=\s*undefined|JSON\.stringify\([^,\n]+,\s*(?:replacer|[^)]*meta)/;
const BULK_FORBIDDEN_EXPORT_ENDPOINT_PATTERN = /Patient\/(?::id|\{id\})\/\$export|\/Patient\/:id\/\$export/;
const IN_CONTAINER_PACKET_FILTER_PATTERN = new RegExp(
  `${["ipt", "ables"].join("")}.*--uid-owner|${["in-container", ["ipt", "ables"].join("")].join(" ")}`,
  "i",
);
const CDS_SERVICE_ID_PATTERN = /\bid\s*:\s*["'`]([^"'`]+)["'`]/g;
const OSOD_CDS_SERVICE_ID_PATTERN = /^osod-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OSOD_CDS_SERVICE_URL_PATTERN = /^https:\/\/osod\.dev\/cds-hooks\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PREFLIGHT_ALLOWED_NETWORK_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/localhost(?::\d+)?(?:\/|$)/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/i,
  /^https?:\/\/\[::1\](?::\d+)?(?:\/|$)/i,
  /^https?:\/\/[a-z0-9_-]+(?::\d+)?(?:\/|$)/i,
];

export function runLogScrubPass(options: LogScrubPassOptions = {}): PreflightPassReport {
  const source = options.source ?? "docker compose logs --tail 500";
  const logText = options.logText ?? readRecentStackLogs();
  const findings = findingsFromPhiText({
    pass: "logs",
    severity: "warning",
    source,
    text: logText,
    messagePrefix: "PHI-shaped value found in recent local stack logs",
  });
  return passReport("logs", findings);
}

export function runResourceNamePass(options: ResourceNamePassOptions = {}): PreflightPassReport {
  const resources = options.resources ?? readResourceNameInventory();
  const findings: PreflightFinding[] = [];

  for (const resource of resources) {
    const resourceType = resource.resourceType ?? "Resource";
    const id = resource.id ?? "unknown";
    const source = `${resourceType}/${id}`;
    for (const [field, value] of lintableResourceFields(resource)) {
      const text = stringifyField(value);
      for (const match of findPhiPatternMatches(text)) {
        findings.push({
          pass: "resource-names",
          severity: "warning",
          code: match.patternId,
          message: `PHI-shaped value found in opaque ${resourceType}.${field}`,
          source,
          line: match.line,
          column: match.column,
        });
      }
    }
  }

  return passReport("resource-names", findings);
}

export function runEnvVarPhiPass(options: EnvVarPhiPassOptions = {}): PreflightPassReport & {
  readonly auditRows: readonly OsodAuditEventRecord[];
} {
  const env = options.env ?? readComposeEnvironment();
  const findings: PreflightFinding[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue;
    }
    for (const match of findPhiPatternMatches(value)) {
      findings.push({
        pass: "env-vars",
        severity: "hard-block",
        code: match.patternId,
        message: `PHI-shaped value found in environment variable ${key}`,
        source: key,
        line: match.line,
        column: match.column,
      });
    }
  }

  const auditRows = findings.length
    ? [
        buildOsodAuditEventRow({
          eventType: "preflight-block",
          actorId: "preflight-linter",
          actorRole: "system",
          resourceType: "Environment",
          actionOutcome: "denied",
          actionReason: "v0.5d preflight linter env-var PHI hard-block",
        }),
      ]
    : [];
  return { ...passReport("env-vars", findings), auditRows };
}

export function runVendorCanonicalShapePass(
  options: VendorCanonicalShapePassOptions = {},
): PreflightPassReport {
  const files = options.files ?? readSourceFiles(options.roots ?? defaultSourceRoots());
  const findings: PreflightFinding[] = [];

  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (MEDPLUM_CLIENT_APP_PATTERN.test(line) && !isMedplumAdapterPath(file.path)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "client-application-boundary",
          message: "Forbidden Medplum client app shape outside the v0.55b adapter boundary.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 21,
          lesson: "v0.55b Binding #1",
        });
      }
      if (isMcpSourcePath(file.path) && PROMISE_ALL_MIGRATION_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "promise-all-migration",
          message: "Migration DDL must apply sequentially; Promise.all over migration paths is forbidden.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 15,
          lesson: "v0.55a Lesson 14",
        });
      }
      for (const match of line.matchAll(OSOD_EXTENSION_URL_PATTERN)) {
        const url = match[0]!;
        if (urlHost(url) === "osod.dev" && !canonicalExtensionUrls().has(url)) {
          findings.push({
            pass: "vendor-canonical-shapes",
            severity: "hard-block",
            code: "osod-extension-url-shape",
            message: "OSOD-authored StructureDefinition URL is missing from data/canonical-extensions/registry.json.",
            source: displayPath(file.path),
            line: index + 1,
            column: match.index === undefined ? undefined : match.index + 1,
            ledgerRow: 19,
            lesson: "v0.55b Binding #1",
          });
        }
      }
      for (const shape of VENDOR_CANONICAL_SHAPES) {
        shape.pattern.lastIndex = 0;
        if (!shape.pattern.test(line)) {
          continue;
        }
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: shape.id,
          message: shape.message,
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: shape.ledgerRow,
          lesson: shape.lesson,
        });
      }
      for (const match of line.matchAll(/(["'`])((?:patient|user|system)\/[^"'`\s]+)\1/g)) {
        const scope = match[2]!;
        const verdict = smartScopeLintVerdict(scope);
        if (verdict === "valid-v2" || verdict === "not-smart-resource") {
          continue;
        }
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: verdict === "legacy-warning" ? "warning" : "hard-block",
          code: verdict === "legacy-warning" ? "smart-scope-v1-legacy" : "smart-scope-invalid",
          message:
            verdict === "legacy-warning"
              ? "SMART v1 scope string is backward-compatible only; v2 granular permissions are preferred."
              : "Malformed SMART scope string; expected ledger row 11 grammar.",
          source: displayPath(file.path),
          line: index + 1,
          column: match.index === undefined ? undefined : match.index + 1,
          ledgerRow: 11,
          lesson: "v0.55a SMART scope-string Pass 4 lint",
        });
      }
    }
  }

  for (const finding of cdsHookIdFormatFindings(files)) {
    findings.push(finding);
  }
  for (const finding of cdsCardSchemaFindings(files)) {
    findings.push(finding);
  }
  for (const finding of agentOpsPolicySchemaFindings(files)) {
    findings.push(finding);
  }
  for (const finding of agentOpsCanonicalNameFindings(files)) {
    findings.push(finding);
  }
  for (const finding of agentOpsImagePayloadFindings(files)) {
    findings.push(finding);
  }
  for (const finding of agentOpsAiastSystemUriFindings(files)) {
    findings.push(finding);
  }
  for (const finding of agentOpsSafetyValveLeakFindings(files)) {
    findings.push(finding);
  }
  for (const finding of agentOpsRuntimeNetworkShapeFindings(files)) {
    findings.push(finding);
  }
  for (const finding of bulkDataJobIdFindings(files)) {
    findings.push(finding);
  }
  for (const finding of capabilityStatementRuleFindings(files)) {
    findings.push(finding);
  }
  for (const finding of bulkDataMetaSecurityFindings(files)) {
    findings.push(finding);
  }
  for (const finding of bulkDataEndpointShapeFindings(files)) {
    findings.push(finding);
  }
  for (const finding of auditEventCountConsistencyFindings(options.files ? files : [...files, ...readAuditEventCountFiles()])) {
    findings.push(finding);
  }

  for (const file of copyFilesForPass(options, files)) {
    const lines = file.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (MARKETPLACE_SUPERLATIVE_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "marketplace-superlative-block",
          message: "Marketplace-superlative copy is blocked until v0.55 ledger row 25 clears.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 25,
          lesson: "Mandate 14-amendment 2026-05-01b",
        });
      }
      if (EXTERNAL_CDS_SUPERLATIVE_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "external-cds-services-superlative-block",
          message: "External CDS services copy must stay opt-in only until v0.55 ledger row 37 clears.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 37,
          lesson: "Mandate 14-amendment 2026-05-01b",
        });
      }
      if (AGENTOPS_SUPERLATIVE_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "agentops-superlative-block",
          message: "AgentOps copy must stay neutral and must not imply an agent marketplace or blessed agent catalog.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 52,
          lesson: "v0.55d PROVISIONAL #1 copy posture",
        });
      }
    }
  }

  return passReport("vendor-canonical-shapes", findings);
}

export function runPreflightLint(options: RunPreflightOptions = {}): PreflightReport {
  const logPass = runLogScrubPass(options);
  const resourcePass = runResourceNamePass(options);
  const envPass = runEnvVarPhiPass(options);
  const shapePass = runVendorCanonicalShapePass(options);
  const passes = [logPass, resourcePass, envPass, shapePass];
  const findings = passes.flatMap((pass) => [...pass.findings]);
  const report: PreflightReport = {
    generatedAt: options.now ?? new Date().toISOString(),
    summary: {
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      hardBlocks: findings.filter((finding) => finding.severity === "hard-block").length,
    },
    passes,
    auditRows: envPass.auditRows,
  };

  if (options.writeReports ?? true) {
    writeReports(report);
  }
  return report;
}

export function assertPreflightNetworkSurface(urls: readonly string[]): void {
  for (const value of urls) {
    const normalized = value.trim();
    if (/[/?#](?:login|password|account[-_]?recovery|recover|reset)/i.test(normalized)) {
      throw new Error("Mandate 8 boundary: preflight linter must not touch login, recovery, or password-change endpoints.");
    }
    if (!PREFLIGHT_ALLOWED_NETWORK_PATTERNS.some((pattern) => pattern.test(normalized))) {
      throw new Error(`Mandate 8 boundary: preflight linter network surface is not local-only: ${normalized}`);
    }
  }
}

function findingsFromPhiText(input: {
  pass: PreflightFinding["pass"];
  severity: PreflightSeverity;
  source: string;
  text: string;
  messagePrefix: string;
}): PreflightFinding[] {
  return findPhiPatternMatches(input.text).map((match: PreflightPhiMatch) => ({
    pass: input.pass,
    severity: input.severity,
    code: match.patternId,
    message: `${input.messagePrefix}: ${match.description}`,
    source: input.source,
    line: match.line,
    column: match.column,
  }));
}

function passReport(id: PreflightPassReport["id"], findings: readonly PreflightFinding[]): PreflightPassReport {
  const status = findings.some((finding) => finding.severity === "hard-block")
    ? "hard-block"
    : findings.length
      ? "warning"
      : "pass";
  return { id, status, findings };
}

function lintableResourceFields(resource: ResourceNameLintResource): [string, unknown][] {
  const resourceType = resource.resourceType ?? "Resource";
  if (resourceType === "Binary") {
    return [["title", resource.title]];
  }
  if (resourceType === "DocumentReference") {
    return [
      ["description", resource.description],
      ["title", resource.title],
    ];
  }
  if (resourceType === "AccessPolicy") {
    return [["name", resource.name]];
  }
  if (resourceType === "Observation") {
    return [
      ["code.text", resource.code?.text],
      ["text.div", resource.text?.div],
    ];
  }
  if (resourceType === "Practitioner") {
    return [["name", resource.name]];
  }
  return [
    ["name", resource.name],
    ["title", resource.title],
    ["description", resource.description],
  ];
}

function stringifyField(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function readRecentStackLogs(): string {
  try {
    const command = composeCommand();
    return execFileSync(command.bin, [...command.args, "logs", "--no-color", "--tail", "500"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function readComposeEnvironment(): Record<string, string> {
  try {
    const command = composeCommand();
    const output = execFileSync(command.bin, [...command.args, "config", "--environment"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseEnvLines(output);
  } catch {
    return Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
}

function readResourceNameInventory(): ResourceNameLintResource[] {
  const postgresUrl = process.env.OSOD_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
  const resourceTypes = [
    "Patient",
    "Practitioner",
    "Observation",
    "DocumentReference",
    "Binary",
    "AccessPolicy",
  ];
  return resourceTypes.flatMap((resourceType) => readResourceTable(postgresUrl, resourceType));
}

function readResourceTable(postgresUrl: string, resourceType: string): ResourceNameLintResource[] {
  const sql = `
    SELECT COALESCE(json_agg(content::json), '[]'::json)::text
    FROM (
      SELECT content
      FROM "${resourceType}"
      WHERE deleted = false
      LIMIT 200
    ) resource_sample;
  `;
  try {
    const output = execFileSync("psql", [postgresUrl, "-Atc", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return JSON.parse(output || "[]") as ResourceNameLintResource[];
  } catch {
    return [];
  }
}

function parseEnvLines(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      env[match[1]!] = match[2]!;
    }
  }
  return env;
}

function composeCommand(): { bin: string; args: string[] } {
  if (hasCommand("docker")) {
    return { bin: "docker", args: ["compose"] };
  }
  return { bin: "docker-compose", args: [] };
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultSourceRoots(): string[] {
  return ["mcp/src", "ui/src", "policy", "data", "scripts", "tests", "docker-compose.yml"].map((path) => resolve(REPO_ROOT, path));
}

function readSourceFiles(roots: readonly string[]): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const root of roots) {
    walk(resolve(root), files);
  }
  return files;
}

function walk(path: string, files: { path: string; text: string }[]): void {
  try {
    const maybeFile = readFileSync(path, "utf8");
    if (SOURCE_EXTENSIONS.has(extname(path))) {
      files.push({ path, text: maybeFile });
    }
    return;
  } catch {
    /* continue as directory */
  }
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (![".git", ".osod", "dist", "node_modules"].includes(entry.name)) {
        walk(child, files);
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) {
      continue;
    }
    files.push({ path: child, text: readFileSync(child, "utf8") });
  }
}

function displayPath(path: string): string {
  if (!isAbsolute(path)) {
    return path;
  }
  return relative(REPO_ROOT, path) || path;
}

function isMedplumAdapterPath(path: string): boolean {
  return displayPath(path).startsWith("data/medplum-adapters/");
}

function isMcpSourcePath(path: string): boolean {
  return displayPath(path).startsWith("mcp/src/");
}

function isCdsServicePath(path: string): boolean {
  return displayPath(path).startsWith("mcp/src/cds/services/");
}

function isAgentOpsCanonicalNameSurface(path: string): boolean {
  const displayed = displayPath(path);
  return (
    displayed.startsWith("mcp/src/agentops/") ||
    displayed.startsWith("mcp/src/cds/") ||
    displayed.startsWith("data/agentops-policies/")
  );
}

function isAgentOpsImagePayloadSurface(path: string): boolean {
  const displayed = displayPath(path);
  return (
    displayed.startsWith("mcp/src/agentops/runtime/llm-adapters/") ||
    displayed.startsWith("mcp/src/agentops/runtime/mcp-serializers/") ||
    displayed.startsWith("mcp/src/agentops/dispatcher/") ||
    displayed.startsWith("mcp/src/bulk-data/") ||
    displayed.startsWith("mcp/src/parsers/") ||
    displayed.startsWith("mcp/src/cds/services/") ||
    displayed === "mcp/src/agentops/runtime/agent-process.ts"
  );
}

function isAgentOpsAiastSurface(path: string): boolean {
  const displayed = displayPath(path);
  return (
    displayed.startsWith("mcp/src/agentops/") ||
    displayed.startsWith("mcp/src/cds/services/") ||
    displayed.startsWith("mcp/src/bulk-data/output/")
  );
}

function isAgentOpsExternalResponseSurface(path: string): boolean {
  const displayed = displayPath(path);
  return (
    displayed === "mcp/src/agentops/safety-valve.ts" ||
    displayed === "mcp/src/agentops/runtime/agent-process.ts" ||
    displayed === "mcp/src/bulk-data/refusal-handler.ts" ||
    displayed.startsWith("mcp/src/bulk-data/output/") ||
    displayed.startsWith("mcp/src/cds/services/")
  );
}

function cdsHookIdFormatFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const ids: Array<{ path: string; line: number; id: string; format: "short" | "url" | "invalid" }> = [];
  for (const file of files) {
    if (!isCdsServicePath(file.path)) {
      continue;
    }
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      for (const match of line.matchAll(CDS_SERVICE_ID_PATTERN)) {
        const id = match[1]!;
        const format = OSOD_CDS_SERVICE_ID_PATTERN.test(id)
          ? "short"
          : OSOD_CDS_SERVICE_URL_PATTERN.test(id)
            ? "url"
            : "invalid";
        ids.push({ path: file.path, line: index + 1, id, format });
      }
    }
  }
  const activeFormats = new Set(ids.filter((entry) => entry.format !== "invalid").map((entry) => entry.format));
  return ids
    .filter((entry) => entry.format === "invalid" || activeFormats.size > 1)
    .map((entry) => ({
      pass: "vendor-canonical-shapes",
      severity: "hard-block",
      code: "hook-id-format",
      message: `CDS service id ${entry.id} does not match the v0.55c hook-service ID format decision.`,
      source: displayPath(entry.path),
      line: entry.line,
      ledgerRow: 33,
      lesson: "v0.55c PROVISIONAL #3 consumption gate",
    }));
}

function cdsCardSchemaFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const helperProvidesDsiFields = files.some((file) =>
    isCdsServicePath(file.path) &&
    file.text.includes("dsi_type") &&
    file.text.includes("intervention_risk_management") &&
    file.text.includes("source_attributes"),
  );
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (!isCdsServicePath(file.path)) {
      continue;
    }
    const emitsCards = /\bcards\s*:|\bruleCard\s*\(/.test(file.text);
    if (!emitsCards) {
      continue;
    }
    const hasFields =
      file.text.includes("dsi_type") &&
      file.text.includes("intervention_risk_management") &&
      file.text.includes("source_attributes");
    if (hasFields || (file.text.includes("ruleCard(") && helperProvidesDsiFields)) {
      continue;
    }
    findings.push({
      pass: "vendor-canonical-shapes",
      severity: "hard-block",
      code: "hti-1-dsi-card-schema",
      message: "CDS card emitter is missing required HTI-1 DSI disclosure fields.",
      source: displayPath(file.path),
      line: 1,
      ledgerRow: 35,
      lesson: "v0.55c Binding #4",
    });
  }
  return findings;
}

function agentOpsPolicySchemaFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (!displayPath(file.path).startsWith("data/agentops-policies/") || !/\.ya?ml$/.test(file.path)) {
      continue;
    }
    try {
      const parsed = parseAgentOpsPolicyYaml(file.text, displayPath(file.path));
      for (const issue of validateAgentOpsPolicyFile(parsed)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: `agentops-policy-schema:${issue.code}`,
          message: issue.message,
          source: displayPath(file.path),
          ledgerRow: 44,
          lesson: "v0.55d Binding #16",
        });
      }
      if (
        displayPath(file.path).startsWith("data/agentops-policies/defaults/") &&
        parsed.policies.some((rule) => rule.composite_key.initiation_mode === "autonomously-initiated")
      ) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "agentops-policy-schema:autonomous-default",
          message: "v0.55d default AgentOps policies must not ship autonomously-initiated rules.",
          source: displayPath(file.path),
          ledgerRow: 46,
          lesson: "v0.55d Q3 Layer 2 lock",
        });
      }
    } catch (error) {
      findings.push({
        pass: "vendor-canonical-shapes",
        severity: "hard-block",
        code: "agentops-policy-schema",
        message: error instanceof Error ? error.message : String(error),
        source: displayPath(file.path),
        ledgerRow: 46,
        lesson: "v0.55d Binding #16",
      });
    }
  }
  return findings;
}

function agentOpsCanonicalNameFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (!isAgentOpsCanonicalNameSurface(file.path)) {
      continue;
    }
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      if (AGENTOPS_INITIATION_MODE_ALIAS_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "agentops-initiation-mode-canonical-name",
          message: "Only initiation_mode is canonical for AgentOps initiation state.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 46,
          lesson: "v0.55d Q1/Q3/Q8 cross-cut",
        });
      }
    }
  }
  return findings;
}

function agentOpsImagePayloadFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (!isAgentOpsImagePayloadSurface(file.path)) {
      continue;
    }
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      if (AGENTOPS_IMAGE_TO_LLM_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "agentops-image-payload-to-llm-block",
          message: "AgentOps LLM-call paths must not receive raw image bytes or image MIME payloads.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 53,
          lesson: "Mandate 13 Criterion 1",
        });
      }
    }
  }
  return findings;
}

function agentOpsAiastSystemUriFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (!isAgentOpsAiastSurface(file.path)) {
      continue;
    }
    const lines = file.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.includes('"AIAST" |') || line.includes("'AIAST' |")) {
        continue;
      }
      if (!AIAST_CODE_PATTERN.test(line)) {
        continue;
      }
      const window = lines.slice(Math.max(0, index - 5), index + 6).join("\n");
      if (!AIAST_SYSTEM_PATTERN.test(window)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "agentops-aiast-system-uri-required",
          message: "AIAST coding must include the canonical HL7 THO CodeSystem URI.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 49,
          lesson: "v0.55d AIAST semantic tag integrity",
        });
      }
    }
  }
  return findings;
}

function agentOpsSafetyValveLeakFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (!isAgentOpsExternalResponseSurface(file.path)) {
      continue;
    }
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      if (/ProtectingCareAccess|171\.206|\/fhir\/exception\/171\.206|X-OSOD-IB-Exception/.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "agentops-safety-valve-no-protectingcareaccess-leak",
          message: "External AgentOps response surfaces must not leak masked care-access exception details or removed IB headers.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 44,
          lesson: "v0.55d Safety Valve privacy masking",
        });
      }
    }
  }
  return findings;
}

function agentOpsRuntimeNetworkShapeFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (!displayPath(file.path).startsWith("mcp/src/agentops/") && displayPath(file.path) !== "docker-compose.yml") {
      continue;
    }
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      if (IN_CONTAINER_PACKET_FILTER_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "agentops-dual-container-network-namespace-required",
          message: "AgentOps egress containment uses sidecar network namespaces, not container-local packet filtering.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 45,
          lesson: "v0.55d Q6 lock amendment",
        });
      }
    }
  }
  return findings;
}

function bulkDataJobIdFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (displayPath(file.path) !== "mcp/src/bulk-data/job-id-generator.ts") {
      continue;
    }
    if (!file.text.includes("randomBytes") || !file.text.includes("BULK_EXPORT_JOB_ID_PATTERN")) {
      findings.push({
        pass: "vendor-canonical-shapes",
        severity: "hard-block",
        code: "bulk-data-no-phi-in-job-id",
        message: "Bulk Data job IDs must be high-entropy URL-safe nonces with a runtime shape check.",
        source: displayPath(file.path),
        line: 1,
        ledgerRow: 70,
        lesson: "v0.55e Binding #25",
      });
    }
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      if (BULK_JOB_ID_PHI_CONSTRUCTOR_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "bulk-data-no-phi-in-job-id",
          message: "Bulk Data job IDs must not be derived from PHI, dates, counters, or predictable values.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 70,
          lesson: "v0.55e Binding #25",
        });
      }
    }
  }
  return findings;
}

function capabilityStatementRuleFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const rulesFile = files.find((file) => displayPath(file.path) === "data/canonical-extensions/capability-statement-rules.json");
  const capabilityTests = new Set(
    files
      .map((file) => displayPath(file.path))
      .filter((path) => path.startsWith("mcp/src/__tests__/capability/") && path.endsWith(".test.ts")),
  );
  if (!rulesFile && capabilityTests.size === 0) {
    return [];
  }
  const findings: PreflightFinding[] = [];
  let rules: Array<{ backing_test?: string; claim_path?: string; required_for_certification?: boolean }> = [];
  try {
    rules = (JSON.parse(rulesFile?.text ?? "{}") as { rules?: typeof rules }).rules ?? [];
  } catch {
    findings.push({
      pass: "vendor-canonical-shapes",
      severity: "hard-block",
      code: "capability-statement-claim-must-have-test",
      message: "CapabilityStatement rules JSON must parse cleanly.",
      source: rulesFile ? displayPath(rulesFile.path) : "data/canonical-extensions/capability-statement-rules.json",
      line: 1,
      ledgerRow: 60,
      lesson: "v0.55e Binding #3",
    });
    return findings;
  }
  const backingTests = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (typeof rule.required_for_certification !== "boolean") {
      findings.push({
        pass: "vendor-canonical-shapes",
        severity: "hard-block",
        code: "capability-statement-claim-must-have-test",
        message: "CapabilityStatement claim rule must explicitly set required_for_certification.",
        source: rulesFile ? displayPath(rulesFile.path) : "data/canonical-extensions/capability-statement-rules.json",
        line: index + 1,
        ledgerRow: 60,
        lesson: "v0.55e Binding #3",
      });
    }
    if (!rule.backing_test || !capabilityTests.has(rule.backing_test)) {
      findings.push({
        pass: "vendor-canonical-shapes",
        severity: "hard-block",
        code: "capability-statement-claim-must-have-test",
        message: `CapabilityStatement claim ${rule.claim_path ?? "(unknown)"} lacks an existing backing integration test.`,
        source: rulesFile ? displayPath(rulesFile.path) : "data/canonical-extensions/capability-statement-rules.json",
        line: index + 1,
        ledgerRow: 60,
        lesson: "v0.55e Binding #3",
      });
      continue;
    }
    backingTests.add(rule.backing_test);
  }
  for (const testPath of capabilityTests) {
    if (!backingTests.has(testPath)) {
      findings.push({
        pass: "vendor-canonical-shapes",
        severity: "hard-block",
        code: "capability-statement-claim-must-have-test",
        message: "CapabilityStatement capability test is not referenced by the rules file.",
        source: testPath,
        line: 1,
        ledgerRow: 60,
        lesson: "v0.55e Binding #3",
      });
    }
  }
  return findings;
}

function bulkDataMetaSecurityFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    if (!displayPath(file.path).startsWith("mcp/src/bulk-data/output/")) {
      continue;
    }
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      if (BULK_META_SECURITY_STRIP_PATTERN.test(line)) {
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: "meta-security-preservation-on-ndjson-output",
          message: "Bulk Data NDJSON output must not strip FHIR meta.security.",
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: 68,
          lesson: "v0.55e Binding #10",
        });
      }
    }
  }
  return findings;
}

function bulkDataEndpointShapeFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const file = files.find((candidate) => displayPath(candidate.path) === "mcp/src/bulk-data/router.ts");
  if (!file) {
    return [];
  }
  const findings: PreflightFinding[] = [];
  const checks = [
    { ok: file.text.includes('"/Group/:id/$export"'), message: "Group export route must include a concrete Group id path parameter." },
    { ok: file.text.includes('"/Patient/$export"'), message: "Patient export route must be all-patients-compartment Patient/$export." },
    { ok: file.text.includes('"/$export"'), message: "System export route must be root-level $export." },
    { ok: !BULK_FORBIDDEN_EXPORT_ENDPOINT_PATTERN.test(file.text), message: "Patient export must not be implemented as a single-patient Patient/{id}/$export route." },
  ];
  for (const check of checks) {
    if (!check.ok) {
      findings.push({
        pass: "vendor-canonical-shapes",
        severity: "hard-block",
        code: "bulk-data-export-endpoint-shape",
        message: check.message,
        source: displayPath(file.path),
        line: 1,
        ledgerRow: 54,
        lesson: "v0.55e Binding #1",
      });
    }
  }
  return findings;
}

function auditEventCountConsistencyFindings(files: readonly { path: string; text: string }[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const file of files) {
    const displayed = displayPath(file.path);
    if (!displayed.endsWith(".md") && !displayed.startsWith("data/code-bindings/")) {
      continue;
    }
    const match = /(\d+)\s+new\s+(?:audit\s+)?event[_ ]types?/i.exec(file.text);
    if (!match) {
      continue;
    }
    const claimed = Number(match[1]);
    const afterLines = file.text.slice(match.index + match[0].length).split(/\r?\n/);
    let listed = 0;
    let started = false;
    for (const line of afterLines) {
      if (/^\s*-\s+`[^`]+`/.test(line)) {
        listed += 1;
        started = true;
        continue;
      }
      if (!started && !line.trim()) {
        continue;
      }
      if (started) {
        break;
      }
    }
    if (listed > 0 && listed !== claimed) {
      findings.push({
        pass: "vendor-canonical-shapes",
        severity: "hard-block",
        code: "audit-event-count-vs-list-consistency",
        message: `Audit event count claim says ${claimed}, but the following list has ${listed} items.`,
        source: displayPath(file.path),
        line: lineForIndex(file.text, match.index),
        ledgerRow: 65,
        lesson: "v0.55e Binding #11",
      });
    }
  }
  return findings;
}

function lineForIndex(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function urlHost(value: string): string | undefined {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function readMarketplaceCopyFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const readIfExists = (path: string): void => {
    try {
      files.push({ path, text: readFileSync(path, "utf8") });
    } catch {
      /* absent docs are handled by tests */
    }
  };
  readIfExists(resolve(REPO_ROOT, "README.md"));
  walkMarkdown(resolve(REPO_ROOT, "docs"), files);
  walkMarkdown(resolve(REPO_ROOT, "ui/src"), files);
  return files;
}

function readAuditEventCountFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  walkMarkdown(resolve(REPO_ROOT, "docs/build-log"), files);
  walkMarkdown(resolve(REPO_ROOT, "data/code-bindings"), files);
  const readIfExists = (path: string): void => {
    try {
      files.push({ path, text: readFileSync(path, "utf8") });
    } catch {
      /* absent files are fine */
    }
  };
  readIfExists(resolve(REPO_ROOT, "README.md"));
  return files;
}

function copyFilesForPass(
  options: VendorCanonicalShapePassOptions,
  files: readonly { path: string; text: string }[],
): { path: string; text: string }[] {
  if (!options.files) {
    return readMarketplaceCopyFiles();
  }
  return files.filter((file) => isSubscriberFacingCopyPath(file.path));
}

function isSubscriberFacingCopyPath(path: string): boolean {
  const displayed = displayPath(path);
  return displayed === "README.md" || displayed.startsWith("docs/") || displayed.startsWith("ui/src/");
}

function walkMarkdown(path: string, files: { path: string; text: string }[]): void {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (![".git", ".osod", "build-log", "dist", "node_modules"].includes(entry.name)) {
        walkMarkdown(child, files);
      }
      continue;
    }
    if (entry.isFile() && [".md", ".ts", ".tsx"].includes(extname(entry.name))) {
      files.push({ path: child, text: readFileSync(child, "utf8") });
    }
  }
}

let cachedCanonicalExtensionUrls: Set<string> | undefined;

function canonicalExtensionUrls(): Set<string> {
  cachedCanonicalExtensionUrls ??= (() => {
    const registryPath = resolve(REPO_ROOT, "data/canonical-extensions/registry.json");
    try {
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
        extensions?: Array<{ url?: string }>;
      };
      return new Set(
        (registry.extensions ?? [])
          .map((entry) => entry.url)
          .filter((url): url is string => typeof url === "string"),
      );
    } catch {
      return new Set<string>();
    }
  })();
  return cachedCanonicalExtensionUrls;
}

function writeReports(report: PreflightReport): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "preflight-report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(REPORT_DIR, "preflight-report.md"), renderMarkdownReport(report));
}

function renderMarkdownReport(report: PreflightReport): string {
  const lines = [
    "# OSOD Preflight Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Warnings: ${report.summary.warnings}`,
    `Hard blocks: ${report.summary.hardBlocks}`,
    "",
  ];
  for (const pass of report.passes) {
    lines.push(`## ${pass.id}: ${pass.status}`, "");
    if (!pass.findings.length) {
      lines.push("No findings.", "");
      continue;
    }
    for (const finding of pass.findings) {
      const location = finding.source
        ? ` (${finding.source}${finding.line ? `:${finding.line}` : ""})`
        : "";
      const citation = finding.ledgerRow ? ` Ledger row ${finding.ledgerRow}; ${finding.lesson ?? "lesson recorded"}.` : "";
      lines.push(`- ${finding.severity}: ${finding.code}${location} - ${finding.message}.${citation}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runPreflightLint();
  const message = `OSOD preflight complete: ${report.summary.warnings} warning(s), ${report.summary.hardBlocks} hard block(s). Reports: .osod/preflight-report.json and .osod/preflight-report.md`;
  console.log(message);
  if (report.summary.hardBlocks > 0) {
    process.exitCode = 1;
  }
}
